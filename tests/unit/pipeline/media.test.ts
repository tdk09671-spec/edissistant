import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkMedia, checkMediaPath, probeSource, projectFps } from '../../../src/main/pipeline/media';

const which = (name: string) => {
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  } catch {
    return '';
  }
};
const ffmpeg = which('ffmpeg');
const ffprobe = which('ffprobe');

describe('frame rates from FFprobe', () => {
  it('maps exact rates to the rates a project can use', () => {
    expect(projectFps('30000/1001')).toBe(29.97);
    expect(projectFps('24000/1001')).toBe(23.976);
    expect(projectFps('60000/1001')).toBe(59.94);
    expect(projectFps('25/1')).toBe(25);
    expect(projectFps('50/1')).toBe(50);
    // Variable or odd rates are not silently rounded.
    expect(projectFps('90000/1')).toBeNull();
    expect(projectFps('15000/1001')).toBeNull();
    expect(projectFps('2997/125')).toBe(23.976); // exactly 23.976: used as the NTSC rate, footage converted
    expect(projectFps('0/0')).toBeNull();
    expect(projectFps(undefined)).toBeNull();
  });

  it('accepts only absolute, existing media files', () => {
    expect(() => checkMediaPath('relative.mp4')).toThrow(/absolute/);
    expect(() => checkMediaPath(path.resolve('/etc/hosts'))).toThrow(/supported media/);
    expect(() => checkMediaPath(path.join(os.tmpdir(), 'no-such-file.mp4'))).toThrow(/not found/);
    expect(() => checkMediaPath(42)).toThrow(/absolute/);
  });
});

describe.skipIf(!ffmpeg || !ffprobe)('probing real files', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-media-'));
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30000/1001:d=2', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'ntsc.mp4')]);
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'silent.mp4')]);
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red@0.5:s=320x180:r=25:d=1,format=rgba', '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', path.join(dir, 'alpha.mov')]);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads the source timing and audio', async () => {
    const info = await probeSource(ffprobe, path.join(dir, 'ntsc.mp4'));
    expect(info).toMatchObject({ width: 320, height: 180, frameRate: '30000/1001', fps: 29.97, videoCodec: 'h264', hasAudio: true, audioCodec: 'aac', sampleRate: 48000 });
    expect(info.duration).toBeCloseTo(2, 1);
    expect(await probeSource(ffprobe, path.join(dir, 'silent.mp4'))).toMatchObject({ fps: 25, hasAudio: false });
  });

  it('checks exported files: frames, alpha, audio', async () => {
    const alpha = await checkMedia(ffprobe, path.join(dir, 'alpha.mov'));
    expect(alpha.video).toMatchObject({ codec: 'prores', frames: 25, hasAlpha: true });
    expect(alpha.audio).toBeNull();
    const ntsc = await checkMedia(ffprobe, path.join(dir, 'ntsc.mp4'));
    expect(ntsc.video).toMatchObject({ hasAlpha: false, frameRate: '30000/1001' });
    expect(ntsc.audio).toMatchObject({ codec: 'aac', sampleRate: 48000 });
  });

  it('fails clearly without FFprobe or with a broken file', async () => {
    await expect(probeSource(undefined, path.join(dir, 'ntsc.mp4'))).rejects.toMatchObject({ code: 'FFPROBE_NOT_FOUND' });
    fs.writeFileSync(path.join(dir, 'broken.mp4'), 'not a video');
    await expect(probeSource(ffprobe, path.join(dir, 'broken.mp4'))).rejects.toMatchObject({ code: 'PROBE_FAILED' });
  });
});
