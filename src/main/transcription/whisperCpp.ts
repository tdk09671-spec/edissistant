// whisper.cpp engine adapter (https://github.com/ggml-org/whisper.cpp, MIT). Runs `whisper-cli`
// as a child process on a 16 kHz WAV and reads its full JSON output, which has per-token timing.

import * as fs from 'fs';
import * as path from 'path';
import {
  parseWhisperCppJson,
  TranscriptionError,
  type TranscriptionDevice,
  type TranscriptionDevicePreference,
  type TranscriptWord,
  type WordTiming,
} from '../../shared/transcription';
import { runProcess, type RunResult } from './process';
import { dtwPreset } from './tools';

export interface EngineInput {
  /** 16 kHz mono WAV inside `workDir`. */
  audioPath: string;
  /** Scratch folder for engine output; deleted by the caller. */
  workDir: string;
  modelPath: string;
  modelName: string;
  language: string;
  device: TranscriptionDevicePreference;
  threads: number;
  dtwAlignment: boolean;
}

export interface EngineOutput {
  language: string;
  words: TranscriptWord[];
  wordTiming: WordTiming;
  end: number;
  device: TranscriptionDevice;
  gpuBackend?: string;
  cpuFallback: boolean;
  warnings: string[];
}

export interface EngineContext {
  signal?: AbortSignal;
  /** Fraction 0–1 of the audio transcribed. */
  onProgress?: (fraction: number) => void;
}

/** Engine contract, so other local engines (e.g. faster-whisper) can be added behind the same service. */
export interface TranscriptionEngine {
  readonly name: string;
  transcribe(input: EngineInput, context: EngineContext): Promise<EngineOutput>;
  version(): Promise<string | undefined>;
}

export interface WhisperCppOptions {
  /** Path to whisper-cli. */
  command: string;
  /** Arguments placed before ours (lets tests run a script through `node`). */
  prefixArgs?: string[];
}

const OUTPUT_BASENAME = 'transcript';

/** Errors that a CPU retry can't fix, so 'auto' mode reports them instead of falling back. */
const NOT_DEVICE_RELATED = /unknown argument|model file not found|input file not found|failed to read audio|unknown language|unknown DTW preset/i;

export function parseWhisperProgress(line: string): number | null {
  const match = /progress\s*=\s*(\d+)%/.exec(line);
  return match ? Math.min(100, Number(match[1])) / 100 : null;
}

/** Reads which compute device whisper.cpp chose from its log. */
export function parseWhisperDevice(log: string): { device: TranscriptionDevice; gpuBackend?: string } {
  const gpu = /whisper_backend_init_gpu: using (\S+) backend/.exec(log);
  if (gpu) return { device: 'gpu', gpuBackend: gpu[1] };
  if (/whisper_backend_init_gpu: no GPU found/.test(log) || /use gpu\s*=\s*0/.test(log)) return { device: 'cpu' };
  return { device: 'unknown' };
}

export class WhisperCppEngine implements TranscriptionEngine {
  readonly name = 'whisper.cpp';
  private readonly command: string;
  private readonly prefixArgs: string[];
  private cachedVersion?: Promise<string | undefined>;

  constructor(options: WhisperCppOptions) {
    this.command = options.command;
    this.prefixArgs = options.prefixArgs ?? [];
  }

  version(): Promise<string | undefined> {
    this.cachedVersion ??= runProcess(this.command, [...this.prefixArgs, '--version'])
      .then((r) => /whisper\.cpp version:\s*(\S+)/.exec(`${r.stdout}\n${r.stderrTail}`)?.[1])
      .catch(() => undefined);
    return this.cachedVersion;
  }

  buildArgs(input: EngineInput, useGpu: boolean): string[] {
    const args = [
      ...this.prefixArgs,
      '-m',
      input.modelPath,
      // Relative names inside the work folder: whisper-cli reads argv in the Windows ANSI code page,
      // so this keeps our own paths ASCII-safe regardless of the user's temp folder name.
      '-f',
      path.basename(input.audioPath),
      '-of',
      OUTPUT_BASENAME,
      '-ojf',
      '-pp',
      '-l',
      input.language || 'auto',
      '-t',
      String(Math.max(1, Math.floor(input.threads))),
    ];
    if (!useGpu) args.push('-ng');
    if (input.dtwAlignment) {
      const preset = dtwPreset(input.modelName);
      if (preset) args.push('-dtw', preset);
    }
    return args;
  }

  private async run(input: EngineInput, useGpu: boolean, context: EngineContext): Promise<RunResult & { log: string }> {
    const log: string[] = [];
    const outFile = path.join(input.workDir, `${OUTPUT_BASENAME}.json`);
    fs.rmSync(outFile, { force: true });
    try {
      const result = await runProcess(this.command, this.buildArgs(input, useGpu), {
        cwd: input.workDir,
        signal: context.signal,
        onStderrLine: (line) => {
          if (log.length < 400) log.push(line);
          const p = parseWhisperProgress(line);
          if (p !== null) context.onProgress?.(p);
        },
      });
      return { ...result, log: log.join('\n') };
    } catch (error) {
      if (error instanceof TranscriptionError) throw error;
      throw new TranscriptionError('ENGINE_NOT_FOUND', `The transcription engine could not be started (${this.command}).`, String(error));
    }
  }

  async transcribe(input: EngineInput, context: EngineContext): Promise<EngineOutput> {
    const warnings: string[] = [];
    if (process.platform === 'win32' && /[^\x00-\x7f]/.test(input.modelPath)) {
      warnings.push('The model path contains non-ASCII characters, which some whisper.cpp builds cannot open on Windows.');
    }
    if (input.dtwAlignment && !dtwPreset(input.modelName)) {
      warnings.push(`DTW alignment isn't available for model "${input.modelName}"; used standard token timing.`);
    }

    let useGpu = input.device !== 'cpu';
    let cpuFallback = false;
    let result = await this.run(input, useGpu, context);

    if (result.code !== 0 && input.device === 'auto' && !NOT_DEVICE_RELATED.test(result.stderrTail)) {
      // GPU builds can fail at init (missing driver/runtime, out of VRAM). Retry once on the CPU.
      cpuFallback = true;
      useGpu = false;
      warnings.push('GPU transcription failed, so it was retried on the CPU.');
      context.onProgress?.(0);
      result = await this.run(input, false, context);
    }

    if (result.code !== 0) {
      const tail = result.stderrTail;
      if (/model file not found|failed to initialize whisper context/i.test(tail)) {
        throw new TranscriptionError('MODEL_NOT_FOUND', 'The Whisper model could not be loaded. It may be missing, incomplete or incompatible.', tail);
      }
      const hint = input.device === 'gpu' ? ' Try running on the CPU.' : '';
      throw new TranscriptionError('TRANSCRIPTION_FAILED', `The transcription engine failed (exit code ${result.code}).${hint}`, tail);
    }

    const outFile = path.join(input.workDir, `${OUTPUT_BASENAME}.json`);
    if (!fs.existsSync(outFile)) {
      throw new TranscriptionError('TRANSCRIPTION_FAILED', 'The transcription engine finished without writing a transcript.', result.stderrTail);
    }
    const parsed = parseWhisperCppJson(fs.readFileSync(outFile, 'utf8'), { dtw: input.dtwAlignment });

    const detected = useGpu ? parseWhisperDevice(result.log) : { device: 'cpu' as const };
    if (input.device === 'gpu' && detected.device === 'cpu') {
      warnings.push('A GPU was requested but the engine found none, so it ran on the CPU.');
    }
    context.onProgress?.(1);
    return { ...parsed, ...detected, cpuFallback, warnings };
  }
}
