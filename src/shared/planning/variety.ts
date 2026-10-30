// Deterministic creative variety. Consistent client style comes from the profile; the variety engine
// keeps the *ideas* varied: it penalises repeating a concept, a family or a transition, respects
// the client's avoid-list and the editor's preferences, and never picks a poorly fitting concept just
// to be different.

import { conceptById, MODE_DEFAULT } from './concepts';
import { unitHash } from './hash';
import type { ConceptCandidate, ConceptFamily, EditorPreferences, MotionStyle, PlanFinding, StyleProfile, VarietyLevel, VisualConcept, VisualMode } from './types';

export interface VarietySettings {
  /** Concepts below this fit are only used when nothing else fits. */
  minFit: number;
  /** Below this best fit, the segment gets no full-screen graphic. */
  minGraphicFit: number;
  /** How many neighbouring segments count as "recent". */
  window: number;
  /** Penalty for reusing a concept within the window (scaled by distance). */
  conceptPenalty: number;
  /** Penalty for the same family on an adjacent segment. */
  familyPenalty: number;
  /** Max share of graphic segments one concept may take before it is penalised. */
  maxConceptShare: number;
  /** Penalty per recent client video that used the concept. */
  historyPenalty: number;
  /** Bonus for concepts not used yet in the project. */
  noveltyBonus: number;
  /** Deterministic jitter amplitude for tie-breaking. */
  jitter: number;
}

export const VARIETY: Record<VarietyLevel, VarietySettings> = {
  low: { minFit: 0.45, minGraphicFit: 0.3, window: 2, conceptPenalty: 0.15, familyPenalty: 0.03, maxConceptShare: 0.5, historyPenalty: 0.01, noveltyBonus: 0, jitter: 0.01 },
  balanced: { minFit: 0.4, minGraphicFit: 0.3, window: 4, conceptPenalty: 0.3, familyPenalty: 0.08, maxConceptShare: 0.3, historyPenalty: 0.03, noveltyBonus: 0.03, jitter: 0.03 },
  experimental: { minFit: 0.3, minGraphicFit: 0.25, window: 6, conceptPenalty: 0.45, familyPenalty: 0.12, maxConceptShare: 0.2, historyPenalty: 0.06, noveltyBonus: 0.1, jitter: 0.08 },
};

/** A decided segment, used as context for the next decision. */
export interface Placed {
  segmentId: string;
  index: number;
  conceptId: string;
  family: ConceptFamily;
  transition: MotionStyle['transitions'][number];
  start: number;
  end: number;
  visualMode: VisualMode;
}

export interface SelectionContext {
  index: number;
  segmentId: string;
  start: number;
  profile: StyleProfile;
  variety: VarietyLevel;
  preferences: EditorPreferences;
  /** Every segment already decided (before or after this one). */
  placed: Placed[];
  /** Concepts per recent client video, most recent first. */
  history: string[][];
  rejected: string[];
  lockedMode?: VisualMode;
  /** Concept forced by the editor (instruction or preference). */
  forced?: string;
  seed: string;
}

export interface Selection {
  conceptId: string;
  fit: number;
  score: number;
  reasoning: string;
  notes: string[];
}

/** True when the profile's avoid-list rules a concept out. */
export function avoidedBy(profile: StyleProfile, concept: VisualConcept): string | null {
  for (const rule of profile.avoid) {
    if (rule.kind === 'concept' && rule.value === concept.id) return rule.reason ?? `Client avoids ${concept.label}`;
    if (rule.kind === 'family' && rule.value === concept.family) return rule.reason ?? `Client avoids ${concept.family} graphics`;
    if (rule.kind === 'effect' && concept.effects.includes(rule.value)) return rule.reason ?? `Client avoids ${rule.value}`;
  }
  return null;
}

const GRAPHIC: ReadonlySet<VisualMode> = new Set(['motion-graphics', 'background-graphics']);

function brandFit(profile: StyleProfile, concept: VisualConcept): number {
  let s = 0;
  if (concept.energy === profile.motion.value.energy) s += 0.04;
  if (concept.density === profile.density.value || (profile.density.value === 'balanced' && concept.density === 'minimal')) s += 0.03;
  const elements = profile.graphicElements.value;
  if (elements.includes('charts') && concept.family === 'data') s += 0.05;
  if (elements.includes('underline') && concept.id === 'underline-callout') s += 0.05;
  if (elements.includes('icons') && concept.id === 'icon-draw') s += 0.05;
  return s;
}

/** Picks the concept for one segment. Pure and deterministic for the same context. */
export function selectConcept(candidates: ConceptCandidate[], ctx: SelectionContext): Selection {
  const settings = VARIETY[ctx.variety];
  const notes: string[] = [];

  if (ctx.forced && conceptById(ctx.forced)) {
    const c = candidates.find((x) => x.conceptId === ctx.forced);
    return { conceptId: ctx.forced, fit: c?.fit ?? 1, score: Infinity, reasoning: c?.reasoning ?? 'Chosen by the editor.', notes: ['Editor choice'] };
  }

  const banned = new Set([...(ctx.preferences.bannedConcepts ?? []), ...ctx.rejected]);
  const preferred = new Set(ctx.preferences.preferredConcepts ?? []);
  const usedInProject = ctx.placed.map((p) => p.conceptId);
  const graphicCount = ctx.placed.filter((p) => GRAPHIC.has(p.visualMode)).length;

  const eligible = candidates
    .map((c) => ({ c, concept: conceptById(c.conceptId) }))
    .filter((x): x is { c: ConceptCandidate; concept: VisualConcept } => !!x.concept)
    .filter(({ c, concept }) => {
      if (banned.has(c.conceptId)) return false;
      if (ctx.lockedMode && concept.visualMode !== ctx.lockedMode) return false;
      // Never the same graphic twice in a row (except at low variety).
      if (ctx.variety !== 'low' && GRAPHIC.has(concept.visualMode) && ctx.placed.some((p) => Math.abs(p.index - ctx.index) === 1 && p.conceptId === c.conceptId)) return false;
      const avoided = avoidedBy(ctx.profile, concept);
      if (avoided) {
        if (c.fit >= settings.minFit) notes.push(`Skipped ${concept.label}: ${avoided}`);
        return false;
      }
      return true;
    });

  // Pacing: too soon after a full-screen graphic → prefer captions or the speaker.
  const previousGraphic = [...ctx.placed].filter((p) => p.index < ctx.index && GRAPHIC.has(p.visualMode)).sort((a, b) => b.index - a.index)[0];
  const tooSoon = !!previousGraphic && ctx.start - previousGraphic.end < ctx.profile.pacing.value.minGapSeconds;
  // Density budget: graphics in the last minute versus the client's usual rate.
  const lastMinute = ctx.placed.filter((p) => p.index < ctx.index && GRAPHIC.has(p.visualMode) && p.end > ctx.start - 60).length;
  const overBudget = lastMinute >= Math.ceil(ctx.profile.pacing.value.graphicsPerMinute * 1.5);

  const scored = eligible.map(({ c, concept }) => {
    let score = c.fit + brandFit(ctx.profile, concept);
    const reasons: string[] = [];
    // Repetition within the project, weighted by distance.
    for (const p of ctx.placed) {
      const d = Math.abs(p.index - ctx.index);
      if (p.conceptId === c.conceptId && d <= settings.window) score -= settings.conceptPenalty * ((settings.window - d + 1) / settings.window);
      if (d === 1 && p.family === concept.family && GRAPHIC.has(concept.visualMode)) score -= settings.familyPenalty;
    }
    const uses = usedInProject.filter((id) => id === c.conceptId).length;
    if (GRAPHIC.has(concept.visualMode) && graphicCount >= 3 && (uses + 1) / (graphicCount + 1) > settings.maxConceptShare) {
      score -= settings.conceptPenalty;
      reasons.push('overused');
    }
    // Cross-video freshness for the client.
    ctx.history.forEach((concepts, i) => {
      if (concepts.includes(c.conceptId)) score -= settings.historyPenalty * (1 - i / Math.max(1, ctx.history.length));
    });
    if (!usedInProject.includes(c.conceptId) && c.fit >= settings.minFit) score += settings.noveltyBonus;
    if (preferred.has(c.conceptId)) score += 0.15;
    if (tooSoon && GRAPHIC.has(concept.visualMode)) score -= 0.3;
    // Only strong ideas earn a graphic once the minute is already busy.
    if (overBudget && GRAPHIC.has(concept.visualMode) && c.fit < 0.75) score -= 0.35;
    score += (unitHash(ctx.seed, ctx.segmentId, c.conceptId) - 0.5) * settings.jitter;
    return { c, concept, score, reasons };
  });

  const best = [...scored].sort((a, b) => b.score - a.score || a.c.conceptId.localeCompare(b.c.conceptId));
  const bestFit = Math.max(0, ...eligible.filter(({ concept }) => GRAPHIC.has(concept.visualMode)).map(({ c }) => c.fit));

  // Nothing fits well enough for a graphic: stay quiet rather than decorate.
  if (!ctx.lockedMode && bestFit < settings.minGraphicFit) {
    const quiet = best.find((x) => !GRAPHIC.has(x.concept.visualMode) && x.concept.components !== null);
    if (quiet) {
      notes.push('No strong visual idea for this sentence; kept it simple.');
      return { conceptId: quiet.c.conceptId, fit: quiet.c.fit, score: quiet.score, reasoning: quiet.c.reasoning, notes };
    }
  }

  // Prefer well-fitting concepts; fall back to the best fit only when nothing clears the bar.
  // Quiet options (speaker, captions) are always acceptable; B-roll and graphics must fit.
  const good = best.filter((x) => x.c.fit >= settings.minFit || (!GRAPHIC.has(x.concept.visualMode) && x.concept.components !== null));
  const pick = good[0] ?? best[0];
  if (!pick) {
    const fallback = MODE_DEFAULT[ctx.lockedMode ?? 'speaker'];
    return { conceptId: fallback, fit: 0, score: 0, reasoning: 'Default for this visual mode.', notes: [...notes, 'No eligible concept; used the mode default.'] };
  }
  const topByFit = [...eligible].sort((a, b) => b.c.fit - a.c.fit)[0];
  if (topByFit && topByFit.c.conceptId !== pick.c.conceptId && GRAPHIC.has(topByFit.concept.visualMode)) {
    const used = usedInProject.filter((id) => id === topByFit.c.conceptId).length;
    if (used > 0) notes.push(`Chose ${pick.concept.label} instead of another ${topByFit.concept.label} (already used ${used}×).`);
  }
  if ((tooSoon || overBudget) && !GRAPHIC.has(pick.concept.visualMode)) notes.push('Close to the previous graphic; giving the viewer a breather.');
  return { conceptId: pick.c.conceptId, fit: pick.c.fit, score: pick.score, reasoning: pick.c.reasoning, notes };
}

/** Rotates through the client's preferred transitions so consecutive graphics don't all enter the same way. */
export function chooseTransition(profile: StyleProfile, placed: Placed[], index: number, override?: MotionStyle['transitions'][number]): MotionStyle['transitions'][number] {
  if (override) return override;
  const avoided = new Set(profile.avoid.filter((r) => r.kind === 'transition').map((r) => r.value));
  const options = profile.motion.value.transitions.filter((t) => !avoided.has(t));
  if (options.length === 0) return 'fade';
  const recent = placed
    .filter((p) => p.index < index && GRAPHIC.has(p.visualMode))
    .sort((a, b) => b.index - a.index)
    .slice(0, 2)
    .map((p) => p.transition);
  return options.find((t) => !recent.includes(t)) ?? options.find((t) => t !== recent[0]) ?? options[0];
}

/** Project-level repetition findings (for the editor; nothing is changed automatically). */
export function detectRepetition(placed: Placed[], variety: VarietyLevel): PlanFinding[] {
  const settings = VARIETY[variety];
  const findings: PlanFinding[] = [];
  const graphics = [...placed].filter((p) => GRAPHIC.has(p.visualMode)).sort((a, b) => a.index - b.index);
  const byConcept = new Map<string, Placed[]>();
  for (const p of graphics) byConcept.set(p.conceptId, [...(byConcept.get(p.conceptId) ?? []), p]);
  for (const [conceptId, uses] of byConcept) {
    if (graphics.length >= 4 && uses.length >= 3 && uses.length / graphics.length > settings.maxConceptShare) {
      findings.push({
        kind: 'repetition',
        severity: 'warning',
        segmentIds: uses.map((u) => u.segmentId),
        message: `${conceptById(conceptId)?.label ?? conceptId} is used for ${uses.length} of ${graphics.length} graphics.`,
      });
    }
  }
  const ordered = [...placed].sort((a, b) => a.index - b.index);
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1];
    const b = ordered[i];
    if (b.index === a.index + 1 && a.conceptId === b.conceptId && GRAPHIC.has(a.visualMode)) {
      findings.push({ kind: 'repetition', severity: 'info', segmentIds: [a.segmentId, b.segmentId], message: `Back-to-back ${conceptById(a.conceptId)?.label ?? a.conceptId}.` });
    }
  }
  let run: Placed[] = [];
  for (const g of graphics) {
    run = run.length && run[run.length - 1].transition === g.transition ? [...run, g] : [g];
    if (run.length === 4) {
      findings.push({ kind: 'repetition', severity: 'info', segmentIds: run.map((r) => r.segmentId), message: `Four graphics in a row enter with "${g.transition}".` });
    }
  }
  return findings;
}
