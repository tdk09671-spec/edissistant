// Pixel maths for the scene renderer: multisample motion blur and the post-capture camera.
//
// Motion blur averages subframes in PREMULTIPLIED space and converts back to straight alpha, so a
// semi-transparent edge keeps its true colour (averaging straight RGBA darkens edges towards black).
// This is the same maths as the podcast skill's render.py.
//
// The post-capture camera ("POSTCAM" in the SaaS skill) scales the un-zoomed capture about a focal
// point with a sub-pixel bicubic resample, so slow pushes don't make text and edges re-snap to whole
// pixels every frame the way a CSS scale does.

/** Accumulates premultiplied RGBA subframes. */
export class Accumulator {
  private readonly sum: Float32Array;
  private count = 0;

  constructor(readonly width: number, readonly height: number) {
    this.sum = new Float32Array(width * height * 4);
  }

  /** Adds a straight-alpha RGBA frame. */
  addStraight(rgba: Uint8Array): void {
    const s = this.sum;
    for (let i = 0; i < rgba.length; i += 4) {
      const a = rgba[i + 3];
      const k = a / 255;
      s[i] += rgba[i] * k;
      s[i + 1] += rgba[i + 1] * k;
      s[i + 2] += rgba[i + 2] * k;
      s[i + 3] += a;
    }
    this.count++;
  }

  /** Adds a frame that is already premultiplied (floats, 0–255 scale). */
  addPremultiplied(p: Float32Array): void {
    const s = this.sum;
    for (let i = 0; i < p.length; i++) s[i] += p[i];
    this.count++;
  }

  /**
   * Mean of the subframes as straight RGBA, rounded like render.py (+0.5, clipped). Premultiplied colour
   * is limited to [0, alpha] first (a resample's overshoot can't create light or negative light).
   */
  toStraight(): Uint8Array {
    const out = new Uint8Array(this.sum.length);
    const n = this.count || 1;
    const s = this.sum;
    for (let i = 0; i < s.length; i += 4) {
      const a = Math.min(255, s[i + 3] / n);
      out[i + 3] = Math.max(0, Math.floor(a + 0.5));
      if (a <= 0) continue;
      for (let c = 0; c < 3; c++) s[i + c] = Math.min(a * n, Math.max(0, s[i + c]));
      const k = 255 / a / n;
      out[i] = Math.min(255, Math.max(0, Math.floor(s[i] * k + 0.5)));
      out[i + 1] = Math.min(255, Math.max(0, Math.floor(s[i + 1] * k + 0.5)));
      out[i + 2] = Math.min(255, Math.max(0, Math.floor(s[i + 2] * k + 0.5)));
    }
    return out;
  }
}

/** Straight RGBA → premultiplied floats (0–255). */
export function premultiply(rgba: Uint8Array): Float32Array {
  const p = new Float32Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const k = rgba[i + 3] / 255;
    p[i] = rgba[i] * k;
    p[i + 1] = rgba[i + 1] * k;
    p[i + 2] = rgba[i + 2] * k;
    p[i + 3] = rgba[i + 3];
  }
  return p;
}

/** Catmull-Rom (Keys a = −0.5) cubic weights for fractional offset f. */
function cubicWeights(f: number, w: Float64Array, o: number): void {
  const a = -0.5;
  const x0 = 1 + f;
  const x1 = f;
  const x2 = 1 - f;
  const x3 = 2 - f;
  w[o] = ((a * x0 - 5 * a) * x0 + 8 * a) * x0 - 4 * a;
  w[o + 1] = ((a + 2) * x1 - (a + 3)) * x1 * x1 + 1;
  w[o + 2] = ((a + 2) * x2 - (a + 3)) * x2 * x2 + 1;
  w[o + 3] = ((a * x3 - 5 * a) * x3 + 8 * a) * x3 - 4 * a;
}

export interface CameraState {
  /** Zoom factor (1 = none). */
  scale: number;
  /** Focal point in output pixels (defaults to the centre). */
  originX?: number;
  originY?: number;
  /** Pan in output pixels, applied after the zoom. */
  x?: number;
  y?: number;
}

/**
 * Applies a camera (scale about a focal point, then pan) to premultiplied RGBA floats with a separable
 * bicubic resample. Out-of-frame samples clamp to the edge. Returns a new premultiplied buffer.
 */
export function applyCamera(src: Float32Array, width: number, height: number, cam: CameraState): Float32Array {
  const s = cam.scale;
  if (!(s > 0)) throw new Error('Camera scale must be positive.');
  const ox = cam.originX ?? width / 2;
  const oy = cam.originY ?? height / 2;
  const px = cam.x ?? 0;
  const py = cam.y ?? 0;
  if (s === 1 && px === 0 && py === 0) return src;
  // Output pixel centre u+0.5 maps to source coordinate ((u+0.5 − px − ox) / s + ox) − 0.5.
  const map = (n: number, origin: number, pan: number) => {
    const idx = new Int32Array(n * 4);
    const wts = new Float64Array(n * 4);
    for (let u = 0; u < n; u++) {
      const sx = (u + 0.5 - pan - origin) / s + origin - 0.5;
      const i0 = Math.floor(sx);
      cubicWeights(sx - i0, wts, u * 4);
      for (let k = 0; k < 4; k++) idx[u * 4 + k] = Math.min(n - 1, Math.max(0, i0 - 1 + k));
    }
    return { idx, wts };
  };
  const mx = map(width, ox, px);
  const my = map(height, oy, py);
  // Horizontal pass.
  const tmp = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let u = 0; u < width; u++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < 4; k++) {
        const w = mx.wts[u * 4 + k];
        const j = row + mx.idx[u * 4 + k] * 4;
        r += src[j] * w;
        g += src[j + 1] * w;
        b += src[j + 2] * w;
        a += src[j + 3] * w;
      }
      const o = row + u * 4;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
      tmp[o + 3] = a;
    }
  }
  // Vertical pass. No clamping here: the cubic's small over/undershoot at hard edges is kept in float
  // and clamped once, when the averaged frame becomes 8-bit (Accumulator.toStraight). Clamping per pass
  // would bias edge positions by a few hundredths of a pixel and make slow pushes step unevenly.
  const out = new Float32Array(width * height * 4);
  for (let v = 0; v < height; v++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < 4; k++) {
        const w = my.wts[v * 4 + k];
        const j = (my.idx[v * 4 + k] * width + x) * 4;
        r += tmp[j] * w;
        g += tmp[j + 1] * w;
        b += tmp[j + 2] * w;
        a += tmp[j + 3] * w;
      }
      const o = (v * width + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  return out;
}

export interface MotionBlur {
  /** Subframes per frame (1 = no blur). */
  samples: number;
  /** Fraction of a frame the shutter stays open (render.py default 0.5). */
  shutter: number;
  /** Time windows (scene seconds) that get more subframes, for fast hits. */
  heavy?: { from: number; to: number; samples: number }[];
}

/** Subframe times for a frame starting at `t` (seconds), like render.py: t + (k/n)·shutter/fps. */
export function subframeTimes(t: number, frameDuration: number, blur: MotionBlur): number[] {
  const heavy = blur.heavy?.find((h) => t >= h.from && t <= h.to);
  const n = Math.max(1, Math.floor(heavy?.samples ?? blur.samples));
  return Array.from({ length: n }, (_, k) => t + (k / n) * blur.shutter * frameDuration);
}
