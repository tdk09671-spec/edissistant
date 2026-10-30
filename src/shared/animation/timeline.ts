// Frame math. All timing is derived from integer frame indices so renders are frame-accurate and
// deterministic: frame f shows the instant t = f / fps (its leading edge).

export interface Rational {
  num: number;
  den: number;
}

const NTSC: Record<string, Rational> = {
  '23.976': { num: 24000, den: 1001 },
  '29.97': { num: 30000, den: 1001 },
  '47.952': { num: 48000, den: 1001 },
  '59.94': { num: 60000, den: 1001 },
  '119.88': { num: 120000, den: 1001 },
};

/** Exact frame rate as a rational: NTSC rates (29.97 …) map to n*1000/1001. */
export function fpsRational(fps: number): Rational {
  for (const [label, rate] of Object.entries(NTSC)) {
    if (Math.abs(fps - Number(label)) < 0.005) return rate;
  }
  if (Number.isInteger(fps)) return { num: fps, den: 1 };
  // Any other fractional rate: keep 3 decimal places.
  return { num: Math.round(fps * 1000), den: 1000 };
}

export function isSupportedFps(fps: number): boolean {
  return Number.isFinite(fps) && fps >= 1 && fps <= 120 && (Number.isInteger(fps) || fpsRational(fps).den === 1001);
}

/** For FFmpeg: "30000/1001", "25". */
export function fpsString(fps: number): string {
  const r = fpsRational(fps);
  return r.den === 1 ? String(r.num) : `${r.num}/${r.den}`;
}

/** Number of frames that cover `seconds` (rounded to the nearest frame). */
export function secondsToFrames(seconds: number, fps: number): number {
  const r = fpsRational(fps);
  return Math.round((seconds * r.num) / r.den + 1e-9);
}

/** Leading-edge time of frame `frame`. */
export function frameToSeconds(frame: number, fps: number): number {
  const r = fpsRational(fps);
  return (frame * r.den) / r.num;
}

export function frameCount(duration: number, fps: number): number {
  return Math.max(1, secondsToFrames(duration, fps));
}

/** Exact duration of `frames` frames. */
export function framesDuration(frames: number, fps: number): number {
  return frameToSeconds(frames, fps);
}

/** SMPTE-style non-drop timecode HH:MM:SS:FF (nominal integer rate). */
export function frameToTimecode(frame: number, fps: number): string {
  const rate = Math.round(fps);
  const ff = frame % rate;
  const total = Math.floor(frame / rate);
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60, ff].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Progress of `t` through [start, start + duration], clamped to 0–1. */
export function progressBetween(t: number, start: number, duration: number): number {
  if (duration <= 0) return t >= start ? 1 : 0;
  return Math.min(1, Math.max(0, (t - start) / duration));
}
