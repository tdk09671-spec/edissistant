// Builds and validates client style profiles. Evidence comes from the preset (explicit editor
// choices), the creative brief (keywords) and analysed reference videos; each trait records where its
// value came from and how confident we are. The profile is the stable brand identity that every
// plan reuses.

import { PlanningError } from './errors';
import { hashHex } from './hash';
import {
  STYLE_PROFILE_SCHEMA,
  STYLE_PROFILE_VERSION,
  type AvoidRule,
  type BackgroundPreference,
  type Density,
  type FontStyle,
  type GenericFamily,
  type MotionStyle,
  type Palette,
  type Provenance,
  type ReferenceAnalysis,
  type StyleProfile,
  type Trait,
} from './types';

/** The parts of the app's Preset (src/renderer/types) a profile is built from. */
export interface PresetLike {
  id: string;
  name: string;
  clientName: string;
  creativeBrief: string;
  fonts: string;
  tracking: string;
  logoPath?: string;
  brandingNotes?: string;
  brandColors?: string[];
}

export interface StyleProfileInput {
  preset: PresetLike;
  /** Optional font files for the families named in preset.fonts. */
  fontFiles?: Record<string, string>;
  references?: ReferenceAnalysis[];
  /** Extra rules and avoid-list entries from the editor. */
  rules?: string[];
  avoid?: AvoidRule[];
  /** Explicit overrides from the editor (highest confidence). */
  overrides?: Partial<{ background: BackgroundPreference; energy: MotionStyle['energy']; density: Density }>;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const GENERIC: GenericFamily[] = ['sans-serif', 'serif', 'monospace'];
const SERIF_HINT = /\b(serif|garamond|times|georgia|playfair|merriweather|baskerville|caslon|didot|bodoni|lora)\b/i;
const MONO_HINT = /\b(mono|code|courier|consolas)\b/i;

function trait<T>(value: T, confidence: number, sources: Provenance[], uncertainty?: string): Trait<T> {
  return uncertainty ? { value, confidence, sources, uncertainty } : { value, confidence, sources };
}

const PRESET = (id: string, note?: string): Provenance => ({ kind: 'preset', sourceId: id, ...(note ? { note } : {}) });
const BRIEF = (note: string): Provenance => ({ kind: 'brief', sourceId: 'brief', note });
const DEFAULT: Provenance = { kind: 'default', sourceId: 'default' };

/** "Inter Bold, Playfair Display" → families with weights. */
export function parseFonts(spec: string): { family: string; weight: number }[] {
  return spec
    .split(/[,;/\n]|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const weightWords: Record<string, number> = { thin: 100, light: 300, regular: 400, book: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900, heavy: 900 };
      let weight = 400;
      let family = s;
      const m = /\b(thin|light|regular|book|medium|semi ?bold|bold|extra ?bold|black|heavy|[1-9]00)\b/i.exec(s);
      if (m) {
        const k = m[1].toLowerCase().replace(' ', '');
        weight = weightWords[k] ?? Number(k);
        family = s.replace(m[0], '').trim();
      }
      // Keep only characters PR #2 accepts in a family name.
      family = family.replace(/[^A-Za-z0-9 _\-.]/g, '').replace(/\s+/g, ' ').trim();
      return { family, weight };
    })
    .filter((f) => f.family.length > 0);
}

/** "+50", "50", "tight", "wide" → letter spacing in px at 1080p. */
export function parseTracking(spec: string): number | null {
  const s = spec.trim().toLowerCase();
  if (!s) return null;
  if (/tight/.test(s)) return -1;
  if (/wide|loose|open/.test(s)) return 4;
  const n = /[-+]?\d+(\.\d+)?/.exec(s);
  if (!n) return null;
  const v = Number(n[0]);
  // Values like +50 are Adobe tracking units (1/1000 em); at ~64 px headlines that's ~3 px.
  return Math.abs(v) > 20 ? Math.round((v / 1000) * 64 * 10) / 10 : v;
}

function fontStyle(family: string, weight: number, tracking: number, file?: string): FontStyle {
  const fallback: GenericFamily = GENERIC.includes(family as GenericFamily)
    ? (family as GenericFamily)
    : SERIF_HINT.test(family)
      ? 'serif'
      : MONO_HINT.test(family)
        ? 'monospace'
        : 'sans-serif';
  return { family, fallback, weight, letterSpacing: tracking, textTransform: 'none', ...(file ? { file } : {}) };
}

function luminance(hex: string): number {
  const h = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join('') : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Brief keywords → style evidence. The brief is editor-written, so it is trusted as intent. */
const BRIEF_RULES: { re: RegExp; apply: (e: Evidence, match: string) => void }[] = [
  { re: /\bpaper|paper[- ]texture|textured|collage|zine\b/i, apply: (e, m) => e.background.push(['paper', 0.8, m]) },
  { re: /\bcinematic|moody|dark|filmic|noir\b/i, apply: (e, m) => e.background.push(['cinematic', 0.75, m]) },
  { re: /\bgradient\b/i, apply: (e, m) => e.background.push(['gradient', 0.7, m]) },
  { re: /\bover (?:the )?footage|lower thirds?|overlay|transparent\b/i, apply: (e, m) => e.background.push(['over-footage', 0.7, m]) },
  { re: /\bclean|minimal|simple|corporate|flat\b/i, apply: (e, m) => (e.background.push(['solid', 0.5, m]), e.density.push(['minimal', 0.7, m])) },
  { re: /\bcalm|elegant|slow|subtle|gentle|luxur\w*\b/i, apply: (e, m) => e.energy.push(['calm', 0.75, m]) },
  { re: /\benergetic|punchy|fast|dynamic|bold|hype|bouncy|playful\b/i, apply: (e, m) => e.energy.push(['energetic', 0.75, m]) },
  { re: /\bdata[- ]driven|charts?|stats|statistics|infographic\w*\b/i, apply: (e, m) => (e.elements.push('charts'), e.density.push(['balanced', 0.5, m])) },
  { re: /\bbusy|dense|maximal\w*|lots of graphics\b/i, apply: (e, m) => e.density.push(['dense', 0.7, m]) },
  { re: /\bgrain|film grain\b/i, apply: (e) => e.elements.push('grain') },
  { re: /\bunderline\w*\b/i, apply: (e) => e.elements.push('underline') },
  { re: /\bicons?\b/i, apply: (e) => e.elements.push('icons') },
  { re: /\buppercase|all caps|capitals\b/i, apply: (e) => (e.textTransform = 'uppercase') },
];

const AVOID_RULES: { re: RegExp; rule: AvoidRule }[] = [
  { re: /\bno (?:bar )?charts?|avoid (?:bar )?charts?\b/i, rule: { kind: 'family', value: 'data', reason: 'Brief: no charts' } },
  { re: /\bno bar charts?\b/i, rule: { kind: 'concept', value: 'bar-comparison', reason: 'Brief: no bar charts' } },
  { re: /\bno (?:bounc\w*|overshoot)|avoid bounc\w*\b/i, rule: { kind: 'effect', value: 'overshoot', reason: 'Brief: no bouncy motion' } },
  { re: /\bno typewriter\b/i, rule: { kind: 'effect', value: 'typewriter', reason: 'Brief: no typewriter text' } },
  { re: /\bno (?:counters?|count[- ]ups?)\b/i, rule: { kind: 'effect', value: 'counter', reason: 'Brief: no counters' } },
  { re: /\bno blur\b/i, rule: { kind: 'transition', value: 'blur', reason: 'Brief: no blur transitions' } },
  { re: /\bno captions\b/i, rule: { kind: 'family', value: 'caption', reason: 'Brief: no captions' } },
];

interface Evidence {
  background: [BackgroundPreference, number, string][];
  energy: [MotionStyle['energy'], number, string][];
  density: [Density, number, string][];
  elements: string[];
  textTransform?: FontStyle['textTransform'];
}

function strongest<T>(items: [T, number, string][]): [T, number, string] | undefined {
  return [...items].sort((a, b) => b[1] - a[1])[0];
}

/** Builds a profile from preset, brief and analysed references. Deterministic for the same input. */
export function buildStyleProfile(input: StyleProfileInput, now: string, previous?: StyleProfile): StyleProfile {
  const { preset } = input;
  const references = input.references ?? [];
  const uncertainties: string[] = [];
  const e: Evidence = { background: [], energy: [], density: [], elements: [] };
  const brief = `${preset.creativeBrief ?? ''}\n${preset.brandingNotes ?? ''}`;
  for (const r of BRIEF_RULES) {
    const m = r.re.exec(brief);
    // "No charts" is an avoid rule, not a preference for charts.
    if (m && !/\b(?:no|avoid|without|never)\s+(?:\w+\s+)?$/i.test(brief.slice(Math.max(0, m.index - 12), m.index))) r.apply(e, m[0].toLowerCase());
  }

  // Typography: explicit preset fonts, else defaults.
  const fonts = parseFonts(preset.fonts ?? '');
  const tracking = parseTracking(preset.tracking ?? '') ?? 0;
  const headlineSpec = fonts[0] ?? { family: 'sans-serif', weight: 700 };
  const bodySpec = fonts[1] ?? { family: headlineSpec.family, weight: Math.min(headlineSpec.weight, 500) };
  const headline = fontStyle(headlineSpec.family, fonts[0] ? headlineSpec.weight : 700, tracking, input.fontFiles?.[headlineSpec.family]);
  const body = fontStyle(bodySpec.family, bodySpec.weight, Math.min(tracking, 2), input.fontFiles?.[bodySpec.family]);
  if (e.textTransform) headline.textTransform = e.textTransform;
  const typography = fonts.length
    ? trait({ headline, body }, 0.95, [PRESET(preset.id, `fonts: ${preset.fonts}`)])
    : trait({ headline, body }, 0.2, [DEFAULT], 'No fonts in the preset; using the system sans-serif.');
  if (!fonts.length) uncertainties.push('Typography is a default: add brand fonts to the preset.');
  for (const f of [headline, body]) {
    if (!GENERIC.includes(f.family as GenericFamily) && !f.file) {
      uncertainties.push(`Font "${f.family}" must be installed on the render machine (or add its font file).`);
    }
  }

  // Palette: brand colors first, then reference colors.
  const brand = (preset.brandColors ?? []).filter((x) => HEX.test(x)).map((x) => x.toLowerCase());
  const refColors = references.flatMap((r) => r.dominantColors).filter((x) => HEX.test(x));
  const meanLum = references.length ? references.reduce((s, r) => s + r.meanLuminance, 0) / references.length : null;
  const dark = meanLum !== null ? meanLum < 0.35 : /dark|cinematic|moody|noir/i.test(brief);
  const background = dark ? '#0b0d12' : /paper/i.test(brief) ? '#f2ece0' : '#ffffff';
  const text = dark ? '#f5f5f2' : '#141414';
  const accents = [...new Set([...brand, ...refColors.filter((c) => contrastRatio(c, background) > 2)])].slice(0, 4);
  if (accents.length === 0) accents.push(dark ? '#e9c46a' : '#2a6df4');
  const ratio = contrastRatio(text, background);
  const paletteSources: Provenance[] = [];
  if (brand.length) paletteSources.push(PRESET(preset.id, 'brand colors'));
  for (const r of references) paletteSources.push({ kind: r.kind, sourceId: r.id, location: r.location, note: 'dominant colors' });
  if (!paletteSources.length) paletteSources.push(DEFAULT);
  const palette = trait<Palette>(
    { background, text, accents, contrast: ratio > 12 ? 'high' : ratio > 6 ? 'medium' : 'low' },
    brand.length ? 0.9 : references.length ? 0.55 : 0.2,
    paletteSources,
    brand.length ? undefined : 'No brand colors in the preset; accents are inferred.'
  );

  // Background preference.
  for (const r of references) e.background.push([r.meanLuminance < 0.3 ? 'cinematic' : r.meanSaturation < 0.15 && r.meanLuminance > 0.75 ? 'paper' : 'solid', 0.45, `reference ${r.id}`]);
  if (input.overrides?.background) e.background.push([input.overrides.background, 0.99, 'editor']);
  const bg = strongest(e.background);
  const bgTrait = bg
    ? trait(bg[0], bg[1], [bg[2] === 'editor' ? { kind: 'editor', sourceId: 'editor' } : bg[2].startsWith('reference') ? { kind: 'reference-video', sourceId: bg[2].slice(10) } : BRIEF(bg[2])])
    : trait<BackgroundPreference>('solid', 0.2, [DEFAULT], 'Background style not stated; defaulting to a solid brand color.');

  // Motion: brief keywords, reference cut pacing.
  const shots = references.map((r) => r.averageShotSeconds).filter((x) => x > 0);
  const avgShot = shots.length ? Math.round((shots.reduce((a, b) => a + b, 0) / shots.length) * 10) / 10 : null;
  if (avgShot !== null) e.energy.push([avgShot < 2.5 ? 'energetic' : avgShot > 6 ? 'calm' : 'moderate', 0.5, 'reference pacing']);
  if (input.overrides?.energy) e.energy.push([input.overrides.energy, 0.99, 'editor']);
  const en = strongest(e.energy);
  const energy = en?.[0] ?? 'moderate';
  const motion = trait<MotionStyle>(
    {
      energy,
      easing: energy === 'energetic' ? 'snappy' : 'smooth',
      transitions: energy === 'calm' ? ['fade', 'wipe', 'slide'] : energy === 'energetic' ? ['slide', 'scale', 'wipe'] : ['slide', 'fade', 'wipe'],
      averageShotSeconds: avgShot,
    },
    en ? en[1] : 0.25,
    en ? [en[2] === 'reference pacing' ? { kind: 'reference-video', sourceId: 'pacing' } : en[2] === 'editor' ? { kind: 'editor', sourceId: 'editor' } : BRIEF(en[2])] : [DEFAULT],
    en ? undefined : 'Motion energy not stated and no references analysed.'
  );

  const den = strongest(input.overrides?.density ? [...e.density, [input.overrides.density, 0.99, 'editor'] as [Density, number, string]] : e.density);
  const density = den ? trait(den[0], den[1], [den[2] === 'editor' ? { kind: 'editor', sourceId: 'editor' } : BRIEF(den[2])]) : trait<Density>('balanced', 0.25, [DEFAULT]);
  const gpm = density.value === 'minimal' ? 2 : density.value === 'dense' ? 6 : 4;
  const pacing = trait({ graphicsPerMinute: gpm, minGapSeconds: density.value === 'dense' ? 1 : density.value === 'minimal' ? 4 : 2 }, density.confidence * 0.8, density.sources);
  const graphicElements = trait([...new Set(e.elements)].sort(), e.elements.length ? 0.7 : 0.2, e.elements.length ? [BRIEF('keywords')] : [DEFAULT]);

  const avoid = [...AVOID_RULES.filter((a) => a.re.test(brief)).map((a) => a.rule), ...(input.avoid ?? [])];
  const rules = [...(input.rules ?? [])];
  if (!references.length) uncertainties.push('No reference videos analysed: motion and colors are inferred from the preset and brief only.');

  const provenance: Provenance[] = [PRESET(preset.id), ...(brief.trim() ? [BRIEF('creative brief')] : [])];
  for (const r of references) provenance.push({ kind: r.kind, sourceId: r.id, location: r.location, note: `${r.frames.length} frames, ${r.cutsPerMinute.toFixed(1)} cuts/min` });

  const traits = [typography, palette, bgTrait, motion, pacing, graphicElements, density];
  const content = { typography, palette, background: bgTrait, motion, pacing, graphicElements, density, rules, avoid, logos: preset.logoPath ? [preset.logoPath] : [] };
  const fingerprint = hashHex(content);
  return {
    schema: STYLE_PROFILE_SCHEMA,
    version: STYLE_PROFILE_VERSION,
    id: preset.id,
    clientName: preset.clientName,
    presetName: preset.name,
    revision: previous ? (previous.fingerprint === fingerprint ? previous.revision : previous.revision + 1) : 1,
    fingerprint,
    ...content,
    provenance,
    confidence: Math.round((traits.reduce((s, t) => s + t.confidence, 0) / traits.length) * 100) / 100,
    uncertainties,
    createdAt: previous?.createdAt ?? now,
    updatedAt: previous?.fingerprint === fingerprint ? previous.updatedAt : now,
  };
}

/** Validates a stored profile (e.g. read from disk). */
export function parseStyleProfile(data: unknown): StyleProfile {
  const p = data as StyleProfile;
  if (!p || p.schema !== STYLE_PROFILE_SCHEMA) throw new PlanningError('INVALID_PROFILE', 'Not an Edissistant style profile.');
  if (p.version !== STYLE_PROFILE_VERSION) throw new PlanningError('INVALID_PROFILE', `Unsupported style profile version ${String(p.version)}.`);
  const ok =
    typeof p.id === 'string' &&
    typeof p.fingerprint === 'string' &&
    p.typography?.value?.headline?.family &&
    HEX.test(p.palette?.value?.background ?? '') &&
    Array.isArray(p.palette?.value?.accents) &&
    p.palette.value.accents.every((a) => HEX.test(a)) &&
    Array.isArray(p.avoid) &&
    Array.isArray(p.rules);
  if (!ok) throw new PlanningError('INVALID_PROFILE', 'Style profile is missing required fields.');
  return p;
}

/** All brand colors a plan may use without an editor override. */
export function brandColors(profile: StyleProfile): Set<string> {
  const p = profile.palette.value;
  return new Set([p.background, p.text, ...p.accents].map((c) => c.toLowerCase()));
}
