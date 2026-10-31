// Small schema-checking toolkit used to validate animation specs (and each component's props).
// Strict by design: unknown properties are errors, so typos and unsupported features from a planner
// are caught before anything renders.

import { isColor } from './color';
import { EASING_NAMES } from './easing';
import type { Typography } from './types';

export interface SpecIssue {
  /** Dotted path to the offending value, e.g. "layers[2].props.typography.fontSize". */
  path: string;
  message: string;
}

export type Obj = Record<string, unknown>;

interface NumberRule {
  required?: boolean;
  min?: number;
  max?: number;
  integer?: boolean;
}

interface StringRule {
  required?: boolean;
  maxLength?: number;
  pattern?: RegExp;
  patternMessage?: string;
  allowEmpty?: boolean;
}

export const GENERIC_FONTS = ['sans-serif', 'serif', 'monospace'] as const;
/** Family names are quoted into CSS font strings, so quotes, commas and semicolons are not allowed. */
export const FONT_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 _\-.]{0,63}$/;

export const join = (path: string, key: string | number) => (typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key);

export class Checker {
  readonly issues: SpecIssue[] = [];
  readonly warnings: SpecIssue[] = [];
  /** Every typography seen, so the renderer can check font availability. */
  readonly typographies: Typography[] = [];

  fail(path: string, message: string): void {
    this.issues.push({ path: path || '(root)', message });
  }

  warn(path: string, message: string): void {
    this.warnings.push({ path: path || '(root)', message });
  }

  object(value: unknown, path: string): Obj | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(path, 'must be an object');
      return null;
    }
    return value as Obj;
  }

  keys(o: Obj, path: string, allowed: readonly string[]): void {
    for (const key of Object.keys(o)) {
      if (!allowed.includes(key)) this.fail(join(path, key), 'unknown property');
    }
  }

  private missing(o: Obj, key: string, path: string, required: boolean | undefined): boolean {
    if (o[key] !== undefined) return false;
    if (required) this.fail(join(path, key), 'is required');
    return true;
  }

  number(o: Obj, key: string, path: string, rule: NumberRule = {}): number | undefined {
    if (this.missing(o, key, path, rule.required)) return undefined;
    return this.numberValue(o[key], join(path, key), rule);
  }

  numberValue(value: unknown, path: string, rule: NumberRule = {}): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.fail(path, 'must be a finite number');
      return undefined;
    }
    if (rule.integer && !Number.isInteger(value)) this.fail(path, 'must be an integer');
    if (rule.min !== undefined && value < rule.min) this.fail(path, `must be ≥ ${rule.min}`);
    if (rule.max !== undefined && value > rule.max) this.fail(path, `must be ≤ ${rule.max}`);
    return value;
  }

  string(o: Obj, key: string, path: string, rule: StringRule = {}): string | undefined {
    if (this.missing(o, key, path, rule.required)) return undefined;
    const value = o[key];
    const p = join(path, key);
    if (typeof value !== 'string') {
      this.fail(p, 'must be a string');
      return undefined;
    }
    if (!rule.allowEmpty && value.trim() === '') this.fail(p, 'must not be empty');
    if (value.length > (rule.maxLength ?? 2000)) this.fail(p, `must be at most ${rule.maxLength ?? 2000} characters`);
    if (rule.pattern && !rule.pattern.test(value)) this.fail(p, rule.patternMessage ?? 'has an invalid format');
    return value;
  }

  boolean(o: Obj, key: string, path: string, required = false): boolean | undefined {
    if (this.missing(o, key, path, required)) return undefined;
    if (typeof o[key] !== 'boolean') {
      this.fail(join(path, key), 'must be true or false');
      return undefined;
    }
    return o[key] as boolean;
  }

  oneOf<T extends string>(o: Obj, key: string, path: string, values: readonly T[], required = false): T | undefined {
    if (this.missing(o, key, path, required)) return undefined;
    if (!values.includes(o[key] as T)) {
      this.fail(join(path, key), `must be one of: ${values.join(', ')}`);
      return undefined;
    }
    return o[key] as T;
  }

  color(o: Obj, key: string, path: string, required = false): string | undefined {
    if (this.missing(o, key, path, required)) return undefined;
    if (!isColor(o[key])) {
      this.fail(join(path, key), 'must be a color (#rgb, #rrggbb, #rrggbbaa, rgb(), rgba() or "transparent")');
      return undefined;
    }
    return o[key] as string;
  }

  array(o: Obj, key: string, path: string, rule: { required?: boolean; min?: number; max?: number } = {}): unknown[] | undefined {
    if (this.missing(o, key, path, rule.required)) return undefined;
    const value = o[key];
    const p = join(path, key);
    if (!Array.isArray(value)) {
      this.fail(p, 'must be an array');
      return undefined;
    }
    if (rule.min !== undefined && value.length < rule.min) this.fail(p, `needs at least ${rule.min} item(s)`);
    if (value.length > (rule.max ?? 1000)) this.fail(p, `must have at most ${rule.max ?? 1000} items`);
    return value;
  }

  easing(value: unknown, path: string): void {
    if (typeof value === 'string') {
      if (!(EASING_NAMES as string[]).includes(value)) this.fail(path, `unknown easing; use one of ${EASING_NAMES.join(', ')}, {cubicBezier}, or {steps}`);
      return;
    }
    const o = this.object(value, path);
    if (!o) return;
    if ('cubicBezier' in o) {
      this.keys(o, path, ['cubicBezier']);
      const arr = o.cubicBezier;
      if (!Array.isArray(arr) || arr.length !== 4 || !arr.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        this.fail(join(path, 'cubicBezier'), 'must be four numbers');
      } else if (arr[0] < 0 || arr[0] > 1 || arr[2] < 0 || arr[2] > 1) {
        this.fail(join(path, 'cubicBezier'), 'x1 and x2 must be between 0 and 1');
      }
    } else if ('steps' in o) {
      this.keys(o, path, ['steps']);
      this.number(o, 'steps', path, { required: true, integer: true, min: 1, max: 1000 });
    } else {
      this.fail(path, 'must be an easing name, {cubicBezier: [x1, y1, x2, y2]} or {steps: n}');
    }
  }

  private keyframes(o: Obj, path: string, checkValue: (v: unknown, p: string) => void): void {
    this.keys(o, path, ['keyframes']);
    const list = this.array(o, 'keyframes', path, { required: true, min: 1, max: 500 });
    list?.forEach((item, i) => {
      const p = join(join(path, 'keyframes'), i);
      const k = this.object(item, p);
      if (!k) return;
      this.keys(k, p, ['t', 'value', 'easing']);
      this.number(k, 't', p, { required: true, min: 0, max: 3600 });
      if (k.value === undefined) this.fail(join(p, 'value'), 'is required');
      else checkValue(k.value, join(p, 'value'));
      if (k.easing !== undefined) this.easing(k.easing, join(p, 'easing'));
    });
  }

  animNumber(o: Obj, key: string, path: string, rule: NumberRule = {}): void {
    if (this.missing(o, key, path, rule.required)) return;
    const value = o[key];
    const p = join(path, key);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      this.keyframes(value as Obj, p, (v, vp) => this.numberValue(v, vp, rule));
    } else {
      this.numberValue(value, p, rule);
    }
  }

  animColor(o: Obj, key: string, path: string, required = false): void {
    if (this.missing(o, key, path, required)) return;
    const value = o[key];
    const p = join(path, key);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      this.keyframes(value as Obj, p, (v, vp) => {
        if (!isColor(v)) this.fail(vp, 'must be a color');
      });
    } else if (!isColor(value)) {
      this.fail(p, 'must be a color or {keyframes}');
    }
  }

  typography(o: Obj, key: string, path: string, required = true): void {
    if (this.missing(o, key, path, required)) return;
    const p = join(path, key);
    const t = this.object(o[key], p);
    if (!t) return;
    this.keys(t, p, ['fontFamily', 'fallback', 'allowFallback', 'fontWeight', 'fontStyle', 'fontSize', 'letterSpacing', 'lineHeight', 'textTransform']);
    this.string(t, 'fontFamily', p, { required: true, pattern: FONT_FAMILY, patternMessage: 'may only contain letters, digits, spaces, "-", "_" and "."' });
    this.oneOf(t, 'fallback', p, GENERIC_FONTS);
    this.boolean(t, 'allowFallback', p);
    this.number(t, 'fontWeight', p, { integer: true, min: 1, max: 1000 });
    this.oneOf(t, 'fontStyle', p, ['normal', 'italic'] as const);
    this.number(t, 'fontSize', p, { required: true, min: 1, max: 2000 });
    this.number(t, 'letterSpacing', p, { min: -500, max: 500 });
    this.number(t, 'lineHeight', p, { min: 0.5, max: 5 });
    this.oneOf(t, 'textTransform', p, ['none', 'uppercase', 'lowercase'] as const);
    if (typeof t.fontFamily === 'string' && FONT_FAMILY.test(t.fontFamily)) this.typographies.push(t as unknown as Typography);
  }

  shadow(o: Obj, key: string, path: string): void {
    if (o[key] === undefined) return;
    const p = join(path, key);
    const s = this.object(o[key], p);
    if (!s) return;
    this.keys(s, p, ['color', 'blur', 'offsetX', 'offsetY']);
    this.color(s, 'color', p, true);
    this.number(s, 'blur', p, { required: true, min: 0, max: 500 });
    this.number(s, 'offsetX', p, { min: -2000, max: 2000 });
    this.number(s, 'offsetY', p, { min: -2000, max: 2000 });
  }

  glow(o: Obj, key: string, path: string): void {
    if (o[key] === undefined) return;
    const p = join(path, key);
    const g = this.object(o[key], p);
    if (!g) return;
    this.keys(g, p, ['color', 'blur', 'strength']);
    this.color(g, 'color', p, true);
    this.number(g, 'blur', p, { required: true, min: 0, max: 500 });
    this.number(g, 'strength', p, { integer: true, min: 1, max: 4 });
  }

  stroke(o: Obj, key: string, path: string): void {
    if (o[key] === undefined) return;
    const p = join(path, key);
    const s = this.object(o[key], p);
    if (!s) return;
    this.keys(s, p, ['color', 'width']);
    this.color(s, 'color', p, true);
    this.number(s, 'width', p, { required: true, min: 0, max: 500 });
  }

  labelStyle(o: Obj, key: string, path: string, extra: readonly string[] = []): Obj | null {
    if (o[key] === undefined) return null;
    const p = join(path, key);
    const l = this.object(o[key], p);
    if (!l) return null;
    this.keys(l, p, ['typography', 'color', ...extra]);
    this.typography(l, 'typography', p);
    this.color(l, 'color', p, true);
    return l;
  }
}
