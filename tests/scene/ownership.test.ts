import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SceneHost } from '../../src/main/scene/client';
import { killVerified, listProcesses, type ProcInfo } from '../../src/main/scene/processes';
import { renderAnimation, renderStills } from '../../src/main/scene/service';
import { writeReport } from './parity';
import { fixtureJob, hostOptions, OUT, sleep, timeCode, TOOLS } from './helpers';

// Process ownership and the new IPC on the real host (Windows report: taskkill /T hit a reused PID; stdin
// closed early (B1); stray stdout bytes (B2)). The user's own jobs must survive every kind of job end.

let userJobs: { label: string; child: ChildProcess; id: ProcInfo }[] = [];

function startUserJob(label: string, cmd: string, args: string[]) {
  const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
  return { label, child };
}

function expectUserJobsAlive(when: string) {
  const now = listProcesses();
  for (const j of userJobs) expect(now.some((p) => p.pid === j.id.pid && p.start === j.id.start), `${j.label} must survive ${when}`).toBe(true);
}

function expectOwnedGone(h: SceneHost) {
  expect(h.cleanup).toBeTruthy();
  const now = listProcesses();
  for (const p of h.cleanup!.owned) expect(now.some((q) => q.pid === p.pid && q.start === p.start), `owned ${p.role} ${p.pid} still running`).toBe(false);
  expect(h.cleanup!.skipped).toEqual([]);
}

beforeAll(async () => {
  const starting = [
    startUserJob('a Node job', process.execPath, ['-e', 'setInterval(() => {}, 1000)']),
    startUserJob('an FFmpeg job', TOOLS.ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-t', '900', '-f', 'null', '-']),
  ];
  const py = process.platform === 'win32' ? 'python' : 'python3';
  if (spawnSync(py, ['--version']).status === 0) starting.push(startUserJob('a Python job', py, ['-c', 'import time\nwhile True: time.sleep(1)']));
  await sleep(500);
  const list = listProcesses();
  userJobs = starting.map((j) => ({ ...j, id: list.find((p) => p.pid === j.child.pid)! }));
  for (const j of userJobs) expect(j.id, `${j.label} started`).toBeTruthy();
});

afterAll(async () => {
  for (const j of userJobs) j.child.kill();
  await sleep(200);
});

describe('process ownership: the user’s own processes always survive', () => {
  it('normal completion: the job reports exactly what it owned, all of it stops, user jobs keep running', async () => {
    let host: SceneHost | null = null;
    await renderStills(hostOptions(), fixtureJob('design/index.html', { kind: 'static' }), [0], path.join(OUT, 'ownership'), 'still', (h) => (host = h));
    const h = host as unknown as SceneHost;
    expect(h.cleanup!.owned.filter((p) => p.role === 'host')).toHaveLength(1);
    expect(h.cleanup!.owned.filter((p) => p.role === 'helper').length).toBeGreaterThan(0);
    writeReport(path.join(OUT, 'ownership.json'), { owned: h.cleanup!.owned, exited: h.cleanup!.exited, killed: h.cleanup!.killed, skipped: h.cleanup!.skipped });
    expectOwnedGone(h);
    expectUserJobsAlive('normal completion');
  });

  it('cancellation, timeout and crash: owned processes stop, user jobs keep running', async () => {
    // Cancel mid-encode.
    const controller = new AbortController();
    let cancelled: SceneHost | null = null;
    const outcome = renderAnimation(
      hostOptions({ signal: controller.signal }),
      fixtureJob('podcast-like/index.html', { kind: 'scene' }),
      { fps: 30, motionBlur: { samples: 1, shutter: 0.5 }, postCamera: false },
      { format: 'png-mov', output: path.join(OUT, 'ownership', 'cancel.mov'), ffmpeg: TOOLS.ffmpeg!, ffprobe: TOOLS.ffprobe! },
      { onHost: (h) => (cancelled = h), onProgress: (n) => n === 3 && controller.abort() }
    ).then(
      () => null,
      (e: unknown) => e as { code?: string }
    );
    expect((await outcome)?.code).toBe('CANCELLED');
    expectOwnedGone(cancelled!);
    expectUserJobsAlive('cancellation');

    // Timeout (endless loop in a frame): the renderer is crashed, the host stopped.
    const t = new SceneHost(hostOptions({ limits: { frameMs: 3000 } }));
    await t.start();
    await t.open(fixtureJob('faults/loop.html', { kind: 'scene' }));
    await expect(t.capture([0.6])).rejects.toMatchObject({ code: 'FRAME_TIMEOUT' });
    await t.close();
    expectOwnedGone(t);
    expectUserJobsAlive('a frame timeout');

    // Crash (memory bomb).
    const c = new SceneHost(hostOptions({ limits: { memoryMB: 700, frameMs: 60_000 }, heapMB: 512 }));
    await c.start();
    await c.open(fixtureJob('faults/memory.html', { kind: 'scene' }));
    await expect(c.capture([0.5])).rejects.toBeTruthy();
    await c.close();
    expectOwnedGone(c);
    expectUserJobsAlive('a renderer crash');
  });

  it('PID reuse: a recorded PID that now belongs to a user process is never killed (real kill path, all platforms)', async () => {
    const victim = userJobs[0].id;
    // A stale record: same PID, different start time (as if our helper had exited and the PID been reused).
    const stale = { ...victim, start: /^\d+$/.test(victim.start) ? String(BigInt(victim.start) - 1n) : 'Mon Jan  1 00:00:00 2001' };
    const r = killVerified([stale]);
    expect(r.killed).toEqual([]);
    expect(r.skipped).toEqual([{ pid: victim.pid, reason: 'reused' }]);
    await sleep(300);
    expectUserJobsAlive('a cleanup with a stale record');
  });
});

describe('IPC on the real host', () => {
  it('stray bytes on the host’s stdout/stderr are diagnostics only and cannot break the protocol (B2)', async () => {
    const h = new SceneHost(hostOptions({ testStdoutNoise: true }));
    try {
      await h.start();
      await h.open(fixtureJob('podcast-like/index.html', { kind: 'scene' }));
      expect(timeCode((await h.capture([0.5])).rgba, 1920)).toBeCloseTo(0.5, 5);
      expect(h.log).toContain('noise on stdout');
    } finally {
      await h.close();
    }
  });

  it('nothing else can connect to a running job’s endpoint, with or without the secret', async () => {
    const h = new SceneHost(hostOptions());
    try {
      await h.start();
      await h.open(fixtureJob('podcast-like/index.html', { kind: 'scene' }));
      const attempt = await new Promise<string>((resolve) => {
        const s = net.connect(h.ipc!.endpoint);
        s.on('connect', () => {
          s.destroy();
          resolve('connected');
        });
        s.on('error', (e) => resolve((e as NodeJS.ErrnoException).code ?? e.message));
      });
      expect(attempt).not.toBe('connected');
      expect(timeCode((await h.capture([0.25])).rgba, 1920)).toBeCloseTo(0.25, 5); // the job is unaffected
    } finally {
      await h.close();
    }
    if (process.platform !== 'win32') expect(fs.existsSync(h.ipc!.endpoint)).toBe(false); // socket removed with the job folder
  });
});
