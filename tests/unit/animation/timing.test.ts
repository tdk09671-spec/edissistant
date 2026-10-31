import { describe, expect, it } from 'vitest';
import {
  captionAt,
  cubicBezier,
  cueFrameRange,
  ease,
  EASING_NAMES,
  EASINGS,
  frameCount,
  frameToSeconds,
  frameToTimecode,
  fpsRational,
  fpsString,
  mixColor,
  parseColor,
  progressBetween,
  resolveColor,
  resolveNumber,
  secondsToFrames,
  segmentFrames,
  toCss,
  type CaptionCue,
} from '../../../src/shared/animation';

describe('frame math', () => {
  it('uses exact NTSC rationals', () => {
    expect(fpsRational(29.97)).toEqual({ num: 30000, den: 1001 });
    expect(fpsRational(23.976)).toEqual({ num: 24000, den: 1001 });
    expect(fpsRational(59.94)).toEqual({ num: 60000, den: 1001 });
    expect(fpsRational(25)).toEqual({ num: 25, den: 1 });
    expect(fpsString(29.97)).toBe('30000/1001');
    expect(fpsString(50)).toBe('50');
  });

  it('counts frames and maps frames to their leading-edge time', () => {
    expect(frameCount(10, 25)).toBe(250);
    // 10 s at 29.97 = 299.7 → 300 frames; at 23.976 = 239.76 → 240.
    expect(frameCount(10, 29.97)).toBe(300);
    expect(frameCount(10, 23.976)).toBe(240);
    expect(frameCount(0.001, 25)).toBe(1);
    expect(frameToSeconds(25, 25)).toBe(1);
    expect(frameToSeconds(30, 29.97)).toBeCloseTo(1.001, 9);
    expect(secondsToFrames(1.001, 29.97)).toBe(30);
    for (let f = 0; f < 2000; f += 37) expect(secondsToFrames(frameToSeconds(f, 59.94), 59.94)).toBe(f);
  });

  // Windows validation round 2 (a6fe66f): ProRes clips at 6.18–12.0 s had 146 frames at 25 fps
  // instead of 145, and 174 at 29.97 instead of 175, because the duration was rounded on its own.
  it('spans a segment from its rounded start to its rounded end, as measured in the Windows test', () => {
    expect(segmentFrames(6.18, 12.0 - 6.18, 25)).toEqual({ first: 155, end: 300, count: 145 });
    expect(segmentFrames(18.11, 22.77 - 18.11, 25)).toEqual({ first: 453, end: 569, count: 116 });
    expect(segmentFrames(6.18, 12.0 - 6.18, 29.97)).toEqual({ first: 185, end: 360, count: 175 });
    // The old count differs in exactly these cases.
    expect(frameCount(12.0 - 6.18, 25)).toBe(146);
    expect(frameCount(12.0 - 6.18, 29.97)).toBe(174);
    // Never zero frames, even for a sliver that rounds to one frame boundary.
    expect(segmentFrames(1.01, 0.02, 25)).toEqual({ first: 25, end: 26, count: 1 });
  });

  it('tiles back-to-back segments with no overlap or gap and keeps every out-point on round(end·fps) − 1', () => {
    for (const fps of [23.976, 24, 25, 29.97, 30, 50, 59.94]) {
      let start = 0.137;
      for (let k = 0; k < 400; k++) {
        const duration = Math.round((0.31 + ((k * 0.7919) % 4.2)) * 1000) / 1000;
        const span = segmentFrames(start, duration, fps);
        const next = segmentFrames(start + duration, 1, fps);
        expect(span.first, `fps ${fps} start ${start}`).toBe(secondsToFrames(start, fps));
        expect(span.end - 1).toBe(secondsToFrames(start + duration, fps) - 1);
        expect(next.first).toBe(span.end);
        // The last frame's own time stays inside the segment, so layers ending at the segment end
        // are still drawn on it.
        expect(frameToSeconds(span.count - 1, fps)).toBeLessThan(duration);
        start = Math.round((start + duration) * 1000) / 1000;
      }
    }
  });

  it('formats timecode and progress', () => {
    expect(frameToTimecode(25 * 3661 + 7, 25)).toBe('01:01:01:07');
    expect(progressBetween(1.5, 1, 1)).toBe(0.5);
    expect(progressBetween(0, 1, 1)).toBe(0);
    expect(progressBetween(5, 1, 1)).toBe(1);
    expect(progressBetween(1, 1, 0)).toBe(1);
  });
});

describe('easing', () => {
  it('every named easing starts at 0 and ends at 1', () => {
    for (const name of EASING_NAMES) {
      expect(EASINGS[name](0), name).toBeCloseTo(0, 6);
      expect(EASINGS[name](1), name).toBeCloseTo(1, 6);
    }
  });

  it('matches CSS cubic-bezier "ease" and clamps progress', () => {
    const cssEase = cubicBezier(0.25, 0.1, 0.25, 1);
    expect(cssEase(0.5)).toBeCloseTo(0.8024, 3);
    expect(cubicBezier(0, 0, 1, 1)(0.3)).toBeCloseTo(0.3, 5);
    expect(ease(2, 'linear')).toBe(1);
    expect(ease(-1, 'linear')).toBe(0);
  });

  it('supports steps and overshooting back easing', () => {
    expect(ease(0.3, { steps: 4 })).toBe(0.25);
    expect(ease(0.99, { steps: 4 })).toBe(0.75);
    expect(ease(1, { steps: 4 })).toBe(1);
    expect(Math.max(...Array.from({ length: 50 }, (_, i) => EASINGS.easeOutBack(i / 49)))).toBeGreaterThan(1);
  });
});

describe('keyframes', () => {
  const kf = { keyframes: [{ t: 1, value: 10, easing: 'linear' as const }, { t: 3, value: 30 }] };

  it('holds before the first and after the last keyframe, and interpolates between', () => {
    expect(resolveNumber(kf, 0, -1)).toBe(10);
    expect(resolveNumber(kf, 2, -1)).toBe(20);
    expect(resolveNumber(kf, 5, -1)).toBe(30);
    expect(resolveNumber(7, 2, -1)).toBe(7);
    expect(resolveNumber(undefined, 2, -1)).toBe(-1);
  });

  it('applies the easing of the earlier keyframe and tolerates unsorted input', () => {
    const eased = { keyframes: [{ t: 2, value: 1 }, { t: 0, value: 0, easing: 'easeInQuad' as const }] };
    expect(resolveNumber(eased, 1, 0)).toBeCloseTo(0.25, 6);
  });

  it('interpolates colors in RGBA', () => {
    const c = { keyframes: [{ t: 0, value: '#000000', easing: 'linear' as const }, { t: 1, value: 'rgba(255, 255, 255, 0)' }] };
    expect(resolveColor(c, 0.5, '#fff')).toBe('rgba(128, 128, 128, 0.5)');
    expect(resolveColor('#123456', 0.5, '#fff')).toBe('#123456');
  });
});

describe('colors', () => {
  it('parses hex, rgb(a) and transparent; rejects named colors and junk', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#ff000080')).toEqual({ r: 255, g: 0, b: 0, a: 0.502 });
    expect(parseColor('rgba(10, 20, 30, 0.5)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor('rgb(10 20 30 / 50%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor('transparent')?.a).toBe(0);
    expect(parseColor('red')).toBeNull();
    expect(parseColor('rgb(300, 0, 0)')).toBeNull();
    expect(parseColor('url(x)')).toBeNull();
    expect(toCss(mixColor({ r: 0, g: 0, b: 0, a: 1 }, { r: 200, g: 100, b: 50, a: 0 }, 0.5))).toBe('rgba(100, 50, 25, 0.5)');
  });
});

describe('caption timing', () => {
  const cues: CaptionCue[] = [
    { start: 0.2, end: 1.0, text: 'For an editor,', words: [{ text: 'For', start: 0.2, end: 0.4 }, { text: 'an', start: 0.4, end: 0.5 }, { text: 'editor,', start: 0.5, end: 1 }] },
    { start: 1.2, end: 1.8, text: 'by an editor.' },
  ];

  it('shows a cue from its start (inclusive) to its end (exclusive)', () => {
    expect(captionAt(cues, 0.19)).toBeNull();
    expect(captionAt(cues, 0.2)?.index).toBe(0);
    expect(captionAt(cues, 0.9999)?.index).toBe(0);
    expect(captionAt(cues, 1.0)).toBeNull();
    expect(captionAt(cues, 1.5)?.index).toBe(1);
  });

  it('reports entrance/exit progress and the active word', () => {
    const s = captionAt(cues, 0.275, { inDuration: 0.15, outDuration: 0.1 })!;
    expect(s.inProgress).toBeCloseTo(0.5, 6);
    expect(s.outProgress).toBe(0);
    expect(s.activeWord).toBe(0);
    expect(captionAt(cues, 0.95, { outDuration: 0.1 })!.outProgress).toBeCloseTo(0.5, 6);
    expect(captionAt(cues, 0.45)!.activeWord).toBe(1);
    expect(captionAt(cues, 0.7)!.activeWord).toBe(2);
    expect(captionAt(cues, 0.25, { in: 'none' })!.inProgress).toBe(1);
    // With a frame duration, the first frame already shows one frame of the entrance.
    expect(captionAt(cues, 0.2, { inDuration: 0.16 }, 0.04)!.inProgress).toBeCloseTo(0.25, 6);
  });

  it('clamps animations to half the cue and gives typewriter a per-character default', () => {
    const short: CaptionCue[] = [{ start: 0, end: 0.1, text: 'Hi' }];
    expect(captionAt(short, 0.025, { inDuration: 1 })!.inProgress).toBeCloseTo(0.5, 6);
    // 20 characters × 35 ms = 0.7 s (the cue is long enough not to clamp it).
    const long: CaptionCue[] = [{ start: 0, end: 4, text: 'twenty characters!!!' }];
    expect(captionAt(long, 0.35, { in: 'typewriter' })!.inProgress).toBeCloseTo(0.5, 6);
    // 14 characters would take 0.49 s, but a 0.8 s cue clamps it to 0.4 s.
    expect(captionAt(cues, 0.4, { in: 'typewriter' })!.inProgress).toBeCloseTo(0.5, 6);
  });

  it('prefers the most recent cue when cues overlap', () => {
    expect(captionAt([{ start: 0, end: 2, text: 'a' }, { start: 1, end: 3, text: 'b' }], 1.5)!.cue.text).toBe('b');
  });

  it('maps cues to exact frame ranges', () => {
    // 25 fps: frames 5 (0.2 s) … 24 (0.96 s); frame 25 is at 1.0 s = cue end (excluded).
    expect(cueFrameRange(cues[0], 25)).toEqual([5, 24]);
    // 29.97: first frame with t ≥ 0.2 is 6 (0.2002 s); last with t < 1.0 is 29 (0.9676 s).
    expect(cueFrameRange(cues[0], 29.97)).toEqual([6, 29]);
    // A cue shorter than a frame that falls between frame times covers no frame.
    expect(cueFrameRange({ start: 0.01, end: 0.02, text: 'x' }, 25)).toBeNull();
  });
});
