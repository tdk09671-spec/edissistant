// Renders a scene job locally: PNG stills of a design, or an animation encoded to ProRes 4444 /
// PNG-in-MOV / H.264 through the existing encoder, validated with FFprobe, cached by content.
//
// Frame i shows scene time i·den/num exactly (25, 30, 29.97 = 30000/1001 …). Motion blur averages
// subframes in premultiplied space inside the host. Cancelling kills the host and FFmpeg and leaves
// no partial file.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fpsRational } from '../../shared/animation/timeline';
import type { ExportFormatId } from '../../shared/animation/types';
import { encodeFrames } from '../render/encoder';
import { validateOutput, type MediaMetadata } from '../render/probe';
import { SceneHost, type SceneHostOptions } from './client';
import { encodePng } from './png';
import { subframeTimes, type MotionBlur } from './pixels';
import { SceneError, type SceneInfo, type SceneJob } from './protocol';

/** Bump when anything that changes rendered pixels changes (host, shim, accumulation, camera). */
export const SCENE_RENDERER_VERSION = 'scene-1';

export interface AnimationSettings {
  fps: number;
  motionBlur: MotionBlur;
  /** Apply the page's camera after capture (registry scenes with a camera function). */
  postCamera: boolean;
  /** Render only these frames [from, to) (for previews and tests). */
  frames?: { from: number; to: number };
}

export interface AnimationTarget {
  format: Extract<ExportFormatId, 'prores-4444' | 'png-mov' | 'h264-mp4' | 'prores-422hq'>;
  output: string;
  ffmpeg: string;
  ffprobe: string;
}

export interface AnimationResult {
  output: string;
  frames: number;
  info: SceneInfo;
  metadata: MediaMetadata;
  fingerprint: string;
  cached: boolean;
  /** Milliseconds per frame (capture + blur + camera), as measured by the host. */
  frameMs: number[];
  hostVersions: Record<string, string>;
}

/** Content fingerprint of everything that determines the pixels of a render. */
export function sceneFingerprint(job: SceneJob, settings: Partial<AnimationSettings> & { stills?: number[] }, format?: string): string {
  const h = crypto.createHash('sha256');
  const files = [...job.files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => [f.path, crypto.createHash('sha256').update(f.data).digest('hex')]);
  const { files: _f, ...rest } = job;
  h.update(JSON.stringify({ v: SCENE_RENDERER_VERSION, job: rest, files, settings, format: format ?? null }));
  return h.digest('hex');
}

export function frameTime(i: number, fps: number): number {
  const r = fpsRational(fps);
  return (i * r.den) / r.num;
}

export function frameTotal(duration: number, fps: number): number {
  const r = fpsRational(fps);
  return Math.round((duration * r.num) / r.den - 1e-9);
}

/** Renders PNG stills at scene times (seconds). Returns the written paths. */
export async function renderStills(host: SceneHostOptions, job: SceneJob, times: number[], outDir: string, name = 'still'): Promise<{ files: string[]; info: SceneInfo }> {
  const h = new SceneHost(host);
  try {
    await h.start();
    const info = await h.open(job);
    fs.mkdirSync(outDir, { recursive: true });
    const files: string[] = [];
    for (const t of times) {
      if (!(t >= 0 && t <= info.duration)) throw new SceneError('INVALID_JOB', `Still time ${t} s is outside the scene (0–${info.duration} s).`);
      const { rgba } = await h.capture([t], false);
      const file = path.join(outDir, `${name}_${t.toFixed(3)}.png`);
      fs.writeFileSync(file, encodePng({ width: info.outputWidth, height: info.outputHeight, data: rgba }));
      files.push(file);
    }
    return { files, info };
  } finally {
    await h.close();
  }
}

/** Renders and encodes an animation. Reuses `cacheDir/<fingerprint>` when nothing changed. */
export async function renderAnimation(
  host: SceneHostOptions,
  job: SceneJob,
  settings: AnimationSettings,
  target: AnimationTarget,
  opts: { cacheDir?: string; onProgress?: (done: number, total: number) => void } = {}
): Promise<AnimationResult> {
  const fingerprint = sceneFingerprint(job, settings, target.format);
  const ext = target.format === 'h264-mp4' ? 'mp4' : 'mov';
  const cached = opts.cacheDir ? path.join(opts.cacheDir, `${fingerprint}.${ext}`) : null;
  const h = new SceneHost(host);
  try {
    await h.start();
    const info = await h.open(job);
    const total = frameTotal(info.duration, settings.fps);
    const from = settings.frames?.from ?? 0;
    const to = Math.min(total, settings.frames?.to ?? total);
    const count = to - from;
    if (count <= 0) throw new SceneError('INVALID_JOB', 'No frames to render.');
    const expected = { format: target.format, width: info.outputWidth, height: info.outputHeight, fps: settings.fps, frames: count };
    if (cached && fs.existsSync(cached)) {
      fs.mkdirSync(path.dirname(target.output), { recursive: true });
      fs.copyFileSync(cached, target.output);
      const metadata = await validateOutput(target.ffprobe, target.output, expected);
      return { output: target.output, frames: count, info, metadata, fingerprint, cached: true, frameMs: [], hostVersions: h.versions };
    }
    const frameDur = frameTime(1, settings.fps);
    const frameMs: number[] = [];
    fs.mkdirSync(path.dirname(target.output), { recursive: true });
    const partial = `${target.output}.partial.${ext}`;
    try {
      await encodeFrames(
        target.ffmpeg,
        { format: target.format, width: info.outputWidth, height: info.outputHeight, fps: settings.fps },
        partial,
        count,
        async (i) => {
          const t = frameTime(from + i, settings.fps);
          const { rgba, ms } = await h.capture(subframeTimes(t, frameDur, settings.motionBlur), settings.postCamera);
          frameMs.push(ms);
          opts.onProgress?.(i + 1, count);
          return rgba;
        },
        { signal: host.signal }
      );
      const metadata = await validateOutput(target.ffprobe, partial, expected);
      fs.renameSync(partial, target.output);
      if (cached) {
        fs.mkdirSync(path.dirname(cached), { recursive: true });
        fs.copyFileSync(target.output, cached);
      }
      return { output: target.output, frames: count, info, metadata, fingerprint, cached: false, frameMs, hostVersions: h.versions };
    } catch (e) {
      fs.rmSync(partial, { force: true });
      throw e;
    }
  } finally {
    await h.close();
  }
}
