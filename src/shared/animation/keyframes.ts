import { mixColor, parseColor, toCss } from './color';
import { ease } from './easing';
import type { Animatable, Keyframe } from './types';

export function isKeyframed<T>(value: Animatable<T> | undefined): value is { keyframes: Keyframe<T>[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { keyframes?: unknown }).keyframes);
}

/** Finds the keyframe pair around `t` and the eased progress between them. */
function segmentAt<T>(keyframes: Keyframe<T>[], t: number): { a: Keyframe<T>; b: Keyframe<T>; p: number } {
  const sorted = keyframes.length > 1 && keyframes.some((k, i) => i > 0 && k.t < keyframes[i - 1].t) ? [...keyframes].sort((x, y) => x.t - y.t) : keyframes;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (t <= first.t) return { a: first, b: first, p: 0 };
  if (t >= last.t) return { a: last, b: last, p: 0 };
  let i = 0;
  while (i < sorted.length - 2 && t >= sorted[i + 1].t) i++;
  const a = sorted[i];
  const b = sorted[i + 1];
  const span = b.t - a.t;
  return { a, b, p: span > 0 ? ease((t - a.t) / span, a.easing) : 1 };
}

/** Value of an animatable number at local time `t` (holds the first/last value outside the keyframes). */
export function resolveNumber(value: Animatable<number> | undefined, t: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!isKeyframed(value)) return value;
  if (value.keyframes.length === 0) return fallback;
  const { a, b, p } = segmentAt(value.keyframes, t);
  return a.value + (b.value - a.value) * p;
}

/** Value of an animatable color at local time `t`, as a CSS rgba() string. */
export function resolveColor(value: Animatable<string> | undefined, t: number, fallback: string): string {
  if (value === undefined) return fallback;
  if (!isKeyframed(value)) return value;
  if (value.keyframes.length === 0) return fallback;
  const { a, b, p } = segmentAt(value.keyframes, t);
  const ca = parseColor(a.value);
  const cb = parseColor(b.value);
  if (!ca || !cb) return a.value;
  return p === 0 ? a.value : toCss(mixColor(ca, cb, p));
}
