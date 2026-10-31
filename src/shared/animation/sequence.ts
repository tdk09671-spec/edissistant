import { stableStringify } from './random';
import { segmentFrames } from './timeline';
import type { AnimationSpec, ExportFormatId, SequenceSpec } from './types';

/**
 * Bump when rendering output changes for the same spec (component drawing, encoder settings), so
 * cached renders from an older engine are not reused.
 */
export const RENDER_ENGINE_VERSION = '2';

export interface RenderSettings {
  format: ExportFormatId;
  /** Output scale relative to the spec resolution (1 = full, 0.5 = half-resolution preview). */
  scale: number;
}

/**
 * The visual content of a segment: everything that affects its pixels. Timeline placement
 * (`start`/`end`) and the segment ID are excluded, so moving a segment or reusing an approved
 * design under another ID never forces a re-render.
 */
export function segmentContent(spec: AnimationSpec): Omit<AnimationSpec, 'id' | 'start' | 'end'> {
  const { id: _id, start: _start, end: _end, ...content } = spec;
  return content;
}

/**
 * Canonical string identifying a render: content + frame count + output settings + asset file
 * fingerprints + engine version. Hash it (SHA-256 in the main process) to get the cache key.
 * The frame count depends on where the segment starts (see segmentFrames), so a move that changes
 * it by a frame re-renders; a move that keeps it reuses the render.
 */
export function renderIdentity(spec: AnimationSpec, settings: RenderSettings, assetFingerprints: Readonly<Record<string, string>>): string {
  return stableStringify({
    engine: RENDER_ENGINE_VERSION,
    content: segmentContent(spec),
    frames: frameSpanCount(spec),
    format: settings.format,
    scale: settings.scale,
    assets: assetFingerprints,
  });
}

export interface SequenceDiff {
  added: string[];
  removed: string[];
  /** Visual content changed: must be re-rendered. */
  changed: string[];
  /** Only the timeline position changed: the existing render is reused. */
  moved: string[];
  unchanged: string[];
}

function frameSpanCount(spec: AnimationSpec): number {
  return segmentFrames(spec.start, spec.duration, spec.fps).count;
}

/** Compares two versions of a sequence by segment ID. */
export function diffSequences(previous: SequenceSpec | null, next: SequenceSpec): SequenceDiff {
  const before = new Map((previous?.segments ?? []).map((s) => [s.id, s]));
  const diff: SequenceDiff = { added: [], removed: [], changed: [], moved: [], unchanged: [] };
  for (const seg of next.segments) {
    const old = before.get(seg.id);
    if (!old) diff.added.push(seg.id);
    else if (stableStringify(segmentContent(old)) !== stableStringify(segmentContent(seg)) || frameSpanCount(old) !== frameSpanCount(seg)) diff.changed.push(seg.id);
    else if (old.start !== seg.start) diff.moved.push(seg.id);
    else diff.unchanged.push(seg.id);
    before.delete(seg.id);
  }
  diff.removed = [...before.keys()];
  return diff;
}

/** Replaces one segment's spec, leaving every other segment object untouched. */
export function replaceSegment(sequence: SequenceSpec, spec: AnimationSpec): SequenceSpec {
  if (!sequence.segments.some((s) => s.id === spec.id)) throw new Error(`Unknown segment "${spec.id}"`);
  return { ...sequence, segments: sequence.segments.map((s) => (s.id === spec.id ? spec : s)) };
}
