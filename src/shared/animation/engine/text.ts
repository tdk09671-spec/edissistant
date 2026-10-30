import { withAlpha } from '../color';
import type { Glow, Shadow, Stroke, TextAlign, Typography } from '../types';
import type { Ctx2D, RenderEnv } from './context';

export function fontString(t: Typography): string {
  const fallback = t.fallback ?? 'sans-serif';
  const family = (['sans-serif', 'serif', 'monospace'] as string[]).includes(t.fontFamily) ? t.fontFamily : `"${t.fontFamily}", ${fallback}`;
  return `${t.fontStyle ?? 'normal'} ${t.fontWeight ?? 400} ${t.fontSize}px ${family}`;
}

export function transformText(text: string, t: Typography): string {
  if (t.textTransform === 'uppercase') return text.toUpperCase();
  if (t.textTransform === 'lowercase') return text.toLowerCase();
  return text;
}

/** Sets font, letter spacing and baseline for drawing `t`. */
export function applyTypography(ctx: Ctx2D, t: Typography): void {
  ctx.font = fontString(t);
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${t.letterSpacing ?? 0}px`;
  ctx.textBaseline = 'middle';
}

export interface TextLine {
  text: string;
  width: number;
}

export interface TextBlock {
  lines: TextLine[];
  lineHeight: number;
  height: number;
  width: number;
}

/** Wraps text greedily at word boundaries within maxWidth (explicit newlines are kept). Typography must be applied. */
export function layoutText(ctx: Ctx2D, text: string, t: Typography, maxWidth?: number, maxLines?: number): TextBlock {
  const lineHeight = t.fontSize * (t.lineHeight ?? 1.2);
  const lines: TextLine[] = [];
  for (const paragraph of transformText(text, t).split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push({ text: '', width: 0 });
      continue;
    }
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && maxWidth && ctx.measureText(candidate).width > maxWidth) {
        lines.push({ text: current, width: ctx.measureText(current).width });
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push({ text: current, width: ctx.measureText(current).width });
  }
  const kept = maxLines && lines.length > maxLines ? lines.slice(0, maxLines) : lines;
  return { lines: kept, lineHeight, height: kept.length * lineHeight, width: Math.max(0, ...kept.map((l) => l.width)) };
}

/** X where a line starts so that it is aligned at x = 0. */
export function lineStartX(width: number, align: TextAlign): number {
  if (align === 'center') return -width / 2;
  if (align === 'right') return -width;
  return 0;
}

export interface TextStyle {
  color: string;
  stroke?: Stroke;
  shadow?: Shadow;
  glow?: Glow;
}

function resetShadow(ctx: Ctx2D): void {
  ctx.shadowColor = 'rgba(0, 0, 0, 0)';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

/**
 * Draws one run of text (textAlign 'left', baseline 'middle') with glow, shadow and stroke.
 * Shadow and glow sizes are scaled by env.scale because canvas shadows ignore the transform.
 */
export function drawStyledText(ctx: Ctx2D, text: string, x: number, y: number, style: TextStyle, env: RenderEnv): void {
  if (!text) return;
  ctx.textAlign = 'left';
  ctx.fillStyle = style.color;
  if (style.glow && style.glow.blur > 0) {
    ctx.shadowColor = style.glow.color;
    ctx.shadowBlur = style.glow.blur * env.scale;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    for (let i = 0; i < (style.glow.strength ?? 2); i++) ctx.fillText(text, x, y);
  }
  if (style.shadow) {
    ctx.shadowColor = style.shadow.color;
    ctx.shadowBlur = style.shadow.blur * env.scale;
    ctx.shadowOffsetX = (style.shadow.offsetX ?? 0) * env.scale;
    ctx.shadowOffsetY = (style.shadow.offsetY ?? 0) * env.scale;
    // Drawing the shadow with a stroke/fill of the text itself; the clean pass below covers it.
    if (style.stroke && style.stroke.width > 0) {
      ctx.strokeStyle = style.stroke.color;
      ctx.lineWidth = style.stroke.width;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, x, y);
    } else {
      ctx.fillText(text, x, y);
    }
  }
  resetShadow(ctx);
  if (style.stroke && style.stroke.width > 0) {
    ctx.strokeStyle = style.stroke.color;
    ctx.lineWidth = style.stroke.width;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
  }
  ctx.fillText(text, x, y);
}

/** Multiplies a style's alpha (for per-unit fades) without touching globalAlpha. */
export function fadeStyle(style: TextStyle, alpha: number): TextStyle {
  if (alpha >= 1) return style;
  return {
    color: withAlpha(style.color, alpha),
    stroke: style.stroke && { ...style.stroke, color: withAlpha(style.stroke.color, alpha) },
    shadow: style.shadow && { ...style.shadow, color: withAlpha(style.shadow.color, alpha) },
    glow: style.glow && { ...style.glow, color: withAlpha(style.glow.color, alpha) },
  };
}

export function formatNumber(value: number, decimals: number, separator: string): string {
  const fixed = Math.abs(value).toFixed(decimals);
  const [int, frac] = fixed.split('.');
  const grouped = separator ? int.replace(/\B(?=(\d{3})+(?!\d))/g, separator) : int;
  const decimalMark = separator === '.' ? ',' : '.';
  return `${value < 0 && Number(fixed) !== 0 ? '-' : ''}${grouped}${frac ? decimalMark + frac : ''}`;
}
