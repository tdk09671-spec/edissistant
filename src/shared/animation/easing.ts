import type { Easing, EasingName } from './types';

type Fn = (t: number) => number;

const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;

function bounceOut(t: number): number {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}

export const EASINGS: Record<EasingName, Fn> = {
  linear: (t) => t,
  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => 1 - (1 - t) * (1 - t),
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  easeInCubic: (t) => t ** 3,
  easeOutCubic: (t) => 1 - (1 - t) ** 3,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  easeInQuart: (t) => t ** 4,
  easeOutQuart: (t) => 1 - (1 - t) ** 4,
  easeInOutQuart: (t) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2),
  easeInExpo: (t) => (t === 0 ? 0 : 2 ** (10 * t - 10)),
  easeOutExpo: (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t)),
  easeInOutExpo: (t) => (t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2),
  easeInBack: (t) => c3 * t ** 3 - c1 * t * t,
  easeOutBack: (t) => 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2,
  easeInOutBack: (t) =>
    t < 0.5 ? ((2 * t) ** 2 * ((c2 + 1) * 2 * t - c2)) / 2 : ((2 * t - 2) ** 2 * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2,
  easeOutElastic: (t) => (t === 0 ? 0 : t === 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  easeOutBounce: bounceOut,
};

export const EASING_NAMES = Object.keys(EASINGS) as EasingName[];

/** CSS cubic-bezier(x1, y1, x2, y2): solves x(s) = t with Newton steps, then bisection. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Fn {
  const bez = (s: number, a: number, b: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  const dBez = (s: number, a: number, b: number) => 3 * a * (1 - s) ** 2 + 6 * (b - a) * s * (1 - s) + 3 * (1 - b) * s * s;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let s = t;
    for (let i = 0; i < 8; i++) {
      const err = bez(s, x1, x2) - t;
      if (Math.abs(err) < 1e-7) return bez(s, y1, y2);
      const d = dBez(s, x1, x2);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0;
    let hi = 1;
    s = t;
    for (let i = 0; i < 40; i++) {
      const x = bez(s, x1, x2);
      if (Math.abs(x - t) < 1e-7) break;
      if (x < t) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return bez(s, y1, y2);
  };
}

export function easingFn(easing: Easing | undefined, fallback: EasingName = 'easeInOutCubic'): Fn {
  if (easing === undefined) return EASINGS[fallback];
  if (typeof easing === 'string') return EASINGS[easing] ?? EASINGS[fallback];
  if ('cubicBezier' in easing) return cubicBezier(...easing.cubicBezier);
  const steps = Math.max(1, Math.floor(easing.steps));
  return (t) => Math.min(1, Math.floor(t * steps) / steps);
}

/** Applies an easing to a clamped 0–1 progress. */
export function ease(progress: number, easing?: Easing, fallback?: EasingName): number {
  const p = Math.min(1, Math.max(0, progress));
  return easingFn(easing, fallback)(p);
}
