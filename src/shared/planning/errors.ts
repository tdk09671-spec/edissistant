export type PlanningErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_PROFILE'
  | 'INVALID_ACTION'
  | 'NO_API_KEY'
  | 'AUTHENTICATION'
  | 'PERMISSION'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'OVERLOADED'
  | 'SERVER_ERROR'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'REFUSED'
  | 'TRUNCATED'
  | 'INVALID_RESPONSE'
  | 'BUDGET_EXCEEDED'
  | 'CREDITS'
  | 'APPROVAL_REQUIRED'
  | 'CANCELLED';

const RETRYABLE: ReadonlySet<PlanningErrorCode> = new Set(['RATE_LIMITED', 'OVERLOADED', 'SERVER_ERROR', 'NETWORK', 'TIMEOUT', 'INVALID_RESPONSE']);

export class PlanningError extends Error {
  readonly code: PlanningErrorCode;
  readonly retryable: boolean;
  /** Server-suggested wait before retrying, when known. */
  readonly retryAfterMs?: number;

  constructor(code: PlanningErrorCode, message: string, extra: { retryAfterMs?: number; retryable?: boolean } = {}) {
    super(redactSecrets(message));
    this.name = 'PlanningError';
    this.code = code;
    this.retryable = extra.retryable ?? RETRYABLE.has(code);
    this.retryAfterMs = extra.retryAfterMs;
  }
}

/** Removes anything that looks like an Anthropic API key from text before it is shown or logged. */
export function redactSecrets(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]{4,}/g, 'sk-ant-[redacted]');
}
