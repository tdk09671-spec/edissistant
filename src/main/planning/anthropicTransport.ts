// Anthropic API transport for the planning engine, using the official SDK (@anthropic-ai/sdk).
//
//  - The API key is fetched on every call from the desktop settings layer (getApiKey) and never
//    stored, logged or written to project files. Error text is scrubbed of anything key-shaped.
//  - SDK retries are off (maxRetries: 0): the planner owns retries, backoff and budgets so they are
//    testable and cancellable. Per-request timeout and AbortSignal are passed through.
//  - Structured output (output_config.format json_schema) and prompt-cache breakpoints on the
//    stable system blocks. Server-side refusal fallback is on by default (beta; can be turned off).
//
// No call is made unless the editor has configured a key and the planner decides to use the model.

import Anthropic from '@anthropic-ai/sdk';
import { PlanningError, redactSecrets } from '../../shared/planning/errors';
import type { ModelCall, ModelReply, ModelTransport } from '../../shared/planning/modelProvider';

/** The part of the SDK client this transport uses (lets tests inject a fake). */
export interface MessagesClient {
  beta: { messages: { create: (body: Anthropic.Beta.MessageCreateParamsNonStreaming, options?: { timeout?: number; signal?: AbortSignal }) => Promise<Anthropic.Beta.BetaMessage> } };
}

export interface AnthropicTransportOptions {
  /** Returns the editor's key from secure storage (main.ts secrets), or null when none is set. */
  getApiKey: () => Promise<string | null | undefined>;
  /** Server-side refusal fallback (beta `server-side-fallback-2026-07-01`, `fallbacks: "default"`). Default true. */
  refusalFallback?: boolean;
  /** For tests: build the client from a key. */
  createClient?: (apiKey: string) => MessagesClient;
}

function retryAfterMs(headers: Headers | undefined): number | undefined {
  const raw = headers?.get?.('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** Maps SDK errors to planning errors, most specific first. */
export function mapSdkError(error: unknown): PlanningError {
  if (error instanceof PlanningError) return error;
  if (error instanceof Anthropic.APIUserAbortError) return new PlanningError('CANCELLED', 'Planning was cancelled.');
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new PlanningError('TIMEOUT', 'The model request timed out.');
  if (error instanceof Anthropic.APIConnectionError) return new PlanningError('NETWORK', 'Could not reach the Anthropic API. Check the internet connection.');
  if (error instanceof Anthropic.AuthenticationError) return new PlanningError('AUTHENTICATION', 'The Claude API key was rejected. Update it in Settings.');
  if (error instanceof Anthropic.PermissionDeniedError) return new PlanningError('PERMISSION', 'This API key is not allowed to use the requested model.');
  if (error instanceof Anthropic.NotFoundError) return new PlanningError('NOT_FOUND', 'The requested model was not found.');
  if (error instanceof Anthropic.RateLimitError) return new PlanningError('RATE_LIMITED', 'Rate limited by the Anthropic API.', { retryAfterMs: retryAfterMs(error.headers) });
  if (error instanceof Anthropic.BadRequestError) return new PlanningError('BAD_REQUEST', `The API rejected the request: ${redactSecrets(error.message)}`);
  if (error instanceof Anthropic.InternalServerError) {
    return error.status === 529
      ? new PlanningError('OVERLOADED', 'The Anthropic API is overloaded.', { retryAfterMs: retryAfterMs(error.headers) })
      : new PlanningError('SERVER_ERROR', `Anthropic API error ${error.status}.`);
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    return status >= 500 ? new PlanningError('SERVER_ERROR', `Anthropic API error ${status}.`) : new PlanningError('BAD_REQUEST', `Anthropic API error ${status}: ${redactSecrets(error.message)}`);
  }
  return new PlanningError('SERVER_ERROR', redactSecrets(error instanceof Error ? error.message : String(error)));
}

export class AnthropicTransport implements ModelTransport {
  constructor(private readonly options: AnthropicTransportOptions) {}

  private client(apiKey: string): MessagesClient {
    return this.options.createClient ? this.options.createClient(apiKey) : new Anthropic({ apiKey, maxRetries: 0 });
  }

  /** Builds the request body (exposed for tests and for token counting). */
  static body(call: ModelCall, refusalFallback: boolean): Anthropic.Beta.MessageCreateParamsNonStreaming {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      ...(call.images ?? []).map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType, data: img.base64 } })),
      { type: 'text', text: call.user },
    ];
    return {
      model: call.model,
      max_tokens: call.maxOutputTokens,
      system: call.system.map((b) => ({ type: 'text' as const, text: b.text, ...(b.cache ? { cache_control: { type: 'ephemeral' as const } } : {}) })),
      messages: [{ role: 'user', content }],
      output_config: { effort: call.effort, format: { type: 'json_schema', schema: call.schema } },
      ...(refusalFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    };
  }

  async complete(call: ModelCall): Promise<ModelReply> {
    const apiKey = (await this.options.getApiKey())?.trim();
    if (!apiKey) throw new PlanningError('NO_API_KEY', 'No Claude API key is set. Add one in Settings to use AI planning; local planning still works.', { retryable: false });
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await this.client(apiKey).beta.messages.create(AnthropicTransport.body(call, this.options.refusalFallback !== false), { timeout: call.timeoutMs, signal: call.signal });
    } catch (error) {
      throw mapSdkError(error);
    }
    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const u = message.usage;
    return {
      text,
      stopReason: message.stop_reason ?? null,
      model: message.model,
      usage: {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
      },
    };
  }
}
