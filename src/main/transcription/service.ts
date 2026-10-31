import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  groupWordsIntoSentences,
  flattenWords,
  normalizeWords,
  roundTime,
  TRANSCRIBABLE_EXTENSIONS,
  TRANSCRIPT_SCHEMA,
  TRANSCRIPT_SCHEMA_VERSION,
  TranscriptionError,
  type Transcript,
  type TranscriptionOptions,
  type TranscriptionProgress,
  type TranscriptionRequest,
  type TranscriptionSettings,
  type TranscriptionStage,
  type TranscriptionStatus,
} from '../../shared/transcription';
import { cacheKey, fingerprintFile, TranscriptCache } from './cache';
import { energyEnvelope, readWav16, refineAnchoredStarts } from './onsets';
import { extractAudio, ffmpegVersion } from './ffmpeg';
import { findFfmpeg, findWhisper, listModels, resolveModel, type ToolLocations } from './tools';
import { WhisperCppEngine, type TranscriptionEngine } from './whisperCpp';

export interface ServiceSettings {
  ffmpegPath?: string;
  transcription?: TranscriptionSettings;
}

export interface ServiceConfig {
  userDataPath: string;
  /** Read on every job so settings changes apply without a restart. */
  getSettings: () => ServiceSettings;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  tempDir?: string;
  /** Override for tests or alternative engines. Defaults to whisper.cpp at the resolved path. */
  createEngine?: (enginePath: string) => TranscriptionEngine;
}

export interface JobHandlers {
  jobId: string;
  onProgress?: (progress: TranscriptionProgress) => void;
}

export interface JobResult {
  transcript: Transcript;
  fromCache: boolean;
}

/** Version of the timing pipeline; part of the cache key. */
export const TIMING_VERSION = 2;

// Share of overall progress per stage.
const EXTRACT_SPAN: [number, number] = [0.02, 0.15];
const TRANSCRIBE_SPAN: [number, number] = [0.15, 0.97];

function defaultThreads(): number {
  // whisper.cpp scales poorly past ~8 threads; leave one core for the UI and playback.
  return Math.max(1, Math.min(8, os.cpus().length - 1));
}

export class TranscriptionService {
  private readonly cache: TranscriptCache;
  private readonly jobs = new Map<string, AbortController>();
  /** Settles (never rejects) when each job has finished, including its temp-folder cleanup. */
  private readonly settled = new Set<Promise<void>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: ServiceConfig) {
    this.cache = new TranscriptCache(path.join(config.userDataPath, 'transcripts'));
  }

  private locations(): ToolLocations & { settings: ServiceSettings } {
    const settings = this.config.getSettings() ?? {};
    const { userDataPath } = this.config;
    return {
      settings,
      ffmpegPath: settings.ffmpegPath,
      whisperPath: settings.transcription?.whisperPath,
      modelsDirectory: settings.transcription?.modelsDirectory?.trim() || path.join(userDataPath, 'models'),
      searchDirs: [path.join(userDataPath, 'bin'), path.join(userDataPath, 'whisper')],
      env: this.config.env ?? process.env,
      platform: this.config.platform ?? process.platform,
    };
  }

  private engineFor(enginePath: string): TranscriptionEngine {
    return this.config.createEngine ? this.config.createEngine(enginePath) : new WhisperCppEngine({ command: enginePath });
  }

  /** Reports which tools and models were found, without running a transcription. */
  async status(): Promise<TranscriptionStatus> {
    const loc = this.locations();
    const ffmpeg = findFfmpeg(loc);
    const engine = findWhisper(loc);
    const models = listModels(loc.modelsDirectory);
    const problems: string[] = [];
    if (!ffmpeg) problems.push('FFmpeg was not found. Set its path in Settings or add it to PATH.');
    if (!engine) problems.push('whisper.cpp (whisper-cli) was not found.');
    if (models.length === 0) problems.push(`No Whisper model found in ${loc.modelsDirectory}.`);
    let defaultModel: string | undefined;
    try {
      defaultModel = models.length ? resolveModel(models, undefined, loc.settings.transcription?.model).name : undefined;
    } catch {
      defaultModel = undefined;
    }
    return {
      ffmpeg: { available: Boolean(ffmpeg), path: ffmpeg, version: ffmpeg ? await ffmpegVersion(ffmpeg) : undefined },
      engine: { available: Boolean(engine), path: engine, version: engine ? await this.engineFor(engine).version() : undefined },
      models,
      modelsDirectory: loc.modelsDirectory,
      defaultModel,
      ready: problems.length === 0,
      problems,
    };
  }

  /** Queues a transcription. Jobs run one at a time because each already uses several CPU cores. */
  transcribe(request: TranscriptionRequest, handlers: JobHandlers): Promise<JobResult> {
    const { jobId } = handlers;
    if (this.jobs.has(jobId)) return Promise.reject(new TranscriptionError('INVALID_REQUEST', `Job ${jobId} is already running.`));
    const controller = new AbortController();
    this.jobs.set(jobId, controller);

    let last: { stage: TranscriptionStage; progress: number } | null = null;
    const report = (stage: TranscriptionStage, progress: number, message: string) => {
      const value = Math.max(0, Math.min(1, progress));
      // Throttle: only stage changes and ≥0.5 % steps reach the UI.
      if (last && last.stage === stage && value - last.progress < 0.005 && value < 1) return;
      last = { stage, progress: value };
      handlers.onProgress?.({ jobId, stage, progress: value, message });
    };

    report('queued', 0, 'Queued');
    let started = false;
    const run = new Promise<JobResult>((resolve, reject) => {
      // A queued job that's cancelled settles at once instead of waiting for its turn.
      controller.signal.addEventListener('abort', () => {
        if (!started) reject(new TranscriptionError('CANCELLED', 'Transcription was cancelled.'));
      });
      this.queue = this.queue.then(() => {
        started = true;
        if (controller.signal.aborted) return;
        return this.runJob(request, controller.signal, report).then(resolve, reject);
      });
    });
    const tracked = run.finally(() => this.jobs.delete(jobId));
    const done = tracked.then(
      () => undefined,
      () => undefined
    );
    this.settled.add(done);
    void done.then(() => this.settled.delete(done));
    return tracked;
  }

  cancel(jobId: string): boolean {
    const controller = this.jobs.get(jobId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  get hasActiveJobs(): boolean {
    return this.jobs.size > 0;
  }

  /** Cancels every job and resolves once they have stopped and cleaned up their temp folders. */
  cancelAll(): Promise<void> {
    for (const controller of this.jobs.values()) controller.abort();
    return Promise.all([...this.settled]).then(() => undefined);
  }

  /** Cached transcript for unchanged media and engine settings, if any. Never runs the engine. */
  getCached(request: TranscriptionRequest): Transcript | null {
    const media = this.validateMedia(request);
    const prepared = this.prepare(request, media);
    const cached = this.cache.get(prepared.key);
    return cached ? this.fromCache(cached, media, request.options) : null;
  }

  clearCache(): number {
    return this.cache.clear();
  }

  // --- internals ---------------------------------------------------------------------------------

  private validateMedia(request: TranscriptionRequest): string {
    const mediaPath = request?.mediaPath;
    if (typeof mediaPath !== 'string' || !mediaPath.trim()) throw new TranscriptionError('INVALID_REQUEST', 'No media file was given.');
    if (!path.isAbsolute(mediaPath)) throw new TranscriptionError('INVALID_REQUEST', 'The media path must be absolute.');
    const ext = path.extname(mediaPath).toLowerCase();
    if (!(TRANSCRIBABLE_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new TranscriptionError('UNSUPPORTED_FORMAT', `${ext || 'This file type'} isn't supported. Use ${TRANSCRIBABLE_EXTENSIONS.join(', ')}.`);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(mediaPath);
    } catch {
      throw new TranscriptionError('FILE_NOT_FOUND', `Media file not found: ${mediaPath}`);
    }
    if (!stat.isFile()) throw new TranscriptionError('FILE_NOT_FOUND', `Not a file: ${mediaPath}`);
    if (stat.size === 0) throw new TranscriptionError('UNSUPPORTED_FORMAT', 'The media file is empty.');
    return mediaPath;
  }

  private prepare(request: TranscriptionRequest, mediaPath: string) {
    const loc = this.locations();
    const options = request.options ?? {};
    const configured = loc.settings.transcription ?? {};
    const ffmpeg = findFfmpeg(loc);
    if (!ffmpeg) throw new TranscriptionError('FFMPEG_NOT_FOUND', 'FFmpeg was not found. Set its path in Settings or add it to PATH.');
    const enginePath = findWhisper(loc);
    if (!enginePath) {
      throw new TranscriptionError('ENGINE_NOT_FOUND', 'whisper.cpp (whisper-cli) was not found. See docs/TRANSCRIPTION.md for setup.');
    }
    const model = resolveModel(listModels(loc.modelsDirectory), options.model, configured.model);
    const language = (options.language || configured.language || 'auto').trim().toLowerCase();
    if (!/^(auto|[a-z]{2,3}(-[a-z]+)?)$/.test(language)) throw new TranscriptionError('INVALID_REQUEST', `Invalid language "${language}".`);
    const audioTrack = Math.max(0, Math.floor(options.audioTrack ?? 0));
    const dtwAlignment = options.dtwAlignment === true;

    const media = fingerprintFile(mediaPath);
    const engineStat = fs.statSync(enginePath);
    const modelStat = fs.statSync(model.path);
    const key = cacheKey({
      schema: TRANSCRIPT_SCHEMA_VERSION,
      media: media.fingerprint,
      engine: `${path.basename(enginePath)}:${engineStat.size}:${Math.floor(engineStat.mtimeMs)}`,
      model: `${model.file}:${modelStat.size}:${Math.floor(modelStat.mtimeMs)}`,
      language,
      audioTrack,
      dtwAlignment,
      // Bumped when word/sentence timing changes, so older cached transcripts are made again
      // (2: sentence starts pinned to segment boundaries are refined from the audio).
      timing: TIMING_VERSION,
    });
    return {
      key,
      ffmpeg,
      enginePath,
      model,
      language,
      audioTrack,
      dtwAlignment,
      media,
      device: options.device ?? configured.device ?? 'auto',
      threads: options.threads && options.threads > 0 ? Math.floor(options.threads) : defaultThreads(),
    };
  }

  /** Re-applies the caller's grouping to a cached transcript and points it at the current path. */
  private fromCache(cached: Transcript, mediaPath: string, options: TranscriptionOptions | undefined): Transcript {
    return {
      ...cached,
      media: { ...cached.media, path: mediaPath, name: path.basename(mediaPath) },
      sentences: groupWordsIntoSentences(flattenWords(cached.sentences), options?.grouping),
    };
  }

  private async runJob(
    request: TranscriptionRequest,
    signal: AbortSignal,
    report: (stage: TranscriptionStage, progress: number, message: string) => void
  ): Promise<JobResult> {
    const checkCancelled = () => {
      if (signal.aborted) throw new TranscriptionError('CANCELLED', 'Transcription was cancelled.');
    };
    checkCancelled();
    report('preparing', 0.01, 'Checking media and tools');
    const mediaPath = this.validateMedia(request);
    const job = this.prepare(request, mediaPath);

    if (!request.options?.force) {
      const cached = this.cache.get(job.key);
      if (cached) {
        report('cache-hit', 1, 'Loaded the saved transcript (media unchanged)');
        report('done', 1, 'Transcript ready');
        return { transcript: this.fromCache(cached, mediaPath, request.options), fromCache: true };
      }
    }

    const workDir = fs.mkdtempSync(path.join(this.config.tempDir ?? os.tmpdir(), 'edissistant-transcribe-'));
    try {
      const audioPath = path.join(workDir, 'audio.wav');
      const lerp = ([a, b]: [number, number], f: number) => a + (b - a) * f;

      report('extracting-audio', EXTRACT_SPAN[0], 'Extracting audio with FFmpeg');
      const { duration } = await extractAudio(job.ffmpeg, mediaPath, audioPath, {
        audioTrack: job.audioTrack,
        signal,
        onProgress: (f) => report('extracting-audio', lerp(EXTRACT_SPAN, f), 'Extracting audio with FFmpeg'),
      });
      checkCancelled();

      report('transcribing', TRANSCRIBE_SPAN[0], `Transcribing with ${job.model.name}`);
      const engine = this.engineFor(job.enginePath);
      const output = await engine.transcribe(
        {
          audioPath,
          workDir,
          modelPath: job.model.path,
          modelName: job.model.name,
          language: job.language,
          device: job.device,
          threads: job.threads,
          dtwAlignment: job.dtwAlignment,
        },
        { signal, onProgress: (f) => report('transcribing', lerp(TRANSCRIBE_SPAN, f), `Transcribing with ${job.model.name}`) }
      );
      checkCancelled();

      report('grouping', 0.98, 'Building sentences');
      const mediaDuration = duration || output.end;
      const warnings = [...output.warnings];
      const anchored = output.anchoredStarts ?? [];
      let onsets = { words: output.words, refined: 0, unchecked: anchored.length };
      if (anchored.length) {
        try {
          const { samples, rate } = readWav16(audioPath);
          onsets = refineAnchoredStarts(output.words, anchored, energyEnvelope(samples, rate));
        } catch {
          // Unreadable audio: keep the engine's times and say so below.
        }
      }
      if (onsets.unchecked > 0) {
        warnings.push(`${onsets.unchecked} sentence start(s) couldn't be checked against the audio and may be early.`);
      }
      const words = normalizeWords(onsets.words, mediaDuration);
      if (words.length === 0) warnings.push('No speech was detected.');
      if (output.wordTiming === 'interpolated') warnings.push('The engine gave no word timing; word times are estimated.');

      const stat = fs.statSync(mediaPath);
      const transcript: Transcript = {
        schema: TRANSCRIPT_SCHEMA,
        version: TRANSCRIPT_SCHEMA_VERSION,
        id: job.key,
        language: output.language,
        duration: roundTime(mediaDuration),
        media: {
          path: mediaPath,
          name: path.basename(mediaPath),
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          fingerprint: job.media.fingerprint,
        },
        engine: {
          name: engine.name,
          version: await engine.version(),
          model: job.model.name,
          device: output.device,
          ...(output.gpuBackend ? { gpuBackend: output.gpuBackend } : {}),
          cpuFallback: output.cpuFallback,
          threads: job.threads,
        },
        wordTiming: output.wordTiming,
        timing: { source: output.timingSource ?? (output.wordTiming === 'word' ? 'tokens' : 'interpolated'), refinedStarts: onsets.refined, uncheckedStarts: onsets.unchecked },
        // The cache keeps default grouping; callers' grouping is applied on top.
        sentences: groupWordsIntoSentences(words),
        createdAt: new Date().toISOString(),
        warnings,
      };
      try {
        this.cache.set(transcript);
      } catch {
        transcript.warnings.push('The transcript could not be cached.');
      }
      report('done', 1, 'Transcript ready');
      const grouped = request.options?.grouping ? groupWordsIntoSentences(words, request.options.grouping) : transcript.sentences;
      return { transcript: { ...transcript, sentences: grouped }, fromCache: false };
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}
