// Shared transcription contract. Pure types only: imported by the main process (engine) and the renderer
// (sequence editor), so nothing here may depend on Node or the DOM.

export const TRANSCRIPT_SCHEMA = 'edissistant.transcript';
export const TRANSCRIPT_SCHEMA_VERSION = 1;

/** Media containers the transcription engine accepts (audio is extracted locally with FFmpeg). */
export const TRANSCRIBABLE_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.wav', '.mp3', '.m4a', '.aac', '.flac'] as const;

export interface TranscriptWord {
  text: string;
  /** Seconds from the start of the media. */
  start: number;
  end: number;
  /** Mean token probability from the engine, 0–1. Absent for edited or interpolated words. */
  confidence?: number;
  /**
   * Set on the first word of a sentence whose start couldn't be verified against the audio (music
   * or noise under it, an overlapping voice, or no clear onset). Its time may be early or late.
   */
  startUncertain?: boolean;
}

export interface TranscriptSentence {
  id: string;
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
  /** Set once an editor has changed the text or timing by hand. */
  edited?: boolean;
}

export type TranscriptionDevice = 'cpu' | 'gpu' | 'unknown';

/**
 * - `word`: per-word times come from the engine's token timestamps.
 * - `interpolated`: the engine only gave segment times; word times were spread across each segment by length.
 */
export type WordTiming = 'word' | 'interpolated';

export interface TranscriptMedia {
  path: string;
  name: string;
  size: number;
  /** ISO time of the file's last modification when it was transcribed. */
  modifiedAt: string;
  /** Content fingerprint used for caching (see main/transcription/cache.ts). */
  fingerprint: string;
}

export interface TranscriptEngineInfo {
  name: string;
  version?: string;
  model: string;
  /** Where inference actually ran, as reported by the engine's own log. `unknown` when it didn't say. */
  device: TranscriptionDevice;
  /** Backend name reported by the engine when it used a GPU (e.g. "CUDA0", "Vulkan0", "Metal"). */
  gpuBackend?: string;
  /** True when a GPU run failed and the job was retried on the CPU. */
  cpuFallback: boolean;
  threads: number;
}

export interface Transcript {
  schema: typeof TRANSCRIPT_SCHEMA;
  version: typeof TRANSCRIPT_SCHEMA_VERSION;
  /** Cache key: identical media + engine settings produce the same id. */
  id: string;
  /** ISO 639-1 code detected or requested, e.g. "en". */
  language: string;
  /** Media duration in seconds (0 when unknown). */
  duration: number;
  media: TranscriptMedia;
  engine: TranscriptEngineInfo;
  wordTiming: WordTiming;
  /** How word and sentence times were produced (absent in transcripts made before 2026-10-31). */
  timing?: TranscriptTiming;
  /** Absent in transcripts made before 2026-10-31 (round 2). */
  coverage?: TranscriptCoverage;
  sentences: TranscriptSentence[];
  createdAt: string;
  /** Non-fatal issues worth showing to the editor (e.g. GPU fallback). */
  warnings: string[];
}

export interface TranscriptTiming {
  /** DTW alignment, whisper token times, or times spread evenly over the engine's segments. */
  source: 'dtw' | 'tokens' | 'interpolated';
  /** Sentence starts the engine pinned to a segment boundary that were moved to the speech onset in the audio. */
  refinedStarts: number;
  /** Such starts with no clear onset in the audio, left as the engine gave them (may be early). */
  uncheckedStarts: number;
  /** Such starts the audio confirmed where the engine put them. */
  confirmedStarts?: number;
  /**
   * Such starts with weak or ambiguous evidence (music or noise under them, an overlapping voice):
   * moved to the best onset found, or left, and flagged on the word (`startUncertain`).
   */
  uncertainStarts?: number;
  /**
   * Set when a DTW run lost speech (e.g. whisper.cpp small.en with flash attention off stops early)
   * and the transcript was made without DTW instead. `dtwEnd` is where the DTW run's text ended.
   */
  dtwFallback?: { reason: 'truncated'; dtwEnd: number };
}

/** Whether the transcript has text wherever the audio has speech. */
export interface TranscriptCoverage {
  /** False when speech in the audio still has no text after recovery (see `gaps`). */
  complete: boolean;
  /** Spans (seconds) with speech in the audio but no transcribed words. */
  gaps: { start: number; end: number }[];
  /** Spans the engine first skipped and a second pass on just that audio transcribed. */
  recovered: { start: number; end: number }[];
}

export interface SentenceGroupingOptions {
  /** A silence at least this long (seconds) always starts a new sentence. Default 0.8. */
  pauseThreshold?: number;
  /** Sentences longer than this (seconds) are split, preferably at a comma. Default 8. */
  maxDuration?: number;
  /** Sentences with more characters than this are split, preferably at a comma. Default 160. */
  maxChars?: number;
}

export type TranscriptionDevicePreference = 'auto' | 'cpu' | 'gpu';

export interface TranscriptionOptions {
  /** ISO 639-1 code, or 'auto' to detect. Default 'auto'. */
  language?: string;
  /** Model file name or short name (e.g. "small.en" or "ggml-small.en.bin"). Default: best installed model. */
  model?: string;
  /** 'auto' tries the GPU build first and falls back to CPU on failure. Default 'auto'. */
  device?: TranscriptionDevicePreference;
  threads?: number;
  /** Audio stream to transcribe, 0-based (e.g. 1 for the second mic on a dual-track MOV). Default 0. */
  audioTrack?: number;
  /**
   * Use whisper.cpp's DTW token alignment for more precise word timing. Needs a model whose
   * architecture is known (tiny … large-v3-turbo). Default false.
   */
  dtwAlignment?: boolean;
  /** Skip the cache lookup and always re-transcribe (the result still replaces the cache entry). */
  force?: boolean;
  grouping?: SentenceGroupingOptions;
}

export interface TranscriptionRequest {
  mediaPath: string;
  options?: TranscriptionOptions;
}

export type TranscriptionStage =
  | 'queued'
  | 'preparing'
  | 'cache-hit'
  | 'extracting-audio'
  | 'transcribing'
  | 'grouping'
  | 'done';

export interface TranscriptionProgress {
  jobId: string;
  stage: TranscriptionStage;
  /** Overall job progress, 0–1. */
  progress: number;
  message: string;
}

export type TranscriptionErrorCode =
  | 'INVALID_REQUEST'
  | 'FILE_NOT_FOUND'
  | 'UNSUPPORTED_FORMAT'
  | 'FFMPEG_NOT_FOUND'
  | 'ENGINE_NOT_FOUND'
  | 'MODEL_NOT_FOUND'
  | 'NO_AUDIO_STREAM'
  | 'EXTRACTION_FAILED'
  | 'TRANSCRIPTION_FAILED'
  | 'INVALID_TRANSCRIPT'
  | 'CANCELLED';

export interface TranscriptionErrorInfo {
  code: TranscriptionErrorCode;
  message: string;
  /** Tail of the tool's stderr, for diagnostics. */
  details?: string;
}

/** IPC-safe result: errors are returned as data because Electron drops custom error fields across IPC. */
export type TranscriptionResult =
  | { ok: true; transcript: Transcript; fromCache: boolean }
  | { ok: false; error: TranscriptionErrorInfo };

export interface ToolStatus {
  available: boolean;
  path?: string;
  version?: string;
}

export interface InstalledModel {
  /** Short name, e.g. "small.en". */
  name: string;
  file: string;
  path: string;
  size: number;
}

export interface TranscriptionStatus {
  ffmpeg: ToolStatus;
  engine: ToolStatus;
  models: InstalledModel[];
  modelsDirectory: string;
  /** Model used when a request doesn't name one. */
  defaultModel?: string;
  ready: boolean;
  problems: string[];
}

/** Optional `transcription` block in settings.json. Every field falls back to auto-discovery. */
export interface TranscriptionSettings {
  /** Path to whisper-cli(.exe) or the folder containing it. */
  whisperPath?: string;
  /** Folder holding ggml-*.bin models. Default: <userData>/models. */
  modelsDirectory?: string;
  /** Default model name or file. */
  model?: string;
  language?: string;
  device?: TranscriptionDevicePreference;
}
