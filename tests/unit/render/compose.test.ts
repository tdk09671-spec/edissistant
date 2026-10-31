import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composePreview, compositionArgs } from '../../../src/main/render/compose';
import { fpsRational, secondsToFrames } from '../../../src/shared/animation';
import { ffmpeg, hasFfmpeg, tempDir } from './helpers';

// Graphics must land on exactly their frames in the composed preview. At NTSC rates a frame's time
// has no exact decimal form (frame 26 at 24000/1001 is 1.0844166…s), and FFmpeg compares the base
// frame's time (pts × time base, a double) with the boundaries written into the filter graph. Exact
// boundaries written with 6 decimals could round past their own frame, starting a graphic one frame
// late or dropping its last frame.

function boundaries(fps: number, clip: { start: number; duration: number }) {
  const args = compositionArgs({ width: 64, height: 36, fps, duration: 60, clips: [{ ...clip, path: '/c.mov', codec: 'prores' }], output: '/o.mp4' });
  const graph = args[args.indexOf('-filter_complex') + 1];
  const [, tbNum, tbDen, first] = /settb=(\d+)\/(\d+),setpts=N\+(\d+)/.exec(graph)!.map(Number);
  const [, from, to] = /enable='gte\(t,([\d.]+)\)\*lt\(t,([\d.]+)\)'/.exec(graph)!.map(Number);
  return { tb: [tbNum, tbDen] as const, first, from, to };
}

describe('composition boundaries (filter graph)', () => {
  it('each graphic is stamped on its frame grid and shown for exactly its frames', () => {
    for (const fps of [23.976, 24, 25, 29.97, 30, 59.94]) {
      const { num, den } = fpsRational(fps);
      const frameTime = (n: number) => (n * den) / num;
      for (let k = 0; k < 200; k++) {
        const start = Math.round((0.5 + k * 0.137) * 1000) / 1000;
        const duration = Math.round((1 + (k % 7) * 0.371) * 1000) / 1000;
        const { tb, first: placed, from, to } = boundaries(fps, { start, duration });
        const first = secondsToFrames(start, fps);
        const count = Math.max(1, secondsToFrames(duration, fps));
        // Clip frame k is stamped first + k in a time base of exactly one frame: no rounding.
        expect(tb).toEqual([den, num]);
        expect(placed).toBe(first);
        for (let n = first - 3; n < first + count + 3; n++) {
          const t = frameTime(n);
          expect(t >= from && t < to, `fps ${fps}, start ${start}, frame ${n}`).toBe(n >= first && n < first + count);
        }
      }
    }
  });
});

// Cases where the old boundary rounded past its frame: 1.064 s at 24000/1001 snaps to frame 26 and
// 1.018 s at 30000/1001 to frame 31; 16.166 s at 30000/1001 (frame 484) was found in a real render.
const CASES = [
  { rate: '24000/1001', fps: 23.976, start: 1.064, frames: 5 },
  { rate: '24000/1001', fps: 23.976, start: 1.065, frames: 7 },
  { rate: '30000/1001', fps: 29.97, start: 1.018, frames: 5 },
  { rate: '30000/1001', fps: 29.97, start: 16.166, frames: 6 },
];

describe.skipIf(!hasFfmpeg)('composition with real FFmpeg at 24000/1001 and 30000/1001', () => {
  let dir: string;
  beforeAll(() => {
    dir = tempDir();
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.each(CASES)('a $frames-frame graphic at $start s ($rate) covers exactly its frames, in order', async ({ rate, fps, start, frames }) => {
    const { num, den } = fpsRational(fps);
    const clip = path.join(dir, `clip-${rate.replace('/', '_')}-${start}.mov`);
    // Clip frame k has brightness 70 + 25k, so the output shows which clip frame landed where.
    execFileSync(ffmpeg!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=64x36:r=${rate},format=yuv444p,geq=lum='70+25*N':cb=128:cr=128`, '-frames:v', String(frames), '-c:v', 'prores_ks', '-pix_fmt', 'yuv422p10le', clip]);
    const first = secondsToFrames(start, fps);
    const total = first + frames + 4;
    const output = path.join(dir, `out-${rate.replace('/', '_')}-${start}.mp4`);
    // Clip duration as the sequence stores it: rounded to the millisecond, not frame-exact.
    const duration = Math.round(((frames * den) / num) * 1000) / 1000;
    await composePreview(ffmpeg!, { width: 64, height: 36, fps, duration: (total * den) / num, clips: [{ path: clip, start, duration, codec: 'prores' }], output });

    const raw = execFileSync(ffmpeg!, ['-v', 'error', '-i', output, '-vf', 'scale=4:4,format=gray', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
    const luma = Array.from({ length: raw.length / 16 }, (_, i) => raw.subarray(i * 16, i * 16 + 16).reduce((a, b) => a + b, 0) / 16);
    expect(luma.length).toBe(total);
    const shown = luma.flatMap((l, i) => (l > 45 ? [i] : []));
    expect(shown).toEqual(Array.from({ length: frames }, (_, i) => first + i));
    // Limited-range luma Y reads back as (Y − 16) × 255/219 in full-range grey.
    shown.forEach((n, k) => expect(Math.abs(luma[n] - ((70 + 25 * k - 16) * 255) / 219), `frame ${n} shows clip frame ${k}`).toBeLessThan(4));
  });
});
