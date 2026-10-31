// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderSegment, renderSequence } from '../../../src/renderer/lib/render';
import type { RenderProgress, RenderResult, SegmentRenderResult } from '../../../src/shared/animation';

afterEach(() => {
  delete (window as { electronAPI?: unknown }).electronAPI;
});

function mockApi(result: RenderResult<unknown>) {
  let listener: ((p: RenderProgress) => void) | null = null;
  const api = {
    renderSegment: vi.fn(async (jobId: string) => {
      listener?.({ jobId, stage: 'rendering', progress: 0.5, message: '' });
      listener?.({ jobId: 'someone-else', stage: 'rendering', progress: 0.9, message: '' });
      return result;
    }),
    renderSequence: vi.fn(async () => result),
    cancelRender: vi.fn(async () => true),
    onRenderProgress: vi.fn((cb: (p: RenderProgress) => void) => {
      listener = cb;
      return () => (listener = null);
    }),
  };
  (window as { electronAPI?: unknown }).electronAPI = api;
  return api;
}

describe('renderer render helpers', () => {
  it('resolves with the result and forwards only its own progress', async () => {
    const api = mockApi({ ok: true, result: { segmentId: 's' } as SegmentRenderResult });
    const seen: number[] = [];
    const job = renderSegment({ id: 's' }, { quality: 'preview' }, (p) => seen.push(p.progress));
    await expect(job.result).resolves.toEqual({ segmentId: 's' });
    expect(api.renderSegment).toHaveBeenCalledWith(job.jobId, { id: 's' }, { quality: 'preview' });
    expect(seen).toEqual([0.5]);
    await job.cancel();
    expect(api.cancelRender).toHaveBeenCalledWith(job.jobId);
  });

  it('rejects with a coded RenderError carrying spec issues', async () => {
    mockApi({ ok: false, error: { code: 'INVALID_SPEC', message: 'bad', issues: [{ path: 'fps', message: 'nope' }] } });
    await expect(renderSequence({}).result).rejects.toMatchObject({ code: 'INVALID_SPEC', issues: [{ path: 'fps', message: 'nope' }] });
  });

  it('rejects outside Electron', async () => {
    await expect(renderSegment({}).result).rejects.toMatchObject({ code: 'FFMPEG_NOT_FOUND' });
  });
});
