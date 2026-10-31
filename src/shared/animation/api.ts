// IPC contract between the app renderer and the main-process render service.
import type { RenderErrorInfo } from './errors';
import type { RenderQuality } from './formats';
import type { ExportFormatId } from './types';

export interface RenderOutputMetadata {
  codec: string;
  width: number;
  height: number;
  pixFmt: string;
  frameRate: string;
  frames: number;
  duration: number;
  hasAlpha: boolean;
  sizeBytes: number;
}

export interface SegmentRenderOptions {
  /** Default depends on the export mode and quality (see defaultFormat). */
  format?: ExportFormatId;
  /** 'preview' renders at half resolution (or `scale`) with fast settings. Default 'final'. */
  quality?: RenderQuality;
  /** Output scale override, 0.1–1. */
  scale?: number;
  /** Ignore the cache and render again. */
  force?: boolean;
}

export interface SegmentRenderResult {
  segmentId: string;
  /** Content hash: identical visuals share one render. */
  key: string;
  path: string;
  format: ExportFormatId;
  metadata: RenderOutputMetadata;
  fromCache: boolean;
  /** Encoder used, e.g. prores_ks, libx264, h264_nvenc. */
  encoder: string;
  warnings: string[];
}

export interface SequenceRenderOptions extends SegmentRenderOptions {
  /** Build the full-timeline preview after rendering segments. Default true. */
  compose?: boolean;
  /** Footage to lay the graphics over in the preview. */
  baseVideo?: string;
}

export interface SequenceRenderResult {
  sequenceId: string;
  segments: SegmentRenderResult[];
  /** Segment IDs rendered in this run. */
  rendered: string[];
  /** Segment IDs served from the cache. */
  reused: string[];
  preview?: { path: string; metadata: RenderOutputMetadata; fromCache: boolean };
}

export type RenderStage = 'queued' | 'validating' | 'loading' | 'rendering' | 'validating-output' | 'cache-hit' | 'composing' | 'done';

export interface RenderProgress {
  jobId: string;
  stage: RenderStage;
  segmentId?: string;
  frame?: number;
  totalFrames?: number;
  /** Overall job progress 0–1. */
  progress: number;
  message: string;
}

export type RenderResult<T> = { ok: true; result: T } | { ok: false; error: RenderErrorInfo };

export interface RenderStatus {
  ffmpeg: { available: boolean; path?: string; version?: string };
  ffprobe: { available: boolean; path?: string };
  /** Formats whose encoder exists in this FFmpeg build. */
  formats: ExportFormatId[];
  /** Validated hardware H.264 encoder, or null when previews encode on the CPU. */
  hardwareH264: string | null;
  cacheDirectory: string;
  problems: string[];
}

/** Methods the preload bridge adds to window.electronAPI. */
export interface RenderBridgeAPI {
  getRenderStatus: () => Promise<RenderStatus>;
  renderSegment: (jobId: string, spec: unknown, options?: SegmentRenderOptions) => Promise<RenderResult<SegmentRenderResult>>;
  renderSequence: (jobId: string, sequence: unknown, options?: SequenceRenderOptions) => Promise<RenderResult<SequenceRenderResult>>;
  cancelRender: (jobId: string) => Promise<boolean>;
  onRenderProgress: (callback: (progress: RenderProgress) => void) => () => void;
  /** Copies a cached render to a folder (e.g. the project's export destination). */
  exportRender: (sourcePath: string, destinationDir: string, fileName: string) => Promise<RenderResult<string>>;
  clearRenderCache: () => Promise<number>;
}
