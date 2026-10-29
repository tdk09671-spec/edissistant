import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeReference, colorStats, ingestLink, parseSceneTimes, representativeTimes } from '../../../src/main/planning/referenceAnalysis';
import { buildStyleProfile } from '../../../src/shared/planning';
import { NOW, preset } from './helpers';

const which = (n: string) => {
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', [n], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  } catch {
    return '';
  }
};
const ffmpeg = which('ffmpeg');
const ffprobe = which('ffprobe');

describe('reference analysis helpers', () => {
  it('parses scene times and picks representative frames from the longest shots', () => {
    expect(parseSceneTimes('[Parsed_showinfo_1] n:0 pts:2048 pts_time:2.0 …\n n:1 pts_time:4.52 x')).toEqual([2, 4.52]);
    expect(representativeTimes(10, [2, 7], 2)).toEqual([4.5, 8.5]);
    expect(representativeTimes(9, [], 3)).toEqual([2.25, 4.5, 6.75]);
  });

  it('computes colour statistics', () => {
    const navy = Buffer.from(Array.from({ length: 300 }, (_, i) => [11, 15, 26][i % 3]));
    const gold = Buffer.from(Array.from({ length: 100 * 3 }, (_, i) => [212, 160, 23][i % 3]));
    const s = colorStats(Buffer.concat([navy, gold]));
    expect(s.dominantColors[0]).toBe('#0b0f1a');
    expect(s.dominantColors).toContain('#d4a017');
    expect(s.meanLuminance).toBeLessThan(0.35);
    expect(colorStats(Buffer.alloc(0)).dominantColors).toEqual([]);
  });

  it('treats links as metadata only: no frames, a clear way forward, no fetching', () => {
    const link = ingestLink({ kind: 'link', url: 'https://www.youtube.com/watch?v=abc', approvedBy: 'editor' });
    expect(link).toMatchObject({ framesAvailable: false, url: 'https://www.youtube.com/watch?v=abc' });
    expect(link.howToAnalyse).toMatch(/gives no video frames.*rights to/);
    expect(() => ingestLink({ kind: 'link', url: 'file:///etc/passwd', approvedBy: 'x' })).toThrow(/http/);
    expect(() => ingestLink({ kind: 'link', url: 'not a url', approvedBy: 'x' })).toThrow(/valid link/);
  });
});

describe.skipIf(!ffmpeg || !ffprobe)('analyzeReference (real FFmpeg, synthetic video)', () => {
  let dir: string;
  let video: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-analysis-'));
    video = path.join(dir, 'reference.mp4');
    // 4 shots: navy, gold, navy, gold — 1.5 s each, 25 fps. A synthetic stand-in for a dark, gold-accented edit.
    const shots = ['0x0b0f1a', '0xd4a017', '0x0b0f1a', '0xd4a017'];
    const inputs = shots.flatMap((c) => ['-f', 'lavfi', '-i', `color=c=${c}:s=320x180:r=25:d=1.5`]);
    const concat = shots.map((_, i) => `[${i}:v]`).join('') + `concat=n=${shots.length}:v=1:a=0[v]`;
    execFileSync(ffmpeg, ['-v', 'error', '-y', ...inputs, '-filter_complex', concat, '-map', '[v]', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-g', '25', video]);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('measures pacing, colours and frames, then reuses the cached analysis', async () => {
    const cacheDir = path.join(dir, 'cache');
    const first = await analyzeReference({ kind: 'local-file', path: video, role: 'reference-video' }, { ffmpeg, ffprobe, cacheDir, frames: 4 });
    expect(first.fromCache).toBe(false);
    const a = first.analysis;
    expect(a).toMatchObject({ width: 320, height: 180, fps: 25, kind: 'reference-video' });
    // MP4 muxing can round the container duration up by a frame or two.
    expect(Math.abs(a.durationSeconds - 6)).toBeLessThan(0.15);
    expect(a.cuts).toHaveLength(3);
    // Scene detection lands within a couple of frames of each cut.
    a.cuts.forEach((c, i) => expect(Math.abs(c - 1.5 * (i + 1))).toBeLessThan(0.1));
    expect(a.averageShotSeconds).toBeCloseTo(1.5, 1);
    expect(a.frames).toHaveLength(4);
    for (const f of a.frames) expect(fs.existsSync(f.path)).toBe(true);
    const near = (hex: string, target: [number, number, number]) => [1, 3, 5].every((i, k) => Math.abs(parseInt(hex.slice(i, i + 2), 16) - target[k]) < 12);
    expect(a.dominantColors.some((c) => near(c, [11, 15, 26]))).toBe(true);
    expect(a.dominantColors.some((c) => near(c, [212, 160, 23]))).toBe(true);

    const second = await analyzeReference({ kind: 'local-file', path: video, role: 'previous-edit' }, { ffmpeg, ffprobe, cacheDir, frames: 4 });
    expect(second.fromCache).toBe(true);
    expect(second.analysis.kind).toBe('previous-edit');
    expect(second.analysis.cuts).toEqual(a.cuts);

    // Feeding it into a profile: fast cutting → energetic, gold shows up as an accent.
    const profile = buildStyleProfile({ preset: { ...preset('lumen'), creativeBrief: '', brandColors: [] }, references: [a] }, NOW);
    expect(profile.motion.value.energy).toBe('energetic');
    expect(profile.motion.value.averageShotSeconds).toBeCloseTo(a.averageShotSeconds, 1);
    expect(profile.provenance).toContainEqual(expect.objectContaining({ kind: 'reference-video', sourceId: a.id }));
  });

  it('re-analyses when the file changes and rejects missing files', async () => {
    const cacheDir = path.join(dir, 'cache2');
    await analyzeReference({ kind: 'local-file', path: video, role: 'reference-video' }, { ffmpeg, ffprobe, cacheDir, frames: 2 });
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(video, later, later);
    const again = await analyzeReference({ kind: 'local-file', path: video, role: 'reference-video' }, { ffmpeg, ffprobe, cacheDir, frames: 2 });
    expect(again.fromCache).toBe(false);
    await expect(analyzeReference({ kind: 'local-file', path: path.join(dir, 'nope.mp4'), role: 'reference-video' }, { ffmpeg, ffprobe, cacheDir })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
