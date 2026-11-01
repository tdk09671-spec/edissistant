import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeFrames } from '../../src/main/render/probe';
import { SceneHost } from '../../src/main/scene/client';
import { decodePng } from '../../src/main/scene/png';
import { frameTime, frameTotal, renderAnimation, renderStills } from '../../src/main/scene/service';
import { fixtureJob, hostOptions, OUT, px, timeCode, TOOLS } from './helpers';

const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');

beforeAll(() => {
  fs.rmSync(path.join(OUT, 'render'), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'render'), { recursive: true });
  if (!TOOLS.ffmpeg || !TOOLS.ffprobe) throw new Error('FFmpeg and FFprobe must be on PATH for the scene suite.');
});

describe('static design → PNG', () => {
  it('renders an HTML/CSS/SVG design locally, with its font loaded from the job files', async () => {
    const { files, info } = await renderStills(hostOptions(), fixtureJob('design/index.html', { kind: 'static' }), [0], path.join(OUT, 'render'), 'design');
    expect(info.fontFamilies).toContain('Brand Display');
    const png = decodePng(fs.readFileSync(files[0]));
    expect([png.width, png.height]).toEqual([1920, 1080]);
    // The half-transparent red probe over the dark background: red mixed into the background.
    const [r, g, b, a] = px(png.data, 1920, 1750, 990);
    expect(a).toBe(255);
    expect(r).toBeGreaterThan(120);
    expect(g).toBeLessThan(20);
    expect(b).toBeLessThan(20);
  });

  it('device scale 2 gives a 3840×2160 still from the same 1920×1080 layout (vector-sharp, not upscaled)', async () => {
    const { files } = await renderStills(hostOptions(), fixtureJob('design/index.html', { kind: 'static' }, { deviceScale: 2 }), [0], path.join(OUT, 'render'), 'design@2x');
    const png = decodePng(fs.readFileSync(files[0]));
    expect([png.width, png.height]).toEqual([3840, 2160]);
    // A 1 CSS-px card border is 2 device px wide; an upscaled 1080p image would blur it instead.
    expect(fs.statSync(files[0]).size).toBeGreaterThan(50_000);
  });
});

describe('deterministic animation (window.SCENE.render(t))', () => {
  it('each frame shows exactly the requested time; the same time always gives the same pixels', async () => {
    const h = new SceneHost(hostOptions());
    try {
      await h.start();
      const info = await h.open(fixtureJob('podcast-like/index.html', { kind: 'scene' }, { query: 'fps=30' }));
      expect(info.duration).toBe(2);
      const times = [0, 0.25, 0.5, 1001 / 30000, 1.9];
      const first = [];
      for (const t of times) {
        const { rgba } = await h.capture([t]);
        expect(timeCode(rgba, 1920)).toBeCloseTo(Math.round(t * 100000) / 100000, 5);
        first.push(sha(rgba));
      }
      // Out of order and repeated: identical bytes.
      for (const i of [3, 0, 4, 1, 2, 2]) expect(sha((await h.capture([times[i]])).rgba)).toBe(first[i]);
    } finally {
      await h.close();
    }
  });

  it('two separate render host processes produce byte-identical frames', async () => {
    const grab = async () => {
      const h = new SceneHost(hostOptions());
      try {
        await h.start();
        await h.open(fixtureJob('podcast-like/index.html', { kind: 'scene' }));
        return [sha((await h.capture([0.6])).rgba), sha((await h.capture([1.3, 1.305, 1.31])).rgba)];
      } finally {
        await h.close();
      }
    };
    expect(await grab()).toEqual(await grab());
  });
});

describe('transparency and motion blur', () => {
  it('transparent capture: empty areas are fully transparent; motion-blurred edges keep their true colour', async () => {
    const h = new SceneHost(hostOptions());
    try {
      await h.start();
      await h.open(fixtureJob('podcast-like/index.html', { kind: 'scene' }, { alpha: true, query: 'alpha=1&nocap=1' }));
      const sharp = (await h.capture([0.5])).rgba;
      expect(px(sharp, 1920, 1000, 200)).toEqual([0, 0, 0, 0]); // no background in alpha mode
      // The bar (white, 40 px, 800 px/s) at t = 0.5 starts at x = 500; without blur its edge is hard.
      expect(px(sharp, 1920, 499, 800)[3]).toBe(0);
      expect(px(sharp, 1920, 500, 800)).toEqual([255, 255, 255, 255]);
      // 4 subframes over a 0.5 shutter at 30 fps: offsets 0, 3.3, 6.7, 10 px → coverage steps 1/4…4/4.
      const blurred = (await h.capture([0, 1, 2, 3].map((k) => 0.5 + (k / 4) * (0.5 / 30)))).rgba;
      const alphas = [501, 505, 508, 515].map((x) => px(blurred, 1920, x, 800)[3]);
      expect(alphas[0]).toBeGreaterThan(55);
      expect(alphas[0]).toBeLessThan(75);
      expect(alphas[1]).toBeGreaterThan(118);
      expect(alphas[1]).toBeLessThan(138);
      expect(alphas[2]).toBeGreaterThan(180);
      expect(alphas[2]).toBeLessThan(200);
      expect(alphas[3]).toBe(255);
      for (const x of [501, 505, 508, 545, 548]) {
        const [r, g, b, a] = px(blurred, 1920, x, 800);
        if (a > 0) expect([r, g, b]).toEqual([255, 255, 255]); // premultiplied averaging: no grey fringe
      }
    } finally {
      await h.close();
    }
  });
});

describe('scene registry adapter (absolute timeline, device scale 2, post-capture camera)', () => {
  it('finds the scenes, renders a scene at its absolute times, and draws canvas particles at device scale', async () => {
    const h = new SceneHost(hostOptions());
    try {
      await h.start();
      const info = await h.open(fixtureJob('saas-like/index.html', { kind: 'registry', sceneId: 'B', camera: 'camAt' }, { deviceScale: 2 }));
      expect(info.scenes).toEqual([{ id: 'A', t0: 0, t1: 2 }, { id: 'B', t0: 2, t1: 4.4 }]);
      expect([info.offset, info.duration, info.outputWidth, info.outputHeight]).toEqual([2, expect.closeTo(2.4, 9), 3840, 2160]);
      const { rgba } = await h.capture([1.0]);
      expect(timeCode(rgba, 3840, 2)).toBeCloseTo(3.0, 5); // scene time 1.0 = page time 3.0
    } finally {
      await h.close();
    }
    const a = new SceneHost(hostOptions());
    try {
      await a.start();
      await a.open(fixtureJob('saas-like/index.html', { kind: 'registry', sceneId: 'A' }, { deviceScale: 2 }));
      const { rgba } = await a.capture([0.5]);
      let lime = 0;
      for (let i = 0; i < rgba.length; i += 4) if (rgba[i] > 200 && rgba[i + 1] > 240 && rgba[i + 2] > 90 && rgba[i + 2] < 130) lime++;
      expect(lime).toBeGreaterThan(300 * 20); // 300 particles, each tens of device pixels
    } finally {
      await a.close();
    }
  });

  it('post-capture camera: a static element moves in even sub-pixel steps during a slow push (no re-snapping)', async () => {
    const h = new SceneHost(hostOptions());
    try {
      await h.start();
      await h.open(fixtureJob('saas-like/index.html', { kind: 'registry', sceneId: 'B', camera: 'camAt' }, { deviceScale: 2 }));
      const fps = 25;
      const row = 180 * 2;
      const centroid = (rgba: Uint8Array) => {
        let m = 0, s = 0;
        for (let x = 1100; x < 1300; x++) { const v = rgba[(row * 3840 + x) * 4]; if (v > 8) { m += v * (x + 0.5); s += v; } }
        return m / s;
      };
      const xs: number[] = [];
      for (let i = 30; i < 45; i++) {
        const t = frameTime(i, fps);
        xs.push(centroid((await h.capture([t], true)).rgba));
        const s = 1 + 0.05 * (t / 2.4);
        expect(Math.abs(xs.at(-1)! - (1920 + (1200 - 1920) * s))).toBeLessThan(0.15);
      }
      const steps = xs.slice(1).map((x, i) => x - xs[i]);
      const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
      expect(mean).toBeCloseTo(-720 * (0.05 / 2.4) / fps, 2);
      for (const s of steps) expect(Math.abs(s - mean)).toBeLessThan(0.05); // even steps
    } finally {
      await h.close();
    }
  });
});

describe('exact frame rates and local encoding', () => {
  for (const fps of [25, 30, 29.97]) {
    it(`${fps} fps: every encoded frame shows scene time i·den/num (PNG-in-MOV, lossless round trip)`, async () => {
      const out = path.join(OUT, 'render', `rate_${fps}.mov`);
      const r = await renderAnimation(hostOptions(), fixtureJob('podcast-like/index.html', { kind: 'scene' }, { query: `fps=${fps}` }), { fps, motionBlur: { samples: 1, shutter: 0.5 } , postCamera: false }, { format: 'png-mov', output: out, ffmpeg: TOOLS.ffmpeg!, ffprobe: TOOLS.ffprobe! });
      expect(r.frames).toBe(frameTotal(2, fps));
      expect(r.metadata.frameRate).toBe(fps === 29.97 ? '30000/1001' : `${fps}/1`);
      expect(r.metadata.frames).toBe(r.frames);
      const check = [0, 1, 2, Math.floor(r.frames / 2), r.frames - 1];
      const frames = await decodeFrames(TOOLS.ffmpeg!, out, check, 1920, 1080);
      check.forEach((i, k) => expect(timeCode(frames[k], 1920)).toBeCloseTo(Math.round(frameTime(i, fps) * 100000) / 100000, 5));
    });
  }

  it('ProRes 4444 and PNG-in-MOV keep alpha: PNG-MOV is bit-exact, ProRes 4444 within its 12-bit YUV precision', async () => {
    const job = fixtureJob('podcast-like/index.html', { kind: 'scene' }, { alpha: true, query: 'alpha=1' });
    const settings = { fps: 30, motionBlur: { samples: 3, shutter: 0.5 }, postCamera: false, frames: { from: 12, to: 18 } };
    const png = await renderAnimation(hostOptions(), job, settings, { format: 'png-mov', output: path.join(OUT, 'render', 'alpha.png.mov'), ffmpeg: TOOLS.ffmpeg!, ffprobe: TOOLS.ffprobe! });
    const pro = await renderAnimation(hostOptions(), job, settings, { format: 'prores-4444', output: path.join(OUT, 'render', 'alpha.prores.mov'), ffmpeg: TOOLS.ffmpeg!, ffprobe: TOOLS.ffprobe! });
    expect(png.metadata).toMatchObject({ codec: 'png', pixFmt: 'rgba', hasAlpha: true, frames: 6 });
    expect(pro.metadata).toMatchObject({ codec: 'prores', hasAlpha: true, frames: 6 });
    expect(pro.metadata.pixFmt).toMatch(/^yuva444p/);
    // Reference: the host's own frame for output frame 3 (scene frame 15).
    const h = new SceneHost(hostOptions());
    let ref: Buffer;
    try {
      await h.start();
      await h.open(job);
      const t = frameTime(15, 30);
      ref = (await h.capture([0, 1, 2].map((k) => t + (k / 3) * (0.5 / 30)))).rgba;
    } finally {
      await h.close();
    }
    const [fromPng] = await decodeFrames(TOOLS.ffmpeg!, png.output, [3], 1920, 1080);
    expect(Buffer.from(fromPng).equals(ref!)).toBe(true);
    const [fromPro] = await decodeFrames(TOOLS.ffmpeg!, pro.output, [3], 1920, 1080);
    let maxA = 0, sumRgb = 0, n = 0;
    for (let i = 0; i < ref!.length; i += 4) {
      maxA = Math.max(maxA, Math.abs(fromPro[i + 3] - ref![i + 3]));
      if (ref![i + 3] === 255) { sumRgb += Math.abs(fromPro[i] - ref![i]) + Math.abs(fromPro[i + 1] - ref![i + 1]) + Math.abs(fromPro[i + 2] - ref![i + 2]); n += 3; }
    }
    expect(maxA).toBeLessThanOrEqual(1); // alpha survives ProRes 4444 (16-bit alpha plane)
    expect(sumRgb / n).toBeLessThan(1.5); // colour through BT.709 YUV 4:4:4 12-bit: within about a level
  });

  it('cache: an unchanged scene is reused, a changed one re-renders', async () => {
    const cacheDir = path.join(OUT, 'render', 'cache');
    fs.rmSync(cacheDir, { recursive: true, force: true });
    const job = fixtureJob('podcast-like/index.html', { kind: 'scene' });
    const settings = { fps: 30, motionBlur: { samples: 1, shutter: 0.5 }, postCamera: false, frames: { from: 0, to: 5 } };
    const target = (n: string) => ({ format: 'png-mov' as const, output: path.join(OUT, 'render', `cache_${n}.mov`), ffmpeg: TOOLS.ffmpeg!, ffprobe: TOOLS.ffprobe! });
    const first = await renderAnimation(hostOptions(), job, settings, target('1'), { cacheDir });
    const again = await renderAnimation(hostOptions(), job, settings, target('2'), { cacheDir });
    expect([first.cached, again.cached]).toEqual([false, true]);
    expect(again.fingerprint).toBe(first.fingerprint);
    const edited = { ...job, files: job.files.map((f) => (f.path.endsWith('.html') ? { ...f, data: Buffer.from(f.data.toString().replace('#fcff7b', '#ff5a3c')) } : f)) };
    const changed = await renderAnimation(hostOptions(), edited, settings, target('3'), { cacheDir });
    expect(changed.cached).toBe(false);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });
});
