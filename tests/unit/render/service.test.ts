import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportRender } from '../../../src/main/render/ipc';
import { decodeFrames, probeVideo } from '../../../src/main/render/probe';
import { encodeFrames } from '../../../src/main/render/encoder';
import { h264WithCpuFallback, RenderService } from '../../../src/main/render/service';
import { RenderError } from '../../../src/shared/animation/errors';
import { hardwareCandidates, probeEncoder, selectH264Encoder } from '../../../src/main/render/gpu';
import type { RenderProgress, SequenceSpec } from '../../../src/shared/animation';
import { ffmpeg, ffprobe, fullSpec, hasFfmpeg, pixelAt, syntheticFrames, tempDir, transparentSpec } from './helpers';

let root: string;
let cacheDir: string;

beforeEach(() => {
  root = tempDir();
  cacheDir = path.join(root, 'renders');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function service(frames = syntheticFrames(), tools: { ffmpeg?: string; ffprobe?: string } = { ffmpeg, ffprobe }) {
  return new RenderService({ cacheDir, findTools: () => tools, createFrameSource: frames, gpu: () => 'off' });
}

const job = (id = 'job', extra: { signal?: AbortSignal; onProgress?: (p: RenderProgress) => void } = {}) => ({ jobId: id, ...extra });

function tmpLeftovers(): string[] {
  const tmp = path.join(cacheDir, '.tmp');
  return fs.existsSync(tmp) ? fs.readdirSync(tmp) : [];
}

describe('RenderService errors (no FFmpeg needed)', () => {
  it('rejects invalid specs with the list of issues', async () => {
    const s = service();
    await expect(s.renderSegment({ specVersion: 1 }, {}, job())).rejects.toMatchObject({
      code: 'INVALID_SPEC',
      issues: expect.arrayContaining([expect.objectContaining({ path: 'id', message: 'is required' })]),
    });
  });

  it('reports missing FFmpeg or FFprobe', async () => {
    await expect(service(syntheticFrames(), {}).renderSegment(transparentSpec('a', 0), {}, job())).rejects.toMatchObject({ code: 'FFMPEG_NOT_FOUND' });
    await expect(service(syntheticFrames(), { ffmpeg: '/usr/bin/ffmpeg' }).renderSegment(transparentSpec('a', 0), {}, job())).rejects.toMatchObject({
      code: 'FFMPEG_NOT_FOUND',
      message: expect.stringMatching(/FFprobe/),
    });
  });
});

describe.skipIf(!hasFfmpeg)('RenderService with real FFmpeg', () => {
  it('renders, validates and caches a transparent segment', async () => {
    const frames = syntheticFrames();
    const s = service(frames);
    const events: RenderProgress[] = [];
    const r = await s.renderSegment(transparentSpec('lower-third', 0), {}, job('j1', { onProgress: (p) => events.push(p) }));
    expect(r).toMatchObject({ segmentId: 'lower-third', format: 'prores-4444', fromCache: false, encoder: 'prores_ks' });
    expect(r.metadata).toMatchObject({ codec: 'prores', width: 160, height: 90, frameRate: '25/1', frames: 25, hasAlpha: true });
    expect(s.cache.contains(r.path)).toBe(true);
    expect(frames.frames).toBe(25);
    expect(frames.closed).toBe(1);

    const stages = [...new Set(events.map((e) => e.stage))];
    expect(stages).toEqual(['queued', 'validating', 'loading', 'rendering', 'validating-output', 'done']);
    expect(events.every((e, i) => i === 0 || e.progress >= events[i - 1].progress)).toBe(true);
    expect(events.find((e) => e.stage === 'rendering' && e.frame === 25)?.totalFrames).toBe(25);
    expect(tmpLeftovers()).toEqual([]);
  });

  it('reuses unchanged renders, even after moving a segment or renaming it', async () => {
    const frames = syntheticFrames();
    const s = service(frames);
    const first = await s.renderSegment(transparentSpec('a', 0), {}, job('1'));
    const moved = await s.renderSegment(transparentSpec('a', 7.5), {}, job('2'));
    const renamed = await s.renderSegment(transparentSpec('b', 3), {}, job('3'));
    expect(moved).toMatchObject({ fromCache: true, key: first.key, path: first.path });
    expect(renamed.fromCache).toBe(true);
    expect(frames.opened).toBe(1);

    const changed = await s.renderSegment(transparentSpec('a', 0, '#ff00ff'), {}, job('4'));
    expect(changed.fromCache).toBe(false);
    expect(changed.key).not.toBe(first.key);
    const forced = await s.renderSegment(transparentSpec('a', 0), { force: true }, job('5'));
    expect(forced.fromCache).toBe(false);
    expect(frames.opened).toBe(3);
  });

  it('renders cheaper previews at half resolution with their own cache entry', async () => {
    const s = service();
    const final = await s.renderSegment(fullSpec('f', 0), {}, job('1'));
    const preview = await s.renderSegment(fullSpec('f', 0), { quality: 'preview' }, job('2'));
    expect(final.metadata).toMatchObject({ codec: 'prores', width: 160, height: 90 });
    expect(preview).toMatchObject({ format: 'h264-mp4', fromCache: false, encoder: 'libx264' });
    expect(preview.metadata).toMatchObject({ width: 80, height: 46 });
  });

  it('refuses non-alpha formats for transparent modes and checks the scale', async () => {
    const s = service();
    await expect(s.renderSegment(transparentSpec('a', 0), { format: 'h264-mp4' }, job('1'))).rejects.toMatchObject({ code: 'INVALID_REQUEST', message: expect.stringMatching(/no alpha/) });
    await expect(s.renderSegment(transparentSpec('a', 0), { scale: 2 }, job('2'))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const webm = await s.renderSegment(transparentSpec('a', 0), { format: 'vp9-webm' }, job('3'));
    expect(webm.metadata).toMatchObject({ codec: 'vp9', hasAlpha: true });
  });

  it('reports missing fonts and media before rendering', async () => {
    const s = service();
    const withFont = transparentSpec('a', 0, '#fff', 1, { assets: { fonts: [{ family: 'Brand', path: path.join(root, 'missing.ttf') }] } });
    await expect(s.renderSegment(withFont, {}, job('1'))).rejects.toMatchObject({ code: 'FONT_NOT_FOUND' });
    const withImage = transparentSpec('a', 0, '#fff', 1, { assets: { images: [{ id: 'logo', path: path.join(root, 'logo.png') }] } });
    await expect(s.renderSegment(withImage, {}, job('2'))).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
  });

  it('puts asset content in the cache key', async () => {
    const font = path.join(root, 'brand.ttf');
    fs.writeFileSync(font, 'font v1');
    const s = service();
    const spec = transparentSpec('a', 0, '#fff', 1, { assets: { fonts: [{ family: 'Brand', path: font }] } });
    const first = await s.renderSegment(spec, {}, job('1'));
    fs.writeFileSync(font, 'font v2');
    const second = await s.renderSegment(spec, {}, job('2'));
    expect(second.fromCache).toBe(false);
    expect(second.key).not.toBe(first.key);
  });

  it('cleans up after an interrupted render and caches nothing', async () => {
    const frames = syntheticFrames({ failAt: 10 });
    const s = service(frames);
    await expect(s.renderSegment(transparentSpec('a', 0), {}, job('1'))).rejects.toThrow(/synthetic failure at frame 10/);
    expect(frames.closed).toBe(1);
    expect(tmpLeftovers()).toEqual([]);
    expect(s.cache.entries()).toEqual([]);
  });

  it('cancels a running render, then runs the next one', async () => {
    const frames = syntheticFrames({ delayMs: 20 });
    const s = service(frames);
    const controller = new AbortController();
    const running = s.renderSegment(transparentSpec('a', 0, '#fff', 4), {}, job('1', {
      signal: controller.signal,
      onProgress: (p) => (p.frame ?? 0) >= 10 && controller.abort(),
    }));
    const queuedController = new AbortController();
    const queued = s.renderSegment(transparentSpec('b', 0, '#f00'), {}, job('2', { signal: queuedController.signal }));
    const next = s.renderSegment(transparentSpec('c', 0, '#00f'), {}, job('3'));
    queuedController.abort();
    await expect(queued).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(frames.frames).toBeLessThan(20);
    await expect(next).resolves.toMatchObject({ segmentId: 'c', fromCache: false });
    expect(tmpLeftovers()).toEqual([]);
    expect(s.cache.entries().map((e) => e.manifest.segmentId)).toEqual(['c']);
  });

  it('removes scratch folders left by a crash on startup', () => {
    const old = path.join(cacheDir, '.tmp', 'crashed');
    const recent = path.join(cacheDir, '.tmp', 'running');
    fs.mkdirSync(old, { recursive: true });
    fs.mkdirSync(recent, { recursive: true });
    fs.writeFileSync(path.join(old, 'render.mov'), 'partial');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
    service();
    expect(tmpLeftovers()).toEqual(['running']);
  });

  it('exports a cached render without overwriting and refuses anything else', async () => {
    const s = service();
    const r = await s.renderSegment(transparentSpec('a', 0), {}, job('1'));
    const out = path.join(root, 'exports');
    fs.mkdirSync(out);
    expect(exportRender(s, r.path, out, 'Lower third')).toBe(path.join(out, 'Lower third.mov'));
    expect(exportRender(s, r.path, out, 'Lower third.mov')).toBe(path.join(out, 'Lower third (2).mov'));
    expect(() => exportRender(s, path.join(root, 'secrets.txt'), out, 'x')).toThrow(/Only rendered files/);
    expect(() => exportRender(s, r.path, out, '..\\evil')).toThrow(/not allowed/);
    expect(() => exportRender(s, r.path, path.join(root, 'nope'), 'x')).toThrow(/existing export folder/);
  });

  it('only uses a hardware H.264 encoder after a real test encode succeeds', async () => {
    expect(await selectH264Encoder(ffmpeg!, 'off')).toBe('libx264');
    expect(await probeEncoder(ffmpeg!, 'libx264')).toBe(true);
    expect(await probeEncoder(ffmpeg!, 'no_such_encoder')).toBe(false);
    // Whatever this machine has: the choice is the first candidate whose real test encode succeeds.
    const platform = process.platform;
    let expected = 'libx264';
    for (const candidate of hardwareCandidates(platform)) {
      if (await probeEncoder(ffmpeg!, candidate)) {
        expected = candidate;
        break;
      }
    }
    expect(await selectH264Encoder(ffmpeg!, 'auto', platform)).toBe(expected);
  });

  it('re-encodes on the CPU when a hardware H.264 encoder fails mid-render', async () => {
    // Regression: NVENC passed its probe but failed on a 6144-px-wide render (limit 4096), failing the job.
    const out = path.join(root, 'fallback.mp4');
    const frame = new Uint8Array(64 * 32 * 4).fill(200);
    const tried: string[] = [];
    const run = (h264Encoder: string) => {
      tried.push(h264Encoder);
      return encodeFrames(ffmpeg!, { format: 'h264-mp4', width: 64, height: 32, fps: 25, h264Encoder }, out, 5, async () => frame);
    };
    const used = await h264WithCpuFallback('no_such_encoder', undefined, run);
    expect(tried).toEqual(['no_such_encoder', 'libx264']);
    expect(used.encoder).toBe('libx264');
    expect(used.warnings[0]).toMatch(/no_such_encoder could not encode this render/);
    expect(await probeVideo(ffprobe!, out)).toMatchObject({ codec: 'h264', frames: 5 });
  });

  it('does not retry on the CPU after a cancel, a non-encoder error or a libx264 failure', async () => {
    const fail = (error: Error) => async () => {
      throw error;
    };
    const controller = new AbortController();
    controller.abort();
    const encodeFailed = new RenderError('ENCODE_FAILED', 'x');
    await expect(h264WithCpuFallback('h264_nvenc', controller.signal, fail(encodeFailed))).rejects.toBe(encodeFailed);
    const sandbox = new RenderError('SANDBOX_FAILED', 'x');
    await expect(h264WithCpuFallback('h264_nvenc', undefined, fail(sandbox))).rejects.toBe(sandbox);
    await expect(h264WithCpuFallback('libx264', undefined, fail(encodeFailed))).rejects.toBe(encodeFailed);
  });
});

describe.skipIf(!hasFfmpeg)('sequences: selective regeneration and preview composition', () => {
  // 4 s at 25 fps. A: full-motion red, frames 10–39. B: transparent green on the right half, frames 50–74.
  const seq = (b = transparentSpec('b', 2, '#00ff00'), a = fullSpec('a', 0.4, '#ff0000', 1.2)): SequenceSpec => ({
    id: 'project',
    width: 160,
    height: 90,
    fps: 25,
    duration: 4,
    segments: [a, b],
  });

  it('composes segments at their exact frames over black', async () => {
    const s = service();
    const r = await s.renderSequence(seq(), {}, job('1'));
    expect(r.rendered).toEqual(['a', 'b']);
    expect(r.preview!.metadata).toMatchObject({ codec: 'h264', width: 160, height: 90, frames: 100, frameRate: '25/1' });

    const at = [9, 10, 39, 40, 49, 50, 74, 75];
    const frames = await decodeFrames(ffmpeg!, r.preview!.path, at, 160, 90, 'h264');
    const px = (i: number, x: number) => pixelAt(frames[i], 160, x, 45).slice(0, 3);
    const isBlack = (p: number[]) => p.every((v) => v < 30);
    const isRed = (p: number[]) => p[0] > 200 && p[1] < 60 && p[2] < 60;
    const isGreen = (p: number[]) => p[1] > 200 && p[0] < 60 && p[2] < 60;
    expect(isBlack(px(0, 40))).toBe(true); // frame 9: before A
    expect(isRed(px(1, 40))).toBe(true); // frame 10: A's first frame
    expect(isRed(px(2, 40))).toBe(true); // frame 39: A's last frame
    expect(isBlack(px(3, 40))).toBe(true); // frame 40: after A
    expect(isBlack(px(4, 120))).toBe(true); // frame 49: before B
    expect(isGreen(px(5, 120))).toBe(true); // frame 50: B, opaque half
    expect(isBlack(px(5, 40))).toBe(true); // frame 50: B's transparent half shows the base
    expect(isGreen(px(6, 120))).toBe(true); // frame 74: B's last frame
    expect(isBlack(px(7, 120))).toBe(true); // frame 75: after B
  });

  it('re-renders only changed segments and reuses everything else', async () => {
    const frames = syntheticFrames();
    const s = service(frames);
    await s.renderSequence(seq(), {}, job('1'));
    expect(frames.opened).toBe(2);

    // Edit B only.
    const edited = await s.renderSequence(seq(transparentSpec('b', 2, '#0000ff')), {}, job('2'));
    expect(edited).toMatchObject({ rendered: ['b'], reused: ['a'] });
    expect(edited.preview!.fromCache).toBe(false);
    expect(frames.opened).toBe(3);

    // Move B: no segment renders, the preview is rebuilt.
    const moved = await s.renderSequence(seq(transparentSpec('b', 2.4, '#0000ff')), {}, job('3'));
    expect(moved).toMatchObject({ rendered: [], reused: ['a', 'b'] });
    expect(moved.preview!.fromCache).toBe(false);

    // Nothing changed: even the preview is reused.
    const again = await s.renderSequence(seq(transparentSpec('b', 2.4, '#0000ff')), {}, job('4'));
    expect(again.preview!.fromCache).toBe(true);
    expect(frames.opened).toBe(3);
  });

  it('lays graphics over source footage and keeps its audio', async () => {
    const s = service();
    const base = path.resolve(__dirname, '../../fixtures/sample.mp4');
    const r = await s.renderSequence({ ...seq(), duration: 3, segments: [transparentSpec('b', 1, '#00ff00')] }, { baseVideo: base }, job('1'));
    const meta = await probeVideo(ffprobe!, r.preview!.path);
    expect(meta).toMatchObject({ width: 160, height: 90, frames: 75 });
    const [before, during] = await decodeFrames(ffmpeg!, r.preview!.path, [10, 40], 160, 90, 'h264');
    // The test pattern shows through where the graphic is transparent.
    expect(pixelAt(before, 160, 120, 45).slice(0, 3).some((v) => v > 40)).toBe(true);
    expect(pixelAt(during, 160, 120, 45)[1]).toBeGreaterThan(200);
    const { stdout } = await import('child_process').then((cp) => ({
      stdout: cp.execFileSync(ffprobe!, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', r.preview!.path], { encoding: 'utf8' }),
    }));
    expect(stdout).toContain('audio');
    await expect(s.renderSequence(seq(), { baseVideo: path.join(root, 'none.mp4') }, job('2'))).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
  });

  it('can skip composition and validates the sequence', async () => {
    const s = service();
    expect((await s.renderSequence(seq(), { compose: false }, job('1'))).preview).toBeUndefined();
    await expect(s.renderSequence({ ...seq(), fps: 30 }, {}, job('2'))).rejects.toMatchObject({ code: 'INVALID_SPEC' });
  });
});
