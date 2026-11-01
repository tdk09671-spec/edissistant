import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SceneHost } from '../../src/main/scene/client';
import { ELECTRON, fixtureJob, hostOptions, Listener, OUT, sleep } from './helpers';

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

/**
 * UDP sockets owned by this user in this network namespace (Linux /proc/net/udp{,6}), except the test
 * listener's own. Chromium makes its helpers non-dumpable, so their per-process fd tables can't be read;
 * the network service (where WebRTC/mDNS sockets would live) shares this namespace, so this is the
 * scope of the evidence.
 */
function userUdpSockets(exceptPort: number): string[] {
  if (process.platform !== 'linux') return [];
  const uid = os.userInfo().uid;
  const out: string[] = [];
  for (const t of ['udp', 'udp6']) {
    if (!fs.existsSync(`/proc/net/${t}`)) continue; // no IPv6 in some containers
    for (const line of fs.readFileSync(`/proc/net/${t}`, 'utf8').split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 8 || Number(f[7]) !== uid) continue;
      const port = parseInt(f[1].split(':')[1], 16);
      if (port !== exceptPort) out.push(`${t}:${port}`);
    }
  }
  return out;
}

/** The executable a process runs (Linux), or '' when it can't be read. */
function exeOf(pid: number): string {
  try {
    return fs.realpathSync(`/proc/${pid}/exe`);
  } catch {
    return '';
  }
}

// Fake desktop handlers (Linux): if the host ever tried to open mailto:/custom schemes with the desktop,
// one of these would run and leave a mark.
const FAKE_BIN = path.join(OUT, 'fake-handlers');
function fakeHandlersPath(): Record<string, string> | undefined {
  if (process.platform !== 'linux') return undefined;
  fs.rmSync(FAKE_BIN, { recursive: true, force: true });
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  for (const b of ['xdg-open', 'xdg-email', 'gio', 'gnome-open', 'kde-open', 'kde-open5', 'exo-open', 'sensible-browser', 'x-www-browser', 'www-browser']) {
    fs.writeFileSync(path.join(FAKE_BIN, b), `#!/bin/sh\necho "${b} $*" >> "${path.join(FAKE_BIN, 'LAUNCHED')}"\n`, { mode: 0o755 });
  }
  return { PATH: `${FAKE_BIN}:${process.env.PATH}` };
}
const launched = () => (fs.existsSync(path.join(FAKE_BIN, 'LAUNCHED')) ? fs.readFileSync(path.join(FAKE_BIN, 'LAUNCHED'), 'utf8') : '');

async function runEscape(opts: Parameters<typeof hostOptions>[0]) {
  const h = new SceneHost(hostOptions(opts));
  let results: Record<string, string> = {};
  let blocked: string[] = [];
  let printFrameMs = 0;
  const procs: { pid: number; name: string; cmd: string; env: string; status: string }[] = [];
  let udp: string[] = [];
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
    const t0 = Date.now();
    await h.capture([0.2]); // calls window.print() inside the frame: must not stall
    printFrameMs = Date.now() - t0;
    h.snapshot();
    udp = userUdpSockets(listener.udpPort); // while the job is still running, after every attempt
    for (const o of h.owned) {
      procs.push({ pid: o.pid, name: o.name, cmd: procText(o.pid, 'cmdline').replace(/\0/g, ' '), env: procText(o.pid, 'environ'), status: procText(o.pid, 'status') });
    }
  } finally {
    await h.close();
  }
  await sleep(300);
  return { h, results, blocked, printFrameMs, procs, udp };
}

const procText = (pid: number, file: string) => {
  try {
    return fs.readFileSync(`/proc/${pid}/${file}`, 'utf8');
  } catch {
    return '';
  }
};

describe('render host isolation', () => {
  it('a hostile scene reaches nothing: no network, files, Node, app API, pop-ups, navigation, workers, printing, WebRTC, WebGPU, camera or external apps', async () => {
    const { h, results, blocked, printFrameMs, procs, udp } = await runEscape({ proxy: `127.0.0.1:${listener.port}`, testFakeMedia: true, env: fakeHandlersPath() });
    report('escape', { results, blocked, printFrameMs, listenerHits: listener.hits, processes: procs.map((p) => ({ pid: p.pid, name: p.name, cmd: p.cmd.slice(0, 120), seccomp: /Seccomp:\s+(\d)/.exec(p.status)?.[1], noNewPrivs: /NoNewPrivs:\s+(\d)/.exec(p.status)?.[1] })), userUdpSockets: udp });

    // Nothing reached the listeners: no HTTP, WebSocket, proxy CONNECT, TCP or UDP (WebRTC/STUN).
    expect(listener.hits).toEqual([]);

    for (const k of ['typeof require', 'typeof process', 'typeof module', 'typeof electron', 'typeof ipcRenderer', 'typeof __dirname', 'electronAPI', 'renderHost', 'chrome.runtime']) {
      expect(results[k], k).toBe('undefined');
    }
    expect(results.eval).toMatch(/^blocked:EvalError/); // CSP: no eval
    expect(results.Function).toMatch(/^blocked:EvalError/);
    expect(results['window.open']).toBe('blocked:null');
    expect(results.alert).toBe('returned'); // no modals (sandboxed document): returns at once, shows nothing
    const mustNotSucceed = [
      'fetch loopback', 'fetch https', 'fetch file', 'fetch windows file', 'fetch app media protocol',
      'xhr', 'image', 'websocket', 'eventsource', 'sendBeacon', 'iframe http', 'iframe file', 'worker', 'serviceWorker', 'geolocation', 'clipboard', 'notification',
      'webrtc', 'webgpu adapter', 'getDisplayMedia', 'external window.open',
    ];
    for (const k of mustNotSucceed) expect(results[k], `${k}: ${results[k]}`).toMatch(/^(blocked|pending)/);
    // Camera and microphone: real (fake) devices exist, so this is the permission being denied, not "no device".
    expect(results.getUserMedia).toBe('blocked:NotAllowedError');
    // WebRTC and WebGPU are gone, also from a fresh about:blank frame.
    expect(results.webrtc).toMatch(/^blocked:TypeError/);
    expect(results['navigator.gpu']).toBe('undefined');
    expect(results['blank frame RTCPeerConnection']).toMatch(/^(undefined|no-window)$/);
    expect(results['blank frame gpu']).toMatch(/^(undefined|no-window)$/);
    // Printing returns at once (no dialog, no stall), in the page, in a frame, and inside a frame render.
    expect(results.print).toBe('returned');
    expect(results['blank frame print']).toMatch(/^(returned|blocked)/);
    expect(printFrameMs).toBeLessThan(5000);
    // These calls "succeed" from the page's point of view but go nowhere (asserted by the listener and the origin).
    expect(results['fetch path traversal']).toMatch(/^(blocked|pending|allowed:404)/); // nothing outside the job's files is served
    expect(results['fetch other job origin']).toMatch(/^(blocked|pending|allowed:404)/); // another job's files are never served
    expect(results['still on origin']).toMatch(/^edissistant-scene:\/\/[0-9a-f]{24}$/);
    expect(results['fetch own file']).toBe('allowed:200'); // its own job files do load
    expect(blocked).toContain('permission:media'); // the permission handler saw and denied it
    // External protocols (mailto:, custom schemes, ms-settings:, tel:) launched nothing: every process the job
    // owned runs the Electron binary (Chromium helpers re-exec /proc/self/exe and are briefly named "exe"),
    // and none of the fake desktop handlers on the host's PATH was ever invoked.
    for (const p of procs) {
      const exe = exeOf(p.pid);
      if (exe) expect(exe, `process ${p.pid} (${p.name}) runs ${exe}`).toBe(fs.realpathSync(ELECTRON));
      else expect(p.name, `process ${p.pid}`).toMatch(/electron|chrome|^exe$/i);
    }
    if (process.platform === 'linux') expect(launched()).toBe('');

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
      // No UDP socket (WebRTC host/STUN, mDNS 5353) owned by this user existed after every attempt.
      expect(udp).toEqual([]);
      // Positive control: the same scan does see this user's sockets (the listener's own UDP socket).
      expect(userUdpSockets(-1)).toContain(`udp:${listener.udpPort}`);
    }
    expect(fs.existsSync(h.dataFolder)).toBe(false);
    expect(fs.existsSync(path.join(os.homedir(), 'Downloads', 'x.txt'))).toBe(false);
  });

  it('GPU mode: WebGPU stays unavailable (page and frames) and nothing gets out', async () => {
    const before = listener.hits.length;
    const { results } = await runEscape({ proxy: `127.0.0.1:${listener.port}`, gpu: true });
    report('escape-gpu', { results });
    expect(listener.hits.slice(before)).toEqual([]);
    expect(results['navigator.gpu']).toBe('undefined');
    expect(results['webgpu adapter']).toMatch(/^(blocked|pending)/);
    expect(results['blank frame gpu']).toMatch(/^(undefined|no-window)$/);
    expect(results.webrtc).toMatch(/^blocked/);
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
    // The other layers still hold without the CSP: printing returns, WebRTC and WebGPU are gone.
    expect(results.print).toBe('returned');
    expect(results.webrtc).toMatch(/^blocked/);
    expect(results['navigator.gpu']).toBe('undefined');
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
