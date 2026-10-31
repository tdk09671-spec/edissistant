import * as fs from 'fs';
import { RenderError } from '../../shared/animation/errors';
import { EXPORT_FORMATS } from '../../shared/animation/formats';
import { fpsRational } from '../../shared/animation/timeline';
import type { ExportFormatId } from '../../shared/animation/types';
import { runTool } from './process';

export interface MediaMetadata {
  codec: string;
  width: number;
  height: number;
  pixFmt: string;
  /** Exact frame rate as FFprobe reports it, e.g. "30000/1001". */
  frameRate: string;
  frames: number;
  /** Seconds. */
  duration: number;
  /** True when the stream stores alpha (alpha pixel format, or VP9's alpha_mode tag). */
  hasAlpha: boolean;
  sizeBytes: number;
}

const ALPHA_PIX_FMT = /^(yuva|rgba|bgra|argb|abgr|gbrap|ya|pal8)/;

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  nb_read_packets?: string;
  nb_frames?: string;
  duration?: string;
  tags?: Record<string, string>;
}

/** Reads the first video stream's metadata; frame count comes from counting packets. */
export async function probeVideo(ffprobe: string, file: string): Promise<MediaMetadata> {
  const { code, stdout, stderrTail } = await runTool(ffprobe, ['-v', 'error', '-count_packets', '-show_streams', '-show_format', '-of', 'json', file]);
  if (code !== 0) throw new RenderError('OUTPUT_INVALID', 'FFprobe could not read the rendered file.', { details: stderrTail });
  let data: { streams?: ProbeStream[]; format?: { duration?: string } };
  try {
    data = JSON.parse(stdout.toString('utf8'));
  } catch {
    throw new RenderError('OUTPUT_INVALID', 'FFprobe returned unreadable metadata.');
  }
  const v = data.streams?.find((s) => s.codec_type === 'video');
  if (!v) throw new RenderError('OUTPUT_INVALID', 'The rendered file has no video stream.');
  const pixFmt = v.pix_fmt ?? '';
  const tags = Object.fromEntries(Object.entries(v.tags ?? {}).map(([k, val]) => [k.toLowerCase(), val]));
  return {
    codec: v.codec_name ?? '',
    width: v.width ?? 0,
    height: v.height ?? 0,
    pixFmt,
    frameRate: v.r_frame_rate ?? '',
    frames: Number(v.nb_read_packets ?? v.nb_frames ?? 0),
    duration: Number(data.format?.duration ?? v.duration ?? 0),
    hasAlpha: ALPHA_PIX_FMT.test(pixFmt) || tags.alpha_mode === '1',
    sizeBytes: fs.statSync(file).size,
  };
}

export interface ExpectedOutput {
  format: ExportFormatId;
  width: number;
  height: number;
  fps: number;
  frames: number;
}

/** Checks a render against what was asked for. Returns the problems found (empty = valid). */
export function outputProblems(meta: MediaMetadata, expected: ExpectedOutput): string[] {
  const info = EXPORT_FORMATS[expected.format];
  const problems: string[] = [];
  if (meta.codec !== info.codec) problems.push(`codec is ${meta.codec}, expected ${info.codec}`);
  if (meta.width !== expected.width || meta.height !== expected.height) {
    problems.push(`size is ${meta.width}×${meta.height}, expected ${expected.width}×${expected.height}`);
  }
  const r = fpsRational(expected.fps);
  const [num, den] = meta.frameRate.split('/').map(Number);
  if (!num || !den || num * r.den !== den * r.num) problems.push(`frame rate is ${meta.frameRate}, expected ${r.num}/${r.den}`);
  if (meta.frames !== expected.frames) problems.push(`has ${meta.frames} frames, expected ${expected.frames}`);
  if (info.alpha && !meta.hasAlpha) problems.push(`pixel format ${meta.pixFmt} has no alpha channel`);
  if (meta.sizeBytes <= 0) problems.push('file is empty');
  return problems;
}

export async function validateOutput(ffprobe: string, file: string, expected: ExpectedOutput): Promise<MediaMetadata> {
  const meta = await probeVideo(ffprobe, file);
  const problems = outputProblems(meta, expected);
  if (problems.length) throw new RenderError('OUTPUT_INVALID', `Render failed validation: ${problems.join('; ')}.`);
  return meta;
}

/**
 * Decodes the given frames back to straight RGBA (one Buffer per frame, in order). VP9 must be
 * decoded with libvpx: FFmpeg's built-in VP9 decoder drops the alpha plane.
 */
export async function decodeFrames(ffmpeg: string, file: string, frames: number[], width: number, height: number, codec?: string): Promise<Buffer[]> {
  const sorted = [...new Set(frames)].sort((a, b) => a - b);
  const select = sorted.map((n) => `eq(n\\,${n})`).join('+');
  const decoder = codec === 'vp9' ? ['-c:v', 'libvpx-vp9'] : [];
  const { code, stdout, stderrTail } = await runTool(ffmpeg, [
    '-hide_banner',
    '-v',
    'error',
    ...decoder,
    '-i',
    file,
    '-vf',
    `select='${select}'`,
    '-fps_mode',
    'passthrough',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    'pipe:1',
  ]);
  if (code !== 0) throw new RenderError('OUTPUT_INVALID', 'Could not decode frames for verification.', { details: stderrTail });
  const size = width * height * 4;
  if (stdout.length !== size * sorted.length) {
    throw new RenderError('OUTPUT_INVALID', `Decoded ${stdout.length} bytes; expected ${size * sorted.length}.`);
  }
  const byFrame = new Map(sorted.map((n, i) => [n, stdout.subarray(i * size, (i + 1) * size)]));
  return frames.map((n) => byFrame.get(n) as Buffer);
}

export interface AlphaStats {
  total: number;
  /** alpha = 0 */
  transparent: number;
  /** 0 < alpha < 255 */
  partial: number;
  /** alpha = 255 */
  opaque: number;
  minAlpha: number;
  maxAlpha: number;
}

export function alphaStats(rgba: Uint8Array): AlphaStats {
  const stats: AlphaStats = { total: rgba.length / 4, transparent: 0, partial: 0, opaque: 0, minAlpha: 255, maxAlpha: 0 };
  for (let i = 3; i < rgba.length; i += 4) {
    const a = rgba[i];
    if (a === 0) stats.transparent++;
    else if (a === 255) stats.opaque++;
    else stats.partial++;
    if (a < stats.minAlpha) stats.minAlpha = a;
    if (a > stats.maxAlpha) stats.maxAlpha = a;
  }
  return stats;
}

/** Largest per-pixel alpha difference between two RGBA buffers. */
export function maxAlphaError(a: Uint8Array, b: Uint8Array): number {
  let max = 0;
  for (let i = 3; i < Math.min(a.length, b.length); i += 4) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
}

export interface AlphaReport {
  hasAlphaChannel: boolean;
  pixFmt: string;
  frames: { index: number; stats: AlphaStats }[];
  /** True if decoded pixels include real transparency (some alpha below 255). */
  transparencySurvives: boolean;
}

/** Decodes frames of a file and reports whether real transparent pixels survived encoding. */
export async function verifyAlpha(ffmpeg: string, ffprobe: string, file: string, frames: number[]): Promise<AlphaReport> {
  const meta = await probeVideo(ffprobe, file);
  const decoded = await decodeFrames(ffmpeg, file, frames, meta.width, meta.height, meta.codec);
  const report = frames.map((index, i) => ({ index, stats: alphaStats(decoded[i]) }));
  return {
    hasAlphaChannel: meta.hasAlpha,
    pixFmt: meta.pixFmt,
    frames: report,
    transparencySurvives: meta.hasAlpha && report.some((f) => f.stats.minAlpha < 255),
  };
}
