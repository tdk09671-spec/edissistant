import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseColor, type AnimationSpec } from '../../../src/shared/animation';
import type { FrameJob, FrameSource, FrameSourceFactory } from '../../../src/main/render/frameSource';

function which(name: string): string | undefined {
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' }).split(/\r?\n/)[0].trim() || undefined;
  } catch {
    return undefined;
  }
}

export const ffmpeg = which('ffmpeg');
export const ffprobe = which('ffprobe');
export const hasFfmpeg = Boolean(ffmpeg && ffprobe);

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'edissistant-render-test-'));
}

/** Straight-RGBA frame filled by a per-pixel function. */
export function makeFrame(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  }
  return data;
}

export function pixelAt(rgba: Uint8Array, width: number, x: number, y: number): [number, number, number, number] {
  const i = (y * width + x) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
}

/** The color a synthetic segment draws: its solid background, or its first layer's `fill`/`color`. */
export function segmentColor(spec: AnimationSpec): [number, number, number] {
  const props = spec.layers[0]?.props as { color?: unknown; fill?: unknown } | undefined;
  const raw = spec.background.type === 'solid' ? spec.background.color : String(props?.fill ?? props?.color ?? '#ffffff');
  const c = parseColor(raw) ?? { r: 255, g: 255, b: 255 };
  return [c.r, c.g, c.b];
}

export interface SyntheticOptions {
  /** Throw when this frame is requested (simulates a crash mid-render). */
  failAt?: number;
  /** Delay per frame, to make cancellation testable. */
  delayMs?: number;
  /** Fail in open() with this error. */
  openError?: Error;
}

/**
 * Frame source that needs no Chromium: full-motion specs fill the frame with their background color;
 * transparent specs draw their first layer's color on the right half and leave the left half clear.
 */
export function syntheticFrames(options: SyntheticOptions = {}): FrameSourceFactory & { opened: number; frames: number; closed: number; jobs: FrameJob[] } {
  const stats = { opened: 0, frames: 0, closed: 0, jobs: [] as FrameJob[] };
  const factory = (job: FrameJob): FrameSource => {
    stats.jobs.push(job);
    const [r, g, b] = segmentColor(job.spec);
    const transparent = job.spec.exportMode !== 'full-motion';
    const frame = makeFrame(job.width, job.height, (x) => (transparent ? (x < job.width / 2 ? [0, 0, 0, 0] : [r, g, b, 255]) : [r, g, b, 255]));
    return {
      async open() {
        stats.opened++;
        if (options.openError) throw options.openError;
        return { warnings: [] };
      },
      async frame(index) {
        if (options.failAt === index) throw new Error(`synthetic failure at frame ${index}`);
        if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
        stats.frames++;
        return frame;
      },
      async close() {
        stats.closed++;
      },
    };
  };
  return Object.defineProperties(factory, {
    opened: { get: () => stats.opened },
    frames: { get: () => stats.frames },
    closed: { get: () => stats.closed },
    jobs: { get: () => stats.jobs },
  }) as FrameSourceFactory & { opened: number; frames: number; closed: number; jobs: FrameJob[] };
}

export function transparentSpec(id: string, start: number, color = '#00ff00', duration = 1, extra: Partial<AnimationSpec> = {}): AnimationSpec {
  return {
    specVersion: 1,
    id,
    start,
    duration,
    width: 160,
    height: 90,
    fps: 25,
    exportMode: 'transparent-motion',
    background: { type: 'transparent' },
    layers: [{ id: 'box', type: 'shape', props: { shape: 'rect', width: 80, height: 90, fill: color } }],
    ...extra,
  } as AnimationSpec;
}

export function fullSpec(id: string, start: number, color = '#ff0000', duration = 1): AnimationSpec {
  return { ...transparentSpec(id, start, color, duration), exportMode: 'full-motion', background: { type: 'solid', color } };
}
