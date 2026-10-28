import { join } from '../../checker';
import { ease } from '../../easing';
import { progressBetween } from '../../timeline';
import type { BarChartProps, DiagramProps, LineChartProps } from '../../types';
import { defineComponent } from '../component';
import type { Ctx2D, RenderEnv } from '../context';
import { applyTypography, drawStyledText, fadeStyle, formatNumber, lineStartX } from '../text';
import { roundRectPath } from './shapes';

function centeredText(ctx: Ctx2D, text: string, x: number, y: number, color: string, env: RenderEnv, alpha = 1): void {
  drawStyledText(ctx, text, x + lineStartX(ctx.measureText(text).width, 'center'), y, fadeStyle({ color }, alpha), env);
}

// --- Bar chart -------------------------------------------------------------------------------------

/** Grow progress (0–1, eased) of bar `i`. */
export function barProgress(p: BarChartProps, i: number, t: number): number {
  const grow = p.grow ?? { duration: 0.8, stagger: 0.08 };
  return ease(progressBetween(t, (grow.delay ?? 0) + i * (grow.stagger ?? 0), grow.duration), grow.easing, 'easeOutCubic');
}

export const barChartComponent = defineComponent<BarChartProps>({
  type: 'barChart',
  validate(p, c, path) {
    c.keys(p, path, ['data', 'width', 'height', 'max', 'orientation', 'barColor', 'gap', 'radius', 'grow', 'labels', 'values', 'axisColor']);
    const data = c.array(p, 'data', path, { required: true, min: 1, max: 500 });
    data?.forEach((d, i) => {
      const dp = join(join(path, 'data'), i);
      const item = c.object(d, dp);
      if (!item) return;
      c.keys(item, dp, ['label', 'value', 'color']);
      c.string(item, 'label', dp, { maxLength: 200, allowEmpty: true });
      c.number(item, 'value', dp, { required: true, min: 0, max: 1e15 });
      c.color(item, 'color', dp);
    });
    c.number(p, 'width', path, { required: true, min: 1, max: 20000 });
    c.number(p, 'height', path, { required: true, min: 1, max: 20000 });
    c.number(p, 'max', path, { min: 0, max: 1e15 });
    c.oneOf(p, 'orientation', path, ['vertical', 'horizontal'] as const);
    c.color(p, 'barColor', path, true);
    c.number(p, 'gap', path, { min: 0, max: 0.9 });
    c.number(p, 'radius', path, { min: 0, max: 1000 });
    if (p.grow !== undefined) {
      const gp = join(path, 'grow');
      const g = c.object(p.grow, gp);
      if (g) {
        c.keys(g, gp, ['duration', 'stagger', 'easing', 'delay']);
        c.number(g, 'duration', gp, { required: true, min: 0, max: 600 });
        c.number(g, 'stagger', gp, { min: 0, max: 60 });
        c.number(g, 'delay', gp, { min: 0, max: 600 });
        if (g.easing !== undefined) c.easing(g.easing, join(gp, 'easing'));
      }
    }
    c.labelStyle(p, 'labels', path);
    const values = c.labelStyle(p, 'values', path, ['decimals', 'suffix', 'prefix']);
    if (values) {
      c.number(values, 'decimals', join(path, 'values'), { integer: true, min: 0, max: 6 });
      c.string(values, 'suffix', join(path, 'values'), { maxLength: 20, allowEmpty: true });
      c.string(values, 'prefix', join(path, 'values'), { maxLength: 20, allowEmpty: true });
    }
    c.color(p, 'axisColor', path);
  },
  draw(ctx, p, time, env) {
    const { width: w, height: h } = p;
    const n = p.data.length;
    const max = p.max ?? Math.max(...p.data.map((d) => d.value), 1e-9);
    const horizontal = p.orientation === 'horizontal';
    const slot = (horizontal ? h : w) / n;
    const thickness = slot * (1 - (p.gap ?? 0.3));

    p.data.forEach((d, i) => {
      const k = barProgress(p, i, time.t);
      const length = (Math.min(d.value, max) / (max || 1)) * (horizontal ? w : h) * k;
      const offset = i * slot + (slot - thickness) / 2;
      ctx.fillStyle = d.color ?? p.barColor;
      const radius = Math.min(p.radius ?? 0, thickness / 2);
      if (length > 0) {
        if (horizontal) roundRectPath(ctx, -w / 2, -h / 2 + offset, length, thickness, radius);
        else roundRectPath(ctx, -w / 2 + offset, h / 2 - length, thickness, length, radius);
        ctx.fill();
      }
      const center = (horizontal ? -h / 2 : -w / 2) + offset + thickness / 2;
      if (p.labels && d.label) {
        applyTypography(ctx, p.labels.typography);
        if (horizontal) {
          const tw = ctx.measureText(d.label).width;
          drawStyledText(ctx, d.label, -w / 2 - tw - p.labels.typography.fontSize * 0.5, center, { color: p.labels.color }, env);
        } else {
          centeredText(ctx, d.label, center, h / 2 + p.labels.typography.fontSize * 0.9, p.labels.color, env);
        }
      }
      if (p.values && k > 0) {
        applyTypography(ctx, p.values.typography);
        const text = `${p.values.prefix ?? ''}${formatNumber(d.value * k, p.values.decimals ?? 0, ',')}${p.values.suffix ?? ''}`;
        const gap = p.values.typography.fontSize * 0.7;
        if (horizontal) drawStyledText(ctx, text, -w / 2 + length + gap * 0.5, center, fadeStyle({ color: p.values.color }, k), env);
        else centeredText(ctx, text, center, h / 2 - length - gap, p.values.color, env, k);
      }
    });

    if (p.axisColor) {
      ctx.strokeStyle = p.axisColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (horizontal) {
        ctx.moveTo(-w / 2, -h / 2);
        ctx.lineTo(-w / 2, h / 2);
      } else {
        ctx.moveTo(-w / 2, h / 2);
        ctx.lineTo(w / 2, h / 2);
      }
      ctx.stroke();
    }
  },
});

// --- Line chart ------------------------------------------------------------------------------------

/** Maps a series to points in a w×h box centered on the origin. */
export function chartPoints(points: number[], w: number, h: number, min: number, max: number): [number, number][] {
  const span = max - min || 1;
  return points.map((v, i) => [-w / 2 + (points.length === 1 ? w / 2 : (i / (points.length - 1)) * w), h / 2 - ((v - min) / span) * h]);
}

/** Draws the first `fraction` of a polyline. Returns the index of the last fully reached point. */
export function partialPolyline(ctx: Ctx2D, pts: [number, number][], fraction: number): number {
  const lengths = pts.slice(1).map((pt, i) => Math.hypot(pt[0] - pts[i][0], pt[1] - pts[i][1]));
  const total = lengths.reduce((a, b) => a + b, 0);
  let remaining = total * Math.min(1, Math.max(0, fraction));
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  let reached = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (remaining >= lengths[i]) {
      ctx.lineTo(pts[i + 1][0], pts[i + 1][1]);
      remaining -= lengths[i];
      reached = i + 1;
    } else {
      const f = lengths[i] > 0 ? remaining / lengths[i] : 0;
      ctx.lineTo(pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f);
      break;
    }
  }
  return reached;
}

export const lineChartComponent = defineComponent<LineChartProps>({
  type: 'lineChart',
  validate(p, c, path) {
    c.keys(p, path, ['series', 'width', 'height', 'min', 'max', 'draw', 'dots', 'axisColor', 'gridLines', 'gridColor', 'labels']);
    const series = c.array(p, 'series', path, { required: true, min: 1, max: 20 });
    series?.forEach((s, i) => {
      const sp = join(join(path, 'series'), i);
      const o = c.object(s, sp);
      if (!o) return;
      c.keys(o, sp, ['points', 'color', 'width']);
      const pts = c.array(o, 'points', sp, { required: true, min: 1, max: 5000 });
      pts?.forEach((v, j) => c.numberValue(v, join(join(sp, 'points'), j), { min: -1e15, max: 1e15 }));
      c.color(o, 'color', sp, true);
      c.number(o, 'width', sp, { min: 0.5, max: 200 });
    });
    c.number(p, 'width', path, { required: true, min: 1, max: 20000 });
    c.number(p, 'height', path, { required: true, min: 1, max: 20000 });
    c.number(p, 'min', path, { min: -1e15, max: 1e15 });
    c.number(p, 'max', path, { min: -1e15, max: 1e15 });
    if (p.draw !== undefined) {
      const dp = join(path, 'draw');
      const d = c.object(p.draw, dp);
      if (d) {
        c.keys(d, dp, ['duration', 'easing', 'delay']);
        c.number(d, 'duration', dp, { required: true, min: 0, max: 600 });
        c.number(d, 'delay', dp, { min: 0, max: 600 });
        if (d.easing !== undefined) c.easing(d.easing, join(dp, 'easing'));
      }
    }
    if (p.dots !== undefined) {
      const dp = join(path, 'dots');
      const d = c.object(p.dots, dp);
      if (d) {
        c.keys(d, dp, ['radius']);
        c.number(d, 'radius', dp, { required: true, min: 0, max: 200 });
      }
    }
    c.color(p, 'axisColor', path);
    c.number(p, 'gridLines', path, { integer: true, min: 0, max: 50 });
    c.color(p, 'gridColor', path);
    const labels = c.labelStyle(p, 'labels', path, ['text']);
    if (labels) {
      const texts = c.array(labels, 'text', join(path, 'labels'), { required: true, max: 5000 });
      texts?.forEach((t, i) => typeof t !== 'string' && c.fail(join(join(join(path, 'labels'), 'text'), i), 'must be a string'));
    }
  },
  draw(ctx, p, time, env) {
    const { width: w, height: h } = p;
    const all = p.series.flatMap((s) => s.points);
    const min = p.min ?? Math.min(...all);
    const max = p.max ?? Math.max(...all);
    const draw = p.draw ?? { duration: 1.2 };
    const k = ease(progressBetween(time.t, draw.delay ?? 0, draw.duration), draw.easing, 'easeInOutCubic');

    if (p.gridLines && p.gridColor) {
      ctx.strokeStyle = p.gridColor;
      ctx.lineWidth = 1;
      for (let i = 0; i <= p.gridLines; i++) {
        const y = -h / 2 + (i / p.gridLines) * h;
        ctx.beginPath();
        ctx.moveTo(-w / 2, y);
        ctx.lineTo(w / 2, y);
        ctx.stroke();
      }
    }
    if (p.axisColor) {
      ctx.strokeStyle = p.axisColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-w / 2, -h / 2);
      ctx.lineTo(-w / 2, h / 2);
      ctx.lineTo(w / 2, h / 2);
      ctx.stroke();
    }
    for (const s of p.series) {
      const pts = chartPoints(s.points, w, h, min, max);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width ?? 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const reached = partialPolyline(ctx, pts, k);
      if (k > 0) ctx.stroke();
      if (p.dots && k > 0) {
        ctx.fillStyle = s.color;
        for (let i = 0; i <= reached; i++) {
          ctx.beginPath();
          ctx.arc(pts[i][0], pts[i][1], p.dots.radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    if (p.labels) {
      applyTypography(ctx, p.labels.typography);
      const count = Math.max(...p.series.map((s) => s.points.length));
      p.labels.text.slice(0, count).forEach((label, i) => {
        const x = -w / 2 + (count === 1 ? w / 2 : (i / (count - 1)) * w);
        centeredText(ctx, label, x, h / 2 + p.labels!.typography.fontSize * 0.9, p.labels!.color, env);
      });
    }
  },
});

// --- Diagram ---------------------------------------------------------------------------------------

/** Point where the segment from a box's center toward (tx, ty) leaves the box. */
export function boxExit(cx: number, cy: number, hw: number, hh: number, tx: number, ty: number): [number, number] {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const s = Math.min(dx !== 0 ? hw / Math.abs(dx) : Infinity, dy !== 0 ? hh / Math.abs(dy) : Infinity);
  return [cx + dx * Math.min(1, s), cy + dy * Math.min(1, s)];
}

export const diagramComponent = defineComponent<DiagramProps>({
  type: 'diagram',
  validate(p, c, path) {
    c.keys(p, path, ['nodes', 'edges', 'nodeStyle', 'edgeStyle', 'reveal']);
    const ids = new Set<string>();
    const nodes = c.array(p, 'nodes', path, { required: true, min: 1, max: 100 });
    nodes?.forEach((n, i) => {
      const np = join(join(path, 'nodes'), i);
      const o = c.object(n, np);
      if (!o) return;
      c.keys(o, np, ['id', 'label', 'x', 'y', 'width', 'height', 'fill']);
      const id = c.string(o, 'id', np, { required: true, maxLength: 100 });
      if (id && ids.has(id)) c.fail(join(np, 'id'), `duplicate node id "${id}"`);
      if (id) ids.add(id);
      c.string(o, 'label', np, { required: true, maxLength: 500, allowEmpty: true });
      c.number(o, 'x', np, { required: true, min: -20000, max: 20000 });
      c.number(o, 'y', np, { required: true, min: -20000, max: 20000 });
      c.number(o, 'width', np, { required: true, min: 1, max: 20000 });
      c.number(o, 'height', np, { required: true, min: 1, max: 20000 });
      c.color(o, 'fill', np);
    });
    const edges = c.array(p, 'edges', path, { required: true, max: 500 });
    edges?.forEach((e, i) => {
      const ep = join(join(path, 'edges'), i);
      const o = c.object(e, ep);
      if (!o) return;
      c.keys(o, ep, ['from', 'to']);
      for (const end of ['from', 'to'] as const) {
        const ref = c.string(o, end, ep, { required: true, maxLength: 100 });
        if (ref && nodes && !ids.has(ref)) c.fail(join(ep, end), `unknown node "${ref}"`);
      }
    });
    const nsp = join(path, 'nodeStyle');
    const ns = p.nodeStyle === undefined ? (c.fail(nsp, 'is required'), null) : c.object(p.nodeStyle, nsp);
    if (ns) {
      c.keys(ns, nsp, ['fill', 'stroke', 'radius', 'typography', 'textColor']);
      c.color(ns, 'fill', nsp, true);
      c.stroke(ns, 'stroke', nsp);
      c.number(ns, 'radius', nsp, { min: 0, max: 1000 });
      c.typography(ns, 'typography', nsp);
      c.color(ns, 'textColor', nsp, true);
    }
    const esp = join(path, 'edgeStyle');
    const es = p.edgeStyle === undefined ? (c.fail(esp, 'is required'), null) : c.object(p.edgeStyle, esp);
    if (es) {
      c.keys(es, esp, ['color', 'width', 'arrow']);
      c.color(es, 'color', esp, true);
      c.number(es, 'width', esp, { required: true, min: 0.5, max: 100 });
      c.boolean(es, 'arrow', esp);
    }
    if (p.reveal !== undefined) {
      const rp = join(path, 'reveal');
      const r = c.object(p.reveal, rp);
      if (r) {
        c.keys(r, rp, ['stagger', 'duration', 'easing']);
        c.number(r, 'stagger', rp, { required: true, min: 0, max: 60 });
        c.number(r, 'duration', rp, { required: true, min: 0, max: 60 });
        if (r.easing !== undefined) c.easing(r.easing, join(rp, 'easing'));
      }
    }
  },
  draw(ctx, p, time, env) {
    const reveal = p.reveal ?? { stagger: 0, duration: 0 };
    const progressOf = (i: number) => ease(progressBetween(time.t, i * reveal.stagger, reveal.duration), reveal.easing, 'easeOutCubic');
    const byId = new Map(p.nodes.map((n) => [n.id, n]));

    // Edges come after all nodes in the reveal order and are drawn beneath them.
    p.edges.forEach((e, i) => {
      const k = progressOf(p.nodes.length + i);
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b || k <= 0) return;
      const ac: [number, number] = [a.x + a.width / 2, a.y + a.height / 2];
      const bc: [number, number] = [b.x + b.width / 2, b.y + b.height / 2];
      const [x0, y0] = boxExit(ac[0], ac[1], a.width / 2, a.height / 2, bc[0], bc[1]);
      const [x1, y1] = boxExit(bc[0], bc[1], b.width / 2, b.height / 2, ac[0], ac[1]);
      const ex = x0 + (x1 - x0) * k;
      const ey = y0 + (y1 - y0) * k;
      ctx.strokeStyle = p.edgeStyle.color;
      ctx.fillStyle = p.edgeStyle.color;
      ctx.lineWidth = p.edgeStyle.width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      if (p.edgeStyle.arrow !== false && k >= 1) {
        const angle = Math.atan2(y1 - y0, x1 - x0);
        const size = p.edgeStyle.width * 4;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - size * Math.cos(angle - 0.45), y1 - size * Math.sin(angle - 0.45));
        ctx.lineTo(x1 - size * Math.cos(angle + 0.45), y1 - size * Math.sin(angle + 0.45));
        ctx.closePath();
        ctx.fill();
      }
    });

    p.nodes.forEach((n, i) => {
      const k = progressOf(i);
      if (k <= 0) return;
      ctx.save();
      ctx.globalAlpha *= k;
      const cx = n.x + n.width / 2;
      const cy = n.y + n.height / 2;
      ctx.translate(cx, cy);
      ctx.scale(0.85 + 0.15 * k, 0.85 + 0.15 * k);
      roundRectPath(ctx, -n.width / 2, -n.height / 2, n.width, n.height, p.nodeStyle.radius ?? 12);
      ctx.fillStyle = n.fill ?? p.nodeStyle.fill;
      ctx.fill();
      if (p.nodeStyle.stroke) {
        ctx.strokeStyle = p.nodeStyle.stroke.color;
        ctx.lineWidth = p.nodeStyle.stroke.width;
        ctx.stroke();
      }
      applyTypography(ctx, p.nodeStyle.typography);
      centeredText(ctx, n.label, 0, 0, p.nodeStyle.textColor, env);
      ctx.restore();
    });
  },
});
