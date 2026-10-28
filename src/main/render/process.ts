import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { cancelled, RenderError } from '../../shared/animation/errors';

export interface ToolResult {
  code: number | null;
  stdout: Buffer;
  stderrTail: string;
}

const TAIL_LINES = 30;

export function tailCollector(): { push: (chunk: Buffer) => void; text: () => string; onLine?: (line: string) => void } {
  const lines: string[] = [];
  let partial = '';
  const collector = {
    onLine: undefined as ((line: string) => void) | undefined,
    push(chunk: Buffer) {
      partial += chunk.toString('utf8');
      const parts = partial.split(/\r\n|\r|\n/);
      partial = parts.pop() ?? '';
      for (const line of parts) {
        if (!line) continue;
        lines.push(line);
        if (lines.length > TAIL_LINES) lines.shift();
        collector.onLine?.(line);
      }
    },
    text: () => [...lines, partial].filter(Boolean).join('\n'),
  };
  return collector;
}

/** Spawns a tool without a shell. Arguments are passed verbatim, so paths with spaces are safe. */
export function spawnTool(command: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Runs a tool to completion, collecting stdout (bounded) and the stderr tail. Aborting kills it and
 * rejects with CANCELLED; failure to start rejects with FFMPEG_NOT_FOUND.
 */
export function runTool(
  command: string,
  args: string[],
  options: { signal?: AbortSignal; maxStdout?: number; onStderrLine?: (line: string) => void; onStdoutLine?: (line: string) => void } = {}
): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(cancelled());
    const child = spawnTool(command, args);
    child.stdin.end();
    const chunks: Buffer[] = [];
    let size = 0;
    const max = options.maxStdout ?? 64 * 1024 * 1024;
    const stderr = tailCollector();
    stderr.onLine = options.onStderrLine;
    const stdoutLines = options.onStdoutLine ? tailCollector() : null;
    if (stdoutLines) stdoutLines.onLine = options.onStdoutLine;
    let killed = false;

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutLines?.push(chunk);
      if (size + chunk.length <= max) {
        chunks.push(chunk);
        size += chunk.length;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const onAbort = () => {
      killed = true;
      child.kill();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      options.signal?.removeEventListener('abort', onAbort);
      reject(new RenderError('FFMPEG_NOT_FOUND', `Could not start ${command}.`, { details: String(error) }));
    });
    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (killed) reject(cancelled());
      else resolve({ code, stdout: Buffer.concat(chunks), stderrTail: stderr.text() });
    });
  });
}
