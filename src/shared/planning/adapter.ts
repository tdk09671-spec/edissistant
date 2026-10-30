// Approved creative plan → PR #2 animation specs. Every renderable concept is expressed with PR #2's
// trusted components (no generated code). Brand styling comes only from the style profile; content
// (text, numbers, items) only from the transcript-derived parameters. Concepts PR #2 can't express are
// returned as unsupported / missing-data / missing-assets instead of a spec that pretends to render.

import { effectiveSegment } from './approval';
import { comparisonSides } from './content';
import { conceptById } from './concepts';
import { ANIMATION_SPEC_VERSION_COMPAT, PR2_ID, type AnimationSpecCompat, type BackgroundCompat, type EasingCompat, type LayerCompat, type SequenceSpecCompat, type TransitionCompat, type TypographyCompat } from './compat';
import { hash53 } from './hash';
import { avoidedBy } from './variety';
import type { EffectiveSegment, FontStyle, PlanningSegmentInput, ProjectPlan, StyleProfile } from './types';

export interface RenderSettings {
  width: number;
  height: number;
  fps: number;
}

export interface AdapterOptions {
  /** Adapt suggested/edited segments too (e.g. for a rough preview). Default: approved only. */
  includeUnapproved?: boolean;
  /** Let PR #2 fall back to a generic font when a brand font isn't installed. Default false (fail loudly). */
  allowFontFallback?: boolean;
  /**
   * Graphics-only deliverable: full-frame graphics get a transparent background (transparent-motion)
   * so they can be laid over footage in an NLE. Default false (graphics carry their background).
   */
  alpha?: boolean;
}

export type AdapterResult =
  | { status: 'renderable'; segmentId: string; conceptId: string; spec: AnimationSpecCompat; warnings: string[] }
  | { status: 'no-graphic'; segmentId: string; conceptId: string; reason: string }
  | { status: 'unsupported'; segmentId: string; conceptId: string; reason: string }
  | { status: 'missing-data'; segmentId: string; conceptId: string; reason: string }
  | { status: 'missing-assets'; segmentId: string; conceptId: string; reason: string }
  | { status: 'not-approved'; segmentId: string; conceptId: string; reason: string };

interface Ctx {
  W: number;
  H: number;
  D: number;
  pace: number;
  scale: number;
  profile: StyleProfile;
  seg: EffectiveSegment;
  ease: EasingCompat;
  headline: TypographyCompat;
  body: TypographyCompat;
  text: string;
  accent: string;
  accent2: string;
  enter: (type?: TransitionCompat['type'], extra?: Partial<TransitionCompat>, layerDuration?: number) => TransitionCompat;
  exit: (layerDuration?: number) => TransitionCompat | undefined;
}

type Built = { layers: LayerCompat[]; mode?: AnimationSpecCompat['exportMode']; background?: BackgroundCompat; images?: { id: string; path: string }[] } | { missing: string; kind: 'missing-data' | 'missing-assets' };

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join('') : hex.slice(1, 7);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function typography(f: FontStyle, size: number, H: number, allowFallback: boolean): TypographyCompat {
  const generic = ['sans-serif', 'serif', 'monospace'].includes(f.family);
  return {
    fontFamily: f.family,
    fallback: f.fallback,
    ...(generic ? {} : { allowFallback }),
    fontWeight: f.weight,
    fontSize: Math.round(size),
    letterSpacing: r2((f.letterSpacing * H) / 1080),
    textTransform: f.textTransform,
  };
}

function background(profile: StyleProfile, forFullFrame: boolean): BackgroundCompat {
  const p = profile.palette.value;
  const grain = profile.graphicElements.value.includes('grain') ? 0.5 : 0.25;
  switch (profile.background.value) {
    case 'paper':
      return { type: 'paper', color: p.background, grain: 0.5, fibers: 0.5 };
    case 'cinematic':
      return { type: 'cinematic', color: p.background, light: p.accents[0], vignette: 0.6, grain };
    case 'gradient':
      return { type: 'gradient', kind: 'linear', angle: 90, stops: [{ offset: 0, color: p.background }, { offset: 1, color: p.accents[1] ?? p.accents[0] }] };
    case 'over-footage':
      return forFullFrame ? { type: 'solid', color: p.background } : { type: 'transparent' };
    default:
      return { type: 'solid', color: p.background };
  }
}

function estimateLines(text: string, fontSize: number, maxWidth: number): number {
  return Math.max(1, Math.ceil((text.length * fontSize * 0.55) / maxWidth));
}

function displayNumber(v: { value: number; unit?: string; label?: string }): { to: number; decimals: number; prefix: string; suffix: string } {
  const currency = /^[$€£]/.exec(v.label ?? '')?.[0] ?? (v.unit === 'currency' ? '$' : '');
  let to = v.value;
  let suffix = '';
  if (v.unit === 'percent') suffix = '%';
  else if (v.unit === 'multiplier') suffix = '×';
  else if (Math.abs(to) >= 1e9) (to /= 1e9), (suffix = 'B');
  else if (Math.abs(to) >= 1e6) (to /= 1e6), (suffix = 'M');
  const decimals = Number.isInteger(to) ? 0 : Math.min(2, String(to).split('.')[1]?.length ?? 1);
  return { to: Math.round(to * 100) / 100, decimals, prefix: currency, suffix };
}

function text(id: string, value: string, t: TypographyCompat, color: string, x: number, y: number, extra: Partial<LayerCompat> & { props?: Record<string, unknown> } = {}): LayerCompat {
  const { props, ...rest } = extra;
  return { id, type: 'text', transform: { x: r2(x), y: r2(y) }, ...rest, props: { text: value, typography: t, color, align: 'center', ...(props ?? {}) } };
}

/** Groups word timings into caption cues relative to the segment start (PR #2 cue rules). */
export function captionCues(seg: EffectiveSegment, D: number): { start: number; end: number; text: string; words?: { text: string; start: number; end: number }[] }[] {
  const words = (seg.words ?? [])
    .map((w) => ({ text: w.text.trim().replace(/\s+/g, ''), start: clamp(w.start - seg.start, 0, D), end: clamp(w.end - seg.start, 0, D) }))
    .filter((w) => w.text && w.end >= w.start);
  if (words.length) {
    const cues: { start: number; end: number; text: string; words: { text: string; start: number; end: number }[] }[] = [];
    let group: typeof words = [];
    const flush = (endAt: number) => {
      if (!group.length) return;
      const start = r2(group[0].start);
      // Rounding to 0.01 s can push a cue past the segment (D = 4.165 → 4.17): clamp after rounding.
      const end = Math.min(D, r2(Math.max(start + 0.05, Math.min(D, endAt))));
      cues.push({ start, end, text: group.map((w) => w.text).join(' '), words: group.map((w) => ({ text: w.text, start: r2(Math.max(start, w.start)), end: Math.min(end, r2(Math.max(w.start, w.end))) })).filter((w) => w.start < end) });
      group = [];
    };
    for (const w of words) {
      const text = [...group, w].map((x) => x.text).join(' ');
      if (group.length && (group.length >= 6 || text.length > 32)) flush(w.start);
      group.push(w);
    }
    flush(Math.max(group[group.length - 1]?.end ?? D, D));
    // Cues must not overlap: end each at the next cue's start.
    for (let i = 0; i < cues.length - 1; i++) cues[i].end = Math.min(cues[i].end, cues[i + 1].start);
    return cues.filter((c) => c.end > c.start);
  }
  // No word timing: split the text evenly by length.
  const chunks: string[] = [];
  let line = '';
  for (const word of seg.text.split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + word).length > 32) (chunks.push(line), (line = word));
    else line = line ? `${line} ${word}` : word;
  }
  if (line) chunks.push(line);
  const total = chunks.reduce((s, c) => s + c.length, 0) || 1;
  let t = 0;
  return chunks.map((c) => {
    const start = r2(t);
    t += (D * c.length) / total;
    return { start, end: Math.min(D, r2(t)), text: c };
  });
}

const BUILDERS: Record<string, (c: Ctx) => Built> = {
  'kinetic-headline': (c) => {
    const line = c.seg.params.headline ?? c.seg.text;
    const n = line.split(/\s+/).length;
    const duration = clamp(0.45 / c.pace, 0.15, c.D * 0.4);
    const stagger = clamp(Math.min(0.09 / c.pace, (c.D * 0.6 - duration) / Math.max(1, n - 1)), 0, 1);
    return {
      layers: [
        text('headline', line, c.headline, c.text, c.W / 2, c.H / 2, {
          exit: c.exit(),
          props: { maxWidth: Math.round(c.W * 0.8), reveal: { by: 'word', style: 'rise', stagger: r2(stagger), duration: r2(duration), easing: c.ease } },
        }),
      ],
    };
  },
  'type-on-quote': (c) => {
    const quote = c.seg.text.length <= 140 ? c.seg.text.trim() : c.seg.params.headline ?? c.seg.text.slice(0, 140);
    const stagger = clamp(Math.min(0.035 / c.pace, (c.D * 0.6) / Math.max(1, quote.length)), 0.005, 0.2);
    return {
      layers: [
        text('quote', `“${quote}”`, { ...c.body, fontSize: Math.round(c.H * 0.055 * c.scale) }, c.text, c.W / 2, c.H / 2, {
          exit: c.exit(),
          props: { maxWidth: Math.round(c.W * 0.7), reveal: { by: 'char', style: 'typewriter', stagger: r2(stagger), duration: 0 } },
        }),
      ],
    };
  },
  'mask-reveal-title': (c) => ({
    layers: [
      text('title', c.seg.params.headline ?? c.seg.text, c.headline, c.text, c.W / 2, c.H / 2, {
        exit: c.exit(),
        props: { maxWidth: Math.round(c.W * 0.8), reveal: { by: 'line', style: 'mask', stagger: r2(0.15 / c.pace), duration: r2(clamp(0.5 / c.pace, 0.15, c.D * 0.4)), easing: c.ease } },
      }),
    ],
  }),
  'question-card': (c) => {
    const q = c.seg.text.length <= 120 ? c.seg.text.trim() : c.seg.params.headline ?? c.seg.text;
    const lines = estimateLines(q, c.headline.fontSize, c.W * 0.8);
    const overshoot = c.profile.motion.value.energy !== 'calm' && !c.profile.avoid.some((a) => a.kind === 'effect' && a.value === 'overshoot');
    const underlineAt = c.H / 2 + (lines * c.headline.fontSize * 1.2) / 2 + c.headline.fontSize * 0.3;
    return {
      layers: [
        text('question', q, c.headline, c.text, c.W / 2, c.H / 2, { enter: c.enter('scale', { easing: overshoot ? 'easeOutBack' : c.ease }), exit: c.exit(), props: { maxWidth: Math.round(c.W * 0.8) } }),
        {
          id: 'underline',
          type: 'highlight',
          start: r2(Math.min(c.D * 0.4, 0.4 / c.pace)),
          transform: { x: r2(c.W / 2), y: r2(underlineAt) },
          exit: c.exit(c.D - Math.min(c.D * 0.4, 0.4 / c.pace)),
          props: { style: 'underline', width: Math.round(c.W * 0.4), height: 4, color: c.accent, strokeWidth: Math.max(2, Math.round(c.H * 0.006)), progress: { keyframes: [{ t: 0, value: 0 }, { t: r2(Math.min(0.5 / c.pace, c.D * 0.3)), value: 1, easing: c.ease }] } },
        },
      ],
    };
  },
  'counter-hero': (c) => {
    const v = c.seg.params.values?.[0];
    if (!v) return { missing: 'No spoken number to count up.', kind: 'missing-data' };
    const n = displayNumber(v);
    const size = Math.round(c.H * 0.16 * c.scale);
    const label = c.seg.params.headline;
    return {
      layers: [
        { id: 'number', type: 'counter', transform: { x: r2(c.W / 2), y: r2(c.H * 0.45) }, enter: c.enter('fade'), exit: c.exit(),
          props: { from: 0, to: n.to, decimals: n.decimals, prefix: n.prefix, suffix: n.suffix, duration: r2(clamp(1.4 / c.pace, 0.3, c.D * 0.6)), easing: 'easeOutExpo', typography: { ...c.headline, fontSize: size }, color: c.accent, align: 'center' } },
        ...(label ? [text('label', label, c.body, c.text, c.W / 2, c.H * 0.45 + size * 0.85, { start: r2(Math.min(0.3, c.D * 0.3)), enter: c.enter('slide', { direction: 'up', distance: 30 }, c.D - Math.min(0.3, c.D * 0.3)), exit: c.exit(c.D - Math.min(0.3, c.D * 0.3)), props: { maxWidth: Math.round(c.W * 0.7) } })] : []),
      ],
    };
  },
  'bar-comparison': (c) => {
    const values = c.seg.params.values ?? [];
    if (values.length < 2) return { missing: 'A bar comparison needs at least two spoken values.', kind: 'missing-data' };
    const unit = displayNumber(values[0]);
    return {
      layers: [
        { id: 'bars', type: 'barChart', transform: { x: r2(c.W / 2), y: r2(c.H * 0.5) }, exit: c.exit(),
          props: {
            data: values.slice(0, 8).map((v, i) => ({ value: Math.abs(v.value), ...(i === values.length - 1 ? { color: c.accent } : {}) })),
            width: Math.round(c.W * 0.5), height: Math.round(c.H * 0.45), barColor: c.accent2, radius: 8,
            grow: { duration: r2(clamp(0.8 / c.pace, 0.2, c.D * 0.5)), stagger: r2(clamp(0.15 / c.pace, 0, c.D * 0.1)), easing: c.ease },
            values: { typography: { ...c.body, fontWeight: 700 }, color: c.text, prefix: unit.prefix, suffix: unit.suffix },
            axisColor: hexToRgba(c.text, 0.4),
          } },
      ],
    };
  },
  'line-trend': (c) => {
    const values = c.seg.params.values ?? [];
    if (values.length < 2) return { missing: 'A trend line needs at least two spoken values.', kind: 'missing-data' };
    return {
      layers: [
        { id: 'trend', type: 'lineChart', transform: { x: r2(c.W / 2), y: r2(c.H * 0.55) }, exit: c.exit(),
          props: { series: [{ points: values.slice(0, 50).map((v) => v.value), color: c.accent, width: Math.max(3, Math.round(c.H * 0.005)) }], width: Math.round(c.W * 0.6), height: Math.round(c.H * 0.4),
            draw: { duration: r2(clamp(1.2 / c.pace, 0.3, c.D * 0.6)), easing: c.ease }, dots: { radius: Math.round(c.H * 0.007) }, gridLines: 4, gridColor: hexToRgba(c.text, 0.12),
            labels: { typography: { ...c.body, fontWeight: 700 }, color: c.text, text: values.slice(0, 50).map((v) => v.label ?? String(v.value)) } } },
        ...(c.seg.params.headline ? [text('caption', c.seg.params.headline, c.body, c.text, c.W / 2, c.H * 0.2, { enter: c.enter('fade'), exit: c.exit(), props: { maxWidth: Math.round(c.W * 0.7) } })] : []),
      ],
    };
  },
  'progress-ring': (c) => {
    const pct = c.seg.params.values?.find((v) => v.unit === 'percent');
    if (!pct) return { missing: 'A progress ring needs a spoken percentage.', kind: 'missing-data' };
    const radius = Math.round(c.H * 0.17 * c.scale);
    return {
      layers: [
        { id: 'ring', type: 'progress', transform: { x: r2(c.W / 2), y: r2(c.H * 0.45) }, enter: c.enter('fade'), exit: c.exit(),
          props: { style: 'ring', radius, thickness: Math.round(radius * 0.16), value: { keyframes: [{ t: 0, value: 0 }, { t: r2(clamp(1.2 / c.pace, 0.3, c.D * 0.6)), value: clamp(pct.value / 100, 0, 1), easing: c.ease }] },
            trackColor: hexToRgba(c.text, 0.15), fillColor: c.accent, label: { typography: { ...c.headline, fontSize: Math.round(radius * 0.45) }, color: c.text } } },
        ...(c.seg.params.headline ? [text('label', c.seg.params.headline, c.body, c.text, c.W / 2, c.H * 0.45 + radius * 1.45, { enter: c.enter('fade'), exit: c.exit(), props: { maxWidth: Math.round(c.W * 0.7) } })] : []),
      ],
    };
  },
  'stat-split': (c) => {
    const values = c.seg.params.values ?? [];
    if (values.length < 2) return { missing: 'Side-by-side stats need two spoken values.', kind: 'missing-data' };
    const size = Math.round(c.H * 0.12 * c.scale);
    const counter = (id: string, x: number, v: (typeof values)[number], color: string): LayerCompat => {
      const n = displayNumber(v);
      return { id, type: 'counter', transform: { x: r2(x), y: r2(c.H / 2) }, enter: c.enter('fade'), exit: c.exit(),
        props: { from: 0, to: n.to, decimals: n.decimals, prefix: n.prefix, suffix: n.suffix, duration: r2(clamp(1.2 / c.pace, 0.3, c.D * 0.6)), easing: 'easeOutExpo', typography: { ...c.headline, fontSize: size }, color, align: 'center' } };
    };
    const caption = (id: string, x: number, v: (typeof values)[number]): LayerCompat[] => {
      const words = [v.unit === 'multiplier' ? v.label : undefined, v.context].filter(Boolean).join(' ');
      return words ? [text(id, words, c.body, hexToRgba(c.text, 0.8), x, c.H / 2 + size * 0.85, { enter: c.enter('fade'), exit: c.exit(), props: { maxWidth: Math.round(c.W * 0.35) } })] : [];
    };
    return {
      layers: [
        ...caption('left-label', c.W * 0.3, values[0]),
        ...caption('right-label', c.W * 0.7, values[1]),
        counter('left', c.W * 0.3, values[0], c.text),
        { id: 'divider', type: 'shape', transform: { x: r2(c.W / 2), y: r2(c.H / 2) }, exit: c.exit(), props: { shape: 'line', width: 0, height: Math.round(c.H * 0.3), stroke: { color: hexToRgba(c.text, 0.5), width: 2 }, drawOn: { keyframes: [{ t: 0, value: 0 }, { t: r2(clamp(0.5 / c.pace, 0.1, c.D * 0.3)), value: 1 }] } } },
        counter('right', c.W * 0.7, values[1], c.accent),
      ],
    };
  },
  'process-steps': (c) => {
    const items = (c.seg.params.items ?? []).slice(0, 5);
    if (items.length < 2) return { missing: 'A process flow needs at least two steps from the transcript.', kind: 'missing-data' };
    const gap = c.W * 0.04;
    const w = Math.min(c.W * 0.18, (c.W * 0.86 - gap * (items.length - 1)) / items.length);
    const h = c.H * 0.13;
    const total = w * items.length + gap * (items.length - 1);
    const stagger = clamp(0.3 / c.pace, 0.05, (c.D * 0.6) / (items.length * 2));
    return {
      layers: [
        { id: 'flow', type: 'diagram', transform: { x: r2((c.W - total) / 2), y: r2(c.H / 2 - h / 2) }, exit: c.exit(),
          props: {
            nodes: items.map((label, i) => ({ id: `n${i}`, label, x: Math.round(i * (w + gap)), y: 0, width: Math.round(w), height: Math.round(h) })),
            edges: items.slice(1).map((_, i) => ({ from: `n${i}`, to: `n${i + 1}` })),
            nodeStyle: { fill: hexToRgba(c.text, 0.08), stroke: { color: c.accent, width: 2 }, radius: Math.round(h * 0.18), typography: { ...c.body, fontSize: Math.round(Math.min(c.H * 0.026, (w / Math.max(...items.map((i) => i.length))) * 1.6)) }, textColor: c.text },
            edgeStyle: { color: hexToRgba(c.text, 0.6), width: 3, arrow: true },
            reveal: { stagger: r2(stagger), duration: r2(clamp(0.35 / c.pace, 0.1, stagger * 2)), easing: c.ease },
          } },
      ],
    };
  },
  'timeline-track': (c) => {
    const items = (c.seg.params.items ?? []).slice(0, 5);
    if (items.length < 2) return { missing: 'A timeline needs at least two milestones from the transcript.', kind: 'missing-data' };
    const span = c.W * 0.72;
    const x0 = (c.W - span) / 2;
    const drawEnd = clamp(0.8 / c.pace, 0.2, c.D * 0.4);
    const layers: LayerCompat[] = [
      { id: 'track', type: 'shape', transform: { x: r2(x0), y: r2(c.H / 2) }, exit: c.exit(),
        props: { shape: 'line', anchor: 'top-left', width: Math.round(span), height: 0, stroke: { color: c.accent, width: Math.max(2, Math.round(c.H * 0.004)) }, drawOn: { keyframes: [{ t: 0, value: 0 }, { t: r2(drawEnd), value: 1, easing: c.ease }] } } },
    ];
    items.forEach((item, i) => {
      const x = x0 + (span * i) / (items.length - 1);
      const start = r2(Math.min(c.D * 0.7, (drawEnd * i) / (items.length - 1)));
      layers.push({ id: `dot${i}`, type: 'shape', start, transform: { x: r2(x), y: r2(c.H / 2) }, enter: c.enter('scale', {}, c.D - start), exit: c.exit(c.D - start), props: { shape: 'ellipse', width: Math.round(c.H * 0.02), height: Math.round(c.H * 0.02), fill: c.accent } });
      layers.push(text(`label${i}`, item, { ...c.body, fontSize: Math.round(c.H * 0.03) }, c.text, x, c.H / 2 + (i % 2 ? 1 : -1) * c.H * 0.07, { start, enter: c.enter('fade', {}, c.D - start), exit: c.exit(c.D - start), props: { maxWidth: Math.round(span / items.length) } }));
    });
    return { layers };
  },
  'list-stack': (c) => {
    const items = (c.seg.params.items ?? []).slice(0, 5);
    if (items.length < 2) return { missing: 'A stacked list needs at least two items from the transcript.', kind: 'missing-data' };
    const gapY = c.H * 0.1;
    return {
      layers: items.map((item, i) => {
        const start = r2(Math.min(c.D * 0.6, (i * 0.25) / c.pace));
        return text(`item${i}`, item, c.body, c.text, c.W * 0.22, c.H / 2 + (i - (items.length - 1) / 2) * gapY, {
          start, enter: c.enter('slide', { direction: 'right', distance: 40 }, c.D - start), exit: c.exit(c.D - start), props: { align: 'left', maxWidth: Math.round(c.W * 0.6) },
        });
      }),
    };
  },
  'split-versus': (c) => {
    const sides = comparisonSides(c.seg.text);
    if (!sides) return { missing: 'Couldn’t find two sides to compare in the sentence.', kind: 'missing-data' };
    return {
      layers: [
        text('left', sides[0], c.headline, c.text, c.W * 0.27, c.H / 2, { enter: c.enter('slide', { direction: 'right' }), exit: c.exit(), props: { maxWidth: Math.round(c.W * 0.38) } }),
        { id: 'divider', type: 'shape', transform: { x: r2(c.W / 2), y: r2(c.H / 2) }, exit: c.exit(), props: { shape: 'line', width: 0, height: Math.round(c.H * 0.4), stroke: { color: c.accent, width: 3 }, drawOn: { keyframes: [{ t: 0, value: 0 }, { t: r2(clamp(0.5 / c.pace, 0.1, c.D * 0.3)), value: 1 }] } } },
        text('right', sides[1], c.headline, c.accent, c.W * 0.73, c.H / 2, { enter: c.enter('slide', { direction: 'left' }), exit: c.exit(), props: { maxWidth: Math.round(c.W * 0.38) } }),
      ],
    };
  },
  'underline-callout': (c) => {
    const line = c.seg.params.headline ?? c.seg.text;
    const lines = estimateLines(line, c.headline.fontSize, c.W * 0.8);
    const width = Math.min(c.W * 0.8, line.length * c.headline.fontSize * 0.5);
    const start = r2(Math.min(c.D * 0.4, 0.35 / c.pace));
    return {
      layers: [
        text('phrase', line, c.headline, c.text, c.W / 2, c.H / 2, { enter: c.enter(), exit: c.exit(), props: { maxWidth: Math.round(c.W * 0.8) } }),
        { id: 'underline', type: 'highlight', start, transform: { x: r2(c.W / 2), y: r2(c.H / 2 + (lines * c.headline.fontSize * 1.2) / 2 + c.headline.fontSize * 0.2) }, exit: c.exit(c.D - start),
          props: { style: 'underline', width: Math.round(width), height: 4, color: c.accent, strokeWidth: Math.max(3, Math.round(c.H * 0.007)), progress: { keyframes: [{ t: 0, value: 0 }, { t: r2(clamp(0.5 / c.pace, 0.1, (c.D - start) * 0.5)), value: 1, easing: c.ease }] } } },
      ],
    };
  },
  'icon-draw': (c) => {
    const line = c.seg.params.headline ?? c.seg.text;
    const s = c.H / 1080;
    return {
      layers: [
        { id: 'check', type: 'path', transform: { x: r2(c.W * 0.2), y: r2(c.H / 2), scale: r2(s * 1.6) }, exit: c.exit(),
          props: { d: 'M -40 0 L -12 28 L 44 -32', stroke: { color: c.accent, width: 10 }, lineCap: 'round', trim: { keyframes: [{ t: 0, value: 0 }, { t: r2(clamp(0.6 / c.pace, 0.15, c.D * 0.4)), value: 1, easing: c.ease }] } } },
        text('phrase', line, c.headline, c.text, c.W * 0.28, c.H / 2, { enter: c.enter('fade'), exit: c.exit(), props: { align: 'left', maxWidth: Math.round(c.W * 0.62) } }),
      ],
    };
  },
  'lower-third': (c) => {
    const name = c.seg.speaker;
    if (!name) return { missing: 'A lower third needs the speaker name on the segment.', kind: 'missing-data' };
    const x = c.W * 0.06;
    const y = c.H * 0.78;
    return {
      mode: 'transparent-motion',
      background: { type: 'transparent' },
      layers: [
        { id: 'bar', type: 'shape', transform: { x: r2(x), y: r2(y) }, enter: c.enter('wipe', { direction: 'right' }), exit: c.exit(),
          props: { shape: 'rect', anchor: 'top-left', width: Math.round(c.W * 0.32), height: Math.round(c.H * 0.09), radius: 8, fill: hexToRgba(c.profile.palette.value.background, 0.85) } },
        text('name', name, { ...c.body, fontWeight: 700, fontSize: Math.round(c.H * 0.035) }, c.profile.palette.value.text, x + c.W * 0.02, y + c.H * 0.045, { start: r2(Math.min(0.2, c.D * 0.2)), enter: c.enter('fade', {}, c.D - Math.min(0.2, c.D * 0.2)), exit: c.exit(c.D - Math.min(0.2, c.D * 0.2)), props: { align: 'left' } }),
      ],
    };
  },
  'logo-sting': (c) => {
    const logo = c.profile.logos[0];
    if (!logo) return { missing: 'The preset has no logo file.', kind: 'missing-assets' };
    return {
      images: [{ id: 'logo', path: logo }],
      layers: [
        { id: 'logo', type: 'image', transform: { x: r2(c.W / 2), y: r2(c.H * 0.42) }, enter: c.enter('scale'), exit: c.exit(), props: { asset: 'logo', width: Math.round(c.W * 0.25), height: Math.round(c.H * 0.2), fit: 'contain' } },
        ...(c.seg.params.headline ? [text('cta', c.seg.params.headline, c.body, c.text, c.W / 2, c.H * 0.66, { enter: c.enter('fade'), exit: c.exit(), props: { maxWidth: Math.round(c.W * 0.7) } })] : []),
      ],
    };
  },
  'caption-emphasis': (c) => {
    const cues = captionCues(c.seg, c.D);
    if (!cues.length) return { missing: 'No caption text.', kind: 'missing-data' };
    const words = cues.some((q) => q.words?.length);
    return {
      mode: 'transparent-captions',
      background: { type: 'transparent' },
      layers: [
        { id: 'captions', type: 'captions',
          props: { cues, style: { typography: { ...c.headline, fontSize: Math.round(c.H * 0.055 * c.scale) }, color: '#ffffff', highlightColor: c.accent, position: { x: 0.5, y: 0.84 }, maxWidth: 0.8, maxLines: 2,
            stroke: { color: '#000000', width: Math.max(2, Math.round(c.H * 0.005)) }, shadow: { color: 'rgba(0, 0, 0, 0.5)', blur: 8, offsetY: 3 } },
            animation: { in: c.profile.motion.value.energy === 'energetic' ? 'pop' : 'fade', out: 'fade', highlightWords: words } } },
      ],
    };
  },
  'ambient-texture': (c) => ({
    mode: 'full-motion',
    background: background(c.profile, true),
    layers: [text('title', c.seg.params.headline ?? c.seg.text, { ...c.body, fontSize: Math.round(c.H * 0.05 * c.scale) }, c.text, c.W / 2, c.H / 2, { opacity: 0.85, enter: c.enter('fade'), exit: c.exit(), props: { maxWidth: Math.round(c.W * 0.7) } })],
  }),
};

function safeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 120);
  return PR2_ID.test(cleaned) ? cleaned : `s-${cleaned}`.slice(0, 128);
}

/** Adapts one effective segment. */
export function adaptSegment(seg: EffectiveSegment, profile: StyleProfile, settings: RenderSettings, options: AdapterOptions = {}): AdapterResult {
  const concept = conceptById(seg.conceptId);
  const base = { segmentId: seg.segmentId, conceptId: seg.conceptId };
  if (!concept) return { ...base, status: 'unsupported', reason: `Unknown concept "${seg.conceptId}".` };
  if (concept.components === null) return { ...base, status: 'unsupported', reason: concept.unsupportedReason ?? 'Not renderable.' };
  if (concept.components.length === 0 || seg.visualMode === 'speaker') return { ...base, status: 'no-graphic', reason: 'Stays on the speaker; nothing to render.' };
  if (seg.visualMode === 'b-roll') return { ...base, status: 'no-graphic', reason: 'B-roll is footage the editor places; nothing to render.' };
  const build = BUILDERS[concept.id];
  if (!build) return { ...base, status: 'unsupported', reason: `No PR #2 mapping for ${concept.label} yet.` };

  const W = settings.width;
  const H = settings.height;
  const D = Math.round((seg.end - seg.start) * 1000) / 1000;
  const pace = clamp(seg.params.pace ?? 1, 0.5, 2) * (profile.motion.value.energy === 'calm' ? 0.85 : profile.motion.value.energy === 'energetic' ? 1.2 : 1);
  const scale = clamp(seg.params.scale ?? 1, 0.5, 2);
  const allowFallback = options.allowFontFallback === true;
  const ease: EasingCompat = profile.motion.value.easing === 'snappy' ? 'easeOutQuart' : profile.motion.value.easing === 'linear' ? 'linear' : 'easeOutCubic';
  const p = profile.palette.value;
  const transition = seg.transition;
  const enterDur = (layerDuration = D) => r2(clamp(0.45 / pace, 0.05, layerDuration * 0.3));
  const ctx: Ctx = {
    W, H, D, pace, scale, profile, seg, ease,
    headline: typography(profile.typography.value.headline, H * 0.075 * scale, H, allowFallback),
    body: typography(profile.typography.value.body, H * 0.04 * scale, H, allowFallback),
    text: p.text,
    accent: seg.params.accent ?? p.accents[0],
    accent2: p.accents[1] ?? hexToRgba(p.text, 0.55),
    enter: (type = transition, extra = {}, layerDuration = D) => ({
      type,
      duration: enterDur(layerDuration),
      easing: ease,
      ...(type === 'slide' ? { direction: 'up' as const, distance: Math.round(H * 0.04) } : {}),
      ...(type === 'wipe' ? { direction: 'right' as const } : {}),
      ...extra,
    }),
    exit: (layerDuration = D) => (layerDuration > 1.2 ? { type: 'fade', duration: r2(clamp(0.3 / pace, 0.05, layerDuration * 0.2)), easing: 'easeInCubic' } : undefined),
  };
  const built = build(ctx);
  if ('missing' in built) return { ...base, status: built.kind, reason: built.missing };

  const warnings: string[] = [];
  const avoided = avoidedBy(profile, concept);
  if (avoided) warnings.push(`${concept.label} goes against the client style (${avoided}); kept because the editor chose it.`);
  const fonts = [profile.typography.value.headline, profile.typography.value.body]
    .filter((f, i, all) => f.file && all.findIndex((g) => g.family === f.family && g.weight === f.weight) === i)
    .map((f) => ({ family: f.family, path: f.file as string, weight: f.weight }));
  for (const f of [profile.typography.value.headline, profile.typography.value.body]) {
    if (!f.file && !['sans-serif', 'serif', 'monospace'].includes(f.family)) warnings.push(`Font "${f.family}" must be installed on the render machine${allowFallback ? ' (fallback allowed)' : ''}.`);
  }
  const planned = built.mode ?? (seg.visualMode === 'captions' ? 'transparent-captions' : profile.background.value === 'over-footage' && seg.visualMode === 'motion-graphics' ? 'transparent-motion' : 'full-motion');
  const mode = options.alpha && planned === 'full-motion' ? 'transparent-motion' : planned;
  const spec: AnimationSpecCompat = {
    specVersion: ANIMATION_SPEC_VERSION_COMPAT,
    id: safeId(seg.segmentId),
    start: Math.round(seg.start * 1000) / 1000,
    duration: D,
    width: W,
    height: H,
    fps: settings.fps,
    exportMode: mode,
    background: options.alpha ? { type: 'transparent' } : (built.background ?? (mode === 'full-motion' ? background(profile, true) : { type: 'transparent' })),
    seed: hash53(`${profile.id}:${seg.segmentId}`) % 2147483647,
    ...(fonts.length || built.images ? { assets: { ...(fonts.length ? { fonts } : {}), ...(built.images ? { images: built.images } : {}) } } : {}),
    // Layers end at the segment end; drop undefined transitions so the spec has no unknown/empty keys.
    layers: built.layers.map((l) => JSON.parse(JSON.stringify(l)) as LayerCompat),
  };
  return { ...base, status: 'renderable', spec, warnings: [...new Set(warnings)] };
}

/** Adapts every segment of a plan. Only approved segments by default. */
export function planToAnimationSpecs(plan: ProjectPlan, inputs: PlanningSegmentInput[], profile: StyleProfile, settings: RenderSettings, options: AdapterOptions = {}): AdapterResult[] {
  const byId = new Map(inputs.map((i) => [i.id, i]));
  return plan.segments.map((s) => {
    const eff = effectiveSegment(s, byId.get(s.segmentId));
    if (s.status !== 'approved' && !options.includeUnapproved) {
      return { status: 'not-approved', segmentId: s.segmentId, conceptId: eff.conceptId, reason: `Segment is ${s.status}; approve it before rendering.` };
    }
    if (s.stale && !options.includeUnapproved) {
      return { status: 'not-approved', segmentId: s.segmentId, conceptId: eff.conceptId, reason: 'The transcript changed after approval; review it first.' };
    }
    return adaptSegment(eff, profile, settings, options);
  });
}

/** Collects renderable specs into a PR #2 SequenceSpec. */
export function toSequenceSpec(projectId: string, results: AdapterResult[], settings: RenderSettings, duration?: number): SequenceSpecCompat {
  const segments = results.flatMap((r) => (r.status === 'renderable' ? [r.spec] : []));
  const end = Math.max(0, ...segments.map((s) => s.start + s.duration));
  return { id: safeId(projectId), width: settings.width, height: settings.height, fps: settings.fps, duration: Math.round(Math.max(duration ?? 0, end) * 1000) / 1000, segments };
}

