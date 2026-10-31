import * as fs from 'fs';
import * as path from 'path';
import type { RenderProgress, RenderStage, RenderStatus, SegmentRenderOptions, SegmentRenderResult, SequenceRenderOptions, SequenceRenderResult } from '../../shared/animation/api';
import { cancelled, RenderError } from '../../shared/animation/errors';
import { defaultFormat, EXPORT_FORMATS, formatAllowedForMode, type RenderQuality } from '../../shared/animation/formats';
import { stableStringify } from '../../shared/animation/random';
import { renderIdentity, RENDER_ENGINE_VERSION } from '../../shared/animation/sequence';
import { frameCount, segmentFrames } from '../../shared/animation/timeline';
import type { AnimationSpec, ExportFormatId, SequenceSpec } from '../../shared/animation/types';
import { validateAnimationSpec, validateSequence } from '../../shared/animation/validate';
import { loadAssets } from './assets';
import { RenderCache, sha256 } from './cache';
import { composePreview } from './compose';
import { encodeFrames } from './encoder';
import type { FrameSourceFactory } from './frameSource';
import { selectH264Encoder, type GpuPreference } from './gpu';
import { validateOutput } from './probe';
import { ffmpegVersion, listEncoders, type Tools } from './tools';

export interface RenderServiceConfig {
  cacheDir: string;
  /** Resolves FFmpeg/FFprobe on every job, so settings changes apply without a restart. */
  findTools: () => Partial<Tools>;
  createFrameSource: FrameSourceFactory;
  /** Hardware H.264 for previews: 'auto' uses a validated GPU encoder when present. Default 'auto'. */
  gpu?: () => GpuPreference;
  platform?: NodeJS.Platform;
  /** Least-recently-used renders are removed above this size. Default 50 GB. */
  maxCacheBytes?: number;
}

export interface JobHandlers {
  jobId: string;
  signal?: AbortSignal;
  onProgress?: (progress: RenderProgress) => void;
}

const ENCODER_FOR: Record<ExportFormatId, string> = {
  'prores-4444': 'prores_ks',
  'prores-422hq': 'prores_ks',
  qtrle: 'qtrle',
  'png-mov': 'png',
  'vp9-webm': 'libvpx-vp9',
  'h264-mp4': 'libx264',
};

type Report = (stage: RenderStage, progress: number, message: string, extra?: Partial<RenderProgress>) => void;

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * Runs an H.264 encode. A hardware encoder can pass its startup probe and still fail on a real render
 * (NVENC is limited to 4096 px wide; sessions can be taken by other apps), so a failure is retried once
 * on the CPU with libx264.
 */
export async function h264WithCpuFallback(encoder: string, signal: AbortSignal | undefined, run: (encoder: string) => Promise<unknown>): Promise<{ encoder: string; warnings: string[] }> {
  try {
    await run(encoder);
    return { encoder, warnings: [] };
  } catch (error) {
    const encodeFailure = error instanceof RenderError && (error.code === 'ENCODE_FAILED' || error.code === 'COMPOSE_FAILED');
    if (encoder === 'libx264' || signal?.aborted || !encodeFailure) throw error;
    await run('libx264');
    return { encoder: 'libx264', warnings: [`${encoder} could not encode this render, so it was encoded on the CPU (libx264).`] };
  }
}

function invalid(issues: { path: string; message: string }[]): RenderError {
  const first = issues[0];
  return new RenderError('INVALID_SPEC', `The animation spec is invalid: ${first.path} ${first.message}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ''}.`, { issues });
}

export class RenderService {
  readonly cache: RenderCache;
  private queue: Promise<unknown> = Promise.resolve();
  private encoders = new Map<string, Promise<Set<string>>>();

  constructor(private readonly config: RenderServiceConfig) {
    this.cache = new RenderCache(config.cacheDir);
    // Scratch folders from renders interrupted by a crash or power loss.
    this.cache.cleanupStale();
  }

  private tools(): Tools {
    const found = this.config.findTools();
    if (!found.ffmpeg) throw new RenderError('FFMPEG_NOT_FOUND', 'FFmpeg was not found. Set its path in Settings or add it to PATH.');
    if (!found.ffprobe) throw new RenderError('FFMPEG_NOT_FOUND', 'FFprobe was not found next to FFmpeg or on PATH. It is needed to validate renders.');
    return found as Tools;
  }

  private encoderSet(ffmpeg: string): Promise<Set<string>> {
    let set = this.encoders.get(ffmpeg);
    if (!set) {
      set = listEncoders(ffmpeg).catch(() => new Set<string>());
      this.encoders.set(ffmpeg, set);
    }
    return set;
  }

  async status(): Promise<RenderStatus> {
    const found = this.config.findTools();
    const problems: string[] = [];
    if (!found.ffmpeg) problems.push('FFmpeg was not found. Set its path in Settings or add it to PATH.');
    if (!found.ffprobe) problems.push('FFprobe was not found next to FFmpeg or on PATH.');
    const encoders = found.ffmpeg ? await this.encoderSet(found.ffmpeg) : new Set<string>();
    const formats = (Object.keys(ENCODER_FOR) as ExportFormatId[]).filter((f) => encoders.has(ENCODER_FOR[f]));
    if (found.ffmpeg && !formats.includes('prores-4444')) problems.push('This FFmpeg build has no ProRes encoder (prores_ks).');
    const hw = found.ffmpeg ? await selectH264Encoder(found.ffmpeg, this.config.gpu?.() ?? 'auto', this.config.platform) : 'libx264';
    return {
      ffmpeg: { available: Boolean(found.ffmpeg), path: found.ffmpeg, version: found.ffmpeg ? await ffmpegVersion(found.ffmpeg) : undefined },
      ffprobe: { available: Boolean(found.ffprobe), path: found.ffprobe },
      formats,
      hardwareH264: hw === 'libx264' ? null : hw,
      cacheDirectory: this.cache.root,
      problems,
    };
  }

  /** Runs jobs one at a time; a queued job that is cancelled settles immediately. */
  private enqueue<T>(handlers: JobHandlers, run: (report: Report) => Promise<T>): Promise<T> {
    let last = { stage: '' as string, progress: -1 };
    const report: Report = (stage, progress, message, extra = {}) => {
      const value = Math.max(0, Math.min(1, progress));
      // Throttle: stage changes and ≥0.5 % steps only.
      if (last.stage === stage && value - last.progress < 0.005 && value < 1) return;
      last = { stage, progress: value };
      handlers.onProgress?.({ jobId: handlers.jobId, stage, progress: value, message, ...extra });
    };
    report('queued', 0, 'Queued');
    let started = false;
    return new Promise<T>((resolve, reject) => {
      handlers.signal?.addEventListener('abort', () => !started && reject(cancelled()), { once: true });
      this.queue = this.queue.then(async () => {
        started = true;
        if (handlers.signal?.aborted) return reject(cancelled());
        await run(report).then(resolve, reject);
      });
    });
  }

  renderSegment(input: unknown, options: SegmentRenderOptions, handlers: JobHandlers): Promise<SegmentRenderResult> {
    return this.enqueue(handlers, async (report) => {
      report('validating', 0.01, 'Validating the animation spec');
      const result = await this.renderOne(input, options, handlers.signal, report, [0, 1]);
      report('done', 1, 'Render ready');
      return result;
    });
  }

  renderSequence(input: unknown, options: SequenceRenderOptions, handlers: JobHandlers): Promise<SequenceRenderResult> {
    return this.enqueue(handlers, async (report) => {
      report('validating', 0.01, 'Validating the sequence');
      const checked = validateSequence(input);
      if (!checked.ok) throw invalid(checked.issues);
      const sequence = checked.sequence;
      if (options.baseVideo && !fs.existsSync(options.baseVideo)) throw new RenderError('MEDIA_NOT_FOUND', `Base video not found: ${options.baseVideo}`);

      const compose = options.compose !== false;
      const totalFrames = sequence.segments.reduce((n, s) => n + segmentFrames(s.start, s.duration, s.fps).count, 0) || 1;
      const renderShare = compose ? 0.85 : 1;
      const segments: SegmentRenderResult[] = [];
      let done = 0;
      for (const spec of sequence.segments) {
        if (handlers.signal?.aborted) throw cancelled();
        const weight = segmentFrames(spec.start, spec.duration, spec.fps).count / totalFrames;
        const span: [number, number] = [done * renderShare, (done + weight) * renderShare];
        segments.push(await this.renderOne(spec, options, handlers.signal, report, span));
        done += weight;
      }
      const result: SequenceRenderResult = {
        sequenceId: sequence.id,
        segments,
        rendered: segments.filter((s) => !s.fromCache).map((s) => s.segmentId),
        reused: segments.filter((s) => s.fromCache).map((s) => s.segmentId),
      };
      if (compose) result.preview = await this.compose(sequence, segments, options, handlers.signal, report);
      report('done', 1, 'Sequence ready');
      return result;
    });
  }

  private async renderOne(input: unknown, options: SegmentRenderOptions, signal: AbortSignal | undefined, report: Report, span: [number, number]): Promise<SegmentRenderResult> {
    const at = (f: number) => span[0] + (span[1] - span[0]) * f;
    const checked = validateAnimationSpec(input);
    if (!checked.ok) throw invalid(checked.issues);
    const spec: AnimationSpec = checked.spec;
    const quality: RenderQuality = options.quality ?? 'final';
    const format = options.format ?? defaultFormat(spec.exportMode, quality);
    if (!EXPORT_FORMATS[format]) throw new RenderError('INVALID_REQUEST', `Unknown format "${String(format)}".`);
    if (!formatAllowedForMode(format, spec.exportMode)) {
      throw new RenderError('INVALID_REQUEST', `${EXPORT_FORMATS[format].label} has no alpha channel; ${spec.exportMode} needs a transparent format.`);
    }
    const scale = options.scale ?? (quality === 'preview' ? 0.5 : 1);
    if (!(scale >= 0.1 && scale <= 1)) throw new RenderError('INVALID_REQUEST', 'scale must be between 0.1 and 1.');
    const width = even(spec.width * scale);
    const height = even(spec.height * scale);

    const tools = this.tools();
    const encoders = await this.encoderSet(tools.ffmpeg);
    if (encoders.size > 0 && !encoders.has(ENCODER_FOR[format])) {
      throw new RenderError('FORMAT_NOT_SUPPORTED', `This FFmpeg build has no ${ENCODER_FOR[format]} encoder for ${EXPORT_FORMATS[format].label}.`);
    }
    report('loading', at(0.02), `Loading assets for ${spec.id}`, { segmentId: spec.id });
    const assets = loadAssets(spec);
    const encoder = format === 'h264-mp4' ? await selectH264Encoder(tools.ffmpeg, this.config.gpu?.() ?? 'auto', this.config.platform) : ENCODER_FOR[format];
    const key = sha256(`${renderIdentity(spec, { format, scale }, assets.fingerprints)}|${quality}|${encoder}`);

    if (!options.force) {
      const hit = this.cache.get(key);
      if (hit) {
        report('cache-hit', at(1), `Reusing the render of ${spec.id}`, { segmentId: spec.id });
        return { segmentId: spec.id, key, path: hit.path, format, metadata: hit.manifest.metadata, fromCache: true, encoder: hit.manifest.encoder ?? encoder, warnings: [] };
      }
    }

    // Same frame span as the composition and the exported clip's place in an NLE (see segmentFrames).
    const frames = segmentFrames(spec.start, spec.duration, spec.fps).count;
    const workDir = this.cache.createWorkDir();
    const output = path.join(workDir, `render${EXPORT_FORMATS[format].extension}`);
    const source = this.config.createFrameSource({ spec, width, height, scale: width / spec.width, assets, systemFonts: checked.systemFonts });
    try {
      const { warnings } = await source.open(signal);
      if (signal?.aborted) throw cancelled();
      const encode = (h264Encoder: string) =>
        encodeFrames(tools.ffmpeg, { format, width, height, fps: spec.fps, h264Encoder, preview: quality === 'preview' }, output, frames, (i) => source.frame(i), {
          signal,
          onFrame: (n) => report('rendering', at(0.05 + 0.9 * (n / frames)), `Rendering ${spec.id}: frame ${n}/${frames}`, { segmentId: spec.id, frame: n, totalFrames: frames }),
        });
      const used = format === 'h264-mp4' ? await h264WithCpuFallback(encoder, signal, encode) : (await encode(encoder), { encoder, warnings: [] });
      report('validating-output', at(0.97), `Checking ${spec.id}`, { segmentId: spec.id });
      const metadata = await validateOutput(tools.ffprobe, output, { format, width, height, fps: spec.fps, frames });
      const entry = this.cache.put(key, output, { segmentId: spec.id, format, scale, metadata, encoder: used.encoder });
      this.cache.prune(this.config.maxCacheBytes ?? 50 * 1024 ** 3);
      return { segmentId: spec.id, key, path: entry.path, format, metadata, fromCache: false, encoder: used.encoder, warnings: [...checked.warnings.map((w) => `${w.path}: ${w.message}`), ...warnings, ...used.warnings] };
    } finally {
      await source.close().catch(() => undefined);
      this.cache.discard(workDir);
    }
  }

  private async compose(sequence: SequenceSpec, segments: SegmentRenderResult[], options: SequenceRenderOptions, signal: AbortSignal | undefined, report: Report) {
    const tools = this.tools();
    const width = segments[0]?.metadata.width ?? even(sequence.width * (options.scale ?? (options.quality === 'preview' ? 0.5 : 1)));
    const height = segments[0]?.metadata.height ?? even(sequence.height * (options.scale ?? (options.quality === 'preview' ? 0.5 : 1)));
    const encoder = await selectH264Encoder(tools.ffmpeg, this.config.gpu?.() ?? 'auto', this.config.platform);
    let base: string | null = null;
    if (options.baseVideo) {
      const stat = fs.statSync(options.baseVideo);
      base = `${path.resolve(options.baseVideo)}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
    }
    const clips = sequence.segments.map((spec, i) => ({ path: segments[i].path, start: spec.start, duration: spec.duration, codec: segments[i].metadata.codec }));
    const key = sha256(
      stableStringify({
        kind: 'preview',
        engine: RENDER_ENGINE_VERSION,
        width,
        height,
        fps: sequence.fps,
        duration: sequence.duration,
        clips: sequence.segments.map((spec, i) => [segments[i].key, spec.start]),
        base,
        encoder,
      })
    );
    const hit = options.force ? null : this.cache.get(key);
    if (hit) {
      report('cache-hit', 1, 'Reusing the preview (nothing changed)');
      return { path: hit.path, metadata: hit.manifest.metadata, fromCache: true };
    }
    const workDir = this.cache.createWorkDir();
    const output = path.join(workDir, 'preview.mp4');
    try {
      report('composing', 0.86, 'Composing the preview');
      const used = await h264WithCpuFallback(encoder, signal, (h264Encoder) =>
        composePreview(
          tools.ffmpeg,
          { width, height, fps: sequence.fps, duration: sequence.duration, clips, baseVideo: options.baseVideo, output, h264Encoder },
          { signal, onProgress: (f) => report('composing', 0.86 + 0.12 * f, 'Composing the preview') }
        )
      );
      const metadata = await validateOutput(tools.ffprobe, output, { format: 'h264-mp4', width, height, fps: sequence.fps, frames: frameCount(sequence.duration, sequence.fps) });
      const entry = this.cache.put(key, output, { segmentId: `${sequence.id}:preview`, format: 'h264-mp4', scale: width / sequence.width, metadata, encoder: used.encoder });
      return { path: entry.path, metadata, fromCache: false };
    } finally {
      this.cache.discard(workDir);
    }
  }
}
