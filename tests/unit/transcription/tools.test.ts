import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dtwPreset, findTool, listModels, resolveModel } from '../../../src/main/transcription/tools';
import { TranscriptionError } from '../../../src/shared/transcription';
import { tempDir } from './helpers';

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function touch(...parts: string[]): string {
  const file = path.join(dir, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
  return file;
}

describe('findTool', () => {
  const base = { searchDirs: [] as string[], env: {} as NodeJS.ProcessEnv, platform: 'linux' as NodeJS.Platform };

  it('prefers the configured file, then a configured folder (or its bin/)', () => {
    const exe = touch('tools', 'whisper-cli');
    expect(findTool(['whisper-cli'], exe, 'X', base)).toBe(exe);
    expect(findTool(['whisper-cli'], path.join(dir, 'tools'), 'X', base)).toBe(exe);
    const binExe = touch('pkg', 'bin', 'whisper-cli');
    expect(findTool(['whisper-cli'], path.join(dir, 'pkg'), 'X', base)).toBe(binExe);
  });

  it('accepts a quoted path copied from Windows Explorer', () => {
    const exe = touch('My Tools', 'ffmpeg');
    expect(findTool(['ffmpeg'], `"${exe}"`, 'X', base)).toBe(exe);
  });

  it('falls back to the env override, search folders, then PATH', () => {
    const fromEnv = touch('env', 'ffmpeg');
    expect(findTool(['ffmpeg'], '', 'FF', { ...base, env: { FF: fromEnv } })).toBe(fromEnv);
    const fromSearch = touch('search', 'ffmpeg');
    expect(findTool(['ffmpeg'], undefined, 'FF', { ...base, searchDirs: [path.join(dir, 'search')] })).toBe(fromSearch);
    const fromPath = touch('path', 'ffmpeg');
    expect(findTool(['ffmpeg'], undefined, 'FF', { ...base, env: { PATH: `/nowhere:${path.join(dir, 'path')}` } })).toBe(fromPath);
  });

  it('adds .exe and splits PATH on ";" on Windows', () => {
    const exe = touch('win', 'whisper-cli.exe');
    expect(findTool(['whisper-cli'], undefined, 'X', { ...base, platform: 'win32', env: { Path: `C:\\nope;${path.join(dir, 'win')}` } })).toBe(exe);
  });

  it('never picks a generic "main" binary from PATH, only from folders it was pointed at', () => {
    touch('path', 'main');
    const env = { PATH: path.join(dir, 'path') };
    expect(findTool(['whisper-cli', 'main'], undefined, 'X', { ...base, env })).toBeUndefined();
    expect(findTool(['whisper-cli', 'main'], path.join(dir, 'path'), 'X', base)).toBe(path.join(dir, 'path', 'main'));
  });

  it('returns undefined when nothing is found', () => {
    expect(findTool(['ffmpeg'], path.join(dir, 'missing'), 'X', base)).toBeUndefined();
  });
});

describe('models', () => {
  it('lists ggml models largest first and ignores test, VAD and encoder files', () => {
    fs.writeFileSync(path.join(dir, 'ggml-base.en.bin'), Buffer.alloc(20));
    fs.writeFileSync(path.join(dir, 'ggml-small.bin'), Buffer.alloc(40));
    for (const f of ['for-tests-ggml-tiny.bin', 'ggml-silero-v5.1.2.bin', 'ggml-base.en-encoder.bin', 'notes.txt', 'ggml-empty.bin']) {
      fs.writeFileSync(path.join(dir, f), f === 'ggml-empty.bin' ? '' : 'x');
    }
    const models = listModels(dir);
    expect(models.map((m) => m.name)).toEqual(['small', 'base.en']);
    expect(listModels(path.join(dir, 'missing'))).toEqual([]);
  });

  it('resolves requested, configured and default models', () => {
    fs.writeFileSync(path.join(dir, 'ggml-base.en.bin'), Buffer.alloc(20));
    fs.writeFileSync(path.join(dir, 'ggml-small.bin'), Buffer.alloc(40));
    const models = listModels(dir);
    expect(resolveModel(models, 'base.en', undefined).name).toBe('base.en');
    expect(resolveModel(models, 'ggml-base.en.bin', undefined).name).toBe('base.en');
    expect(resolveModel(models, undefined, 'base.en').name).toBe('base.en');
    expect(resolveModel(models, undefined, 'gone').name).toBe('small');
    expect(resolveModel(models, undefined, undefined).name).toBe('small');
    expect(resolveModel(models, path.join(dir, 'ggml-small.bin'), undefined).path).toBe(path.join(dir, 'ggml-small.bin'));
  });

  it('throws MODEL_NOT_FOUND for missing models', () => {
    const expectCode = (fn: () => unknown) => {
      try {
        fn();
        expect.unreachable();
      } catch (error) {
        expect((error as TranscriptionError).code).toBe('MODEL_NOT_FOUND');
      }
    };
    expectCode(() => resolveModel([], undefined, undefined));
    expectCode(() => resolveModel([], 'medium', undefined));
    expectCode(() => resolveModel([], path.join(dir, 'nope.bin'), undefined));
  });

  it('maps model names to DTW presets', () => {
    expect(dtwPreset('base.en')).toBe('base.en');
    expect(dtwPreset('large-v3-turbo-q5_0')).toBe('large.v3.turbo');
    expect(dtwPreset('small-q8_0')).toBe('small');
    expect(dtwPreset('large')).toBeUndefined();
    expect(dtwPreset('distil-large-v3')).toBeUndefined();
  });
});
