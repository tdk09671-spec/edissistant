// Converters between the planner and the rest of the app: PR #1 transcript sentences, the existing
// project segments in main, and plan results back into the sequence editor. Timing, transcript text
// and editor instructions are passed through untouched.

import { effectiveSegment } from './approval';
import type { ProjectSegmentCompat, TranscriptSentenceCompat } from './compat';
import { conceptById } from './concepts';
import type { PlanningSegmentInput, ProjectPlan } from './types';

/** PR #1 sentences → planning segments (with word timing for captions). `offset` shifts media time onto the timeline. */
export function fromTranscriptSentences(sentences: TranscriptSentenceCompat[], offset = 0): PlanningSegmentInput[] {
  return sentences
    .filter((s) => s.text.trim())
    .map((s) => ({
      id: s.id,
      start: s.start + offset,
      end: s.end + offset,
      text: s.text,
      words: s.words.map((w) => ({ text: w.text, start: w.start + offset, end: w.end + offset })),
    }));
}

/**
 * Existing project segments (src/renderer/types Segment) → planning segments. The segment's visual
 * mode is a default in the current app, so it is only treated as an editor lock when the segment is
 * already approved.
 */
export function fromProjectSegments(segments: ProjectSegmentCompat[]): PlanningSegmentInput[] {
  return segments
    .filter((s) => s.transcript.trim() && s.end > s.start)
    .map((s) => ({
      id: s.id,
      start: s.start,
      end: s.end,
      text: s.transcript,
      ...(s.instruction.trim() ? { instruction: s.instruction } : {}),
      ...(s.status === 'approved' ? { visualMode: s.visualMode } : {}),
    }));
}

export interface ProjectSegmentUpdate {
  id: string;
  /** Short, editor-facing summary for the existing "AI suggestion" field. */
  aiSuggestion: string;
  /** Present only when the editor approved the plan for this segment. */
  visualMode?: ProjectSegmentCompat['visualMode'];
  status: ProjectSegmentCompat['status'];
}

/**
 * Plan → updates for the existing segment fields. Never touches transcript, timing or instruction.
 * The visual mode is only written for approved segments; `background-graphics` maps to
 * `motion-graphics` because the current app has no separate mode for it.
 */
export function toProjectSegmentUpdates(plan: ProjectPlan): ProjectSegmentUpdate[] {
  return plan.segments.map((s) => {
    const eff = effectiveSegment(s);
    const label = conceptById(eff.conceptId)?.label ?? eff.conceptId;
    const mode = eff.visualMode === 'background-graphics' ? 'motion-graphics' : eff.visualMode;
    return {
      id: s.segmentId,
      aiSuggestion: `${label}: ${s.suggestion.reasoning}`,
      ...(s.status === 'approved' ? { visualMode: mode } : {}),
      status: s.status === 'approved' && !s.stale ? 'approved' : s.status === 'needs-regeneration' || s.status === 'rejected' || s.stale ? 'needs-revision' : 'pending',
    };
  });
}
