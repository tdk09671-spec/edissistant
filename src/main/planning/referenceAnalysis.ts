// Local reference-video analysis with FFmpeg/FFprobe: clip metadata, scene cuts (pacing),
// representative frames, and colour statistics. Results are cached by file fingerprint, so a reference
// is analysed once.
//
// Media ingestion is explicit and lawful: only files on disk are analysed. A link (YouTube, Vimeo,
// Frame.io…) carries no frames by itself; ingestLink records it as metadata only and says what is
// needed (the editor's own file, or a supported downloader the editor is authorised to use). Nothing
// here downloads from, scrapes, or bypasses access controls of any platform.

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PlanningError } from '../../shared/planning/errors';
import type { ReferenceAnalysis } from '../../shared/planning/types';

export type MediaSource =
  | { kind: 'local-file'; path: string; role: 'reference-video' | 'previous-edit' }
  /** A link the editor approved as a reference. Metadata only: no frames are fetched. */
  | { kind: 'link'; url: string; approvedBy: string; note?: string };

export interface LinkReference {
  kind: 'link';
  url: string;
  approvedBy: string;
  note?: string;
  framesAvailable: false;
  /** What the editor can do to make it analysable. */
  howToAnalyse: string;
}

/**
 * A downloader the editor is authorised to use (e.g. their own Frame.io/Drive export, or a platform's
 * official API). Not implemented here: plug one in once its terms allow it.
 */
export interface ApprovedDownloader {
  canHandle(url: string): boolean;
  /** Downloads to `destination` and returns the file path. Must respect the platform's terms. */
  download(url: string, destination: string, options: { signal?: AbortSignal }): Promise<string>;
}

export function ingestLink(source: Extract<MediaSource, { kind: 'link' }>): LinkReference {
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    throw new PlanningError('INVALID_INPUT', 'That is not a valid link.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new PlanningError('INVALID_INPUT', 'Only http(s) links can be saved as references.');
  return {
    kind: 'link',
    url: url.toString(),
    approvedBy: source.approvedBy,
    note: source.note,
    framesAvailable: false,
    howToAnalyse: 'A link alone gives no video frames. Add the video file you have rights to (for example your own export), or connect a downloader you are authorised to use.',
  };
}

// --- FFmpeg helpers -------------------------------------------------------------------------------

function run(command: string, args: string[], signal?: AbortSignal): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new PlanningError('CANCELLED', 'Reference analysis was cancelled.'));
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString('utf8');
      if (err.length > 2_000_000) err = err.slice(-1_000_000);
    });
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (e) => reject(new PlanningError('INVALID_INPUT', `Could not start ${path.basename(command)}: ${e.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(new PlanningError('CANCELLED', 'Reference analysis was cancelled.'));
      else resolve({ code, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

/** Size + mtime + sampled content hash (start, middle, end), like the transcription cache. */
export function fingerprintFile(file: string): string {
  const stat = fs.statSync(file);
  const hash = createHash('sha256').update(`${stat.size}:${Math.floor(stat.mtimeMs)}`);
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Math.min(1 << 20, stat.size);
    for (const offset of [0, Math.max(0, Math.floor(stat.size / 2) - chunk / 2), Math.max(0, stat.size - chunk)]) {
      const buf = Buffer.alloc(chunk);
      const n = fs.readSync(fd, buf, 0, chunk, offset);
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex').slice(0, 32);
}

/** Parses `pts_time:` values from FFmpeg's showinfo output. */
export function parseSceneTimes(stderr: string): number[] {
  return [...stderr.matchAll(/pts_time:(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])).filter(Number.isFinite);
}

/** Picks up to `count` representative times: the middle of the longest shots, in time order. */
export function representativeTimes(duration: number, cuts: number[], count: number): number[] {
  const bounds = [0, ...cuts.filter((c) => c > 0 && c < duration), duration];
  const shots = bounds.slice(1).map((end, i) => ({ start: bounds[i], end, length: end - bounds[i] }));
  const picks = shots
    .filter((s) => s.length > 0.2)
    .sort((a, b) => b.length - a.length || a.start - b.start)
    .slice(0, count)
    .map((s) => Math.round(((s.start + s.end) / 2) * 1000) / 1000);
  if (picks.length < Math.min(count, 3) && duration > 0) {
    for (let i = 1; picks.length < count && i <= count; i++) {
      const t = Math.round(((duration * i) / (count + 1)) * 1000) / 1000;
      if (!picks.includes(t)) picks.push(t);
    }
  }
  return [...new Set(picks)].sort((a, b) => a - b).slice(0, count);
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/** Colour statistics from RGB24 pixels: dominant colours (coarse histogram), luminance, contrast, saturation. */
export function colorStats(rgb: Buffer): { dominantColors: string[]; meanLuminance: number; contrast: number; meanSaturation: number } {
  const n = Math.floor(rgb.length / 3);
  if (n === 0) return { dominantColors: [], meanLuminance: 0, contrast: 0, meanSaturation: 0 };
  const bins = new Map<number, { count: number; r: number; g: number; b: number }>();
  let lumSum = 0;
  let lumSq = 0;
  let satSum = 0;
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    lumSum += l;
    lumSq += l * l;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    satSum += max === 0 ? 0 : (max - min) / max;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const bin = bins.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bin.count++;
    bin.r += r;
    bin.g += g;
    bin.b += b;
    bins.set(key, bin);
  }
  const mean = lumSum / n;
  const dominantColors = [...bins.values()]
    .filter((b) => b.count / n >= 0.02)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((b) => hex(b.r / b.count, b.g / b.count, b.b / b.count));
  return {
    dominantColors,
    meanLuminance: Math.round(mean * 1000) / 1000,
    contrast: Math.round(Math.sqrt(Math.max(0, lumSq / n - mean * mean)) * 1000) / 1000,
    meanSaturation: Math.round((satSum / n) * 1000) / 1000,
  };
}

export interface AnalyzeOptions {
  ffmpeg: string;
  ffprobe: string;
  /** Folder for cached analyses and frames (e.g. <userData>/reference-cache). */
  cacheDir: string;
  frames?: number;
  /** Scene-change threshold 0–1. Default 0.3. */
  sceneThreshold?: number;
  signal?: AbortSignal;
}

/** Analyses a local reference video, reusing the cached result when the file is unchanged. */
export async function analyzeReference(source: Extract<MediaSource, { kind: 'local-file' }>, options: AnalyzeOptions): Promise<{ analysis: ReferenceAnalysis; fromCache: boolean }> {
  const file = source.path;
  if (!path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new PlanningError('INVALID_INPUT', `Reference file not found: ${file}`);
  const fingerprint = fingerprintFile(file);
  const entryDir = path.join(options.cacheDir, fingerprint);
  const cached = path.join(entryDir, 'analysis.json');
  if (fs.existsSync(cached)) {
    try {
      const analysis = JSON.parse(fs.readFileSync(cached, 'utf8')) as ReferenceAnalysis;
      if (analysis.fingerprint === fingerprint && analysis.frames.every((f) => fs.existsSync(f.path))) {
        return { analysis: { ...analysis, kind: source.role, location: file }, fromCache: true };
      }
    } catch {
      // Corrupt cache entry: re-analyse.
    }
  }

  const probe = await run(options.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate:format=duration', '-of', 'json', file], options.signal);
  if (probe.code !== 0) throw new PlanningError('INVALID_INPUT', 'FFprobe could not read the reference video.');
  const meta = JSON.parse(probe.stdout.toString('utf8')) as { streams?: { width?: number; height?: number; r_frame_rate?: string }[]; format?: { duration?: string } };
  const stream = meta.streams?.[0];
  if (!stream) throw new PlanningError('INVALID_INPUT', 'The reference has no video stream.');
  const duration = Number(meta.format?.duration ?? 0);
  const [num, den] = (stream.r_frame_rate ?? '0/1').split('/').map(Number);
  const fps = den ? Math.round((num / den) * 1000) / 1000 : 0;

  // Scene cuts → pacing. Analyse a downscaled stream for speed.
  const scenes = await run(options.ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-an', '-vf', `scale=320:-2,select='gt(scene,${options.sceneThreshold ?? 0.3})',showinfo`, '-f', 'null', '-'], options.signal);
  if (scenes.code !== 0) throw new PlanningError('INVALID_INPUT', 'FFmpeg could not analyse the reference video.');
  const cuts = parseSceneTimes(scenes.stderr).filter((t) => t > 0.05 && t < duration - 0.05);
  const shots = cuts.length + 1;

  // Representative frames: a PNG for review/vision, and a tiny RGB thumbnail for colour stats.
  fs.mkdirSync(entryDir, { recursive: true });
  const times = representativeTimes(duration, cuts, options.frames ?? 6);
  const frames: ReferenceAnalysis['frames'] = [];
  const pixels: Buffer[] = [];
  for (const [i, t] of times.entries()) {
    const png = path.join(entryDir, `frame-${i}.png`);
    const still = await run(options.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', png], options.signal);
    if (still.code === 0 && fs.existsSync(png)) frames.push({ time: t, path: png });
    const thumb = await run(options.ffmpeg, ['-hide_banner', '-nostdin', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', 'scale=48:27', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], options.signal);
    if (thumb.code === 0) pixels.push(thumb.stdout);
  }
  const stats = colorStats(Buffer.concat(pixels));
  const analysis: ReferenceAnalysis = {
    id: `ref-${fingerprint.slice(0, 12)}`,
    kind: source.role,
    location: file,
    fingerprint,
    durationSeconds: Math.round(duration * 1000) / 1000,
    width: stream.width ?? 0,
    height: stream.height ?? 0,
    fps,
    cuts: cuts.map((c) => Math.round(c * 1000) / 1000),
    cutsPerMinute: duration > 0 ? Math.round((cuts.length / (duration / 60)) * 10) / 10 : 0,
    averageShotSeconds: Math.round((duration / shots) * 100) / 100,
    frames,
    ...stats,
    analyzedAt: new Date().toISOString(),
  };
  const tmp = `${cached}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(analysis, null, 2));
  fs.renameSync(tmp, cached);
  return { analysis, fromCache: false };
}
