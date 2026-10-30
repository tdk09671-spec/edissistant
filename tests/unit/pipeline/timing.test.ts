import { describe, expect, it } from 'vitest';
import { compositionArgs } from '../../../src/main/render/compose';
import { fpsRational, secondsToFrames } from '../../../src/shared/animation/timeline';
import { formatTimecode, parseTime } from '../../../src/renderer/lib/time';
import { fileTimecode } from '../../../src/renderer/lib/pipeline';

// Frame-exact placement of graphics over the footage. FFmpeg compares a frame's time (pts × time base,
// a double) with the boundaries written into the filter graph; at NTSC rates those times have no exact
// decimal form, which is where the one-frame-late bug came from (found by the end-to-end run).

function windows(fps: number, clips: { start: number; duration: number }[]) {
  const args = compositionArgs({ width: 640, height: 360, fps, duration: 60, clips: clips.map((c, i) => ({ ...c, path: `/c${i}.mov`, codec: 'prores' })), output: '/o.mp4' });
  const graph = args[args.indexOf('-filter_complex') + 1];
  const offsets = [...graph.matchAll(/setpts=PTS-STARTPTS\+([\d.]+)\/TB/g)].map((m) => Number(m[1]));
  const enables = [...graph.matchAll(/enable='gte\(t,([\d.]+)\)\*lt\(t,([\d.]+)\)'/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
  return { offsets, enables };
}

describe('preview composition timing', () => {
  const rates = [23.976, 24, 25, 29.97, 30, 59.94];

  it('every graphic covers exactly its own frames, and frame n shows clip frame n − first', () => {
    for (const fps of rates) {
      const { num, den } = fpsRational(fps);
      const frameTime = (n: number) => (n * den) / num; // what FFmpeg computes for base frame n
      for (let k = 0; k < 200; k++) {
        const start = Math.round((0.5 + k * 0.137) * 1000) / 1000;
        const duration = Math.round((1 + (k % 7) * 0.371) * 1000) / 1000;
        const { offsets, enables } = windows(fps, [{ start, duration }]);
        const first = secondsToFrames(start, fps);
        const count = Math.max(1, secondsToFrames(duration, fps));
        const [from, to] = enables[0];
        for (let n = first - 3; n < first + count + 3; n++) {
          const t = frameTime(n);
          const shown = t >= from && t < to;
          expect(shown, `fps ${fps} start ${start}: frame ${n}`).toBe(n >= first && n < first + count);
          if (shown) {
            // The overlay uses the latest clip frame whose time is ≤ t.
            const clipFrame = Math.floor((t - offsets[0]) / (den / num) + 1e-9);
            expect(clipFrame).toBe(n - first);
          }
        }
      }
    }
  });

  it('the case the end-to-end run caught: 16.166 s at 29.97 starts on frame 484, not 485', () => {
    const { enables } = windows(29.97, [{ start: 16.166, duration: 3.731 }]);
    const t484 = (484 * 1001) / 30000;
    expect(t484 >= enables[0][0]).toBe(true);
    // The old boundary (the exact frame time written with 6 decimals) rounded up past frame 484.
    expect(t484 >= Number(t484.toFixed(6))).toBe(false);
  });
});

describe('timecodes at NTSC rates count real frames', () => {
  it('formats and parses non-drop timecode from the exact rate', () => {
    // Frame 484 at 29.97 starts at 16.1494667 s; it is 00:00:16:04 (16 × 30 + 4) in non-drop timecode.
    expect(formatTimecode((484 * 1001) / 30000, 29.97)).toBe('00:00:16:04');
    expect(parseTime('00:00:16:04', 29.97)).toBeCloseTo((484 * 1001) / 30000, 9);
    // One hour of 29.97 footage is 107892 frames, labelled 00:59:56:12 in non-drop timecode.
    expect(formatTimecode(3600, 29.97)).toBe('00:59:56:12');
    expect(formatTimecode(3600, 23.976)).toBe('00:59:56:09');
    // Integer rates are unchanged.
    expect(formatTimecode(83.5, 25)).toBe('00:01:23:12');
    expect(parseTime('00:01:23:12', 25)).toBeCloseTo(83.48, 9);
  });

  it('round-trips every frame of the first ten minutes at 23.976 and 29.97', () => {
    for (const fps of [23.976, 29.97]) {
      const { num, den } = fpsRational(fps);
      for (let n = 0; n < 10 * 60 * 30; n += 7) {
        const t = (n * den) / num;
        expect(secondsToFrames(parseTime(formatTimecode(t, fps), fps)!, fps)).toBe(n);
      }
    }
  });

  it('names exported clips by their frame-exact timecode', () => {
    expect(fileTimecode(16.166, 29.97)).toBe('00-00-16-04');
    expect(fileTimecode(83.48, 25)).toBe('00-01-23-12');
  });
});
