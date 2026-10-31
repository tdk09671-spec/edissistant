import { ease } from '../easing';
import { resolveNumber } from '../keyframes';
import { frameToSeconds } from '../timeline';
import type { AnimationSpec, BlendMode, Direction, Layer, Mask, Transform, Transition } from '../types';
import type { Ctx2D, RenderEnv } from './context';
import { drawBackground } from './backgrounds';
import { componentFor } from './registry';

const BLEND: Record<BlendMode, string> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  add: 'lighter',
};

export interface TransitionState {
  alpha: number;
  dx: number;
  dy: number;
  scale: number;
  blur: number;
  /** Fraction of the frame revealed by a wipe (1 = fully visible), with its direction. */
  wipe?: { direction: Direction; amount: number };
}

const DIR: Record<Direction, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

/**
 * Combined effect of a layer's enter and exit transitions at local time `t`.
 * Enter: `direction` is the way the layer moves as it arrives. Exit: the way it leaves.
 */
export function transitionState(enter: Transition | undefined, exit: Transition | undefined, t: number, duration: number): TransitionState {
  const state: TransitionState = { alpha: 1, dx: 0, dy: 0, scale: 1, blur: 0 };
  const apply = (tr: Transition, k: number, entering: boolean) => {
    // k: 0 = fully hidden, 1 = fully shown.
    const hidden = 1 - k;
    const [ux, uy] = DIR[tr.direction ?? (entering ? 'up' : 'down')];
    switch (tr.type) {
      case 'fade':
        state.alpha *= k;
        break;
      case 'slide': {
        const d = (tr.distance ?? 60) * hidden;
        // Entering moves along the direction into place, so it starts behind it; leaving moves on.
        state.dx += (entering ? -ux : ux) * d;
        state.dy += (entering ? -uy : uy) * d;
        state.alpha *= k;
        break;
      }
      case 'scale':
        state.scale *= entering ? 0.8 + 0.2 * k : 1 - 0.2 * hidden;
        state.alpha *= k;
        break;
      case 'blur':
        state.blur += (tr.distance ?? 12) * hidden;
        state.alpha *= k;
        break;
      case 'wipe':
        state.wipe = { direction: tr.direction ?? 'right', amount: k };
        break;
    }
  };
  if (enter && enter.duration > 0 && t < enter.duration) apply(enter, ease(t / enter.duration, enter.easing, 'easeOutCubic'), true);
  if (exit && exit.duration > 0 && t > duration - exit.duration) {
    apply(exit, ease((duration - t) / exit.duration, exit.easing, 'easeInCubic'), false);
  }
  return state;
}

/** Clips to the part of the frame revealed by a wipe moving in `direction` that is `amount` complete. */
function clipWipe(ctx: Ctx2D, direction: Direction, amount: number, w: number, h: number): void {
  const a = Math.min(1, Math.max(0, amount));
  ctx.beginPath();
  if (direction === 'right') ctx.rect(0, 0, w * a, h);
  else if (direction === 'left') ctx.rect(w * (1 - a), 0, w * a, h);
  else if (direction === 'down') ctx.rect(0, 0, w, h * a);
  else ctx.rect(0, h * (1 - a), w, h * a);
  ctx.clip();
}

function applyMask(ctx: Ctx2D, mask: Mask, t: number, env: RenderEnv): void {
  if (mask.type === 'wipe') {
    clipWipe(ctx, mask.direction, resolveNumber(mask.progress, t, 1), env.width, env.height);
  } else {
    ctx.beginPath();
    ctx.rect(resolveNumber(mask.x, t, 0), resolveNumber(mask.y, t, 0), resolveNumber(mask.width, t, env.width), resolveNumber(mask.height, t, env.height));
    ctx.clip();
  }
}

function applyTransform(ctx: Ctx2D, tr: Transform | undefined, t: number, extra: { dx: number; dy: number; scale: number }): void {
  ctx.translate(resolveNumber(tr?.x, t, 0) + extra.dx, resolveNumber(tr?.y, t, 0) + extra.dy);
  const rotation = resolveNumber(tr?.rotation, t, 0);
  if (rotation) ctx.rotate((rotation * Math.PI) / 180);
  const s = resolveNumber(tr?.scale, t, 1) * extra.scale;
  const sx = s * resolveNumber(tr?.scaleX, t, 1);
  const sy = s * resolveNumber(tr?.scaleY, t, 1);
  if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);
}

/** Draws layers active at `t` (seconds relative to their parent: the segment or a group). */
export function drawLayers(ctx: Ctx2D, layers: readonly Layer[], t: number, parentDuration: number, segmentTime: number, env: RenderEnv): void {
  for (const layer of layers) {
    const start = layer.start ?? 0;
    const end = layer.end ?? parentDuration;
    if (t < start || t >= end) continue;
    const local = t - start;
    const duration = end - start;
    const component = componentFor(layer.type);
    if (!component) continue;

    const tr = transitionState(layer.enter, layer.exit, local, duration);
    const alpha = Math.min(1, Math.max(0, resolveNumber(layer.opacity, local, 1))) * tr.alpha;
    if (alpha <= 0) continue;

    ctx.save();
    ctx.globalCompositeOperation = BLEND[layer.blendMode ?? 'normal'];
    ctx.globalAlpha *= alpha;
    // Masks and wipes are in frame coordinates (after the camera, before the layer's own transform).
    if (layer.mask) applyMask(ctx, layer.mask, local, env);
    if (tr.wipe) clipWipe(ctx, tr.wipe.direction, tr.wipe.amount, env.width, env.height);
    if (tr.blur > 0 && 'filter' in ctx) ctx.filter = `blur(${(tr.blur * env.scale).toFixed(2)}px)`;
    applyTransform(ctx, layer.transform, local, tr);
    component.draw(ctx, layer.props as never, { t: local, duration, segmentTime }, env, {
      drawLayers: (children, childT, childDuration, segT) => drawLayers(ctx, children, childT, childDuration, segT, env),
    });
    ctx.restore();
  }
}

/**
 * Renders frame `frame` of a validated spec. The canvas must be `round(width*scale) × round(height*scale)`.
 * Pure function of (spec, frame, env): the same inputs always produce the same pixels.
 */
export function renderFrame(ctx: Ctx2D, spec: AnimationSpec, frame: number, env: RenderEnv): void {
  const t = frameToSeconds(frame, spec.fps);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, Math.round(spec.width * env.scale), Math.round(spec.height * env.scale));
  ctx.scale(env.scale, env.scale);
  drawBackground(ctx, spec.background, frame, env);

  ctx.save();
  if (spec.camera) {
    // Camera moves happen around the frame center: x/y pan, scale zooms, rotation rolls.
    const cx = spec.width / 2;
    const cy = spec.height / 2;
    ctx.translate(cx, cy);
    applyTransform(ctx, spec.camera, t, { dx: 0, dy: 0, scale: 1 });
    ctx.translate(-cx, -cy);
  }
  drawLayers(ctx, spec.layers, t, spec.duration, t, env);
  ctx.restore();
}
