import * as http from 'http';
import type { AddressInfo } from 'net';

// A local stand-in for the Anthropic API (Models + Messages), so the E2E tests drive the real SDK,
// transport and error mapping without a real key, network access or cost. The app talks to it only
// in test mode (EDISSISTANT_ANTHROPIC_BASE_URL is honoured only with EDISSISTANT_TEST_APPDATA and a
// loopback address).

export const GOOD_KEY = 'sk-ant-api03-E2E-mock-key-0123456789abcdefghijklmnopqrstuvwxyz';

export type MockMode = 'ok' | 'invalid-json' | '401' | '402' | '429' | '529' | 'drop' | 'hang';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A concept that fits the line, as a real answer would (the planner checks feasibility). */
function fitting(text: string): string {
  if (/\d/.test(text)) return 'counter-hero';
  if (/\?\s*$/.test(text)) return 'question-card';
  if (/\bthen\b/i.test(text)) return 'process-steps';
  return 'kinetic-headline';
}

function error(res: http.ServerResponse, status: number, type: string, message: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'request-id': `req_mock_${status}`, ...headers });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

/** The key a request carried (the SDK sends `Authorization: Bearer`; older clients `x-api-key`). */
export function keyOf(headers: http.IncomingHttpHeaders): string | undefined {
  const bearer = /^Bearer (.+)$/.exec(String(headers.authorization ?? ''))?.[1];
  return bearer ?? (headers['x-api-key'] as string | undefined);
}

export class MockAnthropic {
  mode: MockMode = 'ok';
  readonly requests: RecordedRequest[] = [];
  private server: http.Server | null = null;
  private hanging: http.ServerResponse[] = [];

  get url(): string {
    const port = (this.server!.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}`;
  }

  /** Requests to the Messages API (the only billed endpoint). */
  get messageRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.path.startsWith('/v1/messages'));
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => this.handle(req, res, body));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    for (const res of this.hanging) res.destroy();
    this.hanging = [];
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: string) {
    const path = req.url ?? '';
    this.requests.push({ method: req.method ?? '', path, headers: req.headers, body });
    if (keyOf(req.headers) !== GOOD_KEY) return error(res, 401, 'authentication_error', 'invalid x-api-key');

    const model = path.match(/^\/v1\/models\/([^/?]+)/)?.[1];
    if (req.method === 'GET' && model) {
      if (model !== 'claude-opus-5-5' && model !== 'claude-sonnet-5-5') return error(res, 404, 'not_found_error', `model: ${model}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'model', id: model, display_name: model === 'claude-opus-5-5' ? 'Claude Opus 5.5' : 'Claude Sonnet 5.5', created_at: '2026-01-01T00:00:00Z' }));
    }

    if (req.method === 'POST' && path.startsWith('/v1/messages')) {
      switch (this.mode) {
        case '401':
          return error(res, 401, 'authentication_error', 'invalid x-api-key');
        case '402':
          return error(res, 402, 'billing_error', 'Your credit balance is too low to access the Anthropic API.');
        case '429':
          return error(res, 429, 'rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit', { 'retry-after': '30' });
        case '529':
          return error(res, 529, 'overloaded_error', 'Overloaded');
        case 'drop':
          return req.socket.destroy();
        case 'hang':
          this.hanging.push(res);
          return;
      }
      const request = JSON.parse(body) as { model: string; messages: { content: { type: string; text?: string }[] }[] };
      const user = request.messages[0].content.filter((c) => c.type === 'text').map((c) => c.text).join('');
      const segs = [...user.matchAll(/<transcript_segment id="([^"]+)"[^>]*>([\s\S]*?)<\/transcript_segment>/g)].map((m) => ({ id: m[1], text: m[2] }));
      const text =
        this.mode === 'invalid-json'
          ? 'Sure! Here are some ideas: a big headline.'
          : JSON.stringify({
              segments: segs.map((seg) => ({
                segmentId: seg.id,
                meaning: 'What the speaker is saying here',
                candidates: [{ conceptId: fitting(seg.text), fit: 0.97, reasoning: 'Claude (mock): this concept fits the line.' }],
              })),
            });
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_mock_ok' });
      return res.end(
        JSON.stringify({
          id: `msg_mock_${this.requests.length}`,
          type: 'message',
          role: 'assistant',
          model: request.model,
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 2400, output_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        })
      );
    }
    return error(res, 404, 'not_found_error', `No mock for ${req.method} ${path}`);
  }
}
