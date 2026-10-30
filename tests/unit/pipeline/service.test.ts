import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateSequence } from '../../../src/shared/animation';
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
