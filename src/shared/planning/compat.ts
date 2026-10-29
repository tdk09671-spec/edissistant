// Structural mirrors of the contracts in the two open PRs, so this module compiles and is tested on
// main without importing unmerged code.
//
//  - PR #1 (feature/local-transcription): src/shared/transcription/types.ts → TranscriptSentence.
//  - PR #2 (feature/animation-rendering): src/shared/animation/types.ts → AnimationSpec, SequenceSpec.
//
// Only the subset the planner produces is mirrored. Field names and value types match those files
// exactly; tests/unit/planning/pr2Compat.test.ts validates adapter output with PR #2's own validator
// when that code is present (after merge), and is skipped otherwise.

// --- PR #1 ----------------------------------------------------------------------------------------

export interface TranscriptSentenceCompat {
  id: string;
  start: number;
  end: number;
  text: string;
  words: { text: string; start: number; end: number; confidence?: number }[];
  edited?: boolean;
}

// --- main: renderer Segment (src/renderer/types/index.ts) ------------------------------------------

export interface ProjectSegmentCompat {
  id: string;
  start: number;
  end: number;
  transcript: string;
  visualMode: 'speaker' | 'b-roll' | 'motion-graphics' | 'captions';
  instruction: string;
  aiSuggestion: string;
  status: 'pending' | 'approved' | 'needs-revision';
}

// --- PR #2 ----------------------------------------------------------------------------------------

export const ANIMATION_SPEC_VERSION_COMPAT = 1;

export type EasingCompat =
  | 'linear'
  | 'easeOutQuad'
  | 'easeOutCubic'
  | 'easeInOutCubic'
  | 'easeOutQuart'
  | 'easeOutExpo'
  | 'easeOutBack'
  | 'easeInCubic';

export type AnimatableCompat<T> = T | { keyframes: { t: number; value: T; easing?: EasingCompat }[] };

export interface TypographyCompat {
  fontFamily: string;
  fallback?: 'sans-serif' | 'serif' | 'monospace';
  allowFallback?: boolean;
  fontWeight?: number;
  fontStyle?: 'normal' | 'italic';
  fontSize: number;
  letterSpacing?: number;
  lineHeight?: number;
  textTransform?: 'none' | 'uppercase' | 'lowercase';
}

export interface TransitionCompat {
  type: 'fade' | 'slide' | 'scale' | 'wipe' | 'blur';
  duration: number;
  easing?: EasingCompat;
  direction?: 'left' | 'right' | 'up' | 'down';
  distance?: number;
}

export type BackgroundCompat =
  | { type: 'transparent' }
  | { type: 'solid'; color: string }
  | { type: 'gradient'; kind: 'linear' | 'radial'; stops: { offset: number; color: string }[]; angle?: number }
  | { type: 'paper'; color?: string; grain?: number; fibers?: number }
  | { type: 'cinematic'; color?: string; vignette?: number; grain?: number; light?: string }
  | { type: 'image'; asset: string; fit?: 'cover' | 'contain' };

export interface LayerCompat {
  id: string;
  type: 'text' | 'shape' | 'path' | 'counter' | 'barChart' | 'lineChart' | 'progress' | 'highlight' | 'diagram' | 'image' | 'captions' | 'group';
  start?: number;
  end?: number;
  transform?: { x?: AnimatableCompat<number>; y?: AnimatableCompat<number>; scale?: AnimatableCompat<number>; rotation?: AnimatableCompat<number> };
  opacity?: AnimatableCompat<number>;
  enter?: TransitionCompat;
  exit?: TransitionCompat;
  /** Component props; shapes per component in PR #2 types.ts. */
  props: Record<string, unknown>;
}

export interface AnimationSpecCompat {
  specVersion: typeof ANIMATION_SPEC_VERSION_COMPAT;
  id: string;
  start: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  exportMode: 'full-motion' | 'transparent-motion' | 'transparent-captions';
  background: BackgroundCompat;
  seed?: number;
  assets?: { fonts?: { family: string; path: string; weight?: number }[]; images?: { id: string; path: string }[] };
  layers: LayerCompat[];
}

export interface SequenceSpecCompat {
  id: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  segments: AnimationSpecCompat[];
}

/** PR #2 component types (engine/registry.ts). */
export const PR2_COMPONENTS = ['text', 'shape', 'path', 'counter', 'barChart', 'lineChart', 'progress', 'highlight', 'diagram', 'image', 'captions', 'group'] as const;

/** PR #2's ID rule (validate.ts ID_PATTERN). */
export const PR2_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
