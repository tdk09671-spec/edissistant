import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { SceneHost } from '../../src/main/scene/client';
import type { SceneAdapter, SceneJob } from '../../src/main/scene/protocol';
import { compareFrames, referenceSession, writeReport, type FrameComparison } from './parity';
import { fixtureJob, hostOptions, OUT, SCENES } from './helpers';

// Edissistant render host vs a render.py-style Playwright reference, on the synthetic scenes.
// Reports the numbers; the thresholds below only catch a broken pipeline (wrong frame, wrong alpha,
// wrong scale). Real thresholds come from the editor's own scenes and exports.

function referenceChromium(): string | undefined {
  if (process.env.PARITY_CHROMIUM) return process.env.PARITY_CHROMIUM;
  return undefined; // Playwright's own browser (npx playwright install chromium)
}

interface Case {
  name: string;
  entry: string;
  adapter: SceneAdapter;
  job: Partial<SceneJob>;
  draw: (t: number) => string;
  samples: number[][];
}

const shutter = (t: number, n: number, fps: number) => Array.from({ length: n }, (_, k) => t + (k / n) * (0.5 / fps));

const CASES: Case[] = [
  { name: 'design (static, opaque)', entry: 'design/index.html', adapter: { kind: 'static' }, job: {}, draw: () => '0', samples: [[0]] },
  { name: 'podcast-like opaque, no blur', entry: 'podcast-like/index.html', adapter: { kind: 'scene' }, job: { query: 'fps=30' }, draw: (t) => `window.SCENE.render(${t})`, samples: [[0.3], [0.6], [1.25]] },
  { name: 'podcast-like opaque, 3 subframes', entry: 'podcast-like/index.html', adapter: { kind: 'scene' }, job: { query: 'fps=30' }, draw: (t) => `window.SCENE.render(${t})`, samples: [shutter(0.5, 3, 30), shutter(1.4, 3, 30)] },
  { name: 'podcast-like alpha (captions + graphics), 3 subframes', entry: 'podcast-like/index.html', adapter: { kind: 'scene' }, job: { alpha: true, query: 'alpha=1&fps=30' }, draw: (t) => `window.SCENE.render(${t})`, samples: [shutter(0.5, 3, 30), shutter(1.4, 3, 30)] },
  { name: 'saas-like scene A, device scale 2 (3840×2160), 4 subframes', entry: 'saas-like/index.html', adapter: { kind: 'registry', sceneId: 'A' }, job: { deviceScale: 2 }, draw: (T) => `window.renderAt(${T})`, samples: [shutter(0.8, 4, 25)] },
];

describe('parity harness (synthetic scenes)', () => {
  it('Edissistant vs a render.py-style Playwright reference: frame-by-frame comparison report', async () => {
    const results: { case: string; times: number[]; metrics: FrameComparison }[] = [];
    let refVersion = '';
    let hostVersions: Record<string, string> = {};
    for (const c of CASES) {
      const job = fixtureJob(c.entry, c.adapter, c.job);
      const W = (job.width) * job.deviceScale;
      const H = (job.height) * job.deviceScale;
      const h = new SceneHost(hostOptions());
      const ref = await referenceSession({ entry: path.join(SCENES, c.entry), query: job.query, width: job.width, height: job.height, deviceScale: job.deviceScale, alpha: job.alpha, draw: c.draw, executablePath: referenceChromium() });
      refVersion = ref.version;
      try {
        await h.start();
        hostVersions = h.versions;
        await h.open(job);
        for (const times of c.samples) {
          const ours = (await h.capture(times)).rgba;
          const theirs = await ref.frame(times);
          results.push({ case: c.name, times, metrics: compareFrames(ours, theirs, W, H) });
        }
        // Negative control: a frame 2 frames later must NOT compare as identical (the comparison can see differences).
        if (c.adapter.kind !== 'static') {
          const later = c.samples[0].map((t) => t + 2 / 30);
          const shifted = compareFrames((await h.capture(later)).rgba, await ref.frame(c.samples[0]), W, H);
          expect(shifted.psnr, `${c.name}: negative control`).toBeLessThan(60);
          results.push({ case: `${c.name} [negative control: +2 frames]`, times: later, metrics: shifted });
        }
        // Sanity: the metric itself reports identical frames as identical.
        const again = (await h.capture(c.samples[0])).rgba;
        const self = compareFrames(again, (await h.capture(c.samples[0])).rgba, W, H);
        expect(self.psnr).toBe(Infinity);
        expect(self.ssim).toBeCloseTo(1, 9);
      } finally {
        await h.close();
        await ref.close();
      }
    }
    writeReport(path.join(OUT, 'parity.json'), { electronChromium: hostVersions.chrome, referenceChromium: refVersion, note: 'Synthetic scenes only; not a fidelity claim for the editor’s workflow.', results });
    for (const r of results.filter((x) => !x.case.includes('negative control'))) {
      // Broken-pipeline guards only (wrong frame or time, missing alpha, wrong scale would fail these by far).
      expect(r.metrics.ssim, r.case).toBeGreaterThan(0.95);
      expect(r.metrics.psnr, r.case).toBeGreaterThan(28);
      expect(r.metrics.alphaMeanDiff, r.case).toBeLessThan(3);
    }
    expect(fs.existsSync(path.join(OUT, 'parity.json'))).toBe(true);
  });
});
