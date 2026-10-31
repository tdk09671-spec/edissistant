import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseWhisperDevice, parseWhisperHelp, parseWhisperProgress, resolveEngineFiles, unknownArgument, WhisperCppEngine, type EngineInput } from '../../../src/main/transcription/whisperCpp';
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

// whisper-cli reads argv in the Windows ANSI code page: whisper.cpp 1.9.5 crashed on a model in
// "modèles" and couldn't find one under "日本", so a user name like "Zoë José 日本" broke the default setup.
describe('Unicode model paths on Windows', () => {
  let user: string;
  let models: string;
  let work: string;
  let unicodeInput: EngineInput;
  beforeEach(() => {
    user = path.join(dir, 'Zoë José 日本');
    models = path.join(user, 'AppData', 'Roaming', 'edissistant', 'modèles');
    work = path.join(user, 'AppData', 'Local', 'Temp', 'edissistant-transcribe-x');
    fs.mkdirSync(models, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(models, 'ggml-base.en.bin'), 'fake model');
    unicodeInput = { ...input, workDir: work, audioPath: copyFixture('tone.wav', work, 'audio.wav'), modelPath: path.join(models, 'ggml-base.en.bin') };
  });

  const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);

  it('passes ASCII model paths unchanged, and leaves other platforms alone', () => {
    expect(resolveEngineFiles(input, 'win32')).toEqual({ cwd: dir, model: input.modelPath, audio: 'audio.wav', output: 'transcript' });
    expect(resolveEngineFiles(unicodeInput, 'linux')).toMatchObject({ cwd: work, model: unicodeInput.modelPath });
  });

  it('runs in the model folder with only ASCII path arguments that point at the right files', () => {
    const files = resolveEngineFiles(unicodeInput, 'win32');
    expect(files.cwd).toBe(models);
    expect(files.model).toBe('ggml-base.en.bin');
    for (const arg of [files.model, files.audio, files.output]) expect(ascii(arg), arg).toBe(true);
    if (process.platform === 'win32') {
      expect(path.resolve(files.cwd, files.audio)).toBe(unicodeInput.audioPath);
      expect(path.resolve(files.cwd, files.output)).toBe(path.join(work, 'transcript'));
    }
    // Nothing was created next to the user's model.
    expect(fs.readdirSync(models)).toEqual(['ggml-base.en.bin']);
  });

  it('uses a temporary hard link when the model file name itself is not ASCII, without touching the original', () => {
    const original = path.join(models, 'ggml-baseé.bin');
    fs.renameSync(unicodeInput.modelPath, original);
    const files = resolveEngineFiles({ ...unicodeInput, modelPath: original }, 'win32');
    expect(files).toMatchObject({ cwd: work, model: 'model.bin', audio: 'audio.wav' });
    const link = path.join(work, 'model.bin');
    expect(fs.readFileSync(link, 'utf8')).toBe('fake model');
    expect(fs.statSync(link).ino).toBe(fs.statSync(original).ino);
    // Deleting the work folder (as the service does) leaves the model in place.
    fs.rmSync(work, { recursive: true, force: true });
    expect(fs.readFileSync(original, 'utf8')).toBe('fake model');
  });

  it('gives an actionable MODEL_NOT_FOUND instead of a crash when no ASCII path or link is possible', () => {
    // A link can't be made (here: no source file; in practice: a different drive or a FAT/exFAT drive).
    const unreachable = { ...unicodeInput, modelPath: path.join(models, 'ggml-日本.bin') };
    expect(() => resolveEngineFiles(unreachable, 'win32')).toThrow(TranscriptionError);
    try {
      resolveEngineFiles(unreachable, 'win32');
    } catch (error) {
      expect(error).toMatchObject({ code: 'MODEL_NOT_FOUND' });
      expect((error as Error).message).toMatch(/modelsDirectory/);
    }
  });

  it.skipIf(process.platform !== 'win32')('transcribes end to end with the model and work folder under a Unicode user folder', async () => {
    const record = path.join(dir, 'runs.jsonl');
    const out = await engine('normal', record).transcribe({ ...unicodeInput, device: 'cpu' }, {});
    expect(out.words.length).toBeGreaterThan(0);
    const args = recorded(record).find((a) => a.includes('-m'))!;
    for (const flag of ['-m', '-f', '-of']) expect(ascii(args[args.indexOf(flag) + 1])).toBe(true);
    expect(fs.readdirSync(models)).toEqual(['ggml-base.en.bin']);
  });
});

// Regression (Windows, whisper.cpp 1.9.x): flash attention is on by default since whisper.cpp 1.8
// and silently disables DTW ("dtw_token_timestamps is not supported with flash_attn - disabling"),
// so -dtw alone gave no DTW times. -nfa fixes it, but older CLIs don't know -nfa.
describe('DTW and flash attention', () => {
  const engineWith = (help: 'modern' | 'legacy' | 'lying', record: string, extra: string[] = []) =>
    new WhisperCppEngine({ command: process.execPath, prefixArgs: [fakeWhisper, `--fake-help=${help}`, `--fake-record=${record}`, ...extra] });
  const runs = (file: string) => recorded(file).filter((a) => !a.includes('--help'));

  it('reads -nfa support from the help text', () => {
    expect(parseWhisperHelp('  -fa,       --flash-attn           [true   ] enable flash attention\n  -nfa,      --no-flash-attn        [false  ] disable flash attention')).toEqual({ noFlashAttn: true });
    expect(parseWhisperHelp('  -fa,       --flash-attn           [false  ] enable flash attention')).toEqual({ noFlashAttn: false });
    expect(parseWhisperHelp('  --nfa-something    unrelated')).toEqual({ noFlashAttn: false });
    expect(unknownArgument('error: unknown argument: -nfa\nusage: whisper-cli')).toBe('-nfa');
    expect(unknownArgument('whisper_init: loading model')).toBeNull();
  });

  it('adds -nfa only with DTW, on GPU and CPU, and only when the CLI has it', () => {
    const e = new WhisperCppEngine({ command: 'whisper-cli' });
    const modern = { noFlashAttn: true };
    expect(e.buildArgs({ ...input, dtwAlignment: true }, true, undefined, modern).slice(-3)).toEqual(['-dtw', 'base.en', '-nfa']);
    const cpu = e.buildArgs({ ...input, dtwAlignment: true }, false, undefined, modern);
    expect(cpu).toContain('-ng');
    expect(cpu.slice(-3)).toEqual(['-dtw', 'base.en', '-nfa']);
    // Normal transcription keeps flash attention (the fast GPU path).
    expect(e.buildArgs(input, true, undefined, modern)).not.toContain('-nfa');
    // Older CLI: no -nfa (flash attention is off there anyway).
    expect(e.buildArgs({ ...input, dtwAlignment: true }, true)).not.toContain('-nfa');
    // No DTW preset for this model: neither flag.
    const custom = e.buildArgs({ ...input, dtwAlignment: true, modelName: 'my-finetune' }, true, undefined, modern);
    expect(custom).not.toContain('-dtw');
    expect(custom).not.toContain('-nfa');
  });

  it('modern CLI: DTW runs with -nfa and the words use DTW times', async () => {
    const record = path.join(dir, 'modern.jsonl');
    const out = await engineWith('modern', record).transcribe({ ...input, dtwAlignment: true, device: 'gpu' }, {});
    expect(runs(record)[0]).toEqual(expect.arrayContaining(['-dtw', 'base.en', '-nfa']));
    expect(out.warnings.join(' ')).not.toMatch(/turned DTW alignment off/);
    // whisper-full.json: "back" has t_dtw 44 (0.44 s) and token offset 0.42 s.
    expect(out.words.find((w) => w.text === 'back')?.start).toBe(0.44);
  });

  it('normal transcription never asks for help or adds -nfa', async () => {
    const record = path.join(dir, 'fast.jsonl');
    await engineWith('modern', record).transcribe({ ...input, device: 'gpu' }, {});
    expect(recorded(record)).toHaveLength(1);
    expect(recorded(record)[0]).not.toContain('-nfa');
  });

  it('older CLI: DTW runs without -nfa and works', async () => {
    const record = path.join(dir, 'legacy.jsonl');
    const out = await engineWith('legacy', record).transcribe({ ...input, dtwAlignment: true, device: 'cpu' }, {});
    expect(runs(record)[0]).not.toContain('-nfa');
    expect(runs(record)[0]).toContain('-ng');
    expect(out.words.find((w) => w.text === 'back')?.start).toBe(0.44);
  });

  it('a CLI that lists -nfa but rejects it is run again without it', async () => {
    const record = path.join(dir, 'lying.jsonl');
    const out = await engineWith('lying', record).transcribe({ ...input, dtwAlignment: true }, {});
    expect(runs(record).map((a) => a.includes('-nfa'))).toEqual([true, false]);
    expect(out.warnings).toContain('This whisper.cpp build rejected -nfa, so it ran without it.');
  });

  it('DTW switched off by flash attention is reported, and token timing is used instead', async () => {
    // A modern CLI whose help couldn't be read: -nfa isn't passed, so whisper.cpp disables DTW.
    const e = engineWith('modern', path.join(dir, 'nohelp.jsonl'));
    (e as unknown as { cachedCapabilities: Promise<unknown> }).cachedCapabilities = Promise.resolve({ noFlashAttn: false });
    const out = await e.transcribe({ ...input, dtwAlignment: true }, {});
    expect(out.warnings.join(' ')).toMatch(/turned DTW alignment off because flash attention is on/);
    expect(out.words.find((w) => w.text === 'back')?.start).toBe(0.42);
  });
});
