import { join } from '../../checker';
import { ease } from '../../easing';
import { resolveColor } from '../../keyframes';
import { progressBetween } from '../../timeline';
import type { CounterProps, TextProps } from '../../types';
import { defineComponent } from '../component';
import type { Ctx2D } from '../context';
import { applyTypography, drawStyledText, fadeStyle, formatNumber, layoutText, lineStartX, transformText, type TextStyle } from '../text';

const ALIGN = ['left', 'center', 'right'] as const;

function blockTop(height: number, verticalAlign: TextProps['verticalAlign']): number {
  if (verticalAlign === 'top') return 0;
  if (verticalAlign === 'bottom') return -height;
  return -height / 2;
}

interface Unit {
  text: string;
  x: number;
  y: number;
  width: number;
  index: number;
}

/** Splits laid-out lines into reveal units with their positions. */
function revealUnits(ctx: Ctx2D, lines: { text: string; width: number }[], by: 'char' | 'word' | 'line', align: TextProps['align'], top: number, lineHeight: number): Unit[] {
  const units: Unit[] = [];
  lines.forEach((line, li) => {
    const y = top + li * lineHeight + lineHeight / 2;
    const x0 = lineStartX(line.width, align ?? 'left');
    if (by === 'line') {
      units.push({ text: line.text, x: x0, y, width: line.width, index: units.length });
      return;
    }
    const parts = by === 'word' ? line.text.split(/(\s+)/) : Array.from(line.text);
    let prefix = '';
    for (const part of parts) {
      if (part.trim()) {
        units.push({ text: part, x: x0 + ctx.measureText(prefix).width, y, width: ctx.measureText(part).width, index: units.length });
      }
      prefix += part;
    }
  });
  return units;
}

export const textComponent = defineComponent<TextProps>({
  type: 'text',
  validate(p, c, path) {
    c.keys(p, path, ['text', 'typography', 'color', 'align', 'verticalAlign', 'maxWidth', 'stroke', 'shadow', 'glow', 'reveal']);
    c.string(p, 'text', path, { required: true, maxLength: 5000 });
    c.typography(p, 'typography', path);
    c.animColor(p, 'color', path, true);
    c.oneOf(p, 'align', path, ALIGN);
    c.oneOf(p, 'verticalAlign', path, ['top', 'middle', 'bottom'] as const);
    c.number(p, 'maxWidth', path, { min: 1, max: 20000 });
    c.stroke(p, 'stroke', path);
    c.shadow(p, 'shadow', path);
    c.glow(p, 'glow', path);
    if (p.reveal !== undefined) {
      const rp = join(path, 'reveal');
      const r = c.object(p.reveal, rp);
      if (r) {
        c.keys(r, rp, ['by', 'style', 'stagger', 'duration', 'easing']);
        c.oneOf(r, 'by', rp, ['char', 'word', 'line'] as const, true);
        c.oneOf(r, 'style', rp, ['fade', 'rise', 'scale', 'mask', 'typewriter'] as const, true);
        c.number(r, 'stagger', rp, { required: true, min: 0, max: 60 });
        c.number(r, 'duration', rp, { required: true, min: 0, max: 60 });
        if (r.easing !== undefined) c.easing(r.easing, join(rp, 'easing'));
      }
    }
  },
  draw(ctx, p, time, env) {
    applyTypography(ctx, p.typography);
    const block = layoutText(ctx, p.text, p.typography, p.maxWidth);
    const top = blockTop(block.height, p.verticalAlign);
    const style: TextStyle = { color: resolveColor(p.color, time.t, '#ffffff'), stroke: p.stroke, shadow: p.shadow, glow: p.glow };
    const align = p.align ?? 'center';

    if (!p.reveal) {
      block.lines.forEach((line, i) => {
        drawStyledText(ctx, line.text, lineStartX(line.width, align), top + i * block.lineHeight + block.lineHeight / 2, style, env);
      });
      return;
    }

    const r = p.reveal;
    for (const unit of revealUnits(ctx, block.lines, r.by, align, top, block.lineHeight)) {
      const raw = progressBetween(time.t, unit.index * r.stagger, r.duration);
      if (raw <= 0) continue;
      const k = r.style === 'typewriter' ? 1 : ease(raw, r.easing, 'easeOutCubic');
      ctx.save();
      if (r.style === 'rise') {
        ctx.translate(0, (1 - k) * p.typography.fontSize * 0.5);
      } else if (r.style === 'scale') {
        const cx = unit.x + unit.width / 2;
        ctx.translate(cx, unit.y);
        ctx.scale(0.6 + 0.4 * k, 0.6 + 0.4 * k);
        ctx.translate(-cx, -unit.y);
      } else if (r.style === 'mask') {
        // Rises out of a slot one line tall.
        ctx.beginPath();
        ctx.rect(unit.x - p.typography.fontSize, unit.y - block.lineHeight / 2, unit.width + p.typography.fontSize * 2, block.lineHeight);
        ctx.clip();
        ctx.translate(0, (1 - k) * block.lineHeight);
      }
      const alpha = r.style === 'fade' || r.style === 'rise' || r.style === 'scale' ? k : 1;
      drawStyledText(ctx, unit.text, unit.x, unit.y, fadeStyle(style, alpha), env);
      ctx.restore();
    }
  },
});

export function counterValue(p: CounterProps, t: number, layerDuration: number): number {
  const duration = p.duration ?? Math.max(0, layerDuration - (p.delay ?? 0));
  const k = ease(progressBetween(t, p.delay ?? 0, duration), p.easing, 'easeOutCubic');
  return p.from + (p.to - p.from) * k;
}

export function formatCounter(p: CounterProps, value: number): string {
  return `${p.prefix ?? ''}${formatNumber(value, p.decimals ?? 0, p.thousandsSeparator ?? ',')}${p.suffix ?? ''}`;
}

export const counterComponent = defineComponent<CounterProps>({
  type: 'counter',
  validate(p, c, path) {
    c.keys(p, path, ['from', 'to', 'delay', 'duration', 'easing', 'decimals', 'prefix', 'suffix', 'thousandsSeparator', 'typography', 'color', 'align', 'shadow', 'glow']);
    c.number(p, 'from', path, { required: true, min: -1e15, max: 1e15 });
    c.number(p, 'to', path, { required: true, min: -1e15, max: 1e15 });
    c.number(p, 'delay', path, { min: 0, max: 3600 });
    c.number(p, 'duration', path, { min: 0, max: 3600 });
    if (p.easing !== undefined) c.easing(p.easing, join(path, 'easing'));
    c.number(p, 'decimals', path, { integer: true, min: 0, max: 6 });
    c.string(p, 'prefix', path, { maxLength: 20, allowEmpty: true });
    c.string(p, 'suffix', path, { maxLength: 20, allowEmpty: true });
    c.oneOf(p, 'thousandsSeparator', path, [',', '.', ' ', ''] as const);
    c.typography(p, 'typography', path);
    c.animColor(p, 'color', path, true);
    c.oneOf(p, 'align', path, ALIGN);
    c.shadow(p, 'shadow', path);
    c.glow(p, 'glow', path);
  },
  draw(ctx, p, time, env) {
    applyTypography(ctx, p.typography);
    const text = transformText(formatCounter(p, counterValue(p, time.t, time.duration)), p.typography);
    const width = ctx.measureText(text).width;
    const x = lineStartX(width, p.align ?? 'center');
    drawStyledText(ctx, text, x, 0, { color: resolveColor(p.color, time.t, '#ffffff'), shadow: p.shadow, glow: p.glow }, env);
  },
});
