import { captionAt } from '../../captions';
import { join, type Checker, type Obj } from '../../checker';
import { ease } from '../../easing';
import type { CaptionsProps, GroupLayer, ImageProps } from '../../types';
import { defineComponent } from '../component';
import type { Ctx2D } from '../context';
import { applyTypography, drawStyledText, layoutText, lineStartX, type TextStyle } from '../text';
import { roundRectPath } from './shapes';

export const MAX_GROUP_DEPTH = 4;

/** Destination rectangle (centered on the origin) for drawing an image of iw×ih into w×h. */
export function fitRect(iw: number, ih: number, w: number, h: number, fit: ImageProps['fit']): [number, number, number, number] {
  if (fit === 'fill' || iw <= 0 || ih <= 0) return [-w / 2, -h / 2, w, h];
  const s = fit === 'contain' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
  return [(-iw * s) / 2, (-ih * s) / 2, iw * s, ih * s];
}

export function drawImageFit(ctx: Ctx2D, image: { width: number; height: number }, w: number, h: number, fit: ImageProps['fit']): void {
  const [x, y, dw, dh] = fitRect(image.width, image.height, w, h, fit);
  ctx.save();
  if (fit !== 'contain') {
    ctx.beginPath();
    ctx.rect(-w / 2, -h / 2, w, h);
    ctx.clip();
  }
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, x, y, dw, dh);
  ctx.restore();
}

export const imageComponent = defineComponent<ImageProps>({
  type: 'image',
  validate(p, c, path, context) {
    c.keys(p, path, ['asset', 'width', 'height', 'fit']);
    const asset = c.string(p, 'asset', path, { required: true, maxLength: 128 });
    if (asset && !context.imageIds.has(asset)) c.fail(join(path, 'asset'), `unknown image asset "${asset}" (declare it in assets.images)`);
    c.number(p, 'width', path, { required: true, min: 1, max: 20000 });
    c.number(p, 'height', path, { required: true, min: 1, max: 20000 });
    c.oneOf(p, 'fit', path, ['cover', 'contain', 'fill'] as const);
  },
  draw(ctx, p, _time, env) {
    const image = env.image(p.asset);
    if (image) drawImageFit(ctx, image, p.width, p.height, p.fit ?? 'contain');
  },
});

// --- Captions --------------------------------------------------------------------------------------

function validateCaptionStyle(c: Checker, s: Obj, path: string): void {
  c.keys(s, path, ['typography', 'color', 'highlightColor', 'position', 'align', 'maxWidth', 'maxLines', 'stroke', 'shadow', 'glow', 'box']);
  c.typography(s, 'typography', path);
  c.color(s, 'color', path, true);
  c.color(s, 'highlightColor', path);
  if (s.position !== undefined) {
    const pp = join(path, 'position');
    const pos = c.object(s.position, pp);
    if (pos) {
      c.keys(pos, pp, ['x', 'y']);
      c.number(pos, 'x', pp, { required: true, min: 0, max: 1 });
      c.number(pos, 'y', pp, { required: true, min: 0, max: 1 });
    }
  }
  c.oneOf(s, 'align', path, ['left', 'center', 'right'] as const);
  c.number(s, 'maxWidth', path, { min: 0.05, max: 1 });
  c.number(s, 'maxLines', path, { integer: true, min: 1, max: 10 });
  c.stroke(s, 'stroke', path);
  c.shadow(s, 'shadow', path);
  c.glow(s, 'glow', path);
  if (s.box !== undefined) {
    const bp = join(path, 'box');
    const box = c.object(s.box, bp);
    if (box) {
      c.keys(box, bp, ['color', 'padding', 'radius']);
      c.color(box, 'color', bp, true);
      c.number(box, 'padding', bp, { required: true, min: 0, max: 500 });
      c.number(box, 'radius', bp, { min: 0, max: 500 });
    }
  }
}

export const captionsComponent = defineComponent<CaptionsProps>({
  type: 'captions',
  validate(p, c, path, context) {
    c.keys(p, path, ['cues', 'style', 'animation']);
    const cues = c.array(p, 'cues', path, { required: true, min: 1, max: 10000 });
    let previousStart = -Infinity;
    cues?.forEach((cue, i) => {
      const cp = join(join(path, 'cues'), i);
      const o = c.object(cue, cp);
      if (!o) return;
      c.keys(o, cp, ['start', 'end', 'text', 'words']);
      const start = c.number(o, 'start', cp, { required: true, min: 0, max: context.segmentDuration });
      const end = c.number(o, 'end', cp, { required: true, min: 0, max: context.segmentDuration + 1e-6 });
      c.string(o, 'text', cp, { required: true, maxLength: 1000 });
      if (start !== undefined && end !== undefined && end <= start) c.fail(join(cp, 'end'), 'must be after start');
      if (start !== undefined) {
        if (start < previousStart) c.fail(join(cp, 'start'), 'cues must be sorted by start time');
        previousStart = start;
      }
      const words = c.array(o, 'words', cp, { max: 500 });
      words?.forEach((w, j) => {
        const wp = join(join(cp, 'words'), j);
        const wo = c.object(w, wp);
        if (!wo) return;
        c.keys(wo, wp, ['text', 'start', 'end']);
        c.string(wo, 'text', wp, { required: true, maxLength: 100, pattern: /^\S+$/, patternMessage: 'must be a single word (no spaces)' });
        const ws = c.number(wo, 'start', wp, { required: true, min: 0, max: context.segmentDuration });
        const we = c.number(wo, 'end', wp, { required: true, min: 0, max: context.segmentDuration + 1e-6 });
        if (ws !== undefined && we !== undefined && we < ws) c.fail(join(wp, 'end'), 'must not be before start');
        if (ws !== undefined && start !== undefined && end !== undefined && (ws < start - 1e-6 || ws >= end)) c.fail(join(wp, 'start'), 'must fall inside the cue');
      });
    });
    const sp = join(path, 'style');
    const style = p.style === undefined ? (c.fail(sp, 'is required'), null) : c.object(p.style, sp);
    if (style) validateCaptionStyle(c, style, sp);
    if (p.animation !== undefined) {
      const ap = join(path, 'animation');
      const a = c.object(p.animation, ap);
      if (a) {
        c.keys(a, ap, ['in', 'out', 'inDuration', 'outDuration', 'highlightWords']);
        c.oneOf(a, 'in', ap, ['none', 'fade', 'pop', 'slide-up', 'typewriter'] as const);
        c.oneOf(a, 'out', ap, ['none', 'fade', 'slide-down'] as const);
        c.number(a, 'inDuration', ap, { min: 0, max: 30 });
        c.number(a, 'outDuration', ap, { min: 0, max: 30 });
        c.boolean(a, 'highlightWords', ap);
      }
    }
  },
  draw(ctx, p, time, env) {
    const animation = p.animation ?? {};
    const state = captionAt(p.cues, time.segmentTime, animation, 1 / env.fps);
    if (!state) return;
    const { cue } = state;
    const s = p.style;
    const typo = s.typography;
    const highlight = animation.highlightWords === true && cue.words && cue.words.length > 0;
    const text = highlight ? cue.words!.map((w) => w.text).join(' ') : cue.text;

    applyTypography(ctx, typo);
    const block = layoutText(ctx, text, typo, (s.maxWidth ?? 0.8) * env.width, s.maxLines);
    const align = s.align ?? 'center';
    const px = (s.position?.x ?? 0.5) * env.width;
    let py = (s.position?.y ?? 0.85) * env.height;

    let alpha = 1;
    let scale = 1;
    const inType = animation.in ?? 'fade';
    const outType = animation.out ?? 'fade';
    if (inType === 'fade') alpha *= state.inProgress;
    if (inType === 'pop') {
      scale = 0.85 + 0.15 * ease(state.inProgress, 'easeOutBack');
      alpha *= Math.min(1, state.inProgress * 2);
    }
    if (inType === 'slide-up') {
      py += (1 - ease(state.inProgress, 'easeOutCubic')) * typo.fontSize * 0.6;
      alpha *= state.inProgress;
    }
    if (outType === 'fade' || outType === 'slide-down') alpha *= 1 - state.outProgress;
    if (outType === 'slide-down') py += ease(state.outProgress, 'easeInCubic') * typo.fontSize * 0.6;
    if (alpha <= 0) return;

    const visibleChars = inType === 'typewriter' ? Math.round(text.length * state.inProgress) : Infinity;
    const top = py - block.height / 2;

    ctx.save();
    ctx.globalAlpha *= alpha;
    if (scale !== 1) {
      ctx.translate(px, py);
      ctx.scale(scale, scale);
      ctx.translate(-px, -py);
    }
    if (s.box) {
      const pad = s.box.padding;
      const x0 = px + lineStartX(block.width, align) - pad;
      roundRectPath(ctx, x0, top - pad, block.width + pad * 2, block.height + pad * 2, s.box.radius ?? 0);
      ctx.fillStyle = s.box.color;
      ctx.fill();
    }
    const base: TextStyle = { color: s.color, stroke: s.stroke, shadow: s.shadow, glow: s.glow };
    let charsLeft = visibleChars;
    let wordIndex = 0;
    block.lines.forEach((line, li) => {
      const y = top + li * block.lineHeight + block.lineHeight / 2;
      const x0 = px + lineStartX(line.width, align);
      if (!highlight) {
        const shown = charsLeft >= line.text.length ? line.text : line.text.slice(0, Math.max(0, charsLeft));
        charsLeft -= line.text.length + 1;
        drawStyledText(ctx, shown, x0, y, base, env);
        return;
      }
      let prefix = '';
      for (const word of line.text.split(' ')) {
        const shown = charsLeft >= word.length ? word : word.slice(0, Math.max(0, charsLeft));
        charsLeft -= word.length + 1;
        const active = wordIndex === state.activeWord;
        const style = active && s.highlightColor ? { ...base, color: s.highlightColor } : base;
        drawStyledText(ctx, shown, x0 + ctx.measureText(prefix).width, y, style, env);
        prefix += `${word} `;
        wordIndex++;
      }
    });
    ctx.restore();
  },
});

// --- Group -----------------------------------------------------------------------------------------

export const groupComponent = defineComponent<GroupLayer['props']>({
  type: 'group',
  validate(p, c, path, context) {
    c.keys(p, path, ['layers']);
    if (context.depth + 1 >= MAX_GROUP_DEPTH) {
      c.fail(path, `groups can be nested at most ${MAX_GROUP_DEPTH - 1} levels deep`);
      return;
    }
    context.validateLayers(p.layers, join(path, 'layers'), context.depth + 1, context.segmentDuration);
  },
  draw(_ctx, p, time, _env, helpers) {
    helpers.drawLayers(p.layers, time.t, time.duration, time.segmentTime);
  },
});
