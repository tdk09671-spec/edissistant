import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SceneHost } from '../../src/main/scene/client';
import { descendants, fixtureJob, hostOptions, Listener, OUT, sleep } from './helpers';

const report = (name: string, data: unknown) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `security-${name}.json`), JSON.stringify(data, null, 2));
};

// Sandbox escape attempts against the render host. Nothing here assumes the sandbox works: a hostile
// page tries every way out, and the test counts anything that reaches its listeners, which also act as
// the host's proxy (so any traffic the host or Chromium itself attempts is counted too).

const SECRET = 'sk-ant-api03-SCENE-HOST-MUST-NEVER-SEE-THIS-000000';
let listener: Listener;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  listener = new Listener();
  await listener.start();
  for (const [k, v] of Object.entries({ ANTHROPIC_API_KEY: SECRET, EDISSISTANT_TEST_SECRET: SECRET, CLAUDE_KEY: SECRET, NODE_OPTIONS: '--max-old-space-size=64' })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await listener.stop();
});

const procText = (pid: number, file: string) => {
  try {
    return fs.readFileSync(`/proc/${pid}/${file}`, 'utf8');
  } catch {
    return '';
  }
};

describe('render host isolation', () => {
  it('a hostile scene reaches nothing: no network, files, Node, app API, pop-ups, navigation or workers', async () => {
    const h = new SceneHost(hostOptions({ proxy: `127.0.0.1:${listener.port}` }));
    let results: Record<string, string> = {};
    let blocked: string[] = [];
    const procs: { pid: number; cmd: string; env: string; status: string }[] = [];
    try {
      await h.start();
      await h.open(fixtureJob('escape/index.html', { kind: 'scene' }, { query: `port=${listener.port}&udp=${listener.udpPort}` }));
      await h.capture([0.1]);
      for (let i = 0; i < 40; i++) {
        const p = (await h.probe()) as { page: { results: Record<string, string> } | null; blocked: string[] };
        results = p.page?.results ?? {};
        blocked = p.blocked;
        if (Object.values(results).every((v) => v !== 'pending')) break;
        await sleep(200);
      }
      await h.capture([0.2]); // still alive and drawing after every attempt
      if (process.platform === 'linux') {
        for (const pid of [h.pid, ...descendants(h.pid)]) procs.push({ pid, cmd: procText(pid, 'cmdline').replace(/\0/g, ' '), env: procText(pid, 'environ'), status: procText(pid, 'status') });
      }
    } finally {
      await h.close();
    }
    await sleep(300);

    report('escape', { results, listenerHits: listener.hits, processes: procs.map((p) => ({ pid: p.pid, cmd: p.cmd.slice(0, 120), seccomp: /Seccomp:\s+(\d)/.exec(p.status)?.[1], noNewPrivs: /NoNewPrivs:\s+(\d)/.exec(p.status)?.[1] })) });
    // Nothing reached the listeners: no HTTP, WebSocket, proxy CONNECT, TCP or UDP (WebRTC/STUN).
    expect(listener.hits).toEqual([]);

    for (const k of ['typeof require', 'typeof process', 'typeof module', 'typeof electron', 'typeof ipcRenderer', 'typeof __dirname', 'electronAPI', 'renderHost', 'chrome.runtime']) {
      expect(results[k], k).toBe('undefined');
    }
    expect(results.eval).toMatch(/^blocked:EvalError/); // CSP: no eval
    expect(results.Function).toMatch(/^blocked:EvalError/);
    expect(results['window.open']).toBe('blocked:null');
    expect(results.alert).toBe('returned'); // dialogs disabled: returns at once, shows nothing
    const mustNotSucceed = [
      'fetch loopback', 'fetch https', 'fetch file', 'fetch windows file', 'fetch app media protocol',
      'xhr', 'image', 'websocket', 'eventsource', 'sendBeacon', 'iframe http', 'iframe file', 'worker', 'serviceWorker', 'getUserMedia', 'geolocation', 'clipboard', 'notification',
    ];
    for (const k of mustNotSucceed) expect(results[k], `${k}: ${results[k]}`).toMatch(/^(blocked|pending)/);
    // These calls "succeed" from the page's point of view but go nowhere (asserted by the listener and the origin).
    expect(results['fetch path traversal']).toMatch(/^(blocked|pending|allowed:404)/); // nothing outside the job's files is served
    expect(results['fetch other job origin']).toMatch(/^(blocked|pending|allowed:404)/); // another job's files are never served
    expect(results.webrtc).toMatch(/^(blocked|pending|allowed:gathered:0)/); // no ICE candidates, no UDP
    expect(results['still on origin']).toMatch(/^edissistant-scene:\/\/[0-9a-f]{24}$/);
    expect(results['fetch own file']).toBe('allowed:200'); // its own job files do load
    void blocked;

    if (process.platform === 'linux') {
      expect(procs.length).toBeGreaterThan(1);
      for (const p of procs) {
        expect(p.env, `process ${p.pid} environment`).not.toContain(SECRET);
        expect(p.env).not.toContain('EDISSISTANT_TEST_SECRET');
        expect(p.env).not.toContain('NODE_OPTIONS');
        expect(p.cmd).not.toContain('--no-sandbox');
      }
      const renderers = procs.filter((p) => p.cmd.includes('--type=renderer'));
      expect(renderers.length).toBeGreaterThan(0);
      for (const r of renderers) {
        // Chromium's sandbox is active: seccomp-BPF filter on, no new privileges.
        expect(r.status).toMatch(/Seccomp:\s+2/);
        expect(r.status).toMatch(/NoNewPrivs:\s+1/);
      }
    }
    expect(fs.existsSync(h.dataFolder)).toBe(false);
    expect(fs.existsSync(path.join(os.homedir(), 'Downloads', 'x.txt'))).toBe(false);
  });

  it('with the CSP switched off (test hook), the network and navigation layers still let nothing out', async () => {
    const before = listener.hits.length;
    const h = new SceneHost(hostOptions({ proxy: `127.0.0.1:${listener.port}`, testDisableCsp: true }));
    let results: Record<string, string> = {};
    let blocked: string[] = [];
    try {
      await h.start();
      await h.open(fixtureJob('escape/index.html', { kind: 'scene' }, { query: `port=${listener.port}&udp=${listener.udpPort}` }));
      await h.capture([0.1]);
      for (let i = 0; i < 40; i++) {
        const p = (await h.probe()) as { page: { results: Record<string, string> } | null; blocked: string[] };
        results = p.page?.results ?? {};
        blocked = p.blocked;
        if (Object.values(results).every((v) => v !== 'pending')) break;
        await sleep(200);
      }
    } finally {
      await h.close();
    }
    await sleep(300);
    report('escape-no-csp', { results, blocked, listenerHits: listener.hits.slice(before) });
    expect(listener.hits.slice(before)).toEqual([]);
    // Without the CSP the requests reach the host's filter, which cancels them.
    expect(blocked.filter((u) => u.includes(`127.0.0.1:${listener.port}`)).length).toBeGreaterThan(5);
    for (const k of ['fetch loopback', 'xhr', 'image', 'websocket', 'eventsource', 'iframe http', 'fetch https', 'fetch file']) {
      expect(results[k], `${k}: ${results[k]}`).toMatch(/^(blocked|pending)/);
    }
    expect(results['still on origin']).toMatch(/^edissistant-scene:/);
  });

  it('job files can only be served under their own names (no path tricks), and only to that job', async () => {
    const h = new SceneHost(hostOptions());
    try {
      await h.start();
      await expect(h.open({ ...fixtureJob('podcast-like/index.html', { kind: 'scene' }), files: [{ path: '../outside.html', data: Buffer.from('x') }] })).rejects.toMatchObject({ code: 'INVALID_JOB' });
    } finally {
      await h.close();
    }
  });

  it('the host makes no network connections of its own (component updates, metrics, DNS) during a whole job', async () => {
    const before = listener.hits.length;
    const h = new SceneHost(hostOptions({ proxy: `127.0.0.1:${listener.port}` }));
    try {
      await h.start();
      await h.open(fixtureJob('podcast-like/index.html', { kind: 'scene' }));
      for (const t of [0, 0.5, 1, 1.5]) await h.capture([t]);
      await sleep(1500);
    } finally {
      await h.close();
    }
    expect(listener.hits.slice(before)).toEqual([]);
  });
});
