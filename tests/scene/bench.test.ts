import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { decodeFrames } from '../../src/main/render/probe';
import { renderAnimation, type AnimationSettings } from '../../src/main/scene/service';
import type { SceneJob } from '../../src/main/scene/protocol';
import { writeReport } from './parity';
import { fixtureJob, hostOptions, OUT, TOOLS } from './helpers';

// Throughput and repeatability on this machine. Numbers are recorded in test-results/scene/benchmark.json;
// the assertions only check that renders complete and repeat exactly.

const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);

interface Run { name: string; job: SceneJob; settings: AnimationSettings; format: 'png-mov' | 'prores-4444' }

const RUNS: Run[] = [
  { name: '1080p30, 1 sample (no blur), PNG-MOV', job: fixtureJob('podcast-like/index.html', { kind: 'scene' }), settings: { fps: 30, motionBlur: { samples: 1, shutter: 0.5 }, postCamera: false }, format: 'png-mov' },
  { name: '1080p30 alpha, 3 subframes (render.py default), ProRes 4444', job: fixtureJob('podcast-like/index.html', { kind: 'scene' }, { alpha: true, query: 'alpha=1' }), settings: { fps: 30, motionBlur: { samples: 3, shutter: 0.5 }, postCamera: false }, format: 'prores-4444' },
  { name: '1080p29.97, 3 subframes, PNG-MOV', job: fixtureJob('podcast-like/index.html', { kind: 'scene' }, { query: 'fps=29.97' }), settings: { fps: 29.97, motionBlur: { samples: 3, shutter: 0.5 }, postCamera: false }, format: 'png-mov' },
  { name: '4K25 (device scale 2), 4 subframes + post-capture camera, 15 frames, PNG-MOV', job: fixtureJob('saas-like/index.html', { kind: 'registry', sceneId: 'B', camera: 'camAt' }, { deviceScale: 2 }), settings: { fps: 25, motionBlur: { samples: 4, shutter: 0.5 }, postCamera: true, frames: { from: 20, to: 35 } }, format: 'png-mov' },
];

describe('benchmarks and repeatability', () => {
  it('renders each configuration twice: records throughput and checks the two renders are identical', { timeout: 30 * 60_000 }, async () => {
    const rows = [];
    for (const r of RUNS) {
      const hashes: string[][] = [];
      const timings: { wallMs: number; frameMs: number }[] = [];
      let frames = 0;
      let size = 0;
      let width = 0;
      for (const pass of [1, 2]) {
        const out = path.join(OUT, 'bench', `${r.name.replace(/[^A-Za-z0-9]+/g, '_')}_${pass}.mov`);
        const t0 = Date.now();
        const res = await renderAnimation(hostOptions(), r.job, r.settings, { format: r.format, output: out, ffmpeg: TOOLS.ffmpeg!, ffprobe: TOOLS.ffprobe! });
        const wallMs = Date.now() - t0;
        frames = res.frames;
        size = res.metadata.sizeBytes;
        width = res.info.outputWidth;
        timings.push({ wallMs, frameMs: res.frameMs.reduce((a, b) => a + b, 0) / res.frameMs.length });
        const pick = [0, Math.floor(frames / 2), frames - 1];
        hashes.push((await decodeFrames(TOOLS.ffmpeg!, out, pick, res.info.outputWidth, res.info.outputHeight)).map(sha));
      }
      expect(hashes[1], `${r.name}: second render identical`).toEqual(hashes[0]);
      rows.push({
        config: r.name,
        frames,
        outputWidth: width,
        fileMB: Math.round((size / 1e6) * 10) / 10,
        msPerFrame: Math.round(timings[1].frameMs),
        renderFps: Math.round((frames / (timings[1].wallMs / 1000)) * 100) / 100,
        wallSeconds: Math.round(timings[1].wallMs / 100) / 10,
        repeatable: hashes[0].join(',') === hashes[1].join(','),
      });
      writeReport(path.join(OUT, 'benchmark.json'), {
        machine: { cpus: os.cpus().length, cpu: os.cpus()[0]?.model, platform: `${os.platform()} ${os.release()}`, memoryGB: Math.round(os.totalmem() / 1e9) },
        rasterisation: 'software (--disable-gpu), the default for repeatable pixels',
        rows,
      });
    }
    expect(fs.existsSync(path.join(OUT, 'benchmark.json'))).toBe(true);
  });
});
