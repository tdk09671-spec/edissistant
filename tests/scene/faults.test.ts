import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { SceneHost } from '../../src/main/scene/client';
import { renderAnimation } from '../../src/main/scene/service';
import { listProcesses } from '../../src/main/scene/processes';
import { fixtureJob, hostOptions, OUT, timeCode, TOOLS } from './helpers';

// Failure handling: every failure ends the job cleanly (no process left behind, no partial file, no
// temporary folder) with a clear code, and the next job works.

/** Every process the job owned (host + helpers, by PID + start time) has stopped; none was skipped. */
function expectOwnedGone(h: SceneHost) {
  expect(h.cleanup, 'cleanup report').toBeTruthy();
  expect(h.cleanup!.owned.some((p) => p.role === 'host')).toBe(true);
  const now = listProcesses();
  for (const p of h.cleanup!.owned) {
    expect(now.some((q) => q.pid === p.pid && q.start === p.start), `owned ${p.role} ${p.pid} (${p.name}) still running`).toBe(false);
  }
  expect(h.cleanup!.skipped).toEqual([]);
}

async function expectFailure(file: string, limits: { loadMs?: number; frameMs?: number; memoryMB?: number }, code: RegExp, captureAt = 0.6, heapMB?: number) {
  const h = new SceneHost(hostOptions({ limits, heapMB }));
  let err: { code?: string; message?: string } | null = null;
  try {
    await h.start();
    await h.open(fixtureJob(`faults/${file}`, { kind: 'scene' }));
    await h.capture([captureAt]);
  } catch (e) {
    err = e as { code?: string; message?: string };
  } finally {
    await h.close();
  }
  expect(err?.code ?? 'none').toMatch(code);
  expectOwnedGone(h);
  expect(fs.existsSync(h.dataFolder)).toBe(false);
  return err!;
}

async function healthyJobStillWorks() {
  const h = new SceneHost(hostOptions());
  try {
    await h.start();
    await h.open(fixtureJob('podcast-like/index.html', { kind: 'scene' }));
    const { rgba } = await h.capture([0.4]);
    expect(timeCode(rgba, 1920)).toBeCloseTo(0.4, 5);
  } finally {
    await h.close();
  }
}

describe('failures end cleanly and the next job works', () => {
  it('an endless loop in a frame times out, the renderer is stopped, nothing is left behind', async () => {
    const err = await expectFailure('loop.html', { frameMs: 3000 }, /FRAME_TIMEOUT/);
    expect(err.message).toMatch(/longer than 3 s|stopped responding/);
    await healthyJobStillWorks();
  });

  it('an endless loop while loading times out', async () => {
    await expectFailure('loadloop.html', { loadMs: 3000 }, /LOAD_TIMEOUT|FRAME_TIMEOUT/);
    await healthyJobStillWorks();
  });

  it('a memory bomb is stopped by the memory limit (or the heap cap) without taking the app down', async () => {
    const err = await expectFailure('memory.html', { memoryMB: 700, frameMs: 60_000 }, /MEMORY_LIMIT|RENDERER_CRASHED|FRAME_TIMEOUT/, 0.5, 512);
    expect(err.message).toBeTruthy();
    await healthyJobStillWorks();
  });

  it("the scene's own exception is reported with its message", async () => {
    const err = await expectFailure('throws.html', {}, /SCENE_ERROR/, 0.5);
    expect(err.message).toContain('Scene bug: missing element #card');
    await healthyJobStillWorks();
  });
});

describe('virtual clock', () => {
  it('timers, intervals, rAF, idle callbacks, Date, performance.now, Math.random and CSS animations follow scene time', async () => {
    const run = async () => {
      const h = new SceneHost(hostOptions());
      try {
        await h.start();
        await h.open(fixtureJob('faults/clock.html', { kind: 'scene' }));
        const out = [];
        for (const t of [0, 0.3, 0.6, 0.3]) {
          await h.capture([t]);
          out.push((await h.probe()).page as { t: number; now: number; date: number; rand: number; log: string[]; anim: number[] });
        }
        return out;
      } finally {
        await h.close();
      }
    };
    const a = await run();
    expect(a.map((p) => p.now)).toEqual([0, 300, 600, 300]);
    expect(a[1].date - a[0].date).toBe(300);
    expect(a[0].log).toEqual(['raf@0', 'idle']); // callbacks run when a frame is drawn, in order
    expect(a[1].log).toEqual(['raf@0', 'idle', 'timeout100@100', 'interval250@250']); // fired at their due time
    expect(a[2].log.filter((l) => l.startsWith('interval')).length).toBe(2);
    expect(a[2].anim[0]).toBe(600); // CSS animation pinned to scene time
    // A second run (new process) sees exactly the same values, random numbers included.
    expect(await run()).toEqual(a);
  });
});

describe('cancellation', () => {
  it('cancelling a render mid-encode stops the host and FFmpeg and leaves no partial file', async () => {
    const out = path.join(OUT, 'faults', 'cancelled.mov');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.rmSync(out, { force: true });
    const controller = new AbortController();
    let seen = 0;
    let host: SceneHost | null = null;
    // The outcome is captured at once, so a rejection is never unhandled while the test waits.
    const outcome = renderAnimation(
      hostOptions({ signal: controller.signal }),
      fixtureJob('podcast-like/index.html', { kind: 'scene' }),
      { fps: 30, motionBlur: { samples: 2, shutter: 0.5 }, postCamera: false },
      { format: 'prores-4444', output: out, ffmpeg: TOOLS.ffmpeg!, ffprobe: TOOLS.ffprobe! },
      {
        onHost: (h) => (host = h),
        onProgress: (done) => {
          seen = done;
          if (done === 5) controller.abort();
        },
      }
    ).then(
      () => null,
      (e: unknown) => e as { code?: string }
    );
    const err = await outcome;
    expect(err?.code).toBe('CANCELLED');
    expect(seen).toBeGreaterThanOrEqual(5);
    expect(seen).toBeLessThan(60);
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.readdirSync(path.dirname(out)).filter((f) => f.includes('partial'))).toEqual([]);
    expectOwnedGone(host!);
    // FFmpeg (a direct child of this test process) is gone too.
    const ffmpegLeft = listProcesses().filter((p) => p.ppid === process.pid && /ffmpeg/i.test(p.name));
    expect(ffmpegLeft).toEqual([]);
    await healthyJobStillWorks();
  });
});
