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
import { analyzeSpeech, readWav16, refineAnchoredStarts, untranscribedSpeech, wavBytes, type OnsetResult, type SpeechAnalysis } from './onsets';
import { extractAudio, ffmpegVersion } from './ffmpeg';
import { findFfmpeg, findWhisper, listModels, resolveModel, type ToolLocations } from './tools';
import { WhisperCppEngine, type EngineInput, type EngineOutput, type TranscriptionEngine } from './whisperCpp';

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
export const TIMING_VERSION = 3;

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
    // The request decides; otherwise the advanced setting (off by default).
    const dtwAlignment = (options.dtwAlignment ?? configured.dtwAlignment) === true;

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
      // (2: sentence starts pinned to segment boundaries are refined from the audio; 3: speech-band
      // onsets with uncertainty flags, and dropped speech detected and transcribed again).
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

  /**
   * Refines sentence starts from the audio and checks that every stretch of speech has text
   * (Windows validation round 2: whisper.cpp 1.9.5 with small.en and -nfa silently dropped the
   * last 8 s of a 40 s clip). Recovery, in order, never silent:
   *   1. A DTW run that left speech without text is redone without DTW; the plain run is kept only
   *      if it covers more speech, with a warning that says so.
   *   2. Speech that still has no text is transcribed again from just that audio (up to 5 spans,
   *      without DTW) and the words are added where nothing overlaps them.
   *   3. Whatever is still missing is listed in `coverage.gaps`, with a warning.
   */
  private async checkAndRecover(
    first: EngineOutput,
    input: EngineInput,
    engine: TranscriptionEngine,
    workDir: string,
    signal: AbortSignal,
    report: (stage: TranscriptionStage, progress: number, message: string) => void
  ): Promise<{ output: EngineOutput; onsets: OnsetResult; warnings: string[]; coverage?: Transcript['coverage']; dtwFallback?: { reason: 'truncated'; dtwEnd: number } }> {
    let audio: { samples: Int16Array; rate: number } | null = null;
    let analysis: SpeechAnalysis | null = null;
    try {
      audio = readWav16(input.audioPath);
      analysis = analyzeSpeech(audio.samples, audio.rate);
    } catch {
      // Unreadable audio: keep the engine's times and say so below.
    }
    const refine = (o: EngineOutput, a: SpeechAnalysis | null): OnsetResult => {
      const anchored = o.anchoredStarts ?? [];
      if (anchored.length && a) return refineAnchoredStarts(o.words, anchored, a);
      const flagged = new Set(anchored.map((x) => x.index));
      const words = o.words.map((w, i) => (flagged.has(i) ? { ...w, startUncertain: true } : { ...w }));
      return { words, refined: 0, unchecked: anchored.length, confirmed: 0, uncertain: 0, checks: [] };
    };
    const spans = (gaps: { start: number; end: number }[]) => gaps.map((g) => `${g.start.toFixed(1)}–${g.end.toFixed(1)} s`).join(', ');
    const total = (gaps: { start: number; end: number }[]) => gaps.reduce((n, g) => n + g.end - g.start, 0);
    const pass = (dir: string, overrides: Partial<EngineInput>) => {
      fs.mkdirSync(dir, { recursive: true });
      return engine.transcribe({ ...input, workDir: dir, ...overrides }, { signal });
    };
    const cancelled = (e: unknown) => signal.aborted || (e instanceof TranscriptionError && e.code === 'CANCELLED');

    const warnings: string[] = [];
    let output = first;
    let onsets = refine(first, analysis);
    if (!analysis || !audio) {
      warnings.push('The audio couldn’t be read back, so sentence starts and missing speech weren’t checked.');
      return { output, onsets, warnings };
    }
    let gaps = untranscribedSpeech(analysis, onsets.words);
    let dtwFallback: { reason: 'truncated'; dtwEnd: number } | undefined;

    if (gaps.length && input.dtwAlignment) {
      report('transcribing', 0.97, 'Some speech has no text with DTW alignment; transcribing again without it');
      try {
        // Same work folder: the engine reads the audio from there (the first pass's output is parsed).
        const plain = await pass(workDir, { dtwAlignment: false });
        const plainOnsets = refine(plain, analysis);
        const plainGaps = untranscribedSpeech(analysis, plainOnsets.words);
        if (total(plainGaps) < total(gaps) - 0.5) {
          const dtwEnd = roundTime(Math.max(0, ...first.words.map((w) => w.end)));
          warnings.push(
            `With DTW alignment, ${input.modelName} returned no text for speech at ${spans(gaps)} (a known whisper.cpp problem with some models when flash attention is off). ` +
              'This transcript was made without DTW so no dialogue is lost; sentence starts are checked against the audio instead.'
          );
          dtwFallback = { reason: 'truncated', dtwEnd };
          output = plain;
          onsets = plainOnsets;
          gaps = plainGaps;
        }
      } catch (error) {
        if (cancelled(error)) throw error;
      }
    }

    const recovered: { start: number; end: number }[] = [];
    if (gaps.length) {
      const { samples, rate } = audio;
      const audioEnd = samples.length / rate;
      for (const [n, gap] of gaps.slice(0, 5).entries()) {
        if (signal.aborted) throw new TranscriptionError('CANCELLED', 'Transcription was cancelled.');
        report('transcribing', 0.97, `Transcribing speech the engine skipped (${gap.start.toFixed(1)}–${gap.end.toFixed(1)} s)`);
        const from = Math.max(0, gap.start - 0.5);
        const to = Math.min(audioEnd, gap.end + 0.5);
        const part = samples.slice(Math.floor(from * rate), Math.ceil(to * rate));
        const dir = path.join(workDir, `part-${n}`);
        fs.mkdirSync(dir, { recursive: true });
        const partPath = path.join(dir, 'audio.wav');
        fs.writeFileSync(partPath, wavBytes(part, rate));
        let partOutput: EngineOutput;
        try {
          partOutput = await pass(dir, { audioPath: partPath, dtwAlignment: false });
        } catch (error) {
          if (cancelled(error)) throw error;
          continue;
        }
        const partOnsets = refine(partOutput, analyzeSpeech(part, rate));
        const overlaps = (w: { start: number; end: number }) => onsets.words.some((x) => x.start < w.end - 0.02 && x.end > w.start + 0.02);
        const added = partOnsets.words
          .map((w) => ({ ...w, start: roundTime(w.start + from), end: roundTime(w.end + from) }))
          .filter((w) => w.end > gap.start - 0.3 && w.start < gap.end + 0.3 && !overlaps(w));
        if (!added.length) continue;
        onsets = {
          ...onsets,
          words: [...onsets.words, ...added].sort((a, b) => a.start - b.start),
          refined: onsets.refined + partOnsets.refined,
          unchecked: onsets.unchecked + partOnsets.unchecked,
          confirmed: onsets.confirmed + partOnsets.confirmed,
          uncertain: onsets.uncertain + partOnsets.uncertain,
        };
        recovered.push(gap);
      }
      gaps = untranscribedSpeech(analysis, onsets.words);
      if (recovered.length) warnings.push(`The engine skipped speech at ${spans(recovered)}; it was transcribed in a second pass over just that audio. Check those lines.`);
      if (gaps.length) warnings.push(`Speech at ${spans(gaps)} has no text in the transcript: the engine returned nothing there, even on a second pass. Check it, or try another model.`);
    }

    const doubtful = onsets.unchecked + onsets.uncertain;
    if (doubtful > 0) {
      warnings.push(
        `${doubtful} sentence start(s) couldn’t be verified against the audio (music or noise under the speech, overlapping voices, or no clear pause). ` +
          'Graphics there may start early or late; those sentences are marked in the transcript.'
      );
    }
    return { output, onsets, warnings, coverage: { complete: gaps.length === 0, gaps, recovered }, ...(dtwFallback ? { dtwFallback } : {}) };
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
      const engineInput: EngineInput = {
        audioPath,
        workDir,
        modelPath: job.model.path,
        modelName: job.model.name,
        language: job.language,
        device: job.device,
        threads: job.threads,
        dtwAlignment: job.dtwAlignment,
      };
      const output = await engine.transcribe(engineInput, {
        signal,
        onProgress: (f) => report('transcribing', lerp(TRANSCRIBE_SPAN, f), `Transcribing with ${job.model.name}`),
      });
      checkCancelled();

      const mediaDuration = duration || output.end;
      const checked = await this.checkAndRecover(output, engineInput, engine, workDir, signal, report);
      const warnings = [...checked.output.warnings, ...checked.warnings];
      const { onsets } = checked;
      report('grouping', 0.98, 'Building sentences');
      const words = normalizeWords(onsets.words, mediaDuration);
      if (words.length === 0) warnings.push('No speech was detected.');
      if (output.wordTiming === 'interpolated') warnings.push('The engine gave no word timing; word times are estimated.');

      const stat = fs.statSync(mediaPath);
      const transcript: Transcript = {
        schema: TRANSCRIPT_SCHEMA,
        version: TRANSCRIPT_SCHEMA_VERSION,
        id: job.key,
        language: checked.output.language,
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
          device: checked.output.device,
          ...(checked.output.gpuBackend ? { gpuBackend: checked.output.gpuBackend } : {}),
          cpuFallback: checked.output.cpuFallback,
          threads: job.threads,
        },
        wordTiming: checked.output.wordTiming,
        timing: {
          source: checked.output.timingSource ?? (checked.output.wordTiming === 'word' ? 'tokens' : 'interpolated'),
          refinedStarts: onsets.refined,
          uncheckedStarts: onsets.unchecked,
          confirmedStarts: onsets.confirmed,
          uncertainStarts: onsets.uncertain,
          ...(checked.dtwFallback ? { dtwFallback: checked.dtwFallback } : {}),
        },
        ...(checked.coverage ? { coverage: checked.coverage } : {}),
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
