import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codecArgs, encodeFrames, encoderArgs } from '../../../src/main/render/encoder';
import { alphaStats, decodeFrames, maxAlphaError, outputProblems, probeVideo, verifyAlpha } from '../../../src/main/render/probe';
import { EXPORT_FORMATS, type ExportFormatId } from '../../../src/shared/animation';
import { ffmpeg, ffprobe, hasFfmpeg, makeFrame, pixelAt, tempDir } from './helpers';

describe('encoder arguments', () => {
  it('reads raw RGBA at the exact frame rate', () => {
    const args = encoderArgs({ format: 'prores-4444', width: 1920, height: 1080, fps: 29.97 }, 'out.mov');
    expect(args.join(' ')).toContain('-f rawvideo -pix_fmt rgba -s 1920x1080 -framerate 30000/1001 -i pipe:0');
  });

  it('uses ProRes 4444 with 16-bit alpha and Rec. 709 tags for transparent output', () => {
    const args = codecArgs({ format: 'prores-4444', width: 16, height: 16, fps: 25 }).join(' ');
    expect(args).toContain('-c:v prores_ks -profile:v 4444 -alpha_bits 16');
    expect(args).toContain('format=yuva444p10le');
    expect(args).toContain('out_color_matrix=bt709');
    expect(args).toContain('-colorspace bt709');
  });

  it('keeps lossless RGB formats in RGB and picks the H.264 encoder', () => {
    expect(codecArgs({ format: 'qtrle', width: 16, height: 16, fps: 25 })).toEqual(['-c:v', 'qtrle', '-pix_fmt', 'argb', '-f', 'mov']);
    expect(codecArgs({ format: 'h264-mp4', width: 16, height: 16, fps: 25, h264Encoder: 'h264_nvenc' })).toContain('h264_nvenc');
    expect(codecArgs({ format: 'vp9-webm', width: 16, height: 16, fps: 25 }).join(' ')).toContain('-auto-alt-ref 0');
  });
});

describe.skipIf(!hasFfmpeg)('encoding with real FFmpeg', () => {
  const W = 64;
  const H = 32;
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Alpha ramp across x (0…252), constant color: every alpha level the format can carry.
  const ramp = makeFrame(W, H, (x) => [200, 120, 40, x * 4]);

  async function encode(format: ExportFormatId, frames: Uint8Array[], fps = 25): Promise<string> {
    const out = path.join(dir, `out${EXPORT_FORMATS[format].extension}`);
    await encodeFrames(ffmpeg!, { format, width: W, height: H, fps }, out, frames.length, async (i) => frames[i]);
    return out;
  }

  it.each([
    // ProRes stores alpha at 10–16 bits; 8 → 10 → 8-bit rounding can move a value by one step.
    ['prores-4444', 1],
    ['qtrle', 0],
    ['png-mov', 0],
  ] as const)('%s preserves every alpha value through encode and decode', async (format, tolerance) => {
    const file = await encode(format, [ramp, ramp, ramp]);
    const [decoded] = await decodeFrames(ffmpeg!, file, [1], W, H, EXPORT_FORMATS[format].codec);
    expect(maxAlphaError(ramp, decoded)).toBeLessThanOrEqual(tolerance);
    const meta = await probeVideo(ffprobe!, file);
    expect(meta.hasAlpha).toBe(true);
    expect(meta.codec).toBe(EXPORT_FORMATS[format].codec);
  });

  it('ProRes 4444 keeps color within a few code values (Rec. 709 both ways)', async () => {
    const solid = makeFrame(W, H, () => [200, 120, 40, 255]);
    const file = await encode('prores-4444', [solid]);
    const [decoded] = await decodeFrames(ffmpeg!, file, [0], W, H, 'prores');
    const [r, g, b, a] = pixelAt(decoded, W, 10, 10);
    expect(a).toBe(255);
    expect(Math.abs(r - 200)).toBeLessThanOrEqual(3);
    expect(Math.abs(g - 120)).toBeLessThanOrEqual(3);
    expect(Math.abs(b - 40)).toBeLessThanOrEqual(3);
  });

  it.each(['prores-4444', 'prores-422hq', 'h264-mp4', 'vp9-webm'] as ExportFormatId[])('%s is tagged Rec. 709 in the file itself', async (format) => {
    // Regression: FFmpeg 7+ takes the tags from the filtered frames, so -color_* alone left them unset.
    const file = await encode(format, [ramp, ramp]);
    const tags = execFileSync(ffprobe!, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_space,color_primaries,color_transfer', '-of', 'json', file], { encoding: 'utf8' });
    expect(JSON.parse(tags).streams[0]).toEqual({ color_space: 'bt709', color_primaries: 'bt709', color_transfer: 'bt709' });
  });

  it('VP9 WebM keeps alpha in flat areas (lossy at edges) when decoded with libvpx', async () => {
    const halves = makeFrame(W, H, (x) => (x < W / 2 ? [0, 0, 0, 0] : [255, 255, 255, 255]));
    const file = await encode('vp9-webm', [halves, halves]);
    const report = await verifyAlpha(ffmpeg!, ffprobe!, file, [0]);
    expect(report.hasAlphaChannel).toBe(true);
    const [decoded] = await decodeFrames(ffmpeg!, file, [0], W, H, 'vp9');
    expect(pixelAt(decoded, W, 4, 16)[3]).toBeLessThanOrEqual(2);
    expect(pixelAt(decoded, W, W - 4, 16)[3]).toBeGreaterThanOrEqual(253);
  });

  it('distinguishes real transparency from black', async () => {
    const black = makeFrame(W, H, () => [0, 0, 0, 255]);
    const opaque = await verifyAlpha(ffmpeg!, ffprobe!, await encode('prores-4444', [black]), [0]);
    expect(opaque.hasAlphaChannel).toBe(true);
    expect(opaque.transparencySurvives).toBe(false);
    expect(opaque.frames[0].stats.opaque).toBe(W * H);

    fs.rmSync(path.join(dir, 'out.mov'));
    const clear = await verifyAlpha(ffmpeg!, ffprobe!, await encode('prores-4444', [ramp]), [0]);
    expect(clear.transparencySurvives).toBe(true);
    expect(clear.frames[0].stats.transparent).toBe(H);

    // A format without alpha never reports transparency.
    const h264 = await verifyAlpha(ffmpeg!, ffprobe!, await encode('h264-mp4', [ramp]), [0]);
    expect(h264.hasAlphaChannel).toBe(false);
    expect(h264.transparencySurvives).toBe(false);
  });

  it('writes exact frame counts and NTSC frame rates', async () => {
    const file = await encode('prores-422hq', Array.from({ length: 30 }, () => ramp), 29.97);
    const meta = await probeVideo(ffprobe!, file);
    expect(meta).toMatchObject({ codec: 'prores', width: W, height: H, frameRate: '30000/1001', frames: 30, hasAlpha: false });
    expect(meta.duration).toBeCloseTo(1.001, 2);
    expect(outputProblems(meta, { format: 'prores-422hq', width: W, height: H, fps: 29.97, frames: 30 })).toEqual([]);
    expect(outputProblems(meta, { format: 'prores-4444', width: 32, height: H, fps: 30, frames: 31 })).toEqual([
      'size is 64×32, expected 32×32',
      'frame rate is 30000/1001, expected 30/1',
      'has 30 frames, expected 31',
      'pixel format yuv422p10le has no alpha channel',
    ]);
  });

  it('can be cancelled mid-encode', async () => {
    const controller = new AbortController();
    const out = path.join(dir, 'cancel.mov');
    const run = encodeFrames(ffmpeg!, { format: 'prores-4444', width: W, height: H, fps: 25 }, out, 500, async (i) => {
      if (i === 5) controller.abort();
      return ramp;
    }, { signal: controller.signal });
    await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('rejects frames of the wrong size and reports encoder failures', async () => {
    await expect(
      encodeFrames(ffmpeg!, { format: 'qtrle', width: W, height: H, fps: 25 }, path.join(dir, 'a.mov'), 2, async () => new Uint8Array(10))
    ).rejects.toMatchObject({ code: 'RENDER_FAILED' });
    await expect(
      encodeFrames(ffmpeg!, { format: 'h264-mp4', width: W, height: H, fps: 25, h264Encoder: 'no_such_encoder' }, path.join(dir, 'b.mp4'), 3, async () => ramp)
    ).rejects.toMatchObject({ code: 'ENCODE_FAILED', details: expect.stringMatching(/no_such_encoder|Unknown encoder/i) });
  });

  it('reports ENCODE_FAILED, not a raw EPIPE, when FFmpeg quits while frames are queued', async () => {
    // Regression: NVENC rejected a 6144-px frame after FFmpeg had started reading; the pending 'drain'
    // wait rejected with EPIPE, so the job failed as RENDER_FAILED and FFmpeg's message was lost.
    // An odd width is likewise only rejected once frames arrive; 8 MB frames fill the pipe first.
    const width = 2001;
    const big = new Uint8Array(width * 1000 * 4);
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(
        encodeFrames(ffmpeg!, { format: 'h264-mp4', width, height: 1000, fps: 25, h264Encoder: 'libx264' }, path.join(dir, `odd${attempt}.mp4`), 40, async () => big)
      ).rejects.toMatchObject({ code: 'ENCODE_FAILED' });
    }
  });

  it('alphaStats counts transparent, partial and opaque pixels', () => {
    expect(alphaStats(new Uint8Array([0, 0, 0, 0, 1, 1, 1, 128, 2, 2, 2, 255]))).toEqual({ total: 3, transparent: 1, partial: 1, opaque: 1, minAlpha: 0, maxAlpha: 255 });
  });
});
