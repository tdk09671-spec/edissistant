import type { SpecIssue } from './checker';

export type RenderErrorCode =
  | 'INVALID_SPEC'
  | 'INVALID_REQUEST'
  | 'FFMPEG_NOT_FOUND'
  | 'FORMAT_NOT_SUPPORTED'
  | 'FONT_NOT_FOUND'
  | 'MEDIA_NOT_FOUND'
  | 'SANDBOX_FAILED'
  | 'RENDER_FAILED'
  | 'ENCODE_FAILED'
  | 'OUTPUT_INVALID'
  | 'COMPOSE_FAILED'
  | 'CANCELLED';

export interface RenderErrorInfo {
  code: RenderErrorCode;
  message: string;
  /** Spec problems for INVALID_SPEC. */
  issues?: SpecIssue[];
  /** Tool output tail for diagnostics. */
  details?: string;
}

export class RenderError extends Error {
  readonly code: RenderErrorCode;
  readonly issues?: SpecIssue[];
  readonly details?: string;

  constructor(code: RenderErrorCode, message: string, extra: { issues?: SpecIssue[]; details?: string } = {}) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
    this.issues = extra.issues;
    this.details = extra.details;
  }

  toInfo(): RenderErrorInfo {
    return {
      code: this.code,
      message: this.message,
      ...(this.issues ? { issues: this.issues } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function toRenderErrorInfo(error: unknown): RenderErrorInfo {
  if (error instanceof RenderError) return error.toInfo();
  return { code: 'RENDER_FAILED', message: error instanceof Error ? error.message : String(error) };
}

export function cancelled(): RenderError {
  return new RenderError('CANCELLED', 'Render was cancelled.');
}
