// Parity harness: renders a scene the way the podcast skill's render.py does (Playwright Chromium,
// --force-color-profile=srgb --disable-lcd-text, DevTools PNG screenshots, premultiplied subframe
// averaging) and compares it frame by frame with the Edissistant render host.
//
// On synthetic scenes this measures the engine gap between Electron's Chromium and a Playwright
// Chromium build. It is NOT evidence of fidelity with the editor's own workflow: that needs their real
// scenes, kits, fonts and exported renders (docs/PRODUCTION-PHASE0.md, "Reference files").

import * as fs from 'fs';
import * as path from 'path';
import { decodePng } from '../../src/main/scene/png';
import { Accumulator } from '../../src/main/scene/pixels';

export interface ReferenceOptions {
  /** Absolute path of the entry HTML (loaded from file://, like render.py). */
  entry: string;
  query?: string;
  width: number;
  height: number;
  deviceScale: number;
  alpha: boolean;
  /** JS evaluated to draw time t (seconds), e.g. "render(t)" or "window.SCENE.render(t)". */
  draw: (t: number) => string;
  executablePath?: string;
}

/** A reference renderer session (Playwright). Returns straight RGBA per output frame. */
export async function referenceSession(o: ReferenceOptions) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: o.executablePath, args: ['--force-color-profile=srgb', '--disable-lcd-text'] });
  const page = await browser.newPage({ viewport: { width: o.width, height: o.height }, deviceScaleFactor: o.deviceScale });
  await page.goto(`file://${o.entry}${o.query ? `?${o.query}` : ''}`);
  await page.waitForTimeout(400);
  await page.evaluate('document.fonts.ready');
  const cdp = await page.context().newCDPSession(page);
  if (o.alpha) await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const W = o.width * o.deviceScale;
  const H = o.height * o.deviceScale;
  const grab = async (t: number) => {
    await page.evaluate(o.draw(t));
    // render.py's frame path (raw DevTools screenshot) at device scale 1; Playwright's own screenshot at
    // higher device scales, where the raw call returns CSS-pixel size in headless Chromium.
    const png =
      o.deviceScale === 1
        ? Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')
        : await page.screenshot({ type: 'png', omitBackground: o.alpha, scale: 'device' });
    const img = decodePng(png);
    if (img.width !== W || img.height !== H) throw new Error(`Reference captured ${img.width}×${img.height}, expected ${W}×${H}.`);
    return img.data;
  };
  return {
    version: browser.version(),
    async frame(times: number[]): Promise<Uint8Array> {
      if (times.length === 1) return grab(times[0]);
      const acc = new Accumulator(o.width * o.deviceScale, o.height * o.deviceScale);
      for (const t of times) acc.addStraight(await grab(t));
      return acc.toStraight();
    },
    close: () => browser.close(),
  };
}

export interface FrameComparison {
  psnr: number;
  ssim: number;
  alphaMeanDiff: number;
  alphaMaxDiff: number;
  /** Share of pixels where any channel differs by more than 8 levels. */
  over8: number;
}

/** Composites straight RGBA over mid grey (as the podcast skill checks alpha files). */
function overGrey(rgba: Uint8Array, i: number, c: number): number {
  const a = rgba[i + 3] / 255;
  return rgba[i + c] * a + 128 * (1 - a);
}

/** PSNR (RGB over grey), block SSIM on Rec. 709 luma (8×8 blocks), alpha differences. */
export function compareFrames(a: Uint8Array, b: Uint8Array, width: number, height: number): FrameComparison {
  if (a.length !== b.length) throw new Error('Frame sizes differ.');
  let se = 0;
  let over = 0;
  let aSum = 0;
  let aMax = 0;
  const la = new Float32Array(width * height);
  const lb = new Float32Array(width * height);
  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    let big = false;
    const ca = [0, 1, 2].map((c) => overGrey(a, i, c));
    const cb = [0, 1, 2].map((c) => overGrey(b, i, c));
    for (let c = 0; c < 3; c++) {
      const d = ca[c] - cb[c];
      se += d * d;
      if (Math.abs(a[i + c] - b[i + c]) > 8) big = true;
    }
    const da = Math.abs(a[i + 3] - b[i + 3]);
    aSum += da;
    aMax = Math.max(aMax, da);
    if (big || da > 8) over++;
    la[p] = 0.2126 * ca[0] + 0.7152 * ca[1] + 0.0722 * ca[2];
    lb[p] = 0.2126 * cb[0] + 0.7152 * cb[1] + 0.0722 * cb[2];
  }
  const mse = se / (width * height * 3);
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let ssimSum = 0;
  let blocks = 0;
  for (let by = 0; by + 8 <= height; by += 8) {
    for (let bx = 0; bx + 8 <= width; bx += 8) {
      let ma = 0, mb = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const k = (by + y) * width + bx + x; ma += la[k]; mb += lb[k]; }
      ma /= 64; mb /= 64;
      let va = 0, vb = 0, cov = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const k = (by + y) * width + bx + x; const da = la[k] - ma, db = lb[k] - mb; va += da * da; vb += db * db; cov += da * db; }
      va /= 63; vb /= 63; cov /= 63;
      ssimSum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      blocks++;
    }
  }
  return {
    psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse),
    ssim: ssimSum / blocks,
    alphaMeanDiff: aSum / (width * height),
    alphaMaxDiff: aMax,
    over8: over / (width * height),
  };
}

export function writeReport(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, (_k, v) => (v === Infinity ? 'identical' : v), 2));
}
