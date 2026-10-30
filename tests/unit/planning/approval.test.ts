import { describe, expect, it } from 'vitest';
import {
  applyEditorAction,
  buildStyleProfile,
  canApply,
  CreativePlanner,
  effectiveSegment,
  PlanningError,
  type PlanningProvider,
  type ProjectPlan,
  type SegmentPlan,
} from '../../../src/shared/planning';
import { LocalConceptProvider } from '../../../src/shared/planning/provider';
import { NOW, now, preset, profile, transcript } from './helpers';

const planner = new CreativePlanner();
const at = '2026-10-29T13:00:00.000Z';
const seg = (p: ProjectPlan, id: string) => p.segments.find((s) => s.segmentId === id)!;
const act = (p: ProjectPlan, id: string, action: Parameters<typeof applyEditorAction>[1]): ProjectPlan => ({
  ...p,
  segments: p.segments.map((s) => (s.segmentId === id ? applyEditorAction(s, action, at) : s)),
});

/** Counts which segments a provider was asked about. */
function spyProvider(): PlanningProvider & { asked: string[][] } {
  const local = new LocalConceptProvider();
  const spy = {
    name: 'spy',
    asked: [] as string[][],
    async suggest(req: Parameters<PlanningProvider['suggest']>[0]) {
      spy.asked.push(req.segments.map((s) => s.segmentId));
      return local.suggest(req);
    },
  };
  return spy;
}

async function base() {
  return (await planner.plan({ projectId: 'p', profile: profile(), segments: transcript('video-a') }, { now })).plan;
}

describe('approval state machine', () => {
  it('allows only valid transitions and records who did what', async () => {
    const p = await base();
    const s = seg(p, 'a2');
    expect(canApply(s, 'approve')).toBe(true);
    const approved = applyEditorAction(s, { type: 'approve' }, at);
    expect(approved.status).toBe('approved');
    expect(approved.history.at(-1)).toEqual({ from: 'suggested', to: 'approved', by: 'editor', reason: 'Approved', at });
    const rejected = applyEditorAction(s, { type: 'reject', reason: 'Too busy' }, at);
    expect(rejected.rejectedConcepts).toEqual([s.suggestion.conceptId]);
    expect(() => applyEditorAction(rejected, { type: 'approve' }, at)).toThrow(PlanningError);
    expect(() => applyEditorAction(rejected, { type: 'approve' }, at)).toThrow(/Can't approve a segment that is rejected/);
    expect(applyEditorAction(rejected, { type: 'request-regeneration' }, at).status).toBe('needs-regeneration');
  });

  it('editor overrides win over the suggestion and accumulate', async () => {
    const s = seg(await base(), 'a2');
    let e = applyEditorAction(s, { type: 'edit', overrides: { conceptId: 'kinetic-headline', params: { pace: 0.8 } } }, at);
    e = applyEditorAction(e, { type: 'edit', overrides: { params: { scale: 1.2 } } }, at);
    expect(e.status).toBe('edited');
    expect(effectiveSegment(e)).toMatchObject({ conceptId: 'kinetic-headline', params: expect.objectContaining({ pace: 0.8, scale: 1.2 }) });
    expect(e.suggestion).toEqual(s.suggestion);
  });
});

describe('replanning', () => {
  it('replans only changed segments and keeps everything else byte-identical', async () => {
    const first = await base();
    const spy = spyProvider();
    const segments = transcript('video-a').map((s) => (s.id === 'a3' ? { ...s, text: 'Revenue grew from $2 million to $12 million this year.' } : s));
    const r = await planner.plan({ projectId: 'p', profile: profile(), segments }, { now, previous: first, provider: spy });
    expect(r.planned).toEqual(['a3']);
    expect(spy.asked).toEqual([['a3']]);
    expect(r.kept).toHaveLength(9);
    for (const s of r.plan.segments) if (s.segmentId !== 'a3') expect(s).toEqual(seg(first, s.segmentId));
    expect(seg(r.plan, 'a3').suggestion.params.values?.map((v) => v.value)).toEqual([2e6, 12e6]);
  });

  it('makes no provider call when nothing changed', async () => {
    const first = await base();
    const spy = spyProvider();
    const r = await planner.plan({ projectId: 'p', profile: profile(), segments: transcript('video-a') }, { now, previous: first, provider: spy });
    expect(spy.asked).toEqual([]);
    expect(r.planned).toEqual([]);
    expect(r.plan.segments).toEqual(first.segments);
  });

  it('never replaces an approved choice when its transcript changes; flags it instead', async () => {
    let p = act(await base(), 'a2', { type: 'approve' });
    const approved = seg(p, 'a2');
    const segments = transcript('video-a').map((s) => (s.id === 'a2' ? { ...s, text: 'Today Northwind serves 2 million customers.' } : s));
    const r = await planner.plan({ projectId: 'p', profile: profile(), segments }, { now, previous: p });
    const after = seg(r.plan, 'a2');
    expect(r.flagged).toEqual(['a2']);
    expect(after.status).toBe('approved');
    expect(after.suggestion).toEqual(approved.suggestion);
    expect(after.text).toBe('Today Northwind serves 2 million customers.'); // the editor's new transcript is shown as-is
    expect(after.stale?.reason).toMatch(/changed after approval/);

    // The editor reviews it and keeps the approval: the flag clears and stays cleared.
    p = act(r.plan, 'a2', { type: 'acknowledge-change' });
    const again = await planner.plan({ projectId: 'p', profile: profile(), segments }, { now, previous: p });
    expect(again.flagged).toEqual([]);
    expect(seg(again.plan, 'a2').stale).toBeUndefined();
  });

  it('replans an approved segment only with explicit editor permission', async () => {
    const p = act(await base(), 'a2', { type: 'approve' });
    const segments = transcript('video-a').map((s) => (s.id === 'a2' ? { ...s, text: 'We now have 40% more customers.' } : s));
    const r = await planner.plan({ projectId: 'p', profile: profile(), segments }, { now, previous: p, allowReplan: ['a2'] });
    expect(r.planned).toEqual(['a2']);
    expect(seg(r.plan, 'a2').status).toBe('suggested');
    expect(seg(r.plan, 'a2').history.at(-1)?.reason).toBe('Replanned with editor permission');
  });

  it('keeps editor edits when the transcript changes under them and asks for review', async () => {
    const p = act(await base(), 'a5', { type: 'edit', overrides: { conceptId: 'list-stack' } });
    const segments = transcript('video-a').map((s) => (s.id === 'a5' ? { ...s, text: 'First we listen, then we ship.' } : s));
    const r = await planner.plan({ projectId: 'p', profile: profile(), segments }, { now, previous: p });
    expect(seg(r.plan, 'a5')).toMatchObject({ status: 'needs-regeneration', overrides: { conceptId: 'list-stack' } });
    expect(r.planned).not.toContain('a5');
  });

  it('a rejected suggestion is replaced by a different concept on the next run', async () => {
    const first = await base();
    const rejectedConcept = seg(first, 'a6').suggestion.conceptId;
    const p = act(first, 'a6', { type: 'reject' });
    const r = await planner.plan({ projectId: 'p', profile: profile(), segments: transcript('video-a') }, { now, previous: p });
    expect(r.planned).toEqual(['a6']);
    expect(seg(r.plan, 'a6').suggestion.conceptId).not.toBe(rejectedConcept);
    expect(seg(r.plan, 'a6').rejectedConcepts).toEqual([rejectedConcept]);
  });

  it('a profile change refreshes untouched suggestions but never editor decisions', async () => {
    let p = act(await base(), 'a2', { type: 'approve' });
    p = act(p, 'a4', { type: 'edit', overrides: { conceptId: 'kinetic-headline' } });
    const changed = buildStyleProfile({ preset: { ...preset('northwind'), creativeBrief: 'No charts. Calm.' } }, NOW);
    const r = await planner.plan({ projectId: 'p', profile: changed, segments: transcript('video-a') }, { now, previous: p });
    expect(r.kept.sort()).toEqual(['a2', 'a4']);
    expect(seg(r.plan, 'a2').status).toBe('approved');
    expect(r.planned).toHaveLength(8);
    expect(r.plan.profileFingerprint).toBe(changed.fingerprint);
  });

  it('drops removed segments with a note and plans new ones', async () => {
    const first = await base();
    const segments = [...transcript('video-a').filter((s) => s.id !== 'a9'), { id: 'a11', start: 40, end: 43, text: 'Thanks for watching.' }];
    const r = await planner.plan({ projectId: 'p', profile: profile(), segments }, { now, previous: first });
    expect(r.planned).toEqual(['a11']);
    expect(r.plan.segments.map((s) => s.segmentId)).not.toContain('a9');
    expect(r.plan.findings).toContainEqual(expect.objectContaining({ kind: 'pacing', segmentIds: ['a9'] }));
  });

  it('preserves approvals across many unchanged replans', async () => {
    let p = await base();
    for (const id of ['a1', 'a2', 'a3']) p = act(p, id, { type: 'approve' });
    for (let i = 0; i < 3; i++) p = (await planner.plan({ projectId: 'p', profile: profile(), segments: transcript('video-a') }, { now, previous: p })).plan;
    expect(p.segments.filter((s: SegmentPlan) => s.status === 'approved').map((s) => s.segmentId)).toEqual(['a1', 'a2', 'a3']);
  });
});
