/** Straight (non-premultiplied) RGBA; r/g/b 0–255, a 0–1. */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC = /^rgba?\(\s*(\d{1,3}(?:\.\d+)?)\s*[, ]\s*(\d{1,3}(?:\.\d+)?)\s*[, ]\s*(\d{1,3}(?:\.\d+)?)\s*(?:[,/]\s*(\d*(?:\.\d+)?%?)\s*)?\)$/i;

/** Parses the color formats a spec may use. Returns null for anything else (no named colors except 'transparent'). */
export function parseColor(input: string): RGBA | null {
  const value = input.trim();
  if (value.toLowerCase() === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = HEX.exec(value);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1 };
  }
  const fn = FUNC.exec(value);
  if (fn) {
    const [r, g, b] = [fn[1], fn[2], fn[3]].map(Number);
    if (r > 255 || g > 255 || b > 255) return null;
    let a = 1;
    if (fn[4] !== undefined && fn[4] !== '') a = fn[4].endsWith('%') ? Number(fn[4].slice(0, -1)) / 100 : Number(fn[4]);
    if (!Number.isFinite(a) || a < 0 || a > 1) return null;
    return { r, g, b, a };
  }
  return null;
}

export function isColor(value: unknown): value is string {
  return typeof value === 'string' && parseColor(value) !== null;
}

export function toCss({ r, g, b, a }: RGBA): string {
  const c = (n: number) => Math.round(Math.min(255, Math.max(0, n)));
  return `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${Math.round(Math.min(1, Math.max(0, a)) * 1000) / 1000})`;
}

/** Linear interpolation in straight RGBA. */
export function mixColor(a: RGBA, b: RGBA, t: number): RGBA {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t };
}

/** Returns a CSS color with its alpha multiplied by `alpha`. */
export function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color) ?? { r: 0, g: 0, b: 0, a: 1 };
  return toCss({ ...c, a: c.a * alpha });
}
