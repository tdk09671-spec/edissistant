import { withAlpha } from '../color';
import { seededRandom } from '../random';
import type { Background } from '../types';
import type { CanvasLike, Ctx2D, RenderEnv } from './context';
import { drawImageFit } from './components/media';

const GRAIN_TILE = 256;
const GRAIN_VARIANTS = 6;

/** A tile of gray noise with per-pixel alpha, built once per render. */
function noiseTile(env: RenderEnv, seed: number): CanvasLike | null {
  const canvas = env.createCanvas(GRAIN_TILE, GRAIN_TILE);
  const ctx = canvas.getContext('2d');
  if (!ctx?.createImageData || !ctx.putImageData) return null;
  const img = ctx.createImageData(GRAIN_TILE, GRAIN_TILE);
  const rand = seededRandom(seed);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = rand() < 0.5 ? 0 : 255;
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = Math.floor(rand() * 255);
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function fillPattern(ctx: Ctx2D, tile: CanvasLike | null, alpha: number, w: number, h: number, blend = 'source-over'): void {
  if (!tile || alpha <= 0 || !ctx.createPattern) return;
  const pattern = ctx.createPattern(tile, 'repeat');
  if (!pattern) return;
  ctx.save();
  ctx.globalCompositeOperation = blend;
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** Paper texture at output resolution: mottling, fibres and grain, deterministic from the seed. */
function paperTexture(env: RenderEnv, bg: Extract<Background, { type: 'paper' }>): CanvasLike {
  const { width: w, height: h, scale } = env;
  const canvas = env.createCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  const rand = seededRandom(env.seed * 7919 + 17);
  ctx.fillStyle = bg.color ?? '#f2ece0';
  ctx.fillRect(0, 0, w, h);

  // Soft light/dark mottling. Soft-light blending shifts tones both ways, so the average stays
  // close to the chosen paper color.
  ctx.save();
  ctx.globalCompositeOperation = 'soft-light';
  for (let i = 0; i < 40; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const r = (0.08 + rand() * 0.25) * Math.max(w, h);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const tone = rand() < 0.5 ? '#000000' : '#ffffff';
    g.addColorStop(0, withAlpha(tone, 0.2 + rand() * 0.2));
    g.addColorStop(1, withAlpha(tone, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();

  // Fibres: short, faint curved strokes.
  const fibres = Math.round(((bg.fibers ?? 0.5) * w * h) / 4000);
  ctx.lineCap = 'round';
  for (let i = 0; i < fibres; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const len = 6 + rand() * 26;
    const a = rand() * Math.PI * 2;
    ctx.strokeStyle = withAlpha(rand() < 0.6 ? '#5a4a30' : '#ffffff', 0.05 + rand() * 0.07);
    ctx.lineWidth = 0.4 + rand() * 0.8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + Math.cos(a + 0.6) * len * 0.5, y + Math.sin(a + 0.6) * len * 0.5, x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  fillPattern(ctx, noiseTile(env, env.seed + 101), (bg.grain ?? 0.5) * 0.35, canvas.width, canvas.height, 'soft-light');
  return canvas;
}

/**
 * Draws the background in spec pixels (the context is already scaled to output pixels).
 * `frame` drives animated grain.
 */
export function drawBackground(ctx: Ctx2D, bg: Background, frame: number, env: RenderEnv): void {
  const { width: w, height: h } = env;
  switch (bg.type) {
    case 'transparent':
      return;
    case 'solid':
      ctx.fillStyle = bg.color;
      ctx.fillRect(0, 0, w, h);
      return;
    case 'gradient': {
      let g;
      if (bg.kind === 'radial') {
        g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
      } else {
        // angle 0 = left → right, 90 = top → bottom.
        const a = ((bg.angle ?? 90) * Math.PI) / 180;
        const r = (Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))) / 2;
        g = ctx.createLinearGradient(w / 2 - Math.cos(a) * r, h / 2 - Math.sin(a) * r, w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r);
      }
      for (const stop of bg.stops) g.addColorStop(stop.offset, stop.color);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      return;
    }
    case 'paper': {
      const texture = env.memo('bg:paper', () => paperTexture(env, bg));
      ctx.drawImage(texture, 0, 0, w, h);
      return;
    }
    case 'cinematic': {
      ctx.fillStyle = bg.color ?? '#0b0d12';
      ctx.fillRect(0, 0, w, h);
      if (bg.light) {
        const g = ctx.createRadialGradient(w / 2, h * 0.25, 0, w / 2, h * 0.25, Math.max(w, h) * 0.7);
        g.addColorStop(0, withAlpha(bg.light, 0.35));
        g.addColorStop(1, withAlpha(bg.light, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
      const vignette = bg.vignette ?? 0.6;
      if (vignette > 0) {
        const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) / 2);
        g.addColorStop(0, 'rgba(0, 0, 0, 0)');
        g.addColorStop(1, withAlpha('#000000', Math.min(1, vignette)));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
      const grain = bg.grain ?? 0.3;
      if (grain > 0) {
        const tiles = env.memo('bg:grain', () => Array.from({ length: GRAIN_VARIANTS }, (_, i) => noiseTile(env, env.seed * 31 + i)));
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        fillPattern(ctx, tiles[frame % GRAIN_VARIANTS], grain * 0.1, Math.round(w * env.scale), Math.round(h * env.scale));
        ctx.restore();
      }
      return;
    }
    case 'image': {
      const image = env.image(bg.asset);
      if (!image) return;
      ctx.save();
      ctx.translate(w / 2, h / 2);
      drawImageFit(ctx, image, w, h, bg.fit ?? 'cover');
      ctx.restore();
      return;
    }
  }
}
