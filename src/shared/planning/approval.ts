// Editor approval workflow. Suggestions are only proposals: the editor approves, edits, rejects or
// asks for a new idea. Every change is recorded, and editor choices always win over suggestions.

import { conceptById, conceptModeIssue, MODE_DEFAULT, modeLabel } from './concepts';
import { PlanningError } from './errors';
import { hashHex } from './hash';
import type { ApprovalStatus, ConceptParams, EditorOverrides, EffectiveSegment, PlanningSegmentInput, SegmentPlan, StatusChange } from './types';

export type EditorAction =
  | { type: 'approve' }
  | { type: 'reject'; reason?: string }
  | { type: 'edit'; overrides: EditorOverrides }
  | { type: 'request-regeneration'; reason?: string }
  /** Clears the "input changed since approval" flag after the editor reviewed it. */
  | { type: 'acknowledge-change' };

/** Which actions are allowed from each status. */
const ALLOWED: Record<ApprovalStatus, ReadonlyArray<EditorAction['type']>> = {
  suggested: ['approve', 'reject', 'edit', 'request-regeneration'],
  edited: ['approve', 'reject', 'edit', 'request-regeneration'],
  approved: ['edit', 'reject', 'request-regeneration', 'acknowledge-change'],
  rejected: ['edit', 'request-regeneration'],
  'needs-regeneration': ['approve', 'edit', 'reject'],
};

const NEXT: Record<EditorAction['type'], (current: ApprovalStatus) => ApprovalStatus> = {
  approve: () => 'approved',
  reject: () => 'rejected',
  edit: () => 'edited',
  'request-regeneration': () => 'needs-regeneration',
  'acknowledge-change': (current) => current,
};

export function canApply(plan: SegmentPlan, action: EditorAction['type']): boolean {
  return ALLOWED[plan.status].includes(action);
}

function change(from: ApprovalStatus | null, to: ApprovalStatus, by: StatusChange['by'], reason: string, at: string): StatusChange {
  return { from, to, by, reason, at };
}

function mergeParams(a: ConceptParams | undefined, b: ConceptParams | undefined): ConceptParams | undefined {
  if (!a && !b) return undefined;
  return { ...(a ?? {}), ...(b ?? {}) };
}

/**
 * Keeps an edit's concept and visual mode compatible. Picking a concept brings its own mode (a
 * "Kinetic headline" on a Captions segment becomes a motion graphic); picking a mode brings that
 * mode's default concept. Asking for an impossible pair explicitly is refused with the reason.
 * Edits that touch neither (params only) are left as they are.
 */
export function alignConceptAndMode(plan: SegmentPlan, overrides: EditorOverrides): { overrides: EditorOverrides; note?: string } {
  if (!overrides.conceptId && !overrides.visualMode) return { overrides };
  const current = effectiveSegment(plan);
  const conceptId = overrides.conceptId ?? current.conceptId;
  const mode = overrides.visualMode ?? current.visualMode;
  const issue = conceptModeIssue(conceptId, mode);
  if (!issue) return { overrides };
  if (overrides.conceptId && overrides.visualMode) throw new PlanningError('INVALID_ACTION', issue);
  if (overrides.conceptId) {
    const native = conceptById(conceptId)!.visualMode;
    return {
      overrides: { ...overrides, visualMode: native },
      note: `Concept set to ${conceptById(conceptId)!.label}; visual mode changed to ${modeLabel(native)} to match.`,
    };
  }
  const fallback = MODE_DEFAULT[mode];
  return {
    overrides: { ...overrides, conceptId: fallback },
    note: `Visual mode set to ${modeLabel(mode)}; concept changed to ${conceptById(fallback)?.label ?? fallback} to match.`,
  };
}

/** Applies an editor action. Throws INVALID_ACTION for transitions the workflow doesn't allow. */
export function applyEditorAction(plan: SegmentPlan, action: EditorAction, at: string): SegmentPlan {
  if (!canApply(plan, action.type)) {
    throw new PlanningError('INVALID_ACTION', `Can't ${action.type.replace('-', ' ')} a segment that is ${plan.status}.`);
  }
  const to = NEXT[action.type](plan.status);
  const next: SegmentPlan = { ...plan, status: to, history: [...plan.history] };
  switch (action.type) {
    case 'approve':
      next.inputHash = plan.stale?.inputHash ?? plan.inputHash;
      next.stale = undefined;
      next.history.push(change(plan.status, to, 'editor', 'Approved', at));
      break;
    case 'reject':
      next.rejectedConcepts = [...new Set([...plan.rejectedConcepts, effectiveConceptId(plan)])];
      next.history.push(change(plan.status, to, 'editor', action.reason ?? 'Rejected', at));
      break;
    case 'edit': {
      const { overrides, note } = alignConceptAndMode(plan, action.overrides);
      next.overrides = {
        ...(plan.overrides ?? {}),
        ...overrides,
        params: mergeParams(plan.overrides?.params, overrides.params),
      };
      next.history.push(change(plan.status, to, 'editor', action.overrides.note ?? note ?? 'Edited', at));
      break;
    }
    case 'request-regeneration':
      next.history.push(change(plan.status, to, 'editor', action.reason ?? 'Asked for a new idea', at));
      break;
    case 'acknowledge-change':
      next.inputHash = plan.stale?.inputHash ?? plan.inputHash;
      next.stale = undefined;
      next.history.push(change(plan.status, to, 'editor', 'Reviewed the changed transcript; kept the approval', at));
      break;
  }
  return next;
}

export function effectiveConceptId(plan: SegmentPlan): string {
  return plan.overrides?.conceptId ?? plan.suggestion.conceptId;
}

/** Suggestion with the editor's overrides applied: what would actually be rendered. */
export function effectiveSegment(plan: SegmentPlan, input?: PlanningSegmentInput): EffectiveSegment {
  return {
    segmentId: plan.segmentId,
    start: plan.start,
    end: plan.end,
    text: plan.text,
    speaker: plan.speaker,
    words: input?.words,
    conceptId: effectiveConceptId(plan),
    visualMode: plan.overrides?.visualMode ?? plan.suggestion.visualMode,
    params: { ...plan.suggestion.params, ...(plan.overrides?.params ?? {}) },
    transition: plan.overrides?.params?.transition ?? plan.suggestion.transition,
    status: plan.status,
  };
}

/** Hash of everything about a segment the planner reads. Timing is included: it changes pacing. */
export function segmentInputHash(s: PlanningSegmentInput): string {
  return hashHex({ text: s.text, start: s.start, end: s.end, speaker: s.speaker, instruction: s.instruction, visualMode: s.visualMode });
}

export function changeRecord(from: ApprovalStatus | null, to: ApprovalStatus, reason: string, at: string): StatusChange {
  return change(from, to, 'planner', reason, at);
}
