import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { frameToSeconds, secondsToFrames, segmentFrames, validateSequence } from '../../../src/shared/animation';
import { snapVisualTiming, visualTimingIssue } from '../../../src/shared/pipeline/convert';
import { PipelineService } from '../../../src/main/pipeline/service';
import type { BuildRequest, PlanOutcome, ProjectPlanningInput } from '../../../src/shared/pipeline/types';
import { now, preset, transcript } from '../planning/helpers';

// The main-process pipeline service with the real planner and store (no Electron, no model).

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-service-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const service = () => new PipelineService({ userDataPath: dir, getApiKey: async () => null, now });

function input(edit: (s: ProjectPlanningInput['segments'][number]) => ProjectPlanningInput['segments'][number] = (s) => s): ProjectPlanningInput {
  return {
    projectId: 'proj-1',
    preset: preset('northwind'),
    segments: transcript('video-a').map((s) => edit({ id: s.id, start: s.start, end: s.end, transcript: s.text, instruction: '' })),
  };
}

const build = (req: ProjectPlanningInput): BuildRequest => ({ ...req, target: 'composite', width: 1920, height: 1080, fps: 29.97, duration: 45 });
const byId = (o: PlanOutcome, id: string) => o.updates.find((u) => u.id === id)!;

describe('PipelineService', () => {
  it('plans locally and deterministically; never touches transcript, timing or instructions', async () => {
    const a = await service().plan(input());
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-service-'));
    const b = await new PipelineService({ userDataPath: other, getApiKey: async () => null, now }).plan(input());
    fs.rmSync(other, { recursive: true, force: true });
    expect(a.updates).toEqual(b.updates);
    expect(a.cost).toEqual({ calls: 0, estimatedCost: 0, warnings: expect.any(Array) });
    expect(a.planned).toHaveLength(10);
    for (const u of a.updates) expect(u).not.toHaveProperty('transcript');
  });

  it('approvals survive a restart (a new service on the same data folder)', async () => {
    await service().plan(input());
    const approved = await service().act({ ...input(), segmentId: 'a2', action: { type: 'approve' } });
    expect(byId(approved, 'a2')).toMatchObject({ status: 'approved', plan: { planStatus: 'approved' } });
    const reopened = await service().plan(input());
    expect(reopened.planned).toEqual([]);
    expect(byId(reopened, 'a2').status).toBe('approved');
  });

  it('never approves a suggestion the editor hasn’t seen', async () => {
    await service().plan(input());
    // The editor typed an instruction, then clicked approve: the plan follows the instruction, and the
    // new suggestion is shown first instead of being approved unseen.
    const withInstruction = input((s) => (s.id === 'a3' ? { ...s, instruction: 'make it a big number counter' } : s));
    const first = await service().act({ ...withInstruction, segmentId: 'a3', action: { type: 'approve' } });
    expect(first.deferred).toMatch(/Review it, then approve/);
    expect(byId(first, 'a3').plan).toMatchObject({ conceptId: 'counter-hero', planStatus: 'suggested' });
    const second = await service().act({ ...withInstruction, segmentId: 'a3', action: { type: 'approve' } });
    expect(second.deferred).toBeUndefined();
    expect(byId(second, 'a3').plan).toMatchObject({ conceptId: 'counter-hero', planStatus: 'approved' });

    // Same after a rejection: the replacement idea has to be seen before it can be approved.
    const rejected = await service().act({ ...input(), segmentId: 'a4', action: { type: 'reject' } });
    const old = byId(rejected, 'a4').plan.conceptId;
    const retry = await service().act({ ...input(), segmentId: 'a4', action: { type: 'approve' } });
    expect(retry.deferred).toBeDefined();
    expect(byId(retry, 'a4').plan.conceptId).not.toBe(old);
    expect(byId(retry, 'a4').status).toBe('pending');
    await expect(service().act({ ...input(), segmentId: 'nope', action: { type: 'approve' } })).rejects.toMatchObject({ code: 'INVALID_ACTION' });
  });

  it('builds a valid PR #2 sequence from approved rows only', async () => {
    const svc = service();
    await svc.plan(input());
    for (const id of ['a2', 'a3', 'a5']) await svc.act({ ...input(), segmentId: id, action: { type: 'approve' } });
    const built = await svc.build(build(input()));
    expect(validateSequence(built.sequence)).toMatchObject({ ok: true });
    expect(new Set(Object.values(built.specIds))).toEqual(new Set(built.results.filter((r) => r.status === 'renderable').map((r) => r.segmentId)));
    expect(built.results.filter((r) => r.status === 'renderable').every((r) => ['a2', 'a3', 'a5'].includes(r.segmentId))).toBe(true);
    expect(built.results.find((r) => r.segmentId === 'a1')).toMatchObject({ status: 'not-approved' });
  });

  it('selective regeneration: revising one approved row changes only that row’s spec', async () => {
    const svc = service();
    await svc.plan(input());
    for (const id of ['a2', 'a3', 'a5', 'a6']) await svc.act({ ...input(), segmentId: id, action: { type: 'approve' } });
    const before = await svc.build(build(input()));

    // Review: the editor changes a6's instruction. The approval is kept but flagged; nothing renders from it.
    const revised = input((s) => (s.id === 'a6' ? { ...s, instruction: 'show it as a list' } : s));
    const flagged = await svc.build(build(revised));
    expect(flagged.results.find((r) => r.segmentId === 'a6')).toMatchObject({ status: 'not-approved' });
    expect(flagged.updates.find((u) => u.id === 'a6')).toMatchObject({ status: 'needs-revision', plan: { stale: expect.any(String) } });

    // With explicit permission it is replanned, then approved again.
    const replanned = await svc.plan({ ...revised, allowReplan: ['a6'] });
    expect(replanned.planned).toEqual(['a6']);
    await svc.act({ ...revised, segmentId: 'a6', action: { type: 'approve' } });
    const after = await svc.build(build(revised));
    const spec = (b: typeof before, id: string) => b.sequence.segments.find((s) => b.specIds[s.id] === id);
    for (const id of ['a2', 'a3', 'a5']) expect(spec(after, id)).toEqual(spec(before, id)); // → PR #2 cache hits
    expect(spec(after, 'a6')).not.toEqual(spec(before, 'a6'));
  });

  it('project notes shape a project-specific profile without changing the client one', async () => {
    const svc = service();
    const plain = await svc.plan(input());
    const noted = await svc.plan({ ...input(), projectId: 'proj-2', notes: 'No charts in this one.' });
    expect(noted.profile.id).not.toBe(plain.profile.id);
    expect(svc.profile(input()).id).toBe(plain.profile.id);
    expect(svc.planning.store.loadProfile(plain.profile.id)?.revision).toBe(1);
  });
});

// Windows validation round 2 (a6fe66f), bug D: Review → segment 6 → instruction "Show it as bars." →
// Approved → Update preview rendered 0 graphics and kept the old one.
describe('Windows regression: an edited instruction on an approved segment is applied, never dropped', () => {
  const approvedAll = async (svc: PipelineService, ids: string[]) => {
    await svc.plan(input());
    for (const id of ids) await svc.act({ ...input(), segmentId: id, action: { type: 'approve' } });
  };
  const bars = input((s) => (s.id === 'a3' ? { ...s, instruction: 'Show it as bars.' } : s));
  const spec = (b: Awaited<ReturnType<PipelineService['build']>>, id: string) => b.sequence.segments.find((s) => b.specIds[s.id] === id);

  it('approve applies the instruction in one step, whether or not a build synced first', async () => {
    for (const syncFirst of [false, true]) {
      const svc = service();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      await approvedAll(svc, ['a2', 'a3', 'a5', 'a6']);
      const before = await svc.build(build(input()));
      expect(byId(await svc.plan(input()), 'a3').plan.plannedInstruction).toBe('');
      if (syncFirst) {
        // The old flow: Update preview before approving leaves it out and says why.
        const flagged = await svc.build(build(bars));
        expect(flagged.results.find((r) => r.segmentId === 'a3')).toMatchObject({ status: 'not-approved', reason: expect.stringMatching(/instruction changed/) });
        expect(flagged.updates.find((u) => u.id === 'a3')!.plan.plannedInstruction).toBe('');
      }
      const applied = await svc.act({ ...bars, segmentId: 'a3', action: { type: 'approve' } });
      expect(applied.instruction).toMatchObject({ status: 'applied', message: expect.stringMatching(/Show it as bars/) });
      expect(byId(applied, 'a3')).toMatchObject({ status: 'approved', plan: { conceptId: 'bar-comparison', planStatus: 'approved', plannedInstruction: 'Show it as bars.' } });
      expect(byId(applied, 'a3').plan.stale).toBeUndefined();

      const after = await svc.build(build(bars));
      expect(after.results.find((r) => r.segmentId === 'a3')).toMatchObject({ status: 'renderable', conceptId: 'bar-comparison' });
      // Only a3 changed: the others hit PR #2's render cache.
      for (const id of ['a2', 'a5', 'a6']) expect(spec(after, id)).toEqual(spec(before, id));
      expect(spec(after, 'a3')).not.toEqual(spec(before, 'a3'));
    }
  });

  it('an instruction the planner doesn’t understand is not applied, and the old graphic is not rendered as if it were', async () => {
    const svc = service();
    await approvedAll(svc, ['a2', 'a6']);
    const vague = input((s) => (s.id === 'a6' ? { ...s, instruction: 'make it feel more premium' } : s));
    const outcome = await svc.act({ ...vague, segmentId: 'a6', action: { type: 'approve' } });
    expect(outcome.instruction).toMatchObject({ status: 'not-applied', message: expect.stringMatching(/wasn’t applied.*keeps its approved graphic/) });
    expect(byId(outcome, 'a6')).toMatchObject({ status: 'needs-revision', plan: { planStatus: 'approved', plannedInstruction: '', stale: expect.stringMatching(/instruction changed/) } });
    const built = await svc.build(build(vague));
    expect(built.results.find((r) => r.segmentId === 'a6')).toMatchObject({ status: 'not-approved' });
    expect(built.results.find((r) => r.segmentId === 'a2')).toMatchObject({ status: 'renderable' });

    // The editor can explicitly keep the approved graphic instead.
    const kept = await svc.act({ ...vague, segmentId: 'a6', action: { type: 'acknowledge-change' } });
    expect(byId(kept, 'a6')).toMatchObject({ status: 'approved', plan: { plannedInstruction: 'make it feel more premium' } });
  });

  it('a partly understood instruction is applied as far as it goes and left for review, never approved silently', async () => {
    const svc = service();
    await approvedAll(svc, ['a6']);
    const partial = input((s) => (s.id === 'a6' ? { ...s, instruction: 'make it a list, in neon green' } : s));
    const outcome = await svc.act({ ...partial, segmentId: 'a6', action: { type: 'approve' } });
    expect(outcome.instruction).toMatchObject({ status: 'partial', message: expect.stringMatching(/neon green.*isn’t approved yet/) });
    expect(byId(outcome, 'a6')).toMatchObject({ status: 'pending', plan: { conceptId: 'list-stack', planStatus: 'suggested' } });
  });

  it('removing the instruction keeps the approved graphic', async () => {
    const svc = service();
    const listed = input((s) => (s.id === 'a6' ? { ...s, instruction: 'make it a list' } : s));
    await svc.plan(listed);
    await svc.act({ ...listed, segmentId: 'a6', action: { type: 'approve' } });
    const concept = byId(await svc.plan(listed), 'a6').plan.conceptId;
    const cleared = await svc.act({ ...input(), segmentId: 'a6', action: { type: 'approve' } });
    expect(cleared.instruction).toMatchObject({ status: 'kept' });
    expect(byId(cleared, 'a6')).toMatchObject({ status: 'approved', plan: { conceptId: concept, plannedInstruction: '' } });
  });

  it('approving an approved, unchanged segment is a no-op, not an error', async () => {
    const svc = service();
    await approvedAll(svc, ['a2']);
    const again = await svc.act({ ...input(), segmentId: 'a2', action: { type: 'approve' } });
    expect(byId(again, 'a2').status).toBe('approved');
  });
});

describe('Windows regression: an incompatible concept no longer breaks the whole render', () => {
  it('the UI sequence that failed on Windows now renders, and other approved segments are unchanged', async () => {
    const svc = service();
    await svc.plan(input());
    await svc.act({ ...input(), segmentId: 'a3', action: { type: 'approve' } });
    const before = await svc.build(build(input()));
    // Captions mode for a2, then "Kinetic headline" from the concept picker (as the inspector sends it), then approve.
    await svc.act({ ...input(), segmentId: 'a2', action: { type: 'edit', overrides: { visualMode: 'captions' } } });
    const picked = await svc.act({ ...input(), segmentId: 'a2', action: { type: 'edit', overrides: { conceptId: 'kinetic-headline' } } });
    expect(byId(picked, 'a2').plan).toMatchObject({ conceptId: 'kinetic-headline', mode: 'motion-graphics' });
    await svc.act({ ...input(), segmentId: 'a2', action: { type: 'approve' } });
    const after = await svc.build(build(input()));
    expect(validateSequence(after.sequence)).toMatchObject({ ok: true });
    expect(after.results.find((r) => r.segmentId === 'a2')).toMatchObject({ status: 'renderable', conceptId: 'kinetic-headline' });
    // a3's spec is byte-identical, so PR #2 serves it from the render cache.
    const spec = (b: typeof before, id: string) => b.sequence.segments.find((s) => b.specIds[s.id] === id);
    expect(spec(after, 'a3')).toEqual(spec(before, 'a3'));
    expect(byId(picked, 'a3').plan.planStatus).toBe('approved');
  });

  it('an impossible pair asked for explicitly is refused with the reason', async () => {
    await service().plan(input());
    await expect(service().act({ ...input(), segmentId: 'a2', action: { type: 'edit', overrides: { conceptId: 'kinetic-headline', visualMode: 'captions' } } })).rejects.toMatchObject({
      code: 'INVALID_ACTION',
      message: expect.stringMatching(/can't be shown in Captions mode/),
    });
  });
});

// Round 3 (Task B): the editor sets a graphic's on-screen in/out separately from the speech timing.
describe('editor-controlled graphic timing', () => {
  const RATES = [25, 23.976, 29.97];

  it('snaps to exact frames at 25, 24000/1001 and 30000/1001 and checks the video length', () => {
    for (const fps of RATES) {
      const t = snapVisualTiming({ start: 6.2, end: 11.97 }, fps);
      // Each boundary is the leading edge of the nearest frame (exact rational frame times).
      expect(t.start).toBe(frameToSeconds(secondsToFrames(t.start, fps), fps));
      expect(t.end).toBe(frameToSeconds(secondsToFrames(t.end, fps), fps));
      expect(Math.abs(t.start - 6.2)).toBeLessThanOrEqual(0.5 / fps + 1e-9);
      expect(Math.abs(t.end - 11.97)).toBeLessThanOrEqual(0.5 / fps + 1e-9);
      expect(snapVisualTiming(t, fps)).toEqual(t); // idempotent: already on the grid
    }
    expect(snapVisualTiming({ start: 1.001, end: 2 }, 29.97).start).toBeCloseTo(30 * 1001 / 30000, 12);
    expect(visualTimingIssue({ start: 1, end: 2 }, 25, 10)).toBeNull();
    expect(visualTimingIssue({ start: -0.5, end: 2 }, 25, 10)).toMatch(/before the beginning/);
    expect(visualTimingIssue({ start: 1, end: 10.5 }, 25, 10)).toMatch(/after the end/);
    expect(visualTimingIssue({ start: 2, end: 2.01 }, 25, 10)).toMatch(/at least one frame/);
    expect(visualTimingIssue({ start: 3, end: 2 }, 25, 10)).toMatch(/at least one frame/);
  });

  it.each(RATES)('at %s fps the built graphic uses the adjusted in/out, frame-exact; nothing else changes and nothing is replanned', async (fps) => {
    const svc = service();
    await svc.plan(input());
    for (const id of ['a2', 'a3', 'a5']) await svc.act({ ...input(), segmentId: id, action: { type: 'approve' } });
    const req = (segments: ProjectPlanningInput['segments']): BuildRequest => ({ ...input(), segments, target: 'composite', width: 1920, height: 1080, fps, duration: 45 });
    const before = await svc.build(req(input().segments));
    const a3 = input().segments.find((s) => s.id === 'a3')!;
    const visualTiming = { start: a3.start + 0.3137, end: a3.end - 0.5021 };
    const adjusted = input().segments.map((s) => (s.id === 'a3' ? { ...s, visualTiming } : s));
    const after = await svc.build(req(adjusted));
    const spec = (b: typeof before, id: string) => b.sequence.segments.find((x) => b.specIds[x.id] === id)!;

    const snapped = snapVisualTiming(visualTiming, fps);
    const span = segmentFrames(spec(after, 'a3').start, spec(after, 'a3').duration, fps);
    expect(span.first).toBe(secondsToFrames(snapped.start, fps));
    expect(span.end).toBe(secondsToFrames(snapped.end, fps));
    for (const id of ['a2', 'a5']) expect(spec(after, id)).toEqual(spec(before, id)); // → reused from the render cache
    expect(spec(after, 'a3')).not.toEqual(spec(before, 'a3'));
    // The speech timing, transcript and plan are untouched: no replanning, no stale flag.
    expect(after.updates.find((u) => u.id === 'a3')).toMatchObject({ status: 'approved' });
    expect(after.updates.find((u) => u.id === 'a3')!.plan.stale).toBeUndefined();
    expect((await svc.plan(input())).planned).toEqual([]);
  });

  it('a graphic timing that no longer fits the video is reported for that row and left out; the rest render', async () => {
    const svc = service();
    await svc.plan(input());
    for (const id of ['a2', 'a3']) await svc.act({ ...input(), segmentId: id, action: { type: 'approve' } });
    const segments = input().segments.map((s) => (s.id === 'a3' ? { ...s, visualTiming: { start: 44, end: 48 } } : s));
    const built = await svc.build({ ...input(), segments, target: 'composite', width: 1920, height: 1080, fps: 25, duration: 45 });
    expect(built.results.find((r) => r.segmentId === 'a3')).toMatchObject({ status: 'not-approved', reason: expect.stringMatching(/Graphic timing: .*after the end/) });
    expect(built.results.find((r) => r.segmentId === 'a2')).toMatchObject({ status: 'renderable' });
  });

  it('the captions deliverable follows the adjusted timing too', async () => {
    const svc = service();
    await svc.plan(input());
    const a1 = input().segments[0];
    const segments = input().segments.map((s, i) => (i === 0 ? { ...s, visualTiming: { start: a1.start, end: a1.start + 1 } } : s));
    const built = await svc.build({ ...input(), segments, target: 'captions', width: 1920, height: 1080, fps: 25, duration: 45 });
    const cap = built.sequence.segments.find((x) => built.specIds[x.id] === a1.id)!;
    expect(cap.duration).toBeCloseTo(1, 6);
  });
});
