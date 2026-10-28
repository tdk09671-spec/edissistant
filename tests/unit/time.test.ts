import { describe, expect, it } from 'vitest';
import { formatClock, formatPrecise, formatTimecode, parseTime } from '../../src/renderer/lib/time';

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
