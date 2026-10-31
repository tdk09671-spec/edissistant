// IPC contract for the end-to-end editing pipeline: transcript segments → creative plan (PR #3) →
// animation specs (PR #2). Transcription and rendering keep their own channels (PR #1, PR #2); these
// channels cover planning, sequence building, source probing and export checks.

import type { ApprovalStatus, PlanFinding, VarietyLevel } from '../planning/types';
import type { EditorAction } from '../planning/approval';
import type { AdapterResult } from '../planning/adapter';
import type { PresetLike } from '../planning/styleProfile';
import type { SequenceSpecCompat } from '../planning/compat';

/** The editor-facing visual modes of a sequence row (renderer `Segment.visualMode`). */
export type UiVisualMode = 'speaker' | 'b-roll' | 'motion-graphics' | 'captions';
/** The editor-facing review status of a sequence row (renderer `Segment.status`). */
export type UiSegmentStatus = 'pending' | 'approved' | 'needs-revision';

export interface SegmentWord {
  text: string;
  /** Seconds on the project timeline. */
  start: number;
  end: number;
}

/** What the pipeline reads from a sequence row. */
export interface PipelineSegment {
  id: string;
  start: number;
  end: number;
  transcript: string;
  instruction: string;
  /** Word timing from transcription; ignored once the editor has changed the text. */
  words?: SegmentWord[];
  /**
   * The editor's on-screen in/out for this row's graphic (seconds), separate from the speech timing
   * above. Never a planning input: changing it re-renders the graphic but never replans it.
   */
  visualTiming?: VisualTiming;
}

/** On-screen in/out of a graphic, set by the editor. Snapped to the project's frame grid. */
export interface VisualTiming {
  start: number;
  end: number;
}

/** The plan for one row, as stored on the project and shown in the sequence table. */
export interface SegmentPlanInfo {
  conceptId: string;
  conceptLabel: string;
  /** Visual mode of the effective plan (suggestion + editor overrides). */
  mode: UiVisualMode;
  planStatus: ApprovalStatus;
  meaning: string;
  reasoning: string;
  source: 'local' | 'model';
  /** Set when an approved segment changed afterwards and needs a look before it renders. */
  stale?: string;
  /**
   * The editor instruction the current graphic was planned with ('' for none). When the row's
   * instruction differs, the editor's request hasn't been applied yet (see `instructionPending`).
   * Absent in projects saved before this field existed.
   */
  plannedInstruction?: string;
  /** False when PR #2 has no way to render this concept (b-roll footage, maps…). */
  renderable: boolean;
  unsupportedReason?: string;
  /** The editor picked the concept or mode (an override), not the planner. */
  editorChoice: boolean;
  warnings: string[];
}

export interface SegmentUpdate {
  id: string;
  aiSuggestion: string;
  status: UiSegmentStatus;
  /** Present only once the editor approved the segment's plan. */
  visualMode?: UiVisualMode;
  plan: SegmentPlanInfo;
}

export interface ProjectPlanningInput {
  projectId: string;
  preset: PresetLike;
  /** Project direction notes; read like the preset's creative brief. */
  notes?: string;
  segments: PipelineSegment[];
  variety?: VarietyLevel;
}

export interface PlanRequest extends ProjectPlanningInput {
  /** Approved segments the editor explicitly allows the planner to replace. */
  allowReplan?: string[];
  /** Ask Claude for candidates (costs money; needs a key). The app keeps this off until approved. */
  useModel?: boolean;
}

export interface PlanOutcome {
  updates: SegmentUpdate[];
  planned: string[];
  kept: string[];
  flagged: string[];
  warnings: string[];
  findings: PlanFinding[];
  profile: { id: string; revision: number; confidence: number; uncertainties: string[] };
  cost: { calls: number; estimatedCost: number; warnings: string[] };
  /** Set when the requested decision was held back (e.g. approving a suggestion the editor hasn't seen). */
  deferred?: string;
  /** What happened to a changed editor instruction when the segment was approved. */
  instruction?: { status: 'applied' | 'partial' | 'not-applied' | 'kept'; message: string };
}

export interface ActRequest extends ProjectPlanningInput {
  segmentId: string;
  action: EditorAction;
}

/**
 * - composite: graphics as planned (with their backgrounds) for laying over the source footage.
 * - alpha: the same graphics with transparent backgrounds, for the editor's NLE.
 * - captions: a caption layer for every segment with a transcript.
 */
export type RenderTarget = 'composite' | 'alpha' | 'captions';

export interface BuildRequest extends ProjectPlanningInput {
  target: RenderTarget;
  width: number;
  height: number;
  fps: number;
  /** Timeline length in seconds (the source duration). */
  duration: number;
  allowFontFallback?: boolean;
}

export interface SegmentBuildResult {
  segmentId: string;
  conceptId: string;
  /** 'invalid': the spec failed PR #2's validator and was left out so the rest still renders. */
  status: AdapterResult['status'] | 'invalid';
  reason?: string;
  warnings: string[];
}

export interface BuildOutcome {
  sequence: SequenceSpecCompat;
  results: SegmentBuildResult[];
  /** Maps PR #2 spec ids back to sequence rows. */
  specIds: Record<string, string>;
}

/** What pipeline:build returns: the sequence plus the row updates from bringing the plan up to date. */
export type BuildResponse = BuildOutcome & { updates: SegmentUpdate[] };

export interface SourceInfo {
  path: string;
  duration: number;
  width: number;
  height: number;
  /** Frame rate as FFprobe reports it, e.g. "30000/1001". */
  frameRate: string;
  /** The rate in the project's terms (23.976, 25, 29.97…), or null if the timeline can't use it. */
  fps: number | null;
  videoCodec: string;
  hasAudio: boolean;
  audioCodec?: string;
  sampleRate?: number;
  channels?: number;
}

export interface MediaCheck {
  path: string;
  sizeBytes: number;
  duration: number;
  video: { codec: string; width: number; height: number; frameRate: string; frames: number; pixFmt: string; hasAlpha: boolean } | null;
  audio: { codec: string; sampleRate: number; channels: number; duration: number } | null;
}

export type PipelineErrorCode = 'INVALID_REQUEST' | 'MEDIA_NOT_FOUND' | 'FFPROBE_NOT_FOUND' | 'PROBE_FAILED' | 'PLANNING_FAILED' | 'INVALID_ACTION';

export type PipelineResult<T> = { ok: true; result: T } | { ok: false; error: { code: PipelineErrorCode | string; message: string } };

/** Methods the preload bridge adds to window.electronAPI. */
export interface PipelineBridgeAPI {
  probeSource: (mediaPath: string) => Promise<PipelineResult<SourceInfo>>;
  planProject: (request: PlanRequest) => Promise<PipelineResult<PlanOutcome>>;
  planAction: (request: ActRequest) => Promise<PipelineResult<PlanOutcome>>;
  buildSequence: (request: BuildRequest) => Promise<PipelineResult<BuildResponse>>;
  checkMedia: (mediaPath: string) => Promise<PipelineResult<MediaCheck>>;
}
