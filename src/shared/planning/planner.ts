// Creative planning service: transcript segments + client style profile → a plan of visual
// suggestions awaiting editor approval. Replanning only touches segments whose input changed (or that
// the editor sent back); approved choices are never replaced without explicit permission.

import { changeRecord, effectiveConceptId, effectiveSegment, segmentInputHash } from './approval';
import { analyzeContent, comparisonSides, isFromTranscript, type ContentAnalysis } from './content';
import { conceptById } from './concepts';
import { PlanningError } from './errors';
import { hashHex } from './hash';
import { parseLocalEdit } from './localEdits';
import { localCandidates, LocalConceptProvider, requestSegment, type ConceptRequestSegment, type PlanningProvider } from './provider';
import { brandColors } from './styleProfile';
import { findInjection } from './untrusted';
import { avoidedBy, chooseTransition, detectRepetition, selectConcept, type Placed } from './variety';
import {
  PROJECT_PLAN_SCHEMA,
  PROJECT_PLAN_VERSION,
  type ConceptCandidate,
  type ConceptParams,
  type PlanFinding,
  type PlanningRequest,
  type PlanningSegmentInput,
  type ProjectPlan,
  type SegmentPlan,
  type Suggestion,
  type VarietyLevel,
} from './types';

export interface PlanOptions {
  provider?: PlanningProvider;
  previous?: ProjectPlan | null;
  /** Segment IDs the editor explicitly allowed to be replanned even though they are approved or edited. */
  allowReplan?: string[];
  signal?: AbortSignal;
  /** Clock for timestamps (tests pass a fixed one). */
  now?: () => string;
}

export interface PlanResult {
  plan: ProjectPlan;
  /** Segment IDs that got a new suggestion in this run. */
  planned: string[];
  /** Segment IDs kept from the previous plan unchanged. */
  kept: string[];
  /** Approved segments whose input changed (approval kept, flagged stale). */
  flagged: string[];
  /** Provider warnings (e.g. model output problems, fallbacks to local). */
  warnings: string[];
}

function validateInputs(segments: PlanningSegmentInput[]): void {
  const ids = new Set<string>();
  for (const s of segments) {
    if (!s.id || typeof s.id !== 'string') throw new PlanningError('INVALID_INPUT', 'Every segment needs an id.');
    if (ids.has(s.id)) throw new PlanningError('INVALID_INPUT', `Duplicate segment id "${s.id}".`);
    ids.add(s.id);
    if (!(Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.start >= 0)) {
      throw new PlanningError('INVALID_INPUT', `Segment "${s.id}" needs 0 ≤ start < end.`);
    }
    if (typeof s.text !== 'string') throw new PlanningError('INVALID_INPUT', `Segment "${s.id}" has no text.`);
  }
}

/**
 * Multiplier (0–1) for whether the sentence actually has what a concept needs: two values for a
 * comparison chart, a percentage for a ring, steps for a flow, a speaker for a lower third, a logo for
 * a sting. Applied to local and model candidates alike, so nothing is suggested that can't be built.
 */
export function feasibility(conceptId: string, a: ContentAnalysis, input: PlanningSegmentInput, profile: PlanningRequest['profile']): number {
  const values = a.numbers.filter((n) => n.unit !== 'year');
  switch (conceptId) {
    case 'bar-comparison':
      return values.length >= 2 && !values.every((v) => v.unit === 'multiplier') ? 1 : 0.3;
    case 'line-trend':
    case 'stat-split':
      return values.length >= 2 ? 1 : 0.3;
    case 'counter-hero':
      return values.length >= 1 ? 1 : 0.3;
    case 'progress-ring':
      return values.some((v) => v.unit === 'percent') ? 1 : 0.2;
    case 'process-steps':
    case 'timeline-track':
    case 'list-stack':
      return a.items.length >= 2 ? 1 : 0.3;
    case 'split-versus':
      return comparisonSides(input.text) ? 1 : 0.3;
    case 'lower-third':
      return input.speaker ? 1 : 0;
    case 'logo-sting':
      return profile.logos.length ? 1 : 0;
    default:
      return 1;
  }
}

/** Content parameters from local analysis; on-screen text always comes from the transcript. */
export function paramsFor(text: string, model?: ConceptParams): { params: ConceptParams; warnings: string[] } {
  const a = analyzeContent(text);
  const warnings: string[] = [];
  const params: ConceptParams = { headline: a.keyPhrase, emphasis: a.emphasis };
  const values = a.numbers.filter((n) => n.unit !== 'year').map((n) => ({ value: n.value, unit: n.unit, label: n.raw, ...(n.context ? { context: n.context } : {}) }));
  if (values.length) params.values = values;
  if (a.items.length) params.items = a.items;
  if (model) {
    // Model text is accepted only when it is made of transcript words; numbers only if spoken.
    if (model.headline) {
      if (isFromTranscript(model.headline, text)) params.headline = model.headline;
      else warnings.push('Ignored a suggested headline that wasn’t in the transcript.');
    }
    if (model.emphasis) params.emphasis = model.emphasis.filter((w) => isFromTranscript(w, text)).slice(0, 5);
    if (model.items) {
      const items = model.items.filter((i) => isFromTranscript(i, text)).slice(0, 8);
      if (items.length >= 2) params.items = items;
    }
    if (model.values) {
      const spoken = new Map(a.numbers.map((n) => [n.value, n]));
      const kept = model.values.filter((v) => spoken.has(v.value));
      if (kept.length < model.values.length) warnings.push('Ignored suggested numbers that weren’t spoken.');
      if (kept.length) {
        params.values = kept.map((v) => {
          const local = spoken.get(v.value)!;
          return { value: v.value, unit: local.unit, label: v.label && isFromTranscript(v.label, text) ? v.label : local.raw, ...(local.context ? { context: local.context } : {}) };
        });
      }
    }
    if (model.pace !== undefined) params.pace = Math.min(2, Math.max(0.5, model.pace));
  }
  return { params, warnings };
}

function requiredAssets(conceptId: string, profile: PlanningRequest['profile']): string[] {
  const assets: string[] = [];
  if (conceptId === 'logo-sting') assets.push(profile.logos[0] ? `logo: ${profile.logos[0]}` : 'logo image (not in preset)');
  if (conceptId === 'b-roll-suggestion') assets.push('supporting footage (editor to choose)');
  if (conceptId === 'map-route') assets.push('map image or map component');
  for (const f of [profile.typography.value.headline, profile.typography.value.body]) {
    if (f.file) assets.push(`font: ${f.file}`);
  }
  return [...new Set(assets)];
}

function describeTreatment(conceptId: string, params: ConceptParams, profile: PlanningRequest['profile']): string {
  const concept = conceptById(conceptId);
  if (!concept) return conceptId;
  const look = `${profile.typography.value.headline.family}${profile.background.value === 'over-footage' ? ' over footage' : `, ${profile.background.value} background`}`;
  const subject = params.values?.[0]?.label ?? params.headline;
  return concept.components && concept.components.length ? `${concept.label}${subject ? ` — “${subject}”` : ''} (${look})` : concept.label;
}

export class CreativePlanner {
  /** Plans (or replans) a project. Deterministic for the same request, previous plan and provider output. */
  async plan(request: PlanningRequest, options: PlanOptions = {}): Promise<PlanResult> {
    validateInputs(request.segments);
    const now = options.now ?? (() => new Date().toISOString());
    const at = now();
    const variety: VarietyLevel = request.variety ?? 'balanced';
    const preferences = request.preferences ?? {};
    const seed = request.seed ?? request.projectId;
    const provider = options.provider ?? new LocalConceptProvider();
    const previous = options.previous ?? null;
    const allowReplan = new Set(options.allowReplan ?? []);
    const prevById = new Map((previous?.segments ?? []).map((s) => [s.segmentId, s]));
    // Profile/variety changes invalidate untouched suggestions, never editor decisions.
    const contextChanged = !previous || previous.profileFingerprint !== request.profile.fingerprint || previous.variety !== variety;

    const ordered = [...request.segments].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    const results = new Map<string, SegmentPlan>();
    const toPlan: { input: PlanningSegmentInput; index: number; prior?: SegmentPlan }[] = [];
    const kept: string[] = [];
    const flagged: string[] = [];

    ordered.forEach((input, index) => {
      const prior = prevById.get(input.id);
      const hash = segmentInputHash(input);
      if (!prior) return toPlan.push({ input, index });
      const changed = prior.inputHash !== hash;
      const permitted = allowReplan.has(input.id);
      const editorOwned = prior.status === 'approved' || prior.status === 'edited';
      if (editorOwned && !permitted) {
        if (changed && prior.status === 'approved') {
          // Keep the approval; tell the editor what changed under it. `instruction` follows the row,
          // so the instruction the graphic was planned with is kept in the flag until it's resolved.
          const plannedInstruction = prior.stale ? (prior.stale.instructionFrom ?? prior.instruction) : prior.instruction;
          const instructionChanged = (input.instruction ?? '').trim() !== (plannedInstruction ?? '').trim();
          results.set(input.id, {
            ...prior,
            start: input.start,
            end: input.end,
            text: input.text,
            speaker: input.speaker,
            instruction: input.instruction,
            stale: {
              reason: instructionChanged
                ? 'The editor instruction changed after approval. Apply it to replan this segment, or keep the approved graphic.'
                : 'The transcript or timing changed after approval.',
              since: prior.stale?.since ?? at,
              inputHash: hash,
              ...(instructionChanged ? { instructionFrom: plannedInstruction ?? '' } : {}),
            },
          });
          flagged.push(input.id);
        } else if (changed) {
          // Edited but not approved: keep the editor's changes, ask for review.
          results.set(input.id, {
            ...prior,
            start: input.start,
            end: input.end,
            text: input.text,
            speaker: input.speaker,
            instruction: input.instruction,
            inputHash: hash,
            status: 'needs-regeneration',
            history: [...prior.history, changeRecord(prior.status, 'needs-regeneration', 'Transcript changed after your edits; edits kept.', at)],
          });
          flagged.push(input.id);
        } else if (prior.stale) {
          // The row is back to what was approved (e.g. the editor undid the change): the flag goes.
          results.set(input.id, { ...prior, start: input.start, end: input.end, text: input.text, speaker: input.speaker, instruction: input.instruction, stale: undefined });
          kept.push(input.id);
        } else {
          results.set(input.id, prior);
          kept.push(input.id);
        }
        return;
      }
      const regenerate = permitted || changed || prior.status === 'rejected' || prior.status === 'needs-regeneration' || contextChanged;
      if (regenerate) toPlan.push({ input, index, prior });
      else {
        results.set(input.id, prior);
        kept.push(input.id);
      }
    });

    // Decided segments are fixed neighbours for the variety engine.
    const placed: Placed[] = [];
    ordered.forEach((input, index) => {
      const fixed = results.get(input.id);
      if (fixed) placed.push(placedOf(fixed, index));
    });

    const reqSegments: ConceptRequestSegment[] = toPlan.map(({ input, index, prior }) =>
      requestSegment(input, { before: ordered[index - 1]?.text, after: ordered[index + 1]?.text }, prior?.rejectedConcepts ?? [])
    );
    let response: Awaited<ReturnType<PlanningProvider['suggest']>> = { candidates: {}, warnings: [] };
    if (reqSegments.length) {
      response = await provider.suggest(
        { projectId: request.projectId, profile: request.profile, segments: reqSegments, usedConcepts: placed.map((p) => p.conceptId), variety },
        { signal: options.signal }
      );
    }
    const warnings = [...response.warnings];
    const history = (request.clientHistory?.projects ?? []).filter((p) => p.projectId !== request.projectId).map((p) => p.concepts);

    toPlan.forEach(({ input, index, prior }, i) => {
      const seg = reqSegments[i];
      const local = localCandidates(seg.analysis);
      const fromProvider = response.candidates[input.id];
      const candidates: ConceptCandidate[] = (fromProvider?.length ? mergeCandidates(fromProvider, local) : local)
        .map((c) => ({ ...c, fit: Math.round(c.fit * feasibility(c.conceptId, seg.analysis, input, request.profile) * 1000) / 1000 }))
        .filter((c) => c.fit > 0);
      const instructionEdit = input.instruction ? parseLocalEdit(input.instruction) : null;
      const forced = preferences.forcedConcepts?.[input.id] ?? instructionEdit?.overrides.conceptId;
      const selection = selectConcept(candidates, {
        index,
        segmentId: input.id,
        start: input.start,
        profile: request.profile,
        variety,
        preferences,
        placed,
        history,
        rejected: prior?.rejectedConcepts ?? [],
        lockedMode: input.visualMode ?? instructionEdit?.overrides.visualMode,
        forced,
        seed,
      });
      const concept = conceptById(selection.conceptId)!;
      const modelParams = fromProvider?.find((c) => c.conceptId === selection.conceptId)?.params;
      const { params, warnings: paramWarnings } = paramsFor(input.text, modelParams);
      if (instructionEdit?.overrides.params) Object.assign(params, instructionEdit.overrides.params);
      const transition = chooseTransition(request.profile, placed, index, params.transition);
      const chosen = candidates.find((c) => c.conceptId === selection.conceptId);
      const suggestion: Suggestion = {
        conceptId: selection.conceptId,
        visualMode: concept.visualMode,
        meaning: chosen?.meaning ?? seg.analysis.meaning,
        treatment: describeTreatment(selection.conceptId, params, request.profile),
        reasoning: selection.reasoning,
        params,
        transition,
        requiredAssets: requiredAssets(selection.conceptId, request.profile),
        source: chosen?.source ?? 'local',
        varietyNotes: selection.notes,
      };
      const segWarnings = [...paramWarnings];
      const injection = findInjection(input.text);
      if (injection) segWarnings.push(`Transcript contains instruction-like text ("${injection}"); treated as speech only.`);
      if (instructionEdit && !instructionEdit.handled && instructionEdit.remainder) {
        segWarnings.push(`Part of the instruction needs a model or a manual edit: "${instructionEdit.remainder}".`);
      }
      const reason = !prior ? 'New suggestion' : prior.status === 'rejected' ? 'New idea after rejection' : allowReplan.has(input.id) ? 'Replanned with editor permission' : 'Input changed; new suggestion';
      const segPlan: SegmentPlan = {
        segmentId: input.id,
        start: input.start,
        end: input.end,
        text: input.text,
        speaker: input.speaker,
        instruction: input.instruction,
        inputHash: segmentInputHash(input),
        status: 'suggested',
        suggestion,
        // Overrides survive a regeneration that the editor asked for.
        overrides: prior?.status === 'needs-regeneration' ? prior.overrides : undefined,
        rejectedConcepts: prior?.rejectedConcepts ?? [],
        warnings: segWarnings,
        history: [...(prior?.history ?? []), changeRecord(prior?.status ?? null, 'suggested', reason, at)],
      };
      results.set(input.id, segPlan);
      placed.push(placedOf(segPlan, index));
    });

    const segments = ordered.map((s) => results.get(s.id)!);
    const findings = [...detectRepetition(placed, variety), ...brandFindings(segments, request), ...otherFindings(segments, previous, request)];
    const plan: ProjectPlan = {
      schema: PROJECT_PLAN_SCHEMA,
      version: PROJECT_PLAN_VERSION,
      projectId: request.projectId,
      profileId: request.profile.id,
      profileFingerprint: request.profile.fingerprint,
      variety,
      segments,
      findings,
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
    };
    return { plan, planned: toPlan.map((t) => t.input.id), kept, flagged, warnings };
  }
}

function placedOf(plan: SegmentPlan, index: number): Placed {
  const eff = effectiveSegment(plan);
  const concept = conceptById(eff.conceptId);
  return { segmentId: plan.segmentId, index, conceptId: eff.conceptId, family: concept?.family ?? 'typography', transition: eff.transition, start: plan.start, end: plan.end, visualMode: eff.visualMode };
}

/** Model candidates first (deduplicated), then local ones as a safety net. */
function mergeCandidates(model: ConceptCandidate[], local: ConceptCandidate[]): ConceptCandidate[] {
  const seen = new Set(model.map((c) => c.conceptId));
  return [...model, ...local.filter((c) => !seen.has(c.conceptId)).map((c) => ({ ...c, fit: c.fit * 0.9 }))];
}

/** Brand consistency: avoided treatments and off-palette colours (editor overrides are reported, not changed). */
export function brandFindings(segments: SegmentPlan[], request: Pick<PlanningRequest, 'profile'>): PlanFinding[] {
  const findings: PlanFinding[] = [];
  const colors = brandColors(request.profile);
  for (const s of segments) {
    const eff = effectiveSegment(s);
    const concept = conceptById(eff.conceptId);
    if (concept) {
      const avoided = avoidedBy(request.profile, concept);
      if (avoided) findings.push({ kind: 'brand', severity: 'warning', segmentIds: [s.segmentId], message: `${concept.label} goes against the client style (${avoided}). Chosen by the editor.` });
    }
    if (eff.params.accent && !colors.has(eff.params.accent.toLowerCase())) {
      findings.push({ kind: 'brand', severity: 'info', segmentIds: [s.segmentId], message: `Accent ${eff.params.accent} is not a brand color (editor override).` });
    }
  }
  return findings;
}

function otherFindings(segments: SegmentPlan[], previous: ProjectPlan | null, request: PlanningRequest): PlanFinding[] {
  const findings: PlanFinding[] = [];
  const injected = segments.filter((s) => findInjection(s.text)).map((s) => s.segmentId);
  if (injected.length) findings.push({ kind: 'injection', severity: 'warning', segmentIds: injected, message: 'Some transcript lines contain instruction-like text. They were planned as speech, never followed.' });
  const unsupported = segments.filter((s) => conceptById(effectiveConceptId(s))?.components === null).map((s) => s.segmentId);
  if (unsupported.length) findings.push({ kind: 'unsupported', severity: 'info', segmentIds: unsupported, message: 'Some suggestions need footage or components the renderer doesn’t have; they won’t render automatically.' });
  const removed = (previous?.segments ?? []).filter((p) => !request.segments.some((s) => s.id === p.segmentId)).map((p) => p.segmentId);
  if (removed.length) findings.push({ kind: 'pacing', severity: 'info', segmentIds: removed, message: `${removed.length} segment(s) were removed from the transcript; their plans were dropped.` });
  const minutes = Math.max(1 / 60, (Math.max(...segments.map((s) => s.end), 0) - Math.min(...segments.map((s) => s.start), 0)) / 60);
  const graphics = segments.filter((s) => ['motion-graphics', 'background-graphics'].includes(effectiveSegment(s).visualMode)).length;
  const target = request.profile.pacing.value.graphicsPerMinute;
  if (segments.length >= 6 && graphics / minutes > target * 1.75) {
    findings.push({ kind: 'pacing', severity: 'info', segmentIds: [], message: `About ${(graphics / minutes).toFixed(1)} graphics per minute; this client usually has ~${target}.` });
  }
  return findings;
}

/** Hash of a whole plan's editor-relevant content (for change detection and caching). */
export function planFingerprint(plan: ProjectPlan): string {
  return hashHex(plan.segments.map((s) => [s.segmentId, s.inputHash, s.status, effectiveSegment(s)]));
}
