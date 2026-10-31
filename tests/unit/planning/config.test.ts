import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlanningService } from '../../../src/main/planning';
import { buildStyleProfile, DEFAULT_PRICING, parsePlanningConfig, PLANNING_CONFIG_SCHEMA, type ModelCall, type ModelTransport } from '../../../src/shared/planning';
import { NOW, now, preset, transcript } from './helpers';

const base = { schema: PLANNING_CONFIG_SCHEMA, version: 1 };

describe('parsePlanningConfig', () => {
  it('accepts a full config', () => {
    const r = parsePlanningConfig({
      ...base,
      models: { 'creative-planning': 'claude-sonnet-5-5', implementation: 'claude-haiku-5-5' },
      effort: { 'creative-planning': 'high' },
      maxSegmentsPerBatch: 8,
      maxOutputTokens: 4000,
      timeoutMs: 30_000,
      retry: { maxAttempts: 2 },
      refusalFallback: false,
      fallbackToLocal: true,
      budget: { softLimit: 0.5, hardLimit: 1, warnAt: [1, 0.5], targetPerVideo: 0.1 },
      projectBudgets: { 'client-x_video-1': { hardLimit: 0.25 } },
      pricing: { version: 'mine-2026-11', currency: 'USD', source: 'my console', models: { 'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 } } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.budget?.warnAt).toEqual([0.5, 1]);
      expect(r.config.models?.implementation).toBe('claude-haiku-5-5');
    }
  });

  it('the documented example file is valid', () => {
    const example = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../docs/examples/planning-config.example.json'), 'utf8'));
    expect(parsePlanningConfig(example)).toMatchObject({ ok: true, config: { budget: { hardLimit: 2 }, projectBudgets: { 'first-real-api-test': { hardLimit: 0.25 } } } });
  });

  it('reports every problem instead of silently ignoring it', () => {
    const r = parsePlanningConfig({
      schema: 'x',
      version: 2,
      models: { planning: 'claude-opus-5-5', implementation: 'bad model id!' },
      effort: { 'creative-planning': 'max' },
      maxOutputTokens: 10,
      budget: { hardLimit: -1, warnAt: 'half' },
      pricing: { version: '', currency: 'EUR', models: { 'claude-opus-5-5': { input: 4 } } },
      typo: true,
    });
    expect(r.ok).toBe(false);
    const text = r.ok ? '' : r.issues.join('\n');
    for (const fragment of ['config.schema', 'config.version', 'config.models.planning is not a task', 'config.models.implementation must be a model id', 'config.effort.creative-planning', 'config.maxOutputTokens', 'config.budget.hardLimit', 'config.budget.warnAt', 'config.pricing.version', 'config.pricing.currency', 'needs input, output, cacheWrite and cacheRead', 'config.typo is not a known setting']) {
      expect(text).toContain(fragment);
    }
  });

  it('refuses credentials anywhere in the file', () => {
    for (const raw of [{ ...base, apiKey: 'x' }, { ...base, models: { 'creative-planning': 'sk-ant-api03-not-real-abcdef' } }, { ...base, budget: { anthropic_api_key: 1 } }]) {
      const r = parsePlanningConfig(raw);
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.issues.join(' ')).toMatch(/Settings/);
      expect(JSON.stringify(r)).not.toContain('sk-ant-api03-not-real-abcdef');
    }
    // A normal setting whose name mentions tokens is not a credential.
    expect(parsePlanningConfig({ ...base, maxOutputTokens: 2000 }).ok).toBe(true);
  });
});

describe('PlanningService reads config.json without code changes', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-config-'));
    file = path.join(dir, 'planning', 'config.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (data: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  };
  const transport = (): ModelTransport & { calls: ModelCall[] } => {
    const t = {
      calls: [] as ModelCall[],
      async complete(call: ModelCall) {
        t.calls.push(call);
        const ids = [...call.user.matchAll(/<transcript_segment id="([^"]+)"/g)].map((m) => m[1]);
        return {
          text: JSON.stringify({ segments: ids.map((id) => ({ segmentId: id, meaning: 'm', candidates: [{ conceptId: 'kinetic-headline', fit: 0.8, reasoning: 'r' }] })) }),
          stopReason: 'end_turn',
          model: call.model,
          usage: { inputTokens: 500, outputTokens: 200, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        };
      },
    };
    return t;
  };
  const request = (projectId = 'p1') => ({ projectId, profile: buildStyleProfile({ preset: preset('northwind') }, NOW), segments: transcript('video-a').slice(0, 3) });

  it('uses code defaults when there is no file', () => {
    const svc = new PlanningService({ userDataPath: dir, getApiKey: async () => null, now, budget: { hardLimit: 3 } });
    const s = svc.settings('p1');
    expect(s.config.state).toBe('missing');
    expect(s.budget).toEqual({ hardLimit: 3 });
    expect(s.pricing).toBe(DEFAULT_PRICING);
    expect(s.refusalFallback).toBe(true);
  });

  it('applies models, batching and limits from the file, re-read on every run', async () => {
    const t = transport();
    const svc = new PlanningService({ userDataPath: dir, getApiKey: async () => 'k', transport: t, now, budget: { hardLimit: 50 } });
    write({ ...base, models: { 'creative-planning': 'claude-sonnet-5-5' }, effort: { 'creative-planning': 'low' }, maxSegmentsPerBatch: 1, budget: { hardLimit: 2 }, projectBudgets: { p2: { hardLimit: 0.000001 } } });
    await svc.plan(request(), { useModel: true });
    expect(t.calls).toHaveLength(3); // one segment per batch
    expect(t.calls.every((c) => c.model === 'claude-sonnet-5-5' && c.effort === 'low')).toBe(true);
    expect(svc.settings('p1').budget.hardLimit).toBe(2);

    // Edit the file between runs: the next run uses the new model, no restart or code change.
    write({ ...base, models: { 'creative-planning': 'claude-haiku-5-5' } });
    await svc.plan({ ...request('p3') }, { useModel: true });
    expect(t.calls.at(-1)!.model).toBe('claude-haiku-5-5');
  });

  it('enforces a per-project hard limit from the file before anything is sent', async () => {
    const t = transport();
    const svc = new PlanningService({ userDataPath: dir, getApiKey: async () => 'k', transport: t, now });
    write({ ...base, projectBudgets: { p2: { hardLimit: 0.000001 } } });
    const r = await svc.plan(request('p2'), { useModel: true });
    expect(t.calls).toHaveLength(0);
    expect(r.warnings.join(' ')).toMatch(/Budget limit/);
    expect(r.plan.segments.every((s) => s.suggestion.source === 'local')).toBe(true);
  });

  it('a per-call budget can tighten the configured hard limit but never raise it', () => {
    const svc = new PlanningService({ userDataPath: dir, getApiKey: async () => null, now });
    write({ ...base, budget: { softLimit: 0.5, hardLimit: 1 } });
    expect(svc.settings('p1', { hardLimit: 100 }).budget).toEqual({ softLimit: 0.5, hardLimit: 1 });
    expect(svc.settings('p1', { hardLimit: 0.2 }).budget.hardLimit).toBe(0.2);
  });

  it('uses a price table from the file for estimates', async () => {
    const t = transport();
    const svc = new PlanningService({ userDataPath: dir, getApiKey: async () => 'k', transport: t, now });
    write({ ...base, models: { 'creative-planning': 'my-model' }, maxSegmentsPerBatch: 50, pricing: { version: 'mine-1', currency: 'USD', source: 'test', models: { 'my-model': { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 } } } });
    const r = await svc.plan(request(), { useModel: true });
    expect(r.cost.calls).toBe(1);
    expect(r.cost.estimatedCost).toBeCloseTo(700 / 1e6, 9);
    expect(svc.store.loadUsage('p1')[0].pricingVersion).toBe('mine-1');
  });

  it('an invalid file disables model calls (never falls back to no limits) and says why', async () => {
    const t = transport();
    const svc = new PlanningService({ userDataPath: dir, getApiKey: async () => 'k', transport: t, now });
    for (const bad of ['{ not json', { ...base, budget: { hardLimit: 'one dollar' } }]) {
      write(bad);
      const r = await svc.plan(request(), { useModel: true });
      expect(t.calls).toHaveLength(0);
      expect(r.warnings[0]).toMatch(/is invalid, so Claude won't be used until it is fixed/);
      expect(r.plan.segments.every((s) => s.suggestion.source === 'local')).toBe(true);
      expect(svc.costReport('p1').warnings[0]).toMatch(/is invalid/);
    }
  });

  it('reads a file saved by Notepad (UTF-8 with BOM, CRLF line endings)', () => {
    const svc = new PlanningService({ userDataPath: dir, getApiKey: async () => null, now });
    write('\uFEFF' + JSON.stringify({ ...base, budget: { hardLimit: 1.5 } }, null, 2).replace(/\n/g, '\r\n'));
    expect(svc.settings('p1')).toMatchObject({ config: { state: 'ok' }, budget: { hardLimit: 1.5 } });
  });

  it('saveConfig validates before writing and never stores a key', () => {
    const svc = new PlanningService({ userDataPath: dir, getApiKey: async () => null, now });
    expect(() => svc.store.saveConfig({ ...base, claudeApiKey: 'sk-ant-api03-not-real-xyz123' })).toThrow(/Settings/);
    expect(fs.existsSync(file)).toBe(false);
    svc.store.saveConfig({ ...base, budget: { hardLimit: 1 } });
    expect(svc.store.loadConfig()).toMatchObject({ state: 'ok', config: { budget: { hardLimit: 1 } } });
  });
});
