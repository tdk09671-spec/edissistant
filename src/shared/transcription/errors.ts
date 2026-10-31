import type { TranscriptionErrorCode, TranscriptionErrorInfo } from './types';

export class TranscriptionError extends Error {
  readonly code: TranscriptionErrorCode;
  readonly details?: string;

  constructor(code: TranscriptionErrorCode, message: string, details?: string) {
    super(message);
    this.name = 'TranscriptionError';
    this.code = code;
    this.details = details;
  }

  toInfo(): TranscriptionErrorInfo {
    return this.details ? { code: this.code, message: this.message, details: this.details } : { code: this.code, message: this.message };
  }
}

export function isCancelled(error: unknown): boolean {
  return error instanceof TranscriptionError && error.code === 'CANCELLED';
}

/** Converts anything thrown into an IPC-safe error description. */
export function toErrorInfo(error: unknown): TranscriptionErrorInfo {
  if (error instanceof TranscriptionError) return error.toInfo();
  return { code: 'TRANSCRIPTION_FAILED', message: error instanceof Error ? error.message : String(error) };
}
