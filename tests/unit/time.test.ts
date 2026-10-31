import { describe, expect, it } from 'vitest';
import { exactFrameRate, formatClock, formatPrecise, formatTimecode, parseTime } from '../../src/renderer/lib/time';

describe('formatTimecode', () => {
  it('formats HH:MM:SS:FF at the given frame rate', () => {
    expect(formatTimecode(0)).toBe('00:00:00:00');
    expect(formatTimecode(61.5, 25)).toBe('00:01:01:12');
    expect(formatTimecode(3600 + 0.5, 30)).toBe('01:00:00:15');
  });
  it('clamps invalid input to zero', () => {
    expect(formatTimecode(-5)).toBe('00:00:00:00');
    expect(formatTimecode(Number.NaN)).toBe('00:00:00:00');
  });
});

describe('formatClock / formatPrecise', () => {
  it('formats short clock times', () => {
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(83)).toBe('1:23');
    expect(formatClock(3723)).toBe('1:02:03');
  });
  it('formats precise times with milliseconds and rolls over 999.5ms', () => {
    expect(formatPrecise(83.5)).toBe('1:23.500');
    expect(formatPrecise(1.9996)).toBe('0:02.000');
  });
});

describe('parseTime', () => {
  it('parses seconds, M:SS, H:MM:SS and timecode', () => {
    expect(parseTime('83')).toBe(83);
    expect(parseTime('83,5')).toBe(83.5);
    expect(parseTime('1:23.5')).toBe(83.5);
    expect(parseTime('1:00:00')).toBe(3600);
    expect(parseTime('00:00:01:12', 25)).toBeCloseTo(1.48);
  });
  it('rejects garbage', () => {
    expect(parseTime('')).toBeNull();
    expect(parseTime('abc')).toBeNull();
    expect(parseTime('1:2:3:4:5')).toBeNull();
  });
});

describe('timecode at NTSC rates (regression: 29.97 was counted as 30 fps, drifting 3.6 s per hour)', () => {
  it('uses the exact rates', () => {
    expect(exactFrameRate(29.97)).toEqual({ num: 30000, den: 1001 });
    expect(exactFrameRate(23.976)).toEqual({ num: 24000, den: 1001 });
    expect(exactFrameRate(59.94)).toEqual({ num: 60000, den: 1001 });
    expect(exactFrameRate(25)).toEqual({ num: 25, den: 1 });
  });

  it('names the real frame at a time and parses back to that frame’s exact start', () => {
    // Frame 484 at 30000/1001 starts at 16.1494666…s; non-drop it is labelled 00:00:16:04 (16 × 30 + 4).
    expect(formatTimecode((484 * 1001) / 30000, 29.97)).toBe('00:00:16:04');
    expect(parseTime('00:00:16:04', 29.97)).toBeCloseTo((484 * 1001) / 30000, 9);
    // Frame 26 at 24000/1001 starts at 1.0844166…s.
    expect(formatTimecode((26 * 1001) / 24000, 23.976)).toBe('00:00:01:02');
    expect(parseTime('00:00:01:02', 23.976)).toBeCloseTo((26 * 1001) / 24000, 9);
    // One real hour is 107892 frames at 29.97 (00:59:56:12) and 86313 at 23.976 (00:59:56:09).
    expect(formatTimecode(3600, 29.97)).toBe('00:59:56:12');
    expect(formatTimecode(3600, 23.976)).toBe('00:59:56:09');
  });

  it('round-trips every frame of the first ten minutes at 24000/1001 and 30000/1001', () => {
    for (const fps of [23.976, 29.97]) {
      const { num, den } = exactFrameRate(fps);
      for (let n = 0; n < 10 * 60 * 30; n++) {
        const t = (n * den) / num;
        const back = parseTime(formatTimecode(t, fps), fps)!;
        expect(Math.round((back * num) / den)).toBe(n);
      }
    }
  });

  it('leaves whole-number rates unchanged', () => {
    expect(formatTimecode(61.5, 25)).toBe('00:01:01:12');
    expect(parseTime('00:01:01:12', 25)).toBeCloseTo(61.48, 9);
  });
});
