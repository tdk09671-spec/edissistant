// Creative planning contract. Pure types (no Node, no DOM): shared by the main-process services and
// the renderer. Nothing here imports PR #1 (transcription) or PR #2 (animation) modules; their shapes
// are mirrored structurally in compat.ts.

export const STYLE_PROFILE_SCHEMA = 'edissistant.style-profile';
export const STYLE_PROFILE_VERSION = 1;
export const PROJECT_PLAN_SCHEMA = 'edissistant.project-plan';
export const PROJECT_PLAN_VERSION = 1;

// --- Style profile ---------------------------------------------------------------------------------

export type ProvenanceKind = 'preset' | 'brief' | 'editor' | 'reference-video' | 'previous-edit' | 'reference-link' | 'vision-model' | 'default';

/** Where a piece of style evidence came from. */
export interface Provenance {
  kind: ProvenanceKind;
  /** Reference ID, preset ID, or "brief". */
  sourceId: string;
  /** File path or URL, when there is one. */
  location?: string;
  note?: string;
}

/** A style value with how sure we are and why. */
export interface Trait<T> {
  value: T;
  /** 0–1. Explicit editor/preset choices ≈ 0.95; inferred from one reference ≈ 0.5; defaults ≈ 0.2. */
  confidence: number;
  sources: Provenance[];
  /** Plain-language caveat shown to the editor when confidence is low. */
  uncertainty?: string;
}

export type GenericFamily = 'sans-serif' | 'serif' | 'monospace';

export interface FontStyle {
  family: string;
  fallback: GenericFamily;
  weight: number;
  /** Letter spacing in pixels at 1080p. */
  letterSpacing: number;
  textTransform: 'none' | 'uppercase' | 'lowercase';
  /** Absolute path to a font file to bundle with renders, when the editor provided one. */
  file?: string;
}

export interface Palette {
  background: string;
  text: string;
  /** Brand accent colors in priority order. */
  accents: string[];
  contrast: 'low' | 'medium' | 'high';
}

export type BackgroundPreference = 'paper' | 'cinematic' | 'solid' | 'gradient' | 'over-footage';
export type MotionEnergy = 'calm' | 'moderate' | 'energetic';
export type Density = 'minimal' | 'balanced' | 'dense';

export interface MotionStyle {
  energy: MotionEnergy;
  /** Preferred easing family (maps to PR #2 easing names). */
  easing: 'smooth' | 'snappy' | 'linear';
  /** Typical transition types, most preferred first. */
  transitions: Array<'fade' | 'slide' | 'scale' | 'wipe' | 'blur'>;
  /** Average shot length in reference edits, seconds (null when unknown). */
  averageShotSeconds: number | null;
}

export interface Pacing {
  /** Graphics per minute the client's edits typically carry. */
  graphicsPerMinute: number;
  /** Minimum seconds between full-screen graphics. */
  minGapSeconds: number;
}

/** Something the client doesn't want. Matched against concept IDs, concept families and effects. */
export interface AvoidRule {
  kind: 'concept' | 'family' | 'effect' | 'transition';
  value: string;
  reason?: string;
}

export interface StyleProfile {
  schema: typeof STYLE_PROFILE_SCHEMA;
  version: typeof STYLE_PROFILE_VERSION;
  /** Stable ID (usually the preset ID). */
  id: string;
  clientName: string;
  presetName: string;
  /** Increments on every saved change. */
  revision: number;
  /** Hash of the style content (not timestamps): changes only when the style changes. */
  fingerprint: string;
  typography: Trait<{ headline: FontStyle; body: FontStyle }>;
  palette: Trait<Palette>;
  background: Trait<BackgroundPreference>;
  motion: Trait<MotionStyle>;
  pacing: Trait<Pacing>;
  /** Recurring graphic devices, e.g. "underline", "grain", "paper texture", "charts". */
  graphicElements: Trait<string[]>;
  density: Trait<Density>;
  /** Positive creative rules from the brief or the editor, e.g. "numbers always count up". */
  rules: string[];
  avoid: AvoidRule[];
  /** Logo files from the preset (absolute paths). */
  logos: string[];
  provenance: Provenance[];
  /** Overall confidence 0–1 and what's missing. */
  confidence: number;
  uncertainties: string[];
  createdAt: string;
  updatedAt: string;
}

// --- Reference analysis -----------------------------------------------------------------------------

/** Measurements from a local reference video (computed by main/planning/referenceAnalysis.ts). */
export interface ReferenceAnalysis {
  id: string;
  kind: 'reference-video' | 'previous-edit';
  location: string;
  fingerprint: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  /** Detected cut times (seconds). */
  cuts: number[];
  cutsPerMinute: number;
  averageShotSeconds: number;
  /** Representative frames saved for review or optional vision analysis. */
  frames: { time: number; path: string }[];
  /** Dominant colors (hex), most common first. */
  dominantColors: string[];
  /** 0–1 */
  meanLuminance: number;
  /** Standard deviation of luminance, 0–1. */
  contrast: number;
  /** 0–1 */
  meanSaturation: number;
  analyzedAt: string;
  /** Optional, only when the editor approved a vision model run. */
  visionNotes?: string[];
}

// --- Planning inputs -------------------------------------------------------------------------------

export type VisualMode = 'speaker' | 'b-roll' | 'motion-graphics' | 'captions' | 'background-graphics';

export interface TranscriptWordInput {
  text: string;
  start: number;
  end: number;
}

/** One transcript segment as the editor approved it. The planner never changes these fields. */
export interface PlanningSegmentInput {
  id: string;
  /** Seconds on the project timeline. */
  start: number;
  end: number;
  text: string;
  speaker?: string;
  /** Editor's instruction for this segment (trusted: it comes from the editor). */
  instruction?: string;
  /** Editor-locked visual mode; the planner must use it. */
  visualMode?: VisualMode;
  words?: TranscriptWordInput[];
}

export type VarietyLevel = 'low' | 'balanced' | 'experimental';

export interface EditorPreferences {
  /** Concepts the editor wants more of (boost). */
  preferredConcepts?: string[];
  /** Concepts never to suggest in this project. */
  bannedConcepts?: string[];
  /** Per-segment concept the editor chose (wins over every suggestion). */
  forcedConcepts?: Record<string, string>;
}

export interface PlanningRequest {
  projectId: string;
  /** Client preset / style profile to plan with. */
  profile: StyleProfile;
  segments: PlanningSegmentInput[];
  variety?: VarietyLevel;
  preferences?: EditorPreferences;
  /** Concepts this client used in recent videos (most recent first), for cross-video freshness. */
  clientHistory?: ClientUsageHistory;
  /** Seed for deterministic tie-breaking. Same inputs + seed → same plan. Default: projectId. */
  seed?: string;
}

// --- Concepts -------------------------------------------------------------------------------------

export type ContentKind =
  | 'statistic'
  | 'money'
  | 'percentage'
  | 'comparison'
  | 'trend'
  | 'process'
  | 'list'
  | 'quote'
  | 'question'
  | 'claim'
  | 'definition'
  | 'time'
  | 'place'
  | 'person'
  | 'emotion'
  | 'call-to-action'
  | 'transition'
  | 'statement';

export type ConceptFamily = 'typography' | 'data' | 'diagram' | 'emphasis' | 'caption' | 'texture' | 'footage' | 'speaker' | 'identity';

/** A reusable creative idea, independent of any one client's look. */
export interface VisualConcept {
  id: string;
  label: string;
  family: ConceptFamily;
  visualMode: VisualMode;
  /** Content kinds this concept tells well, with a 0–1 fit. */
  suits: Partial<Record<ContentKind, number>>;
  energy: MotionEnergy;
  density: Density;
  /** PR #2 component types the concept is built from, or null when it can't render (needs footage, 3D, maps…). */
  components: string[] | null;
  /** Why it can't render, when components is null. */
  unsupportedReason?: string;
  /** Effects the concept relies on (matched against AvoidRule effect). */
  effects: string[];
  description: string;
}

/** What a provider (local heuristics or a model) proposes for one segment. */
export interface ConceptCandidate {
  conceptId: string;
  /** 0–1 fit to the content. */
  fit: number;
  /** Short, user-facing reason (≤ 200 chars). */
  reasoning: string;
  /** Content meaning in a few words (≤ 160 chars). */
  meaning?: string;
  params?: ConceptParams;
  source: 'local' | 'model';
}

/** Content-level parameters. Visual styling (fonts, colors, background) always comes from the profile. */
export interface ConceptParams {
  /** On-screen text. Must be taken from the transcript (checked). */
  headline?: string;
  /** Words to emphasize, from the transcript. */
  emphasis?: string[];
  /** Numbers for counters/charts, from the transcript. */
  values?: { label?: string; value: number; unit?: string; /** Words after the number ("as fast"). */ context?: string }[];
  /** Steps or list items, from the transcript. */
  items?: string[];
  /** Relative pace multiplier: 0.5 slower … 2 faster. Default 1. */
  pace?: number;
  /** Text scale multiplier 0.5–2. Default 1. */
  scale?: number;
  /** Transition override. */
  transition?: MotionStyle['transitions'][number];
  /** Accent color override (editor only). */
  accent?: string;
}

// --- Plans & approvals -----------------------------------------------------------------------------

export type ApprovalStatus = 'suggested' | 'edited' | 'approved' | 'rejected' | 'needs-regeneration';

/** The planner's (or model's) proposal for a segment. */
export interface Suggestion {
  conceptId: string;
  visualMode: VisualMode;
  meaning: string;
  treatment: string;
  reasoning: string;
  params: ConceptParams;
  transition: MotionStyle['transitions'][number];
  requiredAssets: string[];
  source: 'local' | 'model';
  /** Variety notes, e.g. "chose a timeline instead of a third bar chart". */
  varietyNotes: string[];
}

/** Editor's changes on top of a suggestion. Always win over the suggestion. */
export interface EditorOverrides {
  conceptId?: string;
  visualMode?: VisualMode;
  params?: ConceptParams;
  note?: string;
}

export interface StatusChange {
  from: ApprovalStatus | null;
  to: ApprovalStatus;
  by: 'planner' | 'editor';
  reason: string;
  at: string;
}

export interface SegmentPlan {
  segmentId: string;
  /** Copied verbatim from the input; never edited by the planner. */
  start: number;
  end: number;
  text: string;
  speaker?: string;
  instruction?: string;
  /** Hash of the segment input the suggestion was made for. */
  inputHash: string;
  status: ApprovalStatus;
  suggestion: Suggestion;
  overrides?: EditorOverrides;
  /** Concepts the editor rejected for this segment (never suggested again for it). */
  rejectedConcepts: string[];
  /** Set when the input changed after approval; the approval is kept until the editor decides. */
  stale?: { reason: string; since: string; /** Hash of the changed input, adopted when the editor approves or acknowledges. */ inputHash: string };
  warnings: string[];
  history: StatusChange[];
}

export interface ProjectPlan {
  schema: typeof PROJECT_PLAN_SCHEMA;
  version: typeof PROJECT_PLAN_VERSION;
  projectId: string;
  profileId: string;
  profileFingerprint: string;
  variety: VarietyLevel;
  segments: SegmentPlan[];
  /** Project-level repetition and brand findings. */
  findings: PlanFinding[];
  createdAt: string;
  updatedAt: string;
}

export interface PlanFinding {
  kind: 'repetition' | 'brand' | 'pacing' | 'injection' | 'unsupported';
  severity: 'info' | 'warning';
  segmentIds: string[];
  message: string;
}

/** Concepts and transitions a client used in previous videos (most recent first). */
export interface ClientUsageHistory {
  clientId: string;
  projects: { projectId: string; concepts: string[]; transitions: string[]; at: string }[];
}

// --- Effective plan (suggestion + overrides) --------------------------------------------------------

export interface EffectiveSegment {
  segmentId: string;
  start: number;
  end: number;
  text: string;
  speaker?: string;
  words?: TranscriptWordInput[];
  conceptId: string;
  visualMode: VisualMode;
  params: ConceptParams;
  transition: MotionStyle['transitions'][number];
  status: ApprovalStatus;
}
