import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicTransport, mapSdkError, type MessagesClient } from '../../../src/main/planning/anthropicTransport';
import { CostTracker, ModelConceptProvider, PlanningError, redactSecrets, type ModelCall } from '../../../src/shared/planning';

// No real API call is made anywhere in this file: the SDK client is replaced by a fake.

const KEY = 'sk-ant-api03-TESTKEY-not-real-0123456789abcdef';

const call: ModelCall = {
  task: 'creative-planning',
  model: 'claude-opus-5-5',
  system: [
    { text: 'stable instructions', cache: true },
    { text: 'profile summary', cache: true },
  ],
  user: 'segments…',
  maxOutputTokens: 4000,
  effort: 'medium',
  schema: { type: 'object' },
  timeoutMs: 30_000,
};

function message(over: Partial<Anthropic.Beta.BetaMessage> = {}): Anthropic.Beta.BetaMessage {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: '{"segments":[]}', citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 250, cache_creation_input_tokens: 1800, cache_read_input_tokens: 0 },
    ...over,
  } as unknown as Anthropic.Beta.BetaMessage;
}

function fakeClient(impl: (body: unknown, options: unknown) => Promise<Anthropic.Beta.BetaMessage>) {
  const create = vi.fn(impl);
  const keys: string[] = [];
  const client: MessagesClient = { beta: { messages: { create: create as unknown as MessagesClient['beta']['messages']['create'] } } };
  return { create, keys, factory: (key: string) => (keys.push(key), client) };
}

describe('AnthropicTransport request', () => {
  it('builds a structured-output request with cache breakpoints, effort, timeout, signal and refusal fallback', async () => {
    const fake = fakeClient(async () => message());
    const controller = new AbortController();
    const t = new AnthropicTransport({ getApiKey: async () => KEY, createClient: fake.factory });
    const reply = await t.complete({ ...call, signal: controller.signal });
    const [body, options] = fake.create.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      system: [
        { type: 'text', text: 'stable instructions', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'profile summary', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'segments…' }] }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: { type: 'object' } } },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('thinking');
    expect(options).toEqual({ timeout: 30_000, signal: controller.signal });
    expect(reply).toEqual({ text: '{"segments":[]}', stopReason: 'end_turn', model: 'claude-opus-5-5', usage: { inputTokens: 900, outputTokens: 250, cacheCreationInputTokens: 1800, cacheReadInputTokens: 0 } });
  });

  it('can turn the refusal fallback off and sends images for vision tasks', () => {
    const body = AnthropicTransport.body({ ...call, task: 'vision', images: [{ mediaType: 'image/png', base64: 'AAAA' }] }, false) as unknown as Record<string, unknown>;
    expect(body).not.toHaveProperty('betas');
    expect(body).not.toHaveProperty('fallbacks');
    expect((body.messages as { content: unknown[] }[])[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  });

  it('asks the settings layer for the key on every call and never keeps it', async () => {
    const fake = fakeClient(async () => message());
    const getApiKey = vi.fn(async () => KEY);
    const t = new AnthropicTransport({ getApiKey, createClient: fake.factory });
    await t.complete(call);
    await t.complete(call);
    expect(getApiKey).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(t)).not.toContain('TESTKEY');
  });

  it('fails clearly without a key and makes no request', async () => {
    const fake = fakeClient(async () => message());
    const t = new AnthropicTransport({ getApiKey: async () => '  ', createClient: fake.factory });
    await expect(t.complete(call)).rejects.toMatchObject({ code: 'NO_API_KEY', retryable: false });
    expect(fake.create).not.toHaveBeenCalled();
  });
});

describe('SDK error mapping', () => {
  const headers = (h: Record<string, string>) => new Headers(h);
  const cases: [string, unknown, Partial<PlanningError>][] = [
    ['rate limit with retry-after', new Anthropic.RateLimitError(429, { type: 'error' }, 'rate limited', headers({ 'retry-after': '3' })), { code: 'RATE_LIMITED', retryable: true, retryAfterMs: 3000 }],
    ['overloaded (529)', new Anthropic.InternalServerError(529, { type: 'error' }, 'overloaded', headers({})), { code: 'OVERLOADED', retryable: true }],
    ['server error', new Anthropic.InternalServerError(500, { type: 'error' }, 'boom', headers({})), { code: 'SERVER_ERROR', retryable: true }],
    ['authentication', new Anthropic.AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', headers({})), { code: 'AUTHENTICATION', retryable: false }],
    ['permission', new Anthropic.PermissionDeniedError(403, { type: 'error' }, 'denied', headers({})), { code: 'PERMISSION', retryable: false }],
    ['not found', new Anthropic.NotFoundError(404, { type: 'error' }, 'model', headers({})), { code: 'NOT_FOUND', retryable: false }],
    ['bad request', new Anthropic.BadRequestError(400, { type: 'error' }, 'bad', headers({})), { code: 'BAD_REQUEST', retryable: false }],
    ['timeout', new Anthropic.APIConnectionTimeoutError(), { code: 'TIMEOUT', retryable: true }],
    ['network', new Anthropic.APIConnectionError({ message: 'socket hang up' }), { code: 'NETWORK', retryable: true }],
    ['user abort', new Anthropic.APIUserAbortError(), { code: 'CANCELLED', retryable: false }],
  ];
  it.each(cases)('%s', (_label, error, expected) => {
    expect(mapSdkError(error)).toMatchObject(expected);
  });

  it('never leaks a key through error messages', async () => {
    // A response body that echoes the key (the SDK builds its message from the body).
    const leaky = new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: `invalid request for key ${KEY}` } }, undefined, new Headers());
    const mapped = mapSdkError(leaky);
    expect(leaky.message).toContain('TESTKEY');
    expect(mapped.message).not.toContain('TESTKEY');
    expect(mapped.message).toContain('sk-ant-[redacted]');
    expect(new PlanningError('SERVER_ERROR', `failed with ${KEY}`).message).toBe('failed with sk-ant-[redacted]');
    expect(redactSecrets(`Bearer ${KEY}`)).toBe('Bearer sk-ant-[redacted]');
    const t = new AnthropicTransport({ getApiKey: async () => KEY, createClient: fakeClient(async () => Promise.reject(leaky)).factory });
    await expect(t.complete(call)).rejects.toSatisfy((e: Error) => !e.message.includes('TESTKEY'));
  });
});

describe('end to end through the provider (fake SDK client)', () => {
  it('retries a 429 from the SDK, records usage including cache reads, and never stores the key', async () => {
    let n = 0;
    const fake = fakeClient(async (body) => {
      n++;
      if (n === 1) throw new Anthropic.RateLimitError(429, { type: 'error' }, 'slow down', new Headers({ 'retry-after': '1' }));
      const ids = [...String(JSON.stringify(body)).matchAll(/transcript_segment id=\\"([^\\"]+)\\"/g)].map((m) => m[1]);
      return message({
        content: [{ type: 'text', text: JSON.stringify({ segments: ids.map((id) => ({ segmentId: id, meaning: 'm', candidates: [{ conceptId: 'kinetic-headline', fit: 0.8, reasoning: 'r' }] })) }), citations: null }],
        usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 1800 } as Anthropic.Beta.BetaUsage,
      });
    });
    const tracker = new CostTracker('p');
    const sleep = vi.fn(async () => undefined);
    const provider = new ModelConceptProvider({ transport: new AnthropicTransport({ getApiKey: async () => KEY, createClient: fake.factory }), tracker, sleep });
    const { requestSegment } = await import('../../../src/shared/planning');
    const { profile } = await import('./helpers');
    const res = await provider.suggest({ projectId: 'p', profile: profile(), variety: 'balanced', usedConcepts: [], segments: [requestSegment({ id: 'x1', start: 0, end: 2, text: 'This matters.' }, {}, [])] });
    expect(fake.create).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000, undefined);
    expect(res.candidates.x1[0]).toMatchObject({ conceptId: 'kinetic-headline', source: 'model' });
    const report = tracker.report();
    expect(report.usage.cacheReadInputTokens).toBe(1800);
    expect(report.cacheHitRate).toBeCloseTo(1800 / 2300, 3);
    expect(JSON.stringify(tracker.usageEntries())).not.toContain('TESTKEY');
  });
});
