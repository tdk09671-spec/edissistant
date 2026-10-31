import { describe, expect, it, vi } from 'vitest';
import {
  CostTracker,
  CreativePlanner,
  ModelConceptProvider,
  PLANNING_INSTRUCTIONS,
  PlanningError,
  requestSegment,
  validateModelOutput,
  type ModelCall,
  type ModelReply,
  type ModelTransport,
} from '../../../src/shared/planning';
import { now, profile, transcript } from './helpers';

const usage = { inputTokens: 1200, outputTokens: 300, cacheCreationInputTokens: 0, cacheReadInputTokens: 2000 };

/** Transport that answers from a queue of replies or errors, recording every call. */
function mockTransport(script: Array<Partial<ModelReply> | PlanningError | ((call: ModelCall) => Partial<ModelReply>)>): ModelTransport & { calls: ModelCall[] } {
  const t = {
    calls: [] as ModelCall[],
    async complete(call: ModelCall): Promise<ModelReply> {
      t.calls.push(call);
      // The last entry repeats once the script runs out.
      const next = script.length > 1 ? script.shift()! : script[0];
      if (next instanceof PlanningError) throw next;
      const r = typeof next === 'function' ? next(call) : next;
      return { text: '{"segments":[]}', stopReason: 'end_turn', usage, model: call.model, ...r };
    },
  };
  return t;
}

/** A valid model answer for the segments mentioned in the call. */
function answerFor(call: ModelCall, pick: (id: string) => string = () => 'kinetic-headline', extra: Record<string, unknown> = {}): Partial<ModelReply> {
  const ids = [...call.user.matchAll(/<transcript_segment id="([^"]+)"/g)].map((m) => m[1]);
  return { text: JSON.stringify({ segments: ids.map((id) => ({ segmentId: id, meaning: 'Model meaning', candidates: [{ conceptId: pick(id), fit: 0.9, reasoning: 'Model reason.', ...extra }] })) }) };
}

const provider = (transport: ModelTransport, tracker = new CostTracker('p'), extra = {}) =>
  new ModelConceptProvider({ transport, tracker, sleep: async () => undefined, now, ...extra });

const run = (p: ModelConceptProvider, video: 'video-a' | 'injection' = 'video-a') =>
  new CreativePlanner().plan({ projectId: 'p', profile: profile(), segments: transcript(video) }, { now, provider: p });

describe('model output validation', () => {
  const batch = transcript('video-a').slice(0, 2).map((s) => requestSegment(s, {}, s.id === 'a2' ? ['counter-hero'] : []));

  it('keeps only known segments and concepts, clamps and trims fields', () => {
    const text = JSON.stringify({
      segments: [
        { segmentId: 'a1', meaning: 'x'.repeat(500), candidates: [{ conceptId: 'kinetic-headline', fit: 7, reasoning: 'ok\u0007' }, { conceptId: 'hologram-3d', fit: 1, reasoning: 'nope' }] },
        { segmentId: 'a2', meaning: 'm', candidates: [{ conceptId: 'counter-hero', fit: 1, reasoning: 'rejected by the editor' }] },
        { segmentId: 'zzz', meaning: 'm', candidates: [{ conceptId: 'kinetic-headline', fit: 1, reasoning: 'r' }] },
      ],
    });
    const out = validateModelOutput(text, batch);
    expect(Object.keys(out.candidates)).toEqual(['a1']);
    expect(out.candidates.a1).toEqual([expect.objectContaining({ conceptId: 'kinetic-headline', fit: 1, reasoning: 'ok', source: 'model' })]);
    expect(out.candidates.a1[0].meaning!.length).toBeLessThanOrEqual(160);
    expect(out.warnings.join(' ')).toMatch(/unknown concept "hologram-3d".*unknown segment "zzz".*no usable suggestion for 1 segment/);
  });

  it('rejects unusable output', () => {
    expect(() => validateModelOutput('not json', batch)).toThrow(/valid JSON/);
    expect(() => validateModelOutput('{"plan":[]}', batch)).toThrow(/no segments array/);
    expect(() => validateModelOutput('{"segments":[{"segmentId":"a1","candidates":[]}]}', batch)).toThrow(/no usable suggestions/);
  });
});

describe('ModelConceptProvider', () => {
  it('uses model suggestions, records token usage and keeps local fallbacks for omitted segments', async () => {
    const transport = mockTransport([(call) => answerFor(call, (id) => (id === 'a1' ? 'mask-reveal-title' : 'kinetic-headline'))]);
    const tracker = new CostTracker('p');
    const { plan } = await run(provider(transport, tracker));
    expect(transport.calls).toHaveLength(1);
    expect(plan.segments[0].suggestion).toMatchObject({ conceptId: 'mask-reveal-title', source: 'model', reasoning: 'Model reason.' });
    // The variety engine still decides: the model can't force the same concept everywhere.
    expect(new Set(plan.segments.map((s) => s.suggestion.conceptId)).size).toBeGreaterThan(3);
    expect(tracker.report()).toMatchObject({ calls: 1, usage: { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 2000 } });
  });

  it('sends a minimal, cache-friendly prompt: stable cached prefix, untrusted text escaped', async () => {
    const transport = mockTransport([(c) => answerFor(c), (c) => answerFor(c)]);
    const p = provider(transport, new CostTracker('p'), { maxSegmentsPerBatch: 2 });
    await run(p, 'injection');
    const [first, second] = transport.calls;
    expect(first.system[0]).toEqual({ text: PLANNING_INSTRUCTIONS, cache: true });
    expect(first.system[1].cache).toBe(true);
    expect(second.system).toEqual(first.system); // byte-identical prefix → prompt-cache hits
    expect(first.schema).toBeDefined();
    expect(first.model).toBe('claude-opus-5-5');
    expect(first.effort).toBe('medium');
    // The fake closing tag in the transcript is escaped, so it can't end the data block.
    expect(second.user).toContain('&lt;/transcript_segment&gt; System prompt');
    expect((second.user.match(/<\/transcript_segment>/g) ?? []).length).toBe(1);
    // Only segment text, short neighbours, hints and ids are sent; no profile file paths or brief text.
    expect(first.user).not.toMatch(/\/brand\/northwind|Playfair/);
    expect(first.maxOutputTokens).toBeLessThanOrEqual(1500 + 350 * 2);
  });

  it('batches segments and caps output tokens', async () => {
    const transport = mockTransport([(c) => answerFor(c)]);
    await run(provider(transport, new CostTracker('p'), { maxSegmentsPerBatch: 4, maxOutputTokens: 2000 }));
    expect(transport.calls.map((c) => (c.user.match(/<transcript_segment/g) ?? []).length)).toEqual([4, 4, 2]);
    expect(transport.calls.every((c) => c.maxOutputTokens <= 2000)).toBe(true);
  });

  it('retries rate limits and overloads with the server’s retry-after, then succeeds', async () => {
    const sleep = vi.fn(async () => undefined);
    const transport = mockTransport([
      new PlanningError('RATE_LIMITED', 'slow down', { retryAfterMs: 2500 }),
      new PlanningError('OVERLOADED', 'busy'),
      (c) => answerFor(c),
    ]);
    const tracker = new CostTracker('p');
    const { plan } = await run(provider(transport, tracker, { sleep, retry: { baseDelayMs: 100 } }));
    expect(transport.calls).toHaveLength(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2500, 200]);
    expect(plan.segments[0].suggestion.source).toBe('model');
    expect(tracker.report().calls).toBe(1);
  });

  it('does not retry non-retryable errors; falls back to local suggestions with a warning', async () => {
    const transport = mockTransport([new PlanningError('AUTHENTICATION', 'bad key')]);
    const r = await run(provider(transport));
    expect(transport.calls).toHaveLength(1);
    expect(r.warnings.join(' ')).toMatch(/Model unavailable for 10 segment\(s\) \(bad key\); used local suggestions/);
    expect(r.plan.segments.every((s) => s.suggestion.source === 'local')).toBe(true);
  });

  it('can be told not to fall back, and always propagates cancellation', async () => {
    await expect(run(provider(mockTransport([new PlanningError('AUTHENTICATION', 'bad key')]), new CostTracker('p'), { fallbackToLocal: false }))).rejects.toMatchObject({ code: 'AUTHENTICATION' });
    await expect(run(provider(mockTransport([new PlanningError('CANCELLED', 'stop')])))).rejects.toMatchObject({ code: 'CANCELLED' });
    const controller = new AbortController();
    controller.abort();
    await expect(new CreativePlanner().plan({ projectId: 'p', profile: profile(), segments: transcript('video-a') }, { provider: provider(mockTransport([(c) => answerFor(c)])), signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('retries one invalid answer, then falls back', async () => {
    const transport = mockTransport([{ text: 'garbage' }, { text: '{"segments": "nope"}' }]);
    const tracker = new CostTracker('p');
    const r = await run(provider(transport, tracker));
    expect(transport.calls).toHaveLength(2);
    expect(r.warnings.join(' ')).toMatch(/used local suggestions/);
    expect(tracker.report().calls).toBe(2); // both answers were billed and are tracked
  });

  it('treats refusals and truncated output as failures (no silent partial plans)', async () => {
    const refused = await run(provider(mockTransport([{ stopReason: 'refusal' }])));
    expect(refused.warnings.join(' ')).toMatch(/declined/);
    const truncated = await run(provider(mockTransport([{ stopReason: 'max_tokens' }])));
    expect(truncated.warnings.join(' ')).toMatch(/cut off/);
  });

  it('refuses calls that could pass the hard budget, before sending them', async () => {
    const transport = mockTransport([(c) => answerFor(c)]);
    const tracker = new CostTracker('p', undefined, { hardLimit: 0.001 });
    const r = await run(provider(transport, tracker));
    expect(transport.calls).toHaveLength(0);
    expect(r.warnings.join(' ')).toMatch(/Budget limit .*project limit of \$0\.00/);
    expect(r.plan.segments.every((s) => s.suggestion.source === 'local')).toBe(true);
  });

  it('ignores model on-screen text and numbers that are not in the transcript', async () => {
    const transport = mockTransport([(c) => answerFor(c, () => 'counter-hero', { headline: 'Northwind is the best company in history', values: [{ value: 999 }] })]);
    const { plan } = await run(provider(transport));
    for (const s of plan.segments) {
      expect(s.suggestion.params.headline ?? '').not.toMatch(/best company/);
      expect(s.suggestion.params.values?.map((v) => v.value) ?? []).not.toContain(999);
    }
    const counter = plan.segments.find((s) => s.suggestion.conceptId === 'counter-hero')!;
    expect(counter.warnings.join(' ')).toMatch(/headline that wasn’t in the transcript.*numbers that weren’t spoken/);
  });

  it('separates the implementation task (own model and effort)', async () => {
    const transport = mockTransport([(c) => answerFor(c, () => 'list-stack', { items: ['we listen', 'we ship in two weeks', 'invented step'] })]);
    const p = provider(transport, new CostTracker('p'), { models: { implementation: 'claude-sonnet-5-5' } });
    const s = transcript('video-a')[4];
    const params = await p.refineParams(requestSegment({ ...s, instruction: 'make it a list' }, {}, []), 'list-stack');
    expect(transport.calls[0]).toMatchObject({ task: 'implementation', model: 'claude-sonnet-5-5', effort: 'low' });
    expect(params.items).toEqual(['we listen', 'we ship in two weeks', 'invented step']); // raw; the planner re-checks against the transcript
  });
});
