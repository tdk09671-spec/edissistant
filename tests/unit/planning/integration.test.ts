import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlanningService } from '../../../src/main/planning';
import {
  applyEditorAction,
  buildStyleProfile,
  CreativePlanner,
  fromProjectSegments,
  fromTranscriptSentences,
  planToAnimationSpecs,
  toProjectSegmentUpdates,
  toSequenceSpec,
  type ModelCall,
  type ModelTransport,
  type TranscriptSentenceCompat,
} from '../../../src/shared/planning';
import { NOW, now, preset, transcript } from './helpers';

const KEY = 'sk-ant-api03-SERVICEKEY-not-real-0123456789';

describe('integration converters', () => {
  it('maps PR #1 transcript sentences (with word timing) onto the timeline', () => {
    const sentences: TranscriptSentenceCompat[] = [
      { id: 's1', start: 1, end: 2.5, text: 'Hello there.', words: [{ text: 'Hello', start: 1, end: 1.4 }, { text: 'there.', start: 1.5, end: 2.5 }] },
      { id: 's2', start: 3, end: 3.2, text: '   ', words: [] },
    ];
    expect(fromTranscriptSentences(sentences, 10)).toEqual([{ id: 's1', start: 11, end: 12.5, text: 'Hello there.', words: [{ text: 'Hello', start: 11, end: 11.4 }, { text: 'there.', start: 11.5, end: 12.5 }] }]);
  });

  it('maps existing project segments; their default visual mode is only a lock once approved', () => {
    const base = { aiSuggestion: '', instruction: '' };
    const inputs = fromProjectSegments([
      { ...base, id: 'x', start: 0, end: 2, transcript: 'One.', visualMode: 'speaker', status: 'pending', instruction: 'faster' },
      { ...base, id: 'y', start: 2, end: 4, transcript: 'Two.', visualMode: 'captions', status: 'approved' },
      { ...base, id: 'z', start: 4, end: 4, transcript: 'bad timing', visualMode: 'speaker', status: 'pending' },
    ]);
    expect(inputs).toEqual([
      { id: 'x', start: 0, end: 2, text: 'One.', instruction: 'faster' },
      { id: 'y', start: 2, end: 4, text: 'Two.', visualMode: 'captions' },
    ]);
  });

  it('writes plan results back into existing segment fields without touching transcript or timing', async () => {
    const profile = buildStyleProfile({ preset: preset('northwind') }, NOW);
    const { plan } = await new CreativePlanner().plan({ projectId: 'p', profile, segments: transcript('video-a') }, { now });
    const approved = { ...plan, segments: plan.segments.map((s) => (s.segmentId === 'a2' ? applyEditorAction(s, { type: 'approve' }, NOW) : s)) };
    const updates = toProjectSegmentUpdates(approved);
    expect(updates.find((u) => u.id === 'a2')).toMatchObject({ status: 'approved', visualMode: 'motion-graphics', aiSuggestion: expect.stringMatching(/^Hero number count-up: /) });
    expect(updates.find((u) => u.id === 'a1')).not.toHaveProperty('visualMode');
    for (const u of updates) expect(Object.keys(u).sort()).toEqual(expect.arrayContaining(['aiSuggestion', 'id', 'status']));
    expect(updates.every((u) => !('transcript' in u) && !('start' in u) && !('instruction' in u))).toBe(true);
  });
});

describe('documented example: transcript → style profile → plan → approvals → renderable spec', () => {
  it('runs the whole pipeline locally and deterministically', async () => {
    // 1. Style profile from the client preset (cached and reused for every video of this client).
    const profile = buildStyleProfile({ preset: preset('northwind') }, NOW);
    // 2. Transcript segments (from PR #1 in the app; a fixture here).
    const segments = transcript('video-a').slice(1, 6);
    // 3. Plan: suggestions only, nothing is rendered yet.
    const planner = new CreativePlanner();
    const { plan } = await planner.plan({ projectId: 'example', profile, segments }, { now });
    // 4. The editor approves three, edits one with a plain instruction, rejects one.
    let edited = plan;
    const act = (id: string, a: Parameters<typeof applyEditorAction>[1]) => {
      edited = { ...edited, segments: edited.segments.map((s) => (s.segmentId === id ? applyEditorAction(s, a, NOW) : s)) };
    };
    act('a2', { type: 'approve' });
    act('a3', { type: 'approve' });
    act('a5', { type: 'edit', overrides: { conceptId: 'list-stack', params: { pace: 1.3 } } });
    act('a5', { type: 'approve' });
    act('a4', { type: 'reject', reason: 'Keep this on the speaker' });
    // 5. Replan: only the rejected segment gets a new idea; approvals are untouched.
    const replanned = await planner.plan({ projectId: 'example', profile, segments }, { now, previous: edited });
    expect(replanned.planned).toEqual(['a4']);
    // 6. Approved segments → PR #2 animation specs (the renderer validates and renders them).
    const results = planToAnimationSpecs(replanned.plan, segments, profile, { width: 1920, height: 1080, fps: 25 });
    expect(results.map((r) => [r.segmentId, r.status])).toEqual([
      ['a2', 'renderable'],
      ['a3', 'renderable'],
      ['a4', 'not-approved'],
      ['a5', 'renderable'],
      ['a6', 'not-approved'],
    ]);
    const sequence = toSequenceSpec('example', results, { width: 1920, height: 1080, fps: 25 });
    expect(sequence.segments.map((s) => s.id)).toEqual(['a2', 'a3', 'a5']);
    expect(sequence.segments[2].layers.map((l) => l.props.text)).toEqual(['we listen', 'we prototype', 'we ship in two weeks']);

    if (process.env.UPDATE_PLANNING_EXAMPLE) {
      const out = path.resolve(__dirname, '../../../docs/examples/planning-example.json');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const pick = (s: (typeof replanned.plan.segments)[number]) => ({ segmentId: s.segmentId, start: s.start, end: s.end, text: s.text, status: s.status, suggestion: s.suggestion, overrides: s.overrides, rejectedConcepts: s.rejectedConcepts });
      fs.writeFileSync(out, `${JSON.stringify({ profile: { id: profile.id, fingerprint: profile.fingerprint, typography: profile.typography, palette: profile.palette, background: profile.background, motion: profile.motion, avoid: profile.avoid, confidence: profile.confidence, uncertainties: profile.uncertainties }, transcript: segments, plan: replanned.plan.segments.map(pick), findings: replanned.plan.findings, adapter: results.map((r) => ({ segmentId: r.segmentId, status: r.status, ...(r.status !== 'renderable' ? { reason: r.reason } : { warnings: r.warnings }) })), sequence }, null, 2)}\n`);
    }
  });
});

describe('PlanningService (main process)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-service-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const transport = (): ModelTransport & { calls: ModelCall[] } => {
    const t = {
      calls: [] as ModelCall[],
      async complete(call: ModelCall) {
        t.calls.push(call);
        const ids = [...call.user.matchAll(/<transcript_segment id="([^"]+)"/g)].map((m) => m[1]);
        return {
          text: JSON.stringify({ segments: ids.map((id) => ({ segmentId: id, meaning: 'm', candidates: [{ conceptId: 'kinetic-headline', fit: 0.85, reasoning: 'r' }] })) }),
          stopReason: 'end_turn',
          model: call.model,
          usage: { inputTokens: 1000, outputTokens: 400, cacheCreationInputTokens: 0, cacheReadInputTokens: 2000 },
        };
      },
    };
    return t;
  };

  it('plans locally for free, persists plans and approvals, and records usage when the model is used', async () => {
    const t = transport();
    const svc = new PlanningService({ userDataPath: dir, getApiKey: async () => KEY, transport: t, now, budget: { softLimit: 1 } });
    const profile = buildStyleProfile({ preset: preset('northwind') }, NOW);
    const request = { projectId: 'proj-1', profile, segments: transcript('video-a') };

    const local = await svc.plan(request);
    expect(t.calls).toHaveLength(0);
    expect(local.cost).toMatchObject({ calls: 0, estimatedCost: 0 });

    const approved = svc.act('proj-1', 'a2', { type: 'approve' });
    expect(approved.segments.find((s) => s.segmentId === 'a2')!.status).toBe('approved');
    expect(svc.store.loadPlan('proj-1')!.segments.find((s) => s.segmentId === 'a2')!.status).toBe('approved');

    // Nothing changed → a model run plans nothing and costs nothing.
    const unchanged = await svc.plan(request, { useModel: true });
    expect(unchanged.planned).toEqual([]);
    expect(t.calls).toHaveLength(0);

    // A changed sentence → one small model call for just that segment.
    const changed = { ...request, segments: request.segments.map((s) => (s.id === 'a9' ? { ...s, text: 'The key is that every single decision starts with the editor.' } : s)) };
    const modelRun = await svc.plan(changed, { useModel: true });
    expect(modelRun.planned).toEqual(['a9']);
    expect(t.calls).toHaveLength(1);
    expect((t.calls[0].user.match(/<transcript_segment/g) ?? []).length).toBe(1);
    expect(modelRun.cost.calls).toBe(1);
    expect(svc.costReport('proj-1').calls).toBe(1); // persisted and reloaded
    expect(svc.store.loadPlan('proj-1')!.segments.find((s) => s.segmentId === 'a2')!.status).toBe('approved');

    // Nothing written to disk contains the key or the prompt text.
    const files: string[] = [];
    const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))));
    walk(dir);
    for (const f of files) {
      const content = fs.readFileSync(f, 'utf8');
      expect(content).not.toContain('SERVICEKEY');
      expect(content).not.toContain('untrusted data');
    }
  });

  it('records approved concepts per client for cross-video variety', async () => {
    const svc = new PlanningService({ userDataPath: dir, getApiKey: async () => null, now });
    const profile = buildStyleProfile({ preset: preset('northwind') }, NOW);
    await svc.plan({ projectId: 'v1', profile, segments: transcript('video-a') });
    const plan = svc.act('v1', 'a2', { type: 'approve' });
    const history = svc.store.recordProjectUsage(profile.id, plan, NOW);
    expect(history.projects[0]).toMatchObject({ projectId: 'v1', concepts: ['counter-hero'] });
    expect(svc.store.clientHistory(profile.id).projects).toHaveLength(1);
  });

  it('falls back to local planning without a key (no request is sent)', async () => {
    const svc = new PlanningService({ userDataPath: dir, getApiKey: async () => null, now });
    const profile = buildStyleProfile({ preset: preset('northwind') }, NOW);
    const r = await svc.plan({ projectId: 'p', profile, segments: transcript('video-b') }, { useModel: true });
    expect(r.warnings.join(' ')).toMatch(/No Claude API key is set/);
    expect(r.plan.segments.every((s) => s.suggestion.source === 'local')).toBe(true);
    expect(r.cost.calls).toBe(0);
  });
});
