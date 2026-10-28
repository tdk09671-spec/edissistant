// Renderer entry point for the animation/render engine. The UI doesn't call this yet; it is the
// supported way to start, follow and cancel renders from the sequence editor.

import { v4 as uuid } from 'uuid';
import type {
  RenderProgress,
  RenderResult,
  SegmentRenderOptions,
  SegmentRenderResult,
  SequenceRenderOptions,
  SequenceRenderResult,
} from '../../shared/animation/api';
import { RenderError } from '../../shared/animation/errors';

export interface RenderJob<T> {
  jobId: string;
  /** Resolves with the result or rejects with a RenderError (code CANCELLED when cancelled). */
  result: Promise<T>;
  cancel: () => Promise<boolean>;
}

function start<T>(run: (jobId: string) => Promise<RenderResult<T>>, onProgress?: (p: RenderProgress) => void): RenderJob<T> {
  const api = window.electronAPI;
  const jobId = uuid();
  if (!api) {
    return { jobId, result: Promise.reject(new RenderError('FFMPEG_NOT_FOUND', 'Rendering needs the desktop app.')), cancel: async () => false };
  }
  const unsubscribe = onProgress ? api.onRenderProgress((p) => p.jobId === jobId && onProgress(p)) : () => {};
  const result = run(jobId)
    .then((r) => {
      if (!r.ok) throw new RenderError(r.error.code, r.error.message, { issues: r.error.issues, details: r.error.details });
      return r.result;
    })
    .finally(unsubscribe);
  return { jobId, result, cancel: () => api.cancelRender(jobId) };
}

/** Renders one segment spec (cached by content: unchanged specs return instantly). */
export function renderSegment(spec: unknown, options: SegmentRenderOptions = {}, onProgress?: (p: RenderProgress) => void): RenderJob<SegmentRenderResult> {
  return start((jobId) => window.electronAPI!.renderSegment(jobId, spec, options), onProgress);
}

/** Renders a sequence, re-rendering only changed segments, and composes the preview. */
export function renderSequence(sequence: unknown, options: SequenceRenderOptions = {}, onProgress?: (p: RenderProgress) => void): RenderJob<SequenceRenderResult> {
  return start((jobId) => window.electronAPI!.renderSequence(jobId, sequence, options), onProgress);
}
