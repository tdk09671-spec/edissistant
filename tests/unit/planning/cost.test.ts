import { describe, expect, it } from 'vitest';
import { CostTracker, DEFAULT_PRICING, estimateTokens, priceOf, type PricingTable } from '../../../src/shared/planning';

const at = '2026-10-29T12:00:00.000Z';
const u = (i: number, o: number, w = 0, r = 0) => ({ inputTokens: i, outputTokens: o, cacheCreationInputTokens: w, cacheReadInputTokens: r });
const meta = (model = 'claude-opus-5-5', task: 'creative-planning' | 'implementation' = 'creative-planning') => ({ task, model, segments: 5, attempt: 1, at });

describe('cost estimation', () => {
  it('prices input, output, cache writes and cache reads separately', () => {
    // Opus 5.5: $4 in, $20 out, $5 cache write (estimate), $0.20 cache read per MTok.
    expect(priceOf(u(1_000_000, 0), 'claude-opus-5-5', DEFAULT_PRICING)).toBe(4);
    expect(priceOf(u(0, 1_000_000), 'claude-opus-5-5', DEFAULT_PRICING)).toBe(20);
    expect(priceOf(u(0, 0, 1_000_000, 1_000_000), 'claude-opus-5-5', DEFAULT_PRICING)).toBeCloseTo(5.2, 6);
    expect(priceOf(u(1000, 1000), 'some-future-model', DEFAULT_PRICING)).toBeNull();
    expect(estimateTokens('x'.repeat(350))).toBe(100);
  });

  it('reports per project, task and model, with cache hit rate and the pricing version', () => {
    const t = new CostTracker('proj');
    t.record(u(1000, 500, 3000, 0), meta());
    t.record(u(800, 400, 0, 3000), meta());
    t.record(u(200, 100), meta('claude-sonnet-5-5', 'implementation'));
    const r = t.report();
    expect(r.calls).toBe(3);
    expect(r.usage).toEqual(u(2000, 1000, 3000, 3000));
    expect(r.byTask['creative-planning'].calls).toBe(2);
    expect(r.byModel['claude-sonnet-5-5'].estimatedCost).toBeCloseTo((200 * 2 + 100 * 10) / 1e6, 9);
    expect(r.cacheHitRate).toBeCloseTo(3000 / 8000, 3);
    expect(r.estimatedCost).toBeCloseTo((1000 * 4 + 500 * 20 + 3000 * 5 + 800 * 4 + 400 * 20 + 3000 * 0.2 + 200 * 2 + 100 * 10) / 1e6, 6);
    expect(t.usageEntries()[0].pricingVersion).toBe(DEFAULT_PRICING.version);
    expect(r.disclaimer).toMatch(/not your bill/);
  });

  it('uses a configurable, versioned price table and flags unpriced models', () => {
    const custom: PricingTable = { version: 'test-2027', currency: 'USD', source: 'test', models: { 'm-1': { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 } } };
    const t = new CostTracker('proj', custom);
    t.record(u(1_000_000, 0), meta('m-1'));
    t.record(u(1_000_000, 0), meta('m-unknown'));
    const r = t.report();
    expect(r.estimatedCost).toBe(1);
    expect(r.unpricedCalls).toBe(1);
    expect(r.warnings.join(' ')).toMatch(/1 call\(s\) used a model with no price in table test-2027/);
  });

  it('warns once per budget threshold and blocks calls that could pass the hard limit', () => {
    const t = new CostTracker('proj', DEFAULT_PRICING, { softLimit: 0.1, hardLimit: 0.2, warnAt: [0.5, 1] });
    t.record(u(0, 3000), meta()); // $0.06
    expect(t.takeWarnings()).toEqual(['Estimated AI spend for this project is $0.0600 (50% of the $0.10 budget).']);
    expect(t.takeWarnings()).toEqual([]);
    t.record(u(0, 2500), meta()); // total $0.11
    expect(t.takeWarnings()).toHaveLength(1);
    expect(() => t.assertCanSpend(0.05)).not.toThrow();
    expect(() => t.assertCanSpend(0.1)).toThrow(/pass the project limit of \$0\.20/);
    // Worst case assumes full output and uncached input.
    expect(t.worstCase('claude-opus-5-5', 1000, 1000)).toBeCloseTo((1000 * 5 + 1000 * 20) / 1e6, 9);
  });

  it('restores spend from persisted entries so limits hold across sessions', () => {
    const first = new CostTracker('proj', DEFAULT_PRICING, { hardLimit: 0.05 });
    first.record(u(0, 2400), meta()); // $0.048
    const second = new CostTracker('proj', DEFAULT_PRICING, { hardLimit: 0.05 }, [...first.usageEntries(), { ...first.usageEntries()[0], projectId: 'other' }]);
    expect(second.spent).toBeCloseTo(0.048, 6);
    expect(() => second.assertCanSpend(0.01)).toThrow();
  });

  it('reports against a per-video benchmark without promising it', () => {
    const t = new CostTracker('proj', DEFAULT_PRICING, { targetPerVideo: 0.1 });
    t.record(u(10_000, 6_000), meta()); // $0.16
    expect(t.report().warnings.join(' ')).toMatch(/Above the \$0\.10 per-video benchmark \(a goal, not a guarantee\)/);
  });
});
