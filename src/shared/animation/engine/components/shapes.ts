import { resolveColor, resolveNumber } from '../../keyframes';
import type { HighlightProps, PathProps, ProgressProps, ShapeProps } from '../../types';
import { defineComponent } from '../component';
import type { Ctx2D } from '../context';
import { applyTypography, drawStyledText, lineStartX } from '../text';

/** SVG path data limited to drawing commands and numbers (no other syntax can reach Path2D). */
export const SVG_PATH = /^[\sMmLlHhVvCcSsQqTtAaZz0-9.,eE+-]*$/;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export function roundRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/** Strokes the current path with only the first `fraction` of its `length` visible. */
function trimmedStroke(ctx: Ctx2D, length: number, fraction: number, stroke: () => void): void {
  const f = clamp01(fraction);
  if (f <= 0) return;
  if (f < 1) {
    ctx.setLineDash([length * f, length + 1]);
    ctx.lineDashOffset = 0;
  }
  stroke();
  ctx.setLineDash([]);
}

export function ellipsePerimeter(rx: number, ry: number): number {
  // Ramanujan's approximation.
  const h = (rx - ry) ** 2 / (rx + ry) ** 2;
  return Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

export const shapeComponent = defineComponent<ShapeProps>({
  type: 'shape',
  validate(p, c, path) {
    c.keys(p, path, ['shape', 'width', 'height', 'radius', 'fill', 'stroke', 'anchor', 'drawOn', 'shadow']);
    c.oneOf(p, 'shape', path, ['rect', 'ellipse', 'line'] as const, true);
    c.animNumber(p, 'width', path, { required: true, min: -20000, max: 20000 });
    c.animNumber(p, 'height', path, { required: true, min: -20000, max: 20000 });
    c.number(p, 'radius', path, { min: 0, max: 10000 });
    c.animColor(p, 'fill', path);
    c.stroke(p, 'stroke', path);
    c.oneOf(p, 'anchor', path, ['center', 'top-left'] as const);
    c.animNumber(p, 'drawOn', path, { min: 0, max: 1 });
    c.shadow(p, 'shadow', path);
    if (p.fill === undefined && p.stroke === undefined) c.fail(path, 'needs a fill or a stroke');
  },
  draw(ctx, p, time, env) {
    const w = resolveNumber(p.width, time.t, 0);
    const h = resolveNumber(p.height, time.t, 0);
    const x = p.anchor === 'top-left' ? 0 : -w / 2;
    const y = p.anchor === 'top-left' ? 0 : -h / 2;
    const drawOn = resolveNumber(p.drawOn, time.t, 1);
    let length: number;

    if (p.shape === 'line') {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y + h);
      length = Math.hypot(w, h);
    } else if (p.shape === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, -Math.PI / 2, (3 * Math.PI) / 2);
      length = ellipsePerimeter(Math.abs(w / 2), Math.abs(h / 2));
    } else {
      roundRectPath(ctx, x, y, w, h, p.radius ?? 0);
      length = 2 * (Math.abs(w) + Math.abs(h));
    }

    if (p.shadow) {
      ctx.shadowColor = p.shadow.color;
      ctx.shadowBlur = p.shadow.blur * env.scale;
      ctx.shadowOffsetX = (p.shadow.offsetX ?? 0) * env.scale;
      ctx.shadowOffsetY = (p.shadow.offsetY ?? 0) * env.scale;
    }
    if (p.fill !== undefined && p.shape !== 'line') {
      ctx.fillStyle = resolveColor(p.fill, time.t, '#ffffff');
      ctx.fill();
    }
    if (p.stroke && p.stroke.width > 0) {
      ctx.strokeStyle = p.stroke.color;
      ctx.lineWidth = p.stroke.width;
      ctx.lineCap = 'round';
      trimmedStroke(ctx, length, drawOn, () => ctx.stroke());
    }
  },
});

export const pathComponent = defineComponent<PathProps>({
  type: 'path',
  validate(p, c, path) {
    c.keys(p, path, ['d', 'fill', 'stroke', 'trim', 'lineCap']);
    c.string(p, 'd', path, { required: true, maxLength: 20000, pattern: SVG_PATH, patternMessage: 'must be SVG path data (M L H V C S Q T A Z and numbers)' });
    c.animColor(p, 'fill', path);
    c.stroke(p, 'stroke', path);
    c.animNumber(p, 'trim', path, { min: 0, max: 1 });
    c.oneOf(p, 'lineCap', path, ['butt', 'round', 'square'] as const);
    if (p.fill === undefined && p.stroke === undefined) c.fail(path, 'needs a fill or a stroke');
  },
  draw(ctx, p, time, env) {
    const shape = env.memo(`path:${p.d}`, () => env.createPath(p.d));
    if (p.fill !== undefined) {
      ctx.fillStyle = resolveColor(p.fill, time.t, '#ffffff');
      ctx.fill(shape);
    }
    if (p.stroke && p.stroke.width > 0) {
      ctx.strokeStyle = p.stroke.color;
      ctx.lineWidth = p.stroke.width;
      ctx.lineCap = p.lineCap ?? 'round';
      ctx.lineJoin = 'round';
      const length = env.memo(`pathLength:${p.d}`, () => env.pathLength(p.d));
      trimmedStroke(ctx, length, resolveNumber(p.trim, time.t, 1), () => ctx.stroke(shape));
    }
  },
});

export const highlightComponent = defineComponent<HighlightProps>({
  type: 'highlight',
  validate(p, c, path) {
    c.keys(p, path, ['style', 'width', 'height', 'color', 'strokeWidth', 'radius', 'progress']);
    c.oneOf(p, 'style', path, ['box', 'underline', 'marker', 'circle'] as const, true);
    c.number(p, 'width', path, { required: true, min: 0, max: 20000 });
    c.number(p, 'height', path, { required: true, min: 0, max: 20000 });
    c.color(p, 'color', path, true);
    c.number(p, 'strokeWidth', path, { min: 0, max: 500 });
    c.number(p, 'radius', path, { min: 0, max: 10000 });
    c.animNumber(p, 'progress', path, { min: 0, max: 1 });
  },
  draw(ctx, p, time) {
    const k = clamp01(resolveNumber(p.progress, time.t, 1));
    const { width: w, height: h } = p;
    ctx.strokeStyle = p.color;
    ctx.fillStyle = p.color;
    ctx.lineWidth = p.strokeWidth ?? 6;
    ctx.lineCap = 'round';
    if (p.style === 'marker') {
      // A highlighter stroke sweeping left to right behind the subject.
      roundRectPath(ctx, -w / 2, -h / 2, w * k, h, p.radius ?? h * 0.15);
      if (k > 0) ctx.fill();
    } else if (p.style === 'underline') {
      ctx.beginPath();
      ctx.moveTo(-w / 2, h / 2);
      ctx.lineTo(-w / 2 + w * k, h / 2);
      if (k > 0) ctx.stroke();
    } else if (p.style === 'circle') {
      ctx.beginPath();
      ctx.ellipse(0, 0, w / 2, h / 2, 0, -Math.PI / 2, (3 * Math.PI) / 2);
      trimmedStroke(ctx, ellipsePerimeter(w / 2, h / 2), k, () => ctx.stroke());
    } else {
      roundRectPath(ctx, -w / 2, -h / 2, w, h, p.radius ?? 0);
      trimmedStroke(ctx, 2 * (w + h), k, () => ctx.stroke());
    }
  },
});

export const progressComponent = defineComponent<ProgressProps>({
  type: 'progress',
  validate(p, c, path) {
    c.keys(p, path, ['style', 'value', 'width', 'height', 'radius', 'thickness', 'trackColor', 'fillColor', 'rounded', 'label']);
    const style = c.oneOf(p, 'style', path, ['bar', 'ring'] as const, true);
    c.animNumber(p, 'value', path, { required: true, min: 0, max: 1 });
    c.number(p, 'width', path, { required: style === 'bar', min: 1, max: 20000 });
    c.number(p, 'height', path, { required: style === 'bar', min: 1, max: 20000 });
    c.number(p, 'radius', path, { required: style === 'ring', min: 1, max: 10000 });
    c.number(p, 'thickness', path, { min: 1, max: 5000 });
    c.color(p, 'trackColor', path, true);
    c.color(p, 'fillColor', path, true);
    c.boolean(p, 'rounded', path);
    c.labelStyle(p, 'label', path);
  },
  draw(ctx, p, time, env) {
    const value = clamp01(resolveNumber(p.value, time.t, 0));
    if (p.style === 'ring') {
      const r = p.radius ?? 100;
      ctx.lineWidth = p.thickness ?? r * 0.15;
      ctx.lineCap = p.rounded === false ? 'butt' : 'round';
      ctx.strokeStyle = p.trackColor;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
      if (value > 0) {
        ctx.strokeStyle = p.fillColor;
        ctx.beginPath();
        ctx.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * value);
        ctx.stroke();
      }
    } else {
      const w = p.width ?? 400;
      const h = p.height ?? 20;
      const radius = p.rounded === false ? 0 : h / 2;
      ctx.fillStyle = p.trackColor;
      roundRectPath(ctx, -w / 2, -h / 2, w, h, radius);
      ctx.fill();
      if (value > 0) {
        ctx.fillStyle = p.fillColor;
        roundRectPath(ctx, -w / 2, -h / 2, w * value, h, radius);
        ctx.fill();
      }
    }
    if (p.label) {
      applyTypography(ctx, p.label.typography);
      const text = `${Math.round(value * 100)}%`;
      const y = p.style === 'bar' ? -(p.height ?? 20) / 2 - p.label.typography.fontSize * 0.8 : 0;
      drawStyledText(ctx, text, lineStartX(ctx.measureText(text).width, 'center'), y, { color: p.label.color }, env);
    }
  },
});
