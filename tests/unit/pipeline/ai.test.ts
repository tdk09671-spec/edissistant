import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiService } from '../../../src/main/pipeline/ai';
import { registerPipelineIpc } from '../../../src/main/pipeline/ipc';
import { PipelineService } from '../../../src/main/pipeline/service';
import { PLANNING_CONFIG_SCHEMA, PlanningError } from '../../../src/shared/planning';
import type { PipelineResult, PlanOutcome, PlanEstimate, AiStatus, AiConnection, AiConfig, AiUsage } from '../../../src/shared/pipeline/types';
import { fakeTransport } from '../planning/fakeClaude';
import { now, preset, transcript } from '../planning/helpers';

// Claude settings, checks and IPC in the main process. No real API call: the transport and the
// connection test are stand-ins. The key used here is fake and must never come back out.

const KEY = 'sk-ant-api03-TESTKEY-never-real-0123456789abcdefABCDEF';

let dir: string;
let key: string | null;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-service-'));
  key = KEY;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function setup(opts: { transport?: ReturnType<typeof fakeTransport>; test?: ConstructorParameters<typeof AiService>[0]['testConnection'] } = {}) {
  const transport = opts.transport ?? fakeTransport();
  const service = new PipelineService({ userDataPath: dir, getApiKey: async () => key, transport, now });
  const testCalls: { apiKey: string; model: string }[] = [];
  const ai = new AiService({
    planning: service.planning,
    getApiKey: async () => key,
    encryptionAvailable: async () => true,
    now,
    testConnection:
      opts.test ??
      (async (o) => {
        testCalls.push({ apiKey: o.apiKey, model: o.model });
        return o.apiKey === KEY ? { ok: true, model: o.model, displayName: 'Claude Opus 5.5' } : { ok: false, code: 'AUTHENTICATION', message: 'Anthropic rejected the API key.' };
      }),
  });
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) };
  registerPipelineIpc(ipc as never, service, () => undefined, ai);
  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => (await handlers.get(channel)!({}, ...args)) as T;
  return { service, ai, transport, invoke, testCalls };
}

const request = (extra: object = {}) => ({
  projectId: 'proj-1',
  preset: preset('northwind'),
  segments: transcript('video-a').map((s) => ({ id: s.id, start: s.start, end: s.end, transcript: s.text, instruction: '' })),
  ...extra,
});

const writeConfig = (cfg: object) => {
  fs.mkdirSync(path.join(dir, 'planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'planning', 'config.json'), JSON.stringify({ schema: PLANNING_CONFIG_SCHEMA, version: 1, ...cfg }));
};

/** Every file the app wrote, as text: the key must not be in any of them. */
const allFiles = (root: string): string =>
  fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), 'utf8'))
    .join('\n');

describe('AI provider settings', () => {
  it('starts on local only; choosing Anthropic is explicit and remembered', async () => {
    const { invoke } = setup();
    const s0 = await invoke<PipelineResult<AiStatus>>('ai:status');
    expect(s0).toEqual({ ok: true, result: { provider: 'local', keyStored: true, encryptionAvailable: true, model: 'claude-opus-5-5', lastTest: null } });
    await invoke('ai:setProvider', 'anthropic');
    expect((await invoke<PipelineResult<AiStatus>>('ai:status')).ok && (await setup().ai.status()).provider).toBe('anthropic');
    const bad = await invoke<PipelineResult<AiStatus>>('ai:setProvider', 'openai');
    expect(bad).toEqual({ ok: false, error: { code: 'INVALID_REQUEST', message: expect.stringContaining('provider') } });
  });

  it('connection test uses the stored key, returns only the outcome, and is cleared when the key or model changes', async () => {
    const { ai, invoke, testCalls } = setup();
    const r = await invoke<PipelineResult<AiConnection>>('ai:test');
    expect(r).toEqual({ ok: true, result: { ok: true, at: now(), model: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' } });
    expect(testCalls).toEqual([{ apiKey: KEY, model: 'claude-opus-5-5' }]);
    expect((await ai.status()).lastTest?.ok).toBe(true);

    ai.keyChanged(); // the key was replaced
    expect((await ai.status()).lastTest).toBeNull();

    await ai.test();
    ai.setConfig({ model: 'claude-sonnet-5-5' }); // a test of another model says nothing about this one
    expect((await ai.status()).lastTest).toBeNull();
    expect((await ai.status()).model).toBe('claude-sonnet-5-5');

    key = 'sk-ant-wrong-key-0000000000000000';
    const bad = await ai.test();
    expect(bad).toMatchObject({ ok: false, code: 'AUTHENTICATION' });
    key = null;
    expect(await ai.test()).toMatchObject({ ok: false, code: 'NO_API_KEY' });
    expect(testCalls).toHaveLength(3); // no request without a key
    expect(allFiles(dir)).not.toContain('sk-ant-');
  });

  it('model and limits are written to planning/config.json, keeping every other setting; bad values are refused', async () => {
    writeConfig({ effort: { 'creative-planning': 'high' }, budget: { warnAt: [0.5, 1] } });
    const { invoke } = setup();
    const set = await invoke<PipelineResult<AiConfig>>('ai:config:set', { model: ' claude-sonnet-5-5 ', softLimit: 1.234, hardLimit: 5, monthlyLimit: 20 });
    expect(set).toEqual({
      ok: true,
      result: { model: 'claude-sonnet-5-5', defaultModel: 'claude-opus-5-5', knownModels: expect.arrayContaining(['claude-opus-5-5']), softLimit: 1.23, hardLimit: 5, monthlyLimit: 20, pricingVersion: expect.any(String) },
    });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'planning', 'config.json'), 'utf8'));
    expect(saved).toMatchObject({ effort: { 'creative-planning': 'high' }, budget: { warnAt: [0.5, 1], softLimit: 1.23, hardLimit: 5 }, monthlyLimit: 20 });

    const cleared = await invoke<PipelineResult<AiConfig>>('ai:config:set', { model: null, monthlyLimit: null });
    expect(cleared.ok && cleared.result).toMatchObject({ model: 'claude-opus-5-5', hardLimit: 5 });
    expect(cleared.ok && cleared.result.monthlyLimit).toBeUndefined();

    for (const [update, msg] of [
      [{ softLimit: 9, hardLimit: 2 }, 'warning amount'],
      [{ hardLimit: -1 }, 'project limit'],
      [{ model: 'bad model id!' }, 'model id'],
      [{ apiKey: KEY }, 'not an AI setting'],
    ] as const) {
      const r = await invoke<PipelineResult<AiConfig>>('ai:config:set', update);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.message).toContain(msg);
      expect(!r.ok && r.error.message).not.toContain(KEY);
    }
    expect(allFiles(dir)).not.toContain('sk-ant-');
  });

  it('an invalid config.json is reported, not overwritten', async () => {
    writeConfig({ maxOutputTokens: -5 });
    const { ai, invoke } = setup();
    expect((await ai.status()).configIssue).toContain('invalid');
    const r = await invoke<PipelineResult<AiConfig>>('ai:config:set', { hardLimit: 3 });
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'planning', 'config.json'), 'utf8')).maxOutputTokens).toBe(-5);
  });
});

describe('Claude runs through IPC', () => {
  it('refuses a Claude run while the provider is local or no key is stored; nothing is sent', async () => {
    const { invoke, transport } = setup();
    const off = await invoke<PipelineResult<PlanOutcome>>('pipeline:plan', request({ useModel: true }));
    expect(off).toMatchObject({ ok: false, error: { code: 'PROVIDER_OFF' } });
    const est = await invoke<PipelineResult<PlanEstimate>>('pipeline:estimate', request({ useModel: true }));
    expect(est.ok && est.result.blockedBy).toContain('Claude is turned off');
    await invoke('ai:setProvider', 'anthropic');
    key = null;
    expect(await invoke('pipeline:plan', request({ useModel: true }))).toMatchObject({ ok: false, error: { code: 'NO_API_KEY' } });
    expect(transport.calls).toHaveLength(0);
    // Local planning is unaffected.
    const local = await invoke<PipelineResult<PlanOutcome>>('pipeline:plan', request());
    expect(local.ok && local.result.planned).toHaveLength(10);
  });

  it('estimate → run: the estimate names the rows that would be sent; the run reports its tokens and cost; nothing is resent', async () => {
    const { invoke, transport } = setup();
    await invoke('ai:setProvider', 'anthropic');
    const est = await invoke<PipelineResult<PlanEstimate>>('pipeline:estimate', request({ useModel: true }));
    expect(est.ok).toBe(true);
    if (!est.ok) return;
    expect(est.result).toMatchObject({ model: 'claude-opus-5-5', segments: 10, requests: 1, cachedRequests: 0, priced: true });
    expect(est.result.segmentIds).toHaveLength(10);
    expect(est.result.maxCost).toBeGreaterThanOrEqual(est.result.expectedCost);
    expect(est.result.blockedBy).toBeUndefined();
    expect(transport.calls).toHaveLength(0); // estimating sends nothing

    const run = await invoke<PipelineResult<PlanOutcome>>('pipeline:plan', request({ useModel: true, jobId: 'job-1' }));
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.result.run).toEqual({ calls: 1, cachedRequests: 0, inputTokens: 3000, outputTokens: 1200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, estimatedCost: 0.036, models: ['claude-opus-5-5'], warnings: [] });
    expect(run.result.updates.filter((u) => u.plan.source === 'model').length).toBeGreaterThan(5);
    expect(transport.calls).toHaveLength(1);

    // Reopening, approving, rendering or exporting uses the saved plan: local syncs never call Claude.
    await invoke('pipeline:plan', request());
    await invoke('pipeline:act', { ...request(), segmentId: 'a1', action: { type: 'approve' } });
    // Running Claude again on the unchanged project sends nothing.
    const again = await invoke<PipelineResult<PlanOutcome>>('pipeline:plan', request({ useModel: true }));
    expect(again.ok && again.result.run?.calls).toBe(0);
    expect(transport.calls).toHaveLength(1);

    const usage = await invoke<PipelineResult<AiUsage>>('ai:usage', 'proj-1');
    expect(usage.ok && usage.result.history).toHaveLength(1);
    expect(usage.ok && usage.result.projects).toEqual([expect.objectContaining({ projectId: 'proj-1', calls: 1, estimatedCost: 0.036 })]);
    expect(usage.ok && usage.result.disclaimer).toContain('not your bill');
    expect(allFiles(dir)).not.toContain('sk-ant-');
  });

  it('a failed run (credits, auth, rate limit, network) changes nothing and is not retried', async () => {
    for (const code of ['CREDITS', 'AUTHENTICATION', 'RATE_LIMITED', 'NETWORK', 'TIMEOUT'] as const) {
      fs.rmSync(path.join(dir, 'planning'), { recursive: true, force: true });
      const transport = fakeTransport(() => {
        throw new PlanningError(code, `simulated ${code}`, { retryable: code !== 'CREDITS' && code !== 'AUTHENTICATION' });
      });
      const { invoke } = setup({ transport });
      await invoke('ai:setProvider', 'anthropic');
      const r = await invoke<PipelineResult<PlanOutcome>>('pipeline:plan', request({ useModel: true }));
      expect(r).toEqual({ ok: false, error: { code, message: `simulated ${code}` } });
      expect(transport.calls).toHaveLength(1);
      expect(fs.existsSync(path.join(dir, 'planning', 'plans', 'proj-1.json'))).toBe(false);
    }
  });

  it('one run per project at a time; cancel stops a run in progress', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = fakeTransport();
    const transport = {
      calls: inner.calls,
      async complete(call: Parameters<typeof inner.complete>[0]) {
        await gate;
        call.signal?.throwIfAborted();
        return inner.complete(call);
      },
    };
    const { invoke } = setup({ transport: transport as never });
    await invoke('ai:setProvider', 'anthropic');
    const first = invoke<PipelineResult<PlanOutcome>>('pipeline:plan', request({ useModel: true, jobId: 'job-a' }));
    await new Promise((r) => setTimeout(r, 20));
    const second = await invoke<PipelineResult<PlanOutcome>>('pipeline:plan', request({ useModel: true, jobId: 'job-b' }));
    expect(second).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    expect(await invoke('pipeline:cancel', 'job-a')).toBe(true);
    release();
    const r = await first;
    expect(r).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(await invoke('pipeline:cancel', 'job-a')).toBe(false); // finished jobs are forgotten
    expect(fs.existsSync(path.join(dir, 'planning', 'plans', 'proj-1.json'))).toBe(false);
  });
});

describe('reference material', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082', 'hex');

  it('accepts notes and real still images, and refuses videos, fakes, big and missing files', async () => {
    const { ai } = setup();
    const img = path.join(dir, 'look.png');
    fs.writeFileSync(img, png);
    const refs = ai.references({ notes: ['  bold yellow type  ', '', 'https://example.com/ref'], imagePaths: [img, img] });
    expect(refs?.notes).toEqual(['bold yellow type', 'https://example.com/ref']);
    expect(refs?.images).toEqual([{ name: 'look.png', mediaType: 'image/png', base64: png.toString('base64') }]);

    const video = path.join(dir, 'clip.mp4');
    fs.writeFileSync(video, 'not sent');
    expect(() => ai.references({ notes: [], imagePaths: [video] })).toThrow(/videos never are/);
    const fake = path.join(dir, 'fake.png');
    fs.writeFileSync(fake, 'hello');
    expect(() => ai.references({ notes: [], imagePaths: [fake] })).toThrow(/isn't a valid PNG/);
    const big = path.join(dir, 'big.jpg');
    fs.writeFileSync(big, Buffer.alloc(4_000_000, 0xff));
    expect(() => ai.references({ notes: [], imagePaths: [big] })).toThrow(/at most/);
    expect(() => ai.references({ notes: [], imagePaths: [path.join(dir, 'gone.webp')] })).toThrow(/not found/);
    expect(() => ai.references({ notes: [], imagePaths: ['relative.png'] })).toThrow(/absolute/);
    expect(() => ai.references({ notes: ['x'.repeat(2001)], imagePaths: [] })).toThrow(/at most 2000/);
  });

  it('approved references reach the request; a bad reference stops the run before anything is sent', async () => {
    const { invoke, transport } = setup();
    await invoke('ai:setProvider', 'anthropic');
    const img = path.join(dir, 'look.png');
    fs.writeFileSync(img, png);
    const bad = await invoke<PipelineResult<PlanOutcome>>('pipeline:plan', request({ useModel: true, references: { notes: [], imagePaths: [path.join(dir, 'x.mov')] } }));
    expect(bad).toMatchObject({ ok: false, error: { code: 'INVALID_REFERENCE' } });
    expect(transport.calls).toHaveLength(0);
    const ok = await invoke<PipelineResult<PlanOutcome>>('pipeline:plan', request({ useModel: true, references: { notes: ['warm, film grain'], imagePaths: [img] } }));
    expect(ok.ok).toBe(true);
    expect(transport.calls[0].user).toContain('warm, film grain');
    expect(transport.calls[0].images).toHaveLength(1);
  });
});

describe('the editor’s own brief (Windows round 5)', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082', 'hex');
  const BRIEF = 'Feels like a late-night radio show — warm, intimate, never shouty.\nUse the client’s "Quiet Hours" tagline once, near the end; 3 graphics max per minute!';
  const BRANDING = 'Navy #0B1F3A with a single amber accent. Never use drop shadows.';
  const NOTES = 'Episode 12 trailer: lean on the guest’s numbers.';
  const withBrief = (extra: object = {}) =>
    request({ preset: { ...preset('northwind'), creativeBrief: BRIEF, brandingNotes: BRANDING, logoPath: path.join(dir, 'client-logo.png') }, notes: NOTES, ...extra });
  const everything = (t: ReturnType<typeof fakeTransport>) => JSON.stringify(t.calls);

  it('ticked texts reach Claude word for word; unticked ones, unselected images, file paths and the source never do', async () => {
    const { invoke, transport } = setup();
    await invoke('ai:setProvider', 'anthropic');
    const chosen = path.join(dir, 'chosen-look.png');
    const unselected = path.join(dir, 'unselected-look.png');
    fs.writeFileSync(chosen, png);
    fs.writeFileSync(unselected, Buffer.concat([png, Buffer.from('different bytes')]));
    const r = await invoke<PipelineResult<PlanOutcome>>(
      'pipeline:plan',
      withBrief({ useModel: true, references: { notes: [], imagePaths: [chosen], brief: { creativeBrief: true, brandingNotes: false, projectNotes: true } } })
    );
    expect(r.ok).toBe(true);
    const system = transport.calls[0].system.map((b) => b.text).join('\n');
    expect(system).toContain(BRIEF.trim()); // exact wording, punctuation and line breaks
    expect(system).toContain(NOTES);
    expect(system).toContain('<editor_brief kind="creative-brief"');
    expect(everything(transport)).not.toContain('Never use drop shadows'); // unticked
    expect(transport.calls[0].images).toEqual([{ mediaType: 'image/png', base64: png.toString('base64') }]);
    expect(everything(transport)).not.toContain(Buffer.concat([png, Buffer.from('different bytes')]).toString('base64'));
    for (const p of ['unselected-look', 'chosen-look', 'client-logo', dir, 'sample.mp4']) expect(everything(transport)).not.toContain(p);
    // The brief is part of the cacheable system prompt, so batches share it.
    expect(transport.calls[0].system.at(-1)).toMatchObject({ cache: true });
  });

  it('nothing of the brief is sent unless ticked; the style summary shown is the one sent', async () => {
    const { invoke, transport } = setup();
    await invoke('ai:setProvider', 'anthropic');
    const est = await invoke<PipelineResult<PlanEstimate>>('pipeline:estimate', withBrief({ useModel: true, references: { notes: [], imagePaths: [] } }));
    expect(est.ok && est.result.styleSummary).toContain('Client style profile');
    await invoke('pipeline:plan', withBrief({ useModel: true, references: { notes: [], imagePaths: [] } }));
    expect(transport.calls[0].system).toHaveLength(2);
    expect(everything(transport)).not.toContain('late-night radio');
    expect(est.ok && transport.calls[0].system[1].text).toBe(est.ok && est.result.styleSummary);
  });

  it('changing the brief changes the request (no stale cached answer); the estimate counts its tokens', async () => {
    const { invoke, transport } = setup();
    await invoke('ai:setProvider', 'anthropic');
    const refs = { notes: [], imagePaths: [], brief: { creativeBrief: true } };
    const without = await invoke<PipelineResult<PlanEstimate>>('pipeline:estimate', withBrief({ useModel: true, references: { notes: [], imagePaths: [] } }));
    const withIt = await invoke<PipelineResult<PlanEstimate>>('pipeline:estimate', withBrief({ useModel: true, references: refs }));
    expect(withIt.ok && without.ok && withIt.result.inputTokens).toBeGreaterThan(without.ok ? without.result.inputTokens : 0);
    await invoke('pipeline:plan', withBrief({ useModel: true, references: refs }));
    const edited = { ...preset('northwind'), creativeBrief: `${BRIEF} Keep it under 30 seconds.`, brandingNotes: BRANDING };
    await invoke('pipeline:plan', request({ preset: edited, notes: NOTES, useModel: true, references: refs, allowReplan: transcript('video-a').map((s) => s.id) }));
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[1].system.map((b) => b.text).join('\n')).toContain('Keep it under 30 seconds.');
  });
});

describe('spending warnings and limit labels (Windows round 5)', () => {
  it('"warn at" shows before the run (estimate) and after it (run warnings)', async () => {
    writeConfig({ budget: { softLimit: 0.05 } });
    const { invoke } = setup();
    await invoke('ai:setProvider', 'anthropic');
    const first = await invoke<PipelineResult<PlanOutcome>>('pipeline:plan', request({ useModel: true }));
    expect(first.ok && first.result.run?.warnings).toEqual([]); // $0.036 < $0.05
    const est = await invoke<PipelineResult<PlanEstimate>>('pipeline:estimate', request({ useModel: true, allowReplan: transcript('video-a').map((s) => s.id), notes: 'changed' }));
    expect(est.ok && est.result.warning).toMatch(/would likely take the project past your warning amount of \$0\.05/);
    const second = await invoke<PipelineResult<PlanOutcome>>('pipeline:plan', request({ useModel: true, notes: 'changed' }));
    expect(second.ok && second.result.run?.warnings[0]).toMatch(/has passed your warning amount of \$0\.05/);
    const after = await invoke<PipelineResult<PlanEstimate>>('pipeline:estimate', request({ useModel: true, notes: 'changed again' }));
    expect(after.ok && after.result.warning).toMatch(/has passed your warning amount/);
  });

  it('the estimate reports the project limit as configured, and a monthly cap is named as monthly', async () => {
    writeConfig({ budget: { hardLimit: 5 }, monthlyLimit: 0.01 });
    const { invoke, transport } = setup();
    await invoke('ai:setProvider', 'anthropic');
    const est = await invoke<PipelineResult<PlanEstimate>>('pipeline:estimate', request({ useModel: true }));
    expect(est.ok && est.result.budget).toEqual({ hardLimit: 5 }); // not lowered to the monthly room
    expect(est.ok && est.result.monthlyLimit).toBe(0.01);
    expect(est.ok && est.result.blockedBy).toContain('monthly limit of $0.01');
    const run = await invoke<PipelineResult<PlanOutcome>>('pipeline:plan', request({ useModel: true }));
    expect(run).toMatchObject({ ok: false, error: { code: 'BUDGET_EXCEEDED' } });
    expect(!run.ok && run.error.message).toContain('monthly limit of $0.01');
    expect(!run.ok && run.error.message).not.toContain('project limit');
    expect(transport.calls).toHaveLength(0);
  });
});
