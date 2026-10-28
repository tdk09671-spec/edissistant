import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseWhisperDevice, parseWhisperProgress, WhisperCppEngine, type EngineInput } from '../../../src/main/transcription/whisperCpp';
import { TranscriptionError } from '../../../src/shared/transcription';
import { copyFixture, fakeWhisper, tempDir } from './helpers';

let dir: string;
let input: EngineInput;
beforeEach(() => {
  dir = tempDir();
  const model = path.join(dir, 'ggml-base.en.bin');
  fs.writeFileSync(model, 'fake model');
  input = {
    audioPath: copyFixture('tone.wav', dir, 'audio.wav'),
    workDir: dir,
    modelPath: model,
    modelName: 'base.en',
    language: 'auto',
    device: 'auto',
    threads: 4,
    dtwAlignment: false,
  };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function engine(mode = 'normal', record?: string) {
  const prefixArgs = [fakeWhisper, `--fake-mode=${mode}`, ...(record ? [`--fake-record=${record}`] : [])];
  return new WhisperCppEngine({ command: process.execPath, prefixArgs });
}

function recorded(file: string): string[][] {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

describe('log parsing', () => {
  it('reads progress lines', () => {
    expect(parseWhisperProgress('whisper_print_progress_callback: progress =  45%')).toBe(0.45);
    expect(parseWhisperProgress('whisper_full: something else')).toBeNull();
  });

  it('reads the device whisper.cpp chose', () => {
    expect(parseWhisperDevice('whisper_backend_init_gpu: using CUDA0 backend')).toEqual({ device: 'gpu', gpuBackend: 'CUDA0' });
    expect(parseWhisperDevice('whisper_backend_init_gpu: no GPU found')).toEqual({ device: 'cpu' });
    // ACCEL backends such as BLAS are not GPUs.
    expect(parseWhisperDevice('whisper_backend_init: using BLAS backend')).toEqual({ device: 'unknown' });
  });
});

describe('buildArgs', () => {
  it('passes full JSON output, progress, language and threads with work-folder-relative paths', () => {
    const args = new WhisperCppEngine({ command: 'whisper-cli' }).buildArgs(input, true);
    expect(args).toEqual(['-m', input.modelPath, '-f', 'audio.wav', '-of', 'transcript', '-ojf', '-pp', '-l', 'auto', '-t', '4']);
  });

  it('adds -ng for CPU and a DTW preset when requested', () => {
    const args = new WhisperCppEngine({ command: 'whisper-cli' }).buildArgs({ ...input, dtwAlignment: true }, false);
    expect(args).toContain('-ng');
    expect(args.slice(-2)).toEqual(['-dtw', 'base.en']);
  });
});

describe('WhisperCppEngine with a stand-in whisper-cli', () => {
  it('transcribes, reports progress and reads the device from the log', async () => {
    const progress: number[] = [];
    const out = await engine().transcribe(input, { onProgress: (p) => progress.push(p) });
    expect(out.words.length).toBe(15);
    expect(out.language).toBe('en');
    expect(out.wordTiming).toBe('word');
    expect(out.device).toBe('cpu');
    expect(out.cpuFallback).toBe(false);
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(1);
    expect(await engine().version()).toBe('0.0.0-fake');
  });

  it('reports a GPU backend when the engine says it used one', async () => {
    const out = await engine('gpu-ok').transcribe({ ...input, device: 'gpu' }, {});
    expect(out).toMatchObject({ device: 'gpu', gpuBackend: 'CUDA0', cpuFallback: false });
  });

  it('runs with -ng on CPU and never reports a GPU', async () => {
    const record = path.join(dir, 'args.jsonl');
    const out = await engine('gpu-ok', record).transcribe({ ...input, device: 'cpu' }, {});
    expect(out.device).toBe('cpu');
    expect(recorded(record)[0]).toContain('-ng');
  });

  it('falls back to the CPU in auto mode when the GPU run fails', async () => {
    const record = path.join(dir, 'args.jsonl');
    const out = await engine('gpu-fail', record).transcribe(input, {});
    expect(out.cpuFallback).toBe(true);
    expect(out.device).toBe('cpu');
    expect(out.warnings.join(' ')).toMatch(/retried on the CPU/);
    const runs = recorded(record);
    expect(runs).toHaveLength(2);
    expect(runs[0]).not.toContain('-ng');
    expect(runs[1]).toContain('-ng');
  });

  it('does not fall back when the GPU was explicitly requested', async () => {
    await expect(engine('gpu-fail').transcribe({ ...input, device: 'gpu' }, {})).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  });

  it('warns when a GPU was requested but none was found', async () => {
    const out = await engine('normal').transcribe({ ...input, device: 'gpu' }, {});
    expect(out.device).toBe('cpu');
    expect(out.warnings.join(' ')).toMatch(/GPU was requested/);
  });

  it('maps engine failures to error codes', async () => {
    await expect(engine('crash').transcribe({ ...input, device: 'cpu' }, {})).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED' });
    await expect(engine('no-output').transcribe(input, {})).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED' });
    await expect(engine().transcribe({ ...input, modelPath: path.join(dir, 'missing.bin') }, {})).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
    const missing = new WhisperCppEngine({ command: path.join(dir, 'no-such-whisper') });
    await expect(missing.transcribe(input, {})).rejects.toMatchObject({ code: 'ENGINE_NOT_FOUND' });
  });

  it('kills the engine on cancel', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const run = engine('slow').transcribe(input, {
      signal: controller.signal,
      onProgress: (p) => p >= 0.2 && controller.abort(),
    });
    await expect(run).rejects.toBeInstanceOf(TranscriptionError);
    await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
    // The slow stand-in needs ~1.5 s to finish; cancelling must not wait for it.
    expect(Date.now() - started).toBeLessThan(1200);
  });
});
