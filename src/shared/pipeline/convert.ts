// Pure conversions between the sequence editor (renderer Segment rows), the creative planner (PR #3)
// and the animation specs the renderer validates (PR #2). No Electron or Node APIs: unit-tested
// directly and used by the main-process pipeline service.

import { validateAnimationSpec } from '../animation/validate';
import { frameToSeconds, secondsToFrames } from '../animation/timeline';
import { adaptSegment, planToAnimationSpecs, toSequenceSpec, type AdapterResult, type RenderSettings } from '../planning/adapter';
import { effectiveSegment, segmentInputHash, type EditorAction } from '../planning/approval';
import { conceptById } from '../planning/concepts';
import type { PresetLike } from '../planning/styleProfile';
import type { ApprovalStatus, PlanningSegmentInput, ProjectPlan, SegmentPlan, StyleProfile, VisualMode } from '../planning/types';
import type { BuildOutcome, PipelineSegment, RenderTarget, SegmentBuildResult, SegmentPlanInfo, SegmentUpdate, UiSegmentStatus, UiVisualMode, VisualTiming } from './types';

/**
 * Snaps an on-screen in/out to the project's frame grid with exact rational frame math (29.97 is
 * 30000/1001): each boundary goes to the nearest frame's leading edge.
 */
export function snapVisualTiming(t: VisualTiming, fps: number): VisualTiming {
  return { start: frameToSeconds(secondsToFrames(t.start, fps), fps), end: frameToSeconds(secondsToFrames(t.end, fps), fps) };
}

/** Why an on-screen in/out can't be used on this timeline, or null when it can. */
export function visualTimingIssue(t: VisualTiming, fps: number, duration: number): string | null {
  if (!Number.isFinite(t.start) || !Number.isFinite(t.end)) return 'The graphic in/out isn’t a valid time.';
  const s = snapVisualTiming(t, fps);
  if (s.start < 0) return 'The graphic can’t start before the beginning of the video.';
  if (duration > 0 && s.end > duration + 1e-6) return 'The graphic can’t end after the end of the video.';
  if (secondsToFrames(s.end, fps) - secondsToFrames(s.start, fps) < 1) return 'The graphic must be at least one frame long (out after in).';
  return null;
}

const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%$€£.]+/gu, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** True when word timing still describes the row's text (the editor hasn't rewritten it). */
export function wordsMatchText(words: readonly { text: string }[] | undefined, text: string): boolean {
  if (!words?.length) return false;
  return norm(words.map((w) => w.text).join(' ')) === norm(text);
}

/**
 * Sequence rows → planner inputs. Rows without a transcript or with no duration are skipped.
 * The row's visual mode is deliberately not passed: an editor's mode choice reaches the planner as
 * an explicit edit, so writing an approved plan back to the row never looks like a new input.
 */
export function toPlanningInputs(segments: readonly PipelineSegment[]): PlanningSegmentInput[] {
  return [...segments]
    .filter((s) => s.transcript.trim() && s.end > s.start)
    .sort((a, b) => a.start - b.start)
    .map((s) => ({
      id: s.id,
      start: s.start,
      end: s.end,
      text: s.transcript.trim(),
      ...(s.instruction.trim() ? { instruction: s.instruction.trim() } : {}),
      ...(wordsMatchText(s.words, s.transcript) ? { words: s.words!.map((w) => ({ text: w.text, start: w.start, end: w.end })) } : {}),
    }));
}

/** The preset the style profile is built from; project notes are read like the creative brief. */
export function presetWithNotes(preset: PresetLike, notes?: string): PresetLike {
  const extra = notes?.trim();
  return extra ? { ...preset, creativeBrief: [preset.creativeBrief.trim(), extra].filter(Boolean).join('\n') } : preset;
}

export function uiMode(mode: VisualMode): UiVisualMode {
  return mode === 'background-graphics' ? 'motion-graphics' : mode;
}

export function uiStatus(s: Pick<SegmentPlan, 'status' | 'stale'>): UiSegmentStatus {
  if (s.status === 'approved' && !s.stale) return 'approved';
  if (s.status === 'approved' || s.status === 'rejected' || s.status === 'needs-regeneration') return 'needs-revision';
  return 'pending';
}

export function planInfo(s: SegmentPlan): SegmentPlanInfo {
  const eff = effectiveSegment(s);
  const concept = conceptById(eff.conceptId);
  return {
    conceptId: eff.conceptId,
    conceptLabel: concept?.label ?? eff.conceptId,
    mode: uiMode(eff.visualMode),
    planStatus: s.status,
    meaning: s.suggestion.meaning,
    reasoning: s.suggestion.reasoning,
    source: s.suggestion.source,
    ...(s.stale ? { stale: s.stale.reason } : {}),
    plannedInstruction: (s.stale?.instructionFrom ?? s.instruction ?? '').trim(),
    renderable: Boolean(concept && concept.components !== null),
    ...(concept?.components === null ? { unsupportedReason: concept.unsupportedReason ?? 'Not renderable.' } : {}),
    editorChoice: Boolean(s.overrides?.conceptId || s.overrides?.visualMode),
    warnings: s.warnings,
  };
}

/** Plan → the fields the sequence table stores. Transcript, timing and instructions are never touched. */
export function segmentUpdates(plan: ProjectPlan): SegmentUpdate[] {
  return plan.segments.map((s) => {
    const info = planInfo(s);
    const status = uiStatus(s);
    return {
      id: s.segmentId,
      aiSuggestion: `${info.conceptLabel}: ${s.suggestion.reasoning}`,
      status,
      ...(status === 'approved' ? { visualMode: info.mode } : {}),
      plan: info,
    };
  });
}

/**
 * True when the row's editor instruction differs from the one its current graphic was planned with:
 * the editor asked for a change that hasn't been applied. Unknown (older projects) counts as false.
 */
export function instructionPending(row: { instruction: string }, plan: Pick<SegmentPlanInfo, 'plannedInstruction'> | undefined): boolean {
  if (!plan || plan.plannedInstruction === undefined) return false;
  return row.instruction.trim() !== plan.plannedInstruction.trim();
}

/**
 * The editor action that moves a planned segment to the status picked in the UI, or null when the
 * status is already there or the move isn't a planning decision. With a pending instruction,
 * approving always goes to the main process, which applies the instruction (or says why not):
 * acknowledging would keep the old graphic and drop the editor's request.
 */
export function actionForStatus(current: Pick<SegmentPlanInfo, 'planStatus' | 'stale'>, target: UiSegmentStatus, options: { instructionPending?: boolean } = {}): EditorAction | null {
  const status: ApprovalStatus = current.planStatus;
  if (target === 'approved') {
    if (options.instructionPending && status !== 'rejected') return { type: 'approve' };
    if (status === 'approved') return current.stale ? { type: 'acknowledge-change' } : null;
    if (status === 'rejected') return null;
    return { type: 'approve' };
  }
  if (target === 'needs-revision') return status === 'needs-regeneration' || status === 'rejected' ? null : { type: 'request-regeneration', reason: 'Marked for revision' };
  // Back to pending: keep the suggestion but drop the approval.
  return status === 'approved' ? { type: 'edit', overrides: {} } : null;
}

export function parseResolution(value: string): { width: number; height: number } | null {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(value.trim());
  if (!m) return null;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(Number(m[1])), height: even(Number(m[2])) };
}

function summary(r: AdapterResult): SegmentBuildResult {
  return r.status === 'renderable'
    ? { segmentId: r.segmentId, conceptId: r.conceptId, status: r.status, warnings: r.warnings }
    : { segmentId: r.segmentId, conceptId: r.conceptId, status: r.status, reason: r.reason, warnings: [] };
}

/** A caption layer for every row with a transcript (independent of the visual plan). */
function captionResults(inputs: PlanningSegmentInput[], profile: StyleProfile, settings: RenderSettings, allowFontFallback: boolean, visual: Map<string, VisualTiming>): AdapterResult[] {
  return inputs.map((i) =>
    adaptSegment(
      { segmentId: i.id, start: visual.get(i.id)?.start ?? i.start, end: visual.get(i.id)?.end ?? i.end, text: i.text, words: i.words, conceptId: 'caption-emphasis', visualMode: 'captions', params: {}, transition: 'fade', status: 'approved' },
      profile,
      settings,
      { allowFontFallback }
    )
  );
}

/**
 * Adapts the plan, but only for rows whose plan matches what the row says now. A row retimed or
 * rewritten since planning is reported instead of rendered from outdated plan data.
 */
function planResults(plan: ProjectPlan, inputs: PlanningSegmentInput[], profile: StyleProfile, settings: RenderSettings, allowFontFallback: boolean, alpha: boolean, visual: Map<string, VisualTiming>): AdapterResult[] {
  const byId = new Map(inputs.map((i) => [i.id, i]));
  const current = plan.segments.filter((s) => {
    const input = byId.get(s.segmentId);
    if (!input) return false;
    const hash = segmentInputHash(input);
    return hash === s.inputHash || hash === s.stale?.inputHash;
  });
  // The editor's on-screen in/out replaces the speech timing only here, when the spec is made:
  // the plan (and its input hash) keeps the speech timing, so moving a graphic never replans it.
  const timed = current.map((s) => {
    const v = visual.get(s.segmentId);
    return v ? { ...s, start: v.start, end: v.end } : s;
  });
  const adapted = new Map(planToAnimationSpecs({ ...plan, segments: timed }, inputs, profile, settings, { allowFontFallback, alpha }).map((r) => [r.segmentId, r]));
  const planned = new Map(plan.segments.map((s) => [s.segmentId, s]));
  return inputs.map(
    (i): AdapterResult =>
      adapted.get(i.id) ?? {
        status: 'not-approved',
        segmentId: i.id,
        conceptId: planned.get(i.id) ? effectiveSegment(planned.get(i.id)!).conceptId : 'none',
        reason: planned.get(i.id) ? 'Changed since it was planned. Run Suggest visuals to update it.' : 'Not planned yet. Run Suggest visuals.',
      }
  );
}

/**
 * Approved plan → PR #2 SequenceSpec for one deliverable. Only approved, current segments render;
 * every other row comes back with the reason it doesn't (not approved, unsupported, missing data…).
 */
export function buildSequence(
  plan: ProjectPlan,
  inputs: PlanningSegmentInput[],
  profile: StyleProfile,
  options: {
    projectId: string;
    target: RenderTarget;
    width: number;
    height: number;
    fps: number;
    duration: number;
    allowFontFallback?: boolean;
    /** The editor's on-screen in/out per row (see PipelineSegment.visualTiming). */
    visualTiming?: Readonly<Record<string, VisualTiming>>;
  }
): BuildOutcome {
  const settings: RenderSettings = { width: options.width, height: options.height, fps: options.fps };
  const allowFontFallback = options.allowFontFallback === true;
  // Snapped to this timeline's frames; one that doesn't fit (e.g. the video got shorter) is
  // reported for its row and that graphic is left out, never stretched or moved silently.
  const visual = new Map<string, VisualTiming>();
  const badTiming = new Map<string, string>();
  for (const [id, t] of Object.entries(options.visualTiming ?? {})) {
    const issue = visualTimingIssue(t, options.fps, options.duration);
    if (issue) badTiming.set(id, issue);
    else visual.set(id, snapVisualTiming(t, options.fps));
  }
  const adapted = (options.target === 'captions' ? captionResults(inputs, profile, settings, allowFontFallback, visual) : planResults(plan, inputs, profile, settings, allowFontFallback, options.target === 'alpha', visual)).map(
    (r): AdapterResult => (badTiming.has(r.segmentId) && r.status === 'renderable' ? { status: 'not-approved', segmentId: r.segmentId, conceptId: r.conceptId, reason: `Graphic timing: ${badTiming.get(r.segmentId)} Fix it in the Inspector or reset it to the speech timing.` } : r)
  );
  // PR #2 validates a sequence as a whole: one bad segment would stop every graphic from rendering.
  // Each spec is checked on its own first; a failing one is reported and left out.
  const rejected = new Map<string, string>();
  for (const r of adapted) {
    if (r.status !== 'renderable') continue;
    const check = validateAnimationSpec(r.spec);
    if (check.ok) continue;
    const first = check.issues[0];
    rejected.set(r.segmentId, `The renderer rejected this graphic (${first.path} ${first.message}${check.issues.length > 1 ? `, +${check.issues.length - 1} more` : ''}). The other graphics still render.`);
  }
  const rendered = adapted.filter((r) => !rejected.has(r.segmentId));
  const sequence = toSequenceSpec(`${options.projectId}-${options.target}`, rendered, settings, options.duration);
  const specIds: Record<string, string> = {};
  for (const r of rendered) if (r.status === 'renderable') specIds[r.spec.id] = r.segmentId;
  const summaries = adapted.map((r): SegmentBuildResult => {
    const reason = rejected.get(r.segmentId);
    return reason ? { segmentId: r.segmentId, conceptId: r.conceptId, status: 'invalid', reason, warnings: [] } : summary(r);
  });
  return { sequence, results: summaries, specIds };
}
