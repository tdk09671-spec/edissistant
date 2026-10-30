import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findTools } from '../../../src/main/render/tools';
import { tempDir } from './helpers';

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function touch(...parts: string[]): string {
  const file = path.join(dir, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
}

describe('findTools', () => {
  const none = { searchDirs: [], env: {}, platform: 'linux' as NodeJS.Platform };

  it('uses a configured ffmpeg file and finds ffprobe next to it', () => {
    const ffmpeg = touch('My Tools', 'ffmpeg');
    const ffprobe = touch('My Tools', 'ffprobe');
    expect(findTools({ ...none, configured: `"${ffmpeg}"` })).toEqual({ ffmpeg, ffprobe });
  });

  it('accepts a configured folder or its bin/ subfolder', () => {
    const ffmpeg = touch('ffmpeg-7', 'bin', 'ffmpeg');
    const ffprobe = touch('ffmpeg-7', 'bin', 'ffprobe');
    expect(findTools({ ...none, configured: path.join(dir, 'ffmpeg-7') })).toEqual({ ffmpeg, ffprobe });
  });

  it('falls back to the env override, the app folder, then PATH (with .exe and ";" on Windows)', () => {
    const viaEnv = touch('env', 'ffmpeg.exe');
    touch('env', 'ffprobe.exe');
    expect(findTools({ ...none, platform: 'win32', env: { EDISSISTANT_FFMPEG_PATH: path.join(dir, 'env') } }).ffmpeg).toBe(viaEnv);
    const appBin = touch('userData', 'bin', 'ffmpeg');
    expect(findTools({ ...none, searchDirs: [path.join(dir, 'userData', 'bin')] }).ffmpeg).toBe(appBin);
    const onPath = touch('path', 'ffprobe.exe');
    expect(findTools({ ...none, platform: 'win32', env: { Path: `C:\\nope;${path.join(dir, 'path')}` } }).ffprobe).toBe(onPath);
  });

  it('reports what is missing', () => {
    expect(findTools({ ...none, configured: path.join(dir, 'missing') })).toEqual({});
  });
});
