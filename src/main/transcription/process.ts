import { spawn } from 'child_process';
import { TranscriptionError } from '../../shared/transcription';

export interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface RunResult {
  code: number | null;
  /** Last lines of stderr, kept for error messages. */
  stderrTail: string;
  stdout: string;
}

const TAIL_LINES = 40;
const STDOUT_LIMIT = 64 * 1024;

function lineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r\n|\r|\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line) onLine(line);
  };
}

/**
 * Runs a tool without a shell (arguments are passed verbatim, so paths with spaces are safe) and
 * streams its output line by line. Aborting the signal kills the process and rejects with CANCELLED.
 * Spawn failures (e.g. ENOENT) reject with the original Node error.
 */
export function runProcess(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new TranscriptionError('CANCELLED', 'Transcription was cancelled.'));
      return;
    }
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderrLines: string[] = [];
    let stdout = '';
    let cancelled = false;

    child.stdout.on(
      'data',
      lineSplitter((line) => {
        if (stdout.length < STDOUT_LIMIT) stdout += `${line}\n`;
        options.onStdoutLine?.(line);
      })
    );
    child.stderr.on(
      'data',
      lineSplitter((line) => {
        stderrLines.push(line);
        if (stderrLines.length > TAIL_LINES) stderrLines.shift();
        options.onStderrLine?.(line);
      })
    );

    const onAbort = () => {
      cancelled = true;
      child.kill();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (cancelled) reject(new TranscriptionError('CANCELLED', 'Transcription was cancelled.'));
      else resolve({ code, stderrTail: stderrLines.join('\n'), stdout });
    });
  });
}
