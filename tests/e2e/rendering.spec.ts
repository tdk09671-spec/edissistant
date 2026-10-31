import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { AnimationSpec, RenderProgress, SegmentRenderResult } from '../../src/shared/animation';
import { alphaStats, decodeFrames, verifyAlpha } from '../../src/main/render/probe';
import { close, freshAppData, launch, userDataDir, type Launched } from './helpers';

// Renders through the real app: preload bridge → IPC → render service → sandboxed Chromium engine →
// FFmpeg. Outputs are checked by decoding them again with FFmpeg, not by looking at screenshots.

const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'animation');
const which = (name: string) => {
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  } catch {
    return '';
  }
};
const FFMPEG = which('ffmpeg');
const FFPROBE = which('ffprobe');

test.skip(!FFMPEG || !FFPROBE, 'needs FFmpeg and FFprobe on PATH');

const spec = (name: string): AnimationSpec => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));

async function render(page: Page, s: unknown, options: Record<string, unknown> = {}, jobId = `job-${Math.random().toString(36).slice(2)}`) {
  return page.evaluate(([j, sp, o]) => window.electronAPI!.renderSegment(j as string, sp, o as never), [jobId, s, options] as const);
}

async function ok(page: Page, s: unknown, options: Record<string, unknown> = {}): Promise<SegmentRenderResult> {
  const r = await render(page, s, options);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.result;
}

let app: Launched;
let appData: string;
test.beforeEach(async ({}, testInfo) => {
  appData = freshAppData(testInfo);
  app = await launch(appData);
});
test.afterEach(async () => {
  expect(app.errors).toEqual([]);
  await close(app);
});

test('transparent motion graphics keep real alpha in every alpha format', async () => {
  const lowerThird = spec('transparent-lower-third');
  const prores = await ok(app.page, lowerThird);
  expect(prores.metadata).toMatchObject({ codec: 'prores', width: 640, height: 360, frameRate: '25/1', frames: 50, hasAlpha: true });

  // Frame 25 (1.0 s): everything is in. Corners are clear; the bar is translucent; the text is opaque.
  const report = await verifyAlpha(FFMPEG, FFPROBE, prores.path, [0, 25]);
  expect(report.transparencySurvives).toBe(true);
  const [first, mid] = await decodeFrames(FFMPEG, prores.path, [0, 25], 640, 360, 'prores');
  expect(alphaStats(first).maxAlpha).toBeLessThan(255); // the wipe has barely started
  const a = (x: number, y: number) => mid[(y * 640 + x) * 4 + 3];
  expect(a(5, 5)).toBe(0);
  expect(a(600, 20)).toBe(0);
  expect(Math.abs(a(380, 280) - Math.round(0.85 * 255))).toBeLessThanOrEqual(2);
  expect(alphaStats(mid).opaque).toBeGreaterThan(200);

  for (const format of ['qtrle', 'png-mov', 'vp9-webm'] as const) {
    const r = await ok(app.page, lowerThird, { format });
    const v = await verifyAlpha(FFMPEG, FFPROBE, r.path, [25]);
    expect(v.hasAlphaChannel, format).toBe(true);
    expect(v.transparencySurvives, format).toBe(true);
    expect(v.frames[0].stats.transparent, format).toBeGreaterThan(640 * 360 * 0.5);
  }
});

test('captions appear exactly on their cue frames with true alpha', async () => {
  const r = await ok(app.page, spec('captions'));
  expect(r.metadata).toMatchObject({ frames: 50, hasAlpha: true, pixFmt: expect.stringMatching(/^yuva/) });
  // Cue 1: 0.2–1.0 s → frames 5–24. Gap → 25–29. Cue 2: 1.2–1.8 s → frames 30–44.
  const frames = [0, 4, 5, 12, 24, 25, 29, 30, 44, 45];
  const decoded = await decodeFrames(FFMPEG, r.path, frames, 640, 360, 'prores');
  const visible = Object.fromEntries(frames.map((f, i) => [f, alphaStats(decoded[i]).maxAlpha > 0]));
  expect(visible).toEqual({ 0: false, 4: false, 5: true, 12: true, 24: true, 25: false, 29: false, 30: true, 44: true, 45: false });
  // Clear above the caption line, solid inside the letters.
  const mid = decoded[frames.indexOf(12)];
  expect(alphaStats(mid.subarray(0, 640 * 200 * 4)).maxAlpha).toBe(0);
  expect(alphaStats(mid).opaque).toBeGreaterThan(500);
});

test('full-motion backgrounds are opaque and deterministic', async () => {
  const paper: AnimationSpec = {
    ...spec('transparent-lower-third'),
    id: 'paper',
    exportMode: 'full-motion',
    duration: 0.8,
    seed: 3,
    background: { type: 'paper', color: '#f2ece0', grain: 0.6, fibers: 0.6 },
  };
  const first = await ok(app.page, paper, { format: 'qtrle' });
  const second = await ok(app.page, paper, { format: 'qtrle', force: true });
  expect(second.fromCache).toBe(false);
  const [a] = await decodeFrames(FFMPEG, first.path, [5], 640, 360, 'qtrle');
  const [b] = await decodeFrames(FFMPEG, second.path, [5], 640, 360, 'qtrle');
  expect(Buffer.compare(a, b)).toBe(0); // same spec + seed → identical pixels
  expect(alphaStats(a)).toMatchObject({ transparent: 0, partial: 0 });
  // Average of the top band is close to the paper color.
  let r = 0, g = 0, bl = 0;
  const n = 640 * 100;
  for (let i = 0; i < n; i++) {
    r += a[i * 4];
    g += a[i * 4 + 1];
    bl += a[i * 4 + 2];
  }
  expect(Math.abs(r / n - 0xf2)).toBeLessThan(12);
  expect(Math.abs(g / n - 0xec)).toBeLessThan(12);
  expect(Math.abs(bl / n - 0xe0)).toBeLessThan(12);

  const showcase = await ok(app.page, spec('showcase'), { quality: 'preview' });
  expect(showcase.metadata).toMatchObject({ codec: 'h264', width: 640, height: 360, frames: 75, hasAlpha: false });
});

test('fonts and media: missing assets fail clearly; bundled assets render', async ({}, testInfo) => {
  const text = (family: string, allowFallback?: boolean): AnimationSpec => ({
    ...spec('transparent-lower-third'),
    id: 'fonts',
    duration: 0.2,
    layers: [{ id: 't', type: 'text', transform: { x: 320, y: 180 }, props: { text: 'Brand', typography: { fontFamily: family, fontSize: 60, ...(allowFallback ? { allowFallback } : {}) }, color: '#ffffff' } }],
  });
  const missing = await render(app.page, text('Definitely Not Installed Font'));
  expect(missing).toMatchObject({ ok: false, error: { code: 'FONT_NOT_FOUND', message: expect.stringMatching(/Definitely Not Installed Font/) } });
  const fallback = await ok(app.page, text('Definitely Not Installed Font', true));
  expect(fallback.warnings.join(' ')).toMatch(/not installed; its fallback was used/);

  const dir = testInfo.outputPath('assets');
  fs.mkdirSync(dir, { recursive: true });
  const logo = path.join(dir, 'logo.png');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x3a6df0:s=64x32', '-frames:v', '1', logo]);
  const withImage: AnimationSpec = {
    ...text('sans-serif'),
    assets: { images: [{ id: 'logo', path: logo }] },
    layers: [{ id: 'logo', type: 'image', transform: { x: 320, y: 180 }, props: { asset: 'logo', width: 200, height: 100, fit: 'fill' } }],
  };
  const img = await ok(app.page, withImage);
  const [frame] = await decodeFrames(FFMPEG, img.path, [0], 640, 360, 'prores');
  const center = frame.subarray((180 * 640 + 320) * 4, (180 * 640 + 320) * 4 + 4);
  expect(Math.abs(center[0] - 0x3a)).toBeLessThan(6);
  expect(Math.abs(center[2] - 0xf0)).toBeLessThan(6);
  expect(center[3]).toBe(255);

  fs.rmSync(logo);
  expect(await render(app.page, withImage, { force: true })).toMatchObject({ ok: false, error: { code: 'MEDIA_NOT_FOUND' } });

  const systemFont = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'C:\\Windows\\Fonts\\arialbd.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf'].find((f) => fs.existsSync(f));
  if (systemFont) {
    const bundled = { ...text('Edissistant Test Brand'), assets: { fonts: [{ family: 'Edissistant Test Brand', path: systemFont, weight: 400 }] } };
    expect((await ok(app.page, bundled)).warnings).toEqual([]);
  }
});

test('invalid specs are rejected with paths before anything runs', async () => {
  const bad = await render(app.page, { ...spec('captions'), background: { type: 'solid', color: '#000000' }, fps: 27.5 });
  expect(bad.ok).toBe(false);
  if (bad.ok) return;
  expect(bad.error.code).toBe('INVALID_SPEC');
  expect(bad.error.issues!.map((i) => i.path)).toEqual(expect.arrayContaining(['fps', 'background']));
  const tmp = path.join(userDataDir(appData), 'renders', '.tmp');
  expect(fs.existsSync(tmp) ? fs.readdirSync(tmp) : []).toEqual([]);
});

test('the render sandbox has no Node, no network, no app API and only a message bridge', async () => {
  // Long enough to still be running when the cancel arrives; the test never waits for it to finish.
  const long: AnimationSpec = { ...spec('showcase'), id: 'long', duration: 60, width: 640, height: 360 };
  const pending = render(app.page, long, { quality: 'preview', force: true }, 'sandbox-probe');
  let sandbox: Page | undefined;
  await expect.poll(() => (sandbox = app.app.windows().find((w) => w.url().includes('render-sandbox.html'))) !== undefined, { timeout: 20_000 }).toBe(true);
  const probe = await sandbox!.evaluate(async () => {
    const attempt = async (url: string) => {
      try {
        await fetch(url);
        return 'loaded';
      } catch {
        return 'blocked';
      }
    };
    return {
      require: typeof (globalThis as { require?: unknown }).require,
      process: typeof (globalThis as { process?: unknown }).process,
      electronAPI: typeof (window as { electronAPI?: unknown }).electronAPI,
      bridge: Object.keys((window as unknown as { renderHost: object }).renderHost).sort(),
      web: await attempt('https://example.com/'),
      file: await attempt('file:///etc/hosts'),
    };
  });
  expect(probe).toEqual({ require: 'undefined', process: 'undefined', electronAPI: 'undefined', bridge: ['onCommand', 'send'], web: 'blocked', file: 'blocked' });
  await app.page.evaluate(() => window.electronAPI!.cancelRender('sandbox-probe'));
  expect(await pending).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
});

test('cancelling a render stops it, closes the sandbox and leaves no files', async () => {
  const long: AnimationSpec = { ...spec('showcase'), id: 'cancel-me', duration: 20 };
  const progress: RenderProgress[] = [];
  await app.page.exposeFunction('reportProgress', (p: RenderProgress) => progress.push(p));
  await app.page.evaluate(() => window.electronAPI!.onRenderProgress((p) => (window as unknown as { reportProgress: (p: unknown) => void }).reportProgress(p)));
  const pending = render(app.page, long, {}, 'cancel-job');
  await expect.poll(() => progress.some((p) => (p.frame ?? 0) >= 10), { timeout: 30_000 }).toBe(true);
  expect(await app.page.evaluate(() => window.electronAPI!.cancelRender('cancel-job'))).toBe(true);
  expect(await pending).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
  await expect.poll(() => app.app.windows().filter((w) => w.url().includes('render-sandbox')).length).toBe(0);
  const renders = path.join(userDataDir(appData), 'renders');
  expect(fs.readdirSync(renders).filter((n) => n !== '.tmp')).toEqual([]);
  expect(fs.readdirSync(path.join(renders, '.tmp'))).toEqual([]);
});

test('sequences re-render only edited segments and rebuild the preview', async () => {
  const lt = spec('transparent-lower-third');
  const seg = (id: string, start: number, name: string): AnimationSpec => ({
    ...lt,
    id,
    start,
    duration: 1,
    layers: lt.layers.map((l) => (l.id === 'name' ? { ...l, props: { ...l.props, text: name } } : l)) as AnimationSpec['layers'],
  });
  const sequence = (b: AnimationSpec) => ({ id: 'proj', width: 640, height: 360, fps: 25, duration: 4, segments: [seg('a', 0, 'Alex Rivera'), b] });
  const run = (s: unknown) => app.page.evaluate((sq) => window.electronAPI!.renderSequence(`seq-${Math.random().toString(36).slice(2)}`, sq, { quality: 'preview' }), s);

  const first = await run(sequence(seg('b', 2, 'Sam Lee')));
  if (!first.ok) throw new Error(JSON.stringify(first.error));
  expect(first).toMatchObject({ ok: true, result: { rendered: ['a', 'b'], reused: [] } });
  const edited = await run(sequence(seg('b', 2, 'Sam Lee, Editor')));
  expect(edited).toMatchObject({ ok: true, result: { rendered: ['b'], reused: ['a'], preview: { fromCache: false } } });
  if (!edited.ok) return;
  expect(edited.result.preview!.metadata).toMatchObject({ codec: 'h264', width: 320, height: 180, frames: 100 });
  const unchanged = await run(sequence(seg('b', 2, 'Sam Lee, Editor')));
  expect(unchanged).toMatchObject({ ok: true, result: { rendered: [], preview: { fromCache: true } } });
});

test('performance: 1080p frame throughput (recorded, generous bound)', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const hd: AnimationSpec = { ...spec('showcase'), id: 'perf', width: 1920, height: 1080, duration: 4 };
  const results: Record<string, { seconds: number; fps: number; mb: number }> = {};
  for (const [label, options] of [
    ['prores-422hq 1080p', {}],
    ['prores-4444 1080p (transparent)', { format: 'prores-4444' }],
    ['h264 preview 960x540', { quality: 'preview' }],
  ] as const) {
    const s = label.includes('transparent') ? { ...hd, id: 'perf-alpha', exportMode: 'transparent-motion', background: { type: 'transparent' } } : hd;
    const t0 = Date.now();
    const r = await ok(app.page, s, { ...options, force: true });
    const seconds = (Date.now() - t0) / 1000;
    results[label] = { seconds, fps: Math.round((r.metadata.frames / seconds) * 10) / 10, mb: Math.round((r.metadata.sizeBytes / 1e6) * 10) / 10 };
    expect(r.metadata.frames).toBe(100);
  }
  testInfo.annotations.push({ type: 'performance', description: JSON.stringify(results) });
  fs.writeFileSync(testInfo.outputPath('performance.json'), JSON.stringify(results, null, 2));
  console.log('render performance', JSON.stringify(results));
  // Only a sanity bound: catches pathological regressions, not machine speed.
  for (const r of Object.values(results)) expect(r.fps).toBeGreaterThan(1);
});
