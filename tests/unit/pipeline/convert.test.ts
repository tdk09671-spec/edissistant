import { describe, expect, it } from 'vitest';
import { fpsRational, secondsToFrames, validateAnimationSpec, validateSequence } from '../../../src/shared/animation';
import { adaptSegment, applyEditorAction, CreativePlanner, type ProjectPlan } from '../../../src/shared/planning';
import { actionForStatus, buildSequence, parseResolution, segmentUpdates, toPlanningInputs, uiStatus, wordsMatchText } from '../../../src/shared/pipeline/convert';
import type { PipelineSegment } from '../../../src/shared/pipeline/types';
import { NOW, now, profile, transcript } from '../planning/helpers';

const rows = (): PipelineSegment[] =>
  transcript('video-a').map((s) => ({ id: s.id, start: s.start, end: s.end, transcript: s.text, instruction: '' }));

async function planned(segments = rows()): Promise<ProjectPlan> {
  return (await new CreativePlanner().plan({ projectId: 'p1', profile: profile(), segments: toPlanningInputs(segments) }, { now })).plan;
}

const approveAll = (plan: ProjectPlan): ProjectPlan => ({ ...plan, segments: plan.segments.map((s) => applyEditorAction(s, { type: 'approve' }, NOW)) });

describe('sequence rows → planner inputs', () => {
  it('skips empty rows, sorts by time and never passes the row’s visual mode', () => {
    const input = toPlanningInputs([
      { id: 'b', start: 5, end: 7, transcript: ' Second. ', instruction: '  make it a list ' },
      { id: 'a', start: 1, end: 3, transcript: 'First.', instruction: '' },
      { id: 'c', start: 8, end: 8, transcript: 'No duration.', instruction: '' },
      { id: 'd', start: 9, end: 10, transcript: '   ', instruction: '' },
    ]);
    expect(input).toEqual([
      { id: 'a', start: 1, end: 3, text: 'First.' },
      { id: 'b', start: 5, end: 7, text: 'Second.', instruction: 'make it a list' },
    ]);
  });

  it('keeps word timing only while it still matches the text', () => {
    const words = [
      { text: 'We', start: 1, end: 1.2 },
      { text: 'grew', start: 1.2, end: 1.5 },
      { text: '40%.', start: 1.5, end: 2 },
    ];
    expect(wordsMatchText(words, 'We grew 40%.')).toBe(true);
    expect(toPlanningInputs([{ id: 'a', start: 1, end: 2, transcript: 'We grew 40%.', instruction: '', words }])[0].words).toHaveLength(3);
    // The editor rewrote the sentence: the old timing would caption the wrong words.
    expect(toPlanningInputs([{ id: 'a', start: 1, end: 2, transcript: 'We grew 45%.', instruction: '', words }])[0].words).toBeUndefined();
  });
});

describe('plan → sequence rows', () => {
  it('maps plan states to row statuses and only sets the visual mode once approved', async () => {
    const plan = await planned();
    const updates = segmentUpdates(plan);
    expect(updates.every((u) => u.status === 'pending' && u.visualMode === undefined && u.plan.planStatus === 'suggested')).toBe(true);
    for (const u of updates) expect(Object.keys(u).sort()).toEqual(['aiSuggestion', 'id', 'plan', 'status']);
    const approved = segmentUpdates(approveAll(plan));
    expect(approved.every((u) => u.status === 'approved' && u.visualMode === u.plan.mode)).toBe(true);
    expect(uiStatus({ status: 'approved', stale: { reason: 'x', since: NOW, inputHash: 'h' } })).toBe('needs-revision');
    expect(uiStatus({ status: 'rejected' })).toBe('needs-revision');
    expect(uiStatus({ status: 'edited' })).toBe('pending');
  });

  it('turns status picks into planner actions', () => {
    expect(actionForStatus({ planStatus: 'suggested' }, 'approved')).toEqual({ type: 'approve' });
    expect(actionForStatus({ planStatus: 'approved' }, 'approved')).toBeNull();
    expect(actionForStatus({ planStatus: 'approved', stale: 'changed' }, 'approved')).toEqual({ type: 'acknowledge-change' });
    expect(actionForStatus({ planStatus: 'rejected' }, 'approved')).toBeNull();
    expect(actionForStatus({ planStatus: 'approved' }, 'needs-revision')).toMatchObject({ type: 'request-regeneration' });
    expect(actionForStatus({ planStatus: 'needs-regeneration' }, 'needs-revision')).toBeNull();
    expect(actionForStatus({ planStatus: 'approved' }, 'pending')).toEqual({ type: 'edit', overrides: {} });
    expect(actionForStatus({ planStatus: 'suggested' }, 'pending')).toBeNull();
    // A changed instruction goes to the main process to be applied, never acknowledged away.
    expect(actionForStatus({ planStatus: 'approved' }, 'approved', { instructionPending: true })).toEqual({ type: 'approve' });
    expect(actionForStatus({ planStatus: 'approved', stale: 'changed' }, 'approved', { instructionPending: true })).toEqual({ type: 'approve' });
    expect(actionForStatus({ planStatus: 'rejected' }, 'approved', { instructionPending: true })).toBeNull();
  });

  it('parses export resolutions to even sizes', () => {
    expect(parseResolution('1920x1080')).toEqual({ width: 1920, height: 1080 });
    expect(parseResolution('1081x1351')).toEqual({ width: 1082, height: 1352 });
    expect(parseResolution('big')).toBeNull();
  });
});

describe('approved plan → PR #2 sequences', () => {
  const opts = { projectId: 'p1', width: 1920, height: 1080, duration: 45 };

  it('renders only approved rows; the composite validates with PR #2 at 23.976, 25 and 29.97 fps', async () => {
    const plan = await planned();
    const half = { ...plan, segments: plan.segments.map((s, i) => (i % 2 ? applyEditorAction(s, { type: 'approve' }, NOW) : s)) };
    for (const fps of [23.976, 25, 29.97]) {
      const built = buildSequence(half, toPlanningInputs(rows()), profile(), { ...opts, fps, target: 'composite' });
      expect(validateSequence(built.sequence)).toMatchObject({ ok: true });
      expect(built.sequence.fps).toBe(fps);
      const approvedIds = new Set(half.segments.filter((s) => s.status === 'approved').map((s) => s.segmentId));
      for (const r of built.results) if (!approvedIds.has(r.segmentId)) expect(r.status).toBe('not-approved');
      expect(Object.values(built.specIds).every((id) => approvedIds.has(id))).toBe(true);
    }
  });

  it('alpha target: the same graphics with transparent backgrounds', async () => {
    const plan = approveAll(await planned());
    const composite = buildSequence(plan, toPlanningInputs(rows()), profile(), { ...opts, fps: 25, target: 'composite' });
    const alpha = buildSequence(plan, toPlanningInputs(rows()), profile(), { ...opts, fps: 25, target: 'alpha' });
    expect(validateSequence(alpha.sequence)).toMatchObject({ ok: true });
    expect(alpha.sequence.segments.map((s) => s.id)).toEqual(composite.sequence.segments.map((s) => s.id));
    for (const spec of alpha.sequence.segments) {
      expect(spec.background).toEqual({ type: 'transparent' });
      expect(spec.exportMode).not.toBe('full-motion');
    }
    expect(composite.sequence.segments.some((s) => s.exportMode === 'full-motion' && s.background.type !== 'transparent')).toBe(true);
  });

  it('captions target: one caption clip per row with text, approved or not', async () => {
    const plan = await planned();
    const inputs = toPlanningInputs(rows());
    const built = buildSequence(plan, inputs, profile(), { ...opts, fps: 29.97, target: 'captions' });
    expect(validateSequence(built.sequence)).toMatchObject({ ok: true });
    expect(built.sequence.segments).toHaveLength(inputs.length);
    expect(built.sequence.segments.every((s) => s.exportMode === 'transparent-captions' && s.layers[0].type === 'captions')).toBe(true);
  });

  it('a row changed since planning is reported, not rendered from the old plan', async () => {
    const plan = approveAll(await planned());
    const edited = rows().map((r, i) => (i === 1 ? { ...r, end: r.end + 0.5 } : r));
    const built = buildSequence(plan, toPlanningInputs(edited), profile(), { ...opts, fps: 25, target: 'composite' });
    expect(built.results.find((r) => r.segmentId === edited[1].id)).toMatchObject({ status: 'not-approved', reason: expect.stringMatching(/Changed since it was planned/) });
  });
});

describe('caption legibility (found in the demo render)', () => {
  it('highlights with a brand colour that reads on dark footage, not a near-black one', () => {
    const p = profile();
    const dark = { ...p, palette: { ...p.palette, value: { ...p.palette.value, accents: ['#111216', '#e9a94b'] } } };
    const seg = { segmentId: 'a', start: 0, end: 2, text: 'New episodes every Tuesday.', conceptId: 'caption-emphasis', visualMode: 'captions' as const, params: {}, transition: 'fade' as const, status: 'approved' as const };
    const r = adaptSegment(seg, dark, { width: 1920, height: 1080, fps: 25 });
    if (r.status !== 'renderable') throw new Error(r.status);
    expect((r.spec.layers[0].props as { style: { highlightColor: string } }).style.highlightColor).toBe('#e9a94b');
    const none = adaptSegment(seg, { ...dark, palette: { ...dark.palette, value: { ...dark.palette.value, accents: ['#111216'] } } }, { width: 1920, height: 1080, fps: 25 });
    if (none.status !== 'renderable') throw new Error(none.status);
    expect((none.spec.layers[0].props as { style: { highlightColor: string } }).style.highlightColor).toBe('#ffd166');
  });
});

describe('caption timing regression (found by the end-to-end run)', () => {
  it('cues and words never end after the segment, even when rounding would push them past it', () => {
    // Segment 0.8–4.965 s (4.165 s); word timing from transcription isn't rounded like the row is.
    const words = 'This is The Cutting Room, the podcast for people who edit for a living.'.split(' ').map((text, i, all) => ({
      text,
      start: 0.8 + (4.1654 * i) / all.length,
      end: 0.8 + (4.1654 * (i + 1)) / all.length,
    }));
    for (const fps of [25, 29.97]) {
      const r = adaptSegment(
        { segmentId: 'a', start: 0.8, end: 4.965, text: words.map((w) => w.text).join(' '), words, conceptId: 'caption-emphasis', visualMode: 'captions', params: {}, transition: 'fade', status: 'approved' },
        profile(),
        { width: 1920, height: 1080, fps }
      );
      expect(r.status).toBe('renderable');
      if (r.status !== 'renderable') return;
      expect(validateAnimationSpec(r.spec)).toMatchObject({ ok: true });
      const cues = (r.spec.layers[0].props as { cues: { end: number; words?: { end: number }[] }[] }).cues;
      for (const c of cues) {
        expect(c.end).toBeLessThanOrEqual(r.spec.duration);
        for (const w of c.words ?? []) expect(w.end).toBeLessThanOrEqual(c.end);
      }
    }
  });
});

describe('one bad segment never blocks the others (Windows regression)', () => {
  it('a spec the renderer would reject is reported as invalid and left out; the rest is a valid sequence', async () => {
    const plan = approveAll(await planned());
    // An editor override PR #2 can't accept (not a colour) on one segment only.
    // Concepts that draw with the accent colour.
    const target = plan.segments.find((s) => ['counter-hero', 'progress-ring', 'bar-comparison', 'line-trend', 'question-card', 'underline-callout', 'stat-split'].includes(s.suggestion.conceptId))!.segmentId;
    const broken = { ...plan, segments: plan.segments.map((s) => (s.segmentId === target ? { ...s, overrides: { ...(s.overrides ?? {}), params: { accent: 'not-a-colour' } } } : s)) };
    const good = buildSequence(plan, toPlanningInputs(rows()), profile(), { projectId: 'p1', width: 1920, height: 1080, fps: 25, duration: 45, target: 'composite' });
    const built = buildSequence(broken, toPlanningInputs(rows()), profile(), { projectId: 'p1', width: 1920, height: 1080, fps: 25, duration: 45, target: 'composite' });
    expect(built.results.find((r) => r.segmentId === target)).toMatchObject({ status: 'invalid', reason: expect.stringMatching(/renderer rejected this graphic.*other graphics still render/) });
    expect(validateSequence(built.sequence)).toMatchObject({ ok: true });
    expect(built.sequence.segments).toHaveLength(good.sequence.segments.length - 1);
    for (const s of built.sequence.segments) expect(s).toEqual(good.sequence.segments.find((g) => g.id === s.id));
  });
});

describe('fractional sentence starts reach the timeline unchanged (Windows regression)', () => {
  it('specs keep the exact start; the first frame is the rational frame nearest it at 25, 24000/1001 and 30000/1001', async () => {
    const starts = [1.237, 2.48, 4.905, 16.166];
    const fractional: PipelineSegment[] = starts.map((start, i) => ({ id: `f${i}`, start, end: start + 1.9, transcript: ['We talked to 120 editors.', 'Revenue grew 40%.', 'First we listen, then we plan.', 'What would you automate first?'][i], instruction: '' }));
    const plan = approveAll(await planned(fractional));
    for (const fps of [25, 23.976, 29.97]) {
      const { num, den } = fpsRational(fps);
      const built = buildSequence(plan, toPlanningInputs(fractional), profile(), { projectId: 'p1', width: 1920, height: 1080, fps, duration: 30, target: 'composite' });
      for (const spec of built.sequence.segments) {
        const row = fractional.find((r) => r.id === built.specIds[spec.id])!;
        expect(spec.start).toBe(row.start);
        const first = secondsToFrames(spec.start, fps);
        expect(first).toBe(Math.round((row.start * num) / den));
        // Never more than half a frame from the speech, either way.
        expect(Math.abs((first * den) / num - row.start)).toBeLessThanOrEqual(den / num / 2 + 1e-9);
      }
    }
  });
});
