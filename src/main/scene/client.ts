// App side of the render host: starts the host process, sends one job, pulls frames, and always
// cleans up (kills the process, deletes its temporary data folder).
//
// The host gets a scrubbed environment (display and system variables only: no API keys, no app
// variables, no NODE_OPTIONS) and an empty data folder of its own, so it shares nothing with the app.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_LIMITS, encodeMessage, MessageReader, SceneError, type HostMessage, type SceneInfo, type SceneJob, type SceneLimits } from './protocol';

/** Environment variables the host may inherit. Everything else (keys, tokens, app settings) is dropped. */
const ENV_ALLOW = [
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'HOME', 'PATH', 'LANG', 'LC_ALL', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE',
  'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS', 'PATHEXT', 'COMPUTERNAME',
];

export function hostEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_ALLOW) if (env[k] !== undefined) out[k] = env[k]!;
  return out;
}

/** Stops whatever is left of the host's process tree (Chromium helpers exit on their own, but late). */
export function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

export interface SceneHostOptions {
  /** The Electron binary (process.execPath in the app; require('electron') in tests). */
  electron: string;
  /** Compiled host entry (dist/main/scene/host/hostMain.js). */
  hostScript: string;
  limits?: Partial<SceneLimits>;
  /** GPU rasterisation instead of software (faster, may differ between machines). */
  gpu?: boolean;
  /** Test hook: send the host's (dead-end) proxy here instead, to count any attempted traffic. */
  proxy?: string;
  /** Renderer JS heap cap in MB. */
  heapMB?: number;
  /** Tests only: serve pages without the CSP, to check the network layer on its own. */
  testDisableCsp?: boolean;
  /** Extra environment for the host (tests only). */
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export class SceneHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private dataDir = '';
  private readonly reader = new MessageReader(1 << 20);
  private waiters: { match: (m: HostMessage) => boolean; resolve: (v: { msg: HostMessage; bin: Buffer | null }) => void; reject: (e: Error) => void }[] = [];
  private failure: Error | null = null;
  private nextId = 1;
  private stderr = '';
  private exited: Promise<void> = Promise.resolve();
  readonly limits: SceneLimits;
  versions: Record<string, string> = {};
  pid = 0;
  info: SceneInfo | null = null;

  constructor(private readonly options: SceneHostOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  async start(): Promise<void> {
    if (this.options.signal?.aborted) throw new SceneError('CANCELLED', 'Cancelled.');
    this.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edissistant-scene-'));
    const args = [
      this.options.hostScript,
      `--scene-host-data=${this.dataDir}`,
      ...(this.options.proxy ? [`--scene-proxy=${this.options.proxy}`] : []),
      ...(this.options.gpu ? ['--scene-gpu'] : []),
      ...(this.options.heapMB ? [`--scene-heap=${this.options.heapMB}`] : []),
      ...(this.options.testDisableCsp ? ['--scene-test-no-csp'] : []),
    ];
    // Its own process group (POSIX), so closing can stop Chromium's helper processes with it.
    const child = spawn(this.options.electron, args, { env: { ...hostEnvironment(), ...this.options.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    this.child = child;
    this.exited = new Promise((resolve) => child.once('exit', () => resolve()));
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        for (const { header, bin } of this.reader.push(chunk)) this.dispatch(header as HostMessage, bin);
      } catch (e) {
        this.abort(new SceneError('HOST_FAILED', (e as Error).message));
      }
    });
    child.stderr.on('data', (c: Buffer) => {
      this.stderr = (this.stderr + c.toString('utf8')).slice(-8000);
    });
    child.on('error', (e) => this.abort(new SceneError('HOST_FAILED', `Could not start the render host: ${e.message}`)));
    child.on('exit', (code, signal) => this.abort(new SceneError('HOST_FAILED', `The render host exited (${signal ?? code}).`)));
    child.stdin.on('error', () => undefined);
    this.options.signal?.addEventListener('abort', () => void this.close(new SceneError('CANCELLED', 'Cancelled.')), { once: true });
    const ready = await this.wait((m) => m.type === 'ready', this.limits.loadMs);
    if (ready.msg.type === 'ready') {
      this.pid = ready.msg.pid;
      this.versions = ready.msg.versions;
    }
  }

  /** Recent stderr from the host (Chromium logs), for diagnostics. */
  get log(): string {
    return this.stderr;
  }

  get dataFolder(): string {
    return this.dataDir;
  }

  private dispatch(msg: HostMessage, bin: Buffer | null): void {
    if (msg.type === 'error' && (msg.id === undefined || !this.waiters.some((w) => w.match(msg)))) {
      this.abort(new SceneError(msg.code, msg.message));
      return;
    }
    const i = this.waiters.findIndex((w) => w.match(msg));
    if (i < 0) return;
    const [w] = this.waiters.splice(i, 1);
    if (msg.type === 'error') w.reject(new SceneError(msg.code, msg.message));
    else w.resolve({ msg, bin });
  }

  private abort(error: Error): void {
    if (!this.failure) this.failure = error;
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w.reject(this.failure);
  }

  private wait(match: (m: HostMessage) => boolean, ms: number): Promise<{ msg: HostMessage; bin: Buffer | null }> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      // The app's own watchdog: the host must answer in time, or it is killed.
      const timer = setTimeout(() => {
        const err = new SceneError('FRAME_TIMEOUT', 'The render host stopped responding.');
        void this.close(err);
        reject(err);
      }, ms + 5000);
      this.waiters.push({
        match,
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
    });
  }

  private write(header: object, bin?: Uint8Array): void {
    if (this.failure) throw this.failure;
    for (const part of encodeMessage(header, bin)) this.child!.stdin.write(part);
  }

  /** Sends the job's files and opens the scene. */
  async open(job: SceneJob): Promise<SceneInfo> {
    for (const f of job.files) this.write({ type: 'file', path: f.path }, f.data);
    const { files: _files, ...rest } = job;
    this.write({ type: 'open', job: rest, limits: this.limits, token: crypto.randomBytes(12).toString('hex') });
    const r = await this.wait((m) => m.type === 'opened', this.limits.loadMs * 2);
    if (r.msg.type !== 'opened') throw new SceneError('HOST_FAILED', 'Unexpected reply.');
    this.info = r.msg.info;
    return r.msg.info;
  }

  /** One output frame: the average of the given scene times (seconds), as straight RGBA. */
  async capture(times: number[], postCamera = false): Promise<{ rgba: Buffer; ms: number }> {
    const id = this.nextId++;
    this.write({ type: 'capture', id, times, postCamera });
    const r = await this.wait((m) => (m.type === 'frame' || m.type === 'error') && (m as { id?: number }).id === id, this.limits.frameMs);
    if (r.msg.type !== 'frame' || !r.bin) throw new SceneError('HOST_FAILED', 'Unexpected reply.');
    return { rgba: r.bin, ms: r.msg.ms };
  }

  /** Test hook: what the page put in window.__probe, plus every request the host blocked. */
  async probe(): Promise<{ page: unknown; blocked: string[] }> {
    const id = this.nextId++;
    this.write({ type: 'probe', id });
    const r = await this.wait((m) => m.type === 'probe' && m.id === id, 10_000);
    return JSON.parse((r.msg as { value: string }).value);
  }

  /** Stops the host (gracefully, then by force) and deletes its data folder. Safe to call twice. */
  async close(reason?: Error): Promise<void> {
    if (reason) this.abort(reason);
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.stdin.end(Buffer.concat(encodeMessage({ type: 'close' })));
      } catch {
        // already gone
      }
      const killer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await this.exited;
      clearTimeout(killer);
    }
    if (child?.pid) killTree(child.pid);
    this.child = null;
    if (this.dataDir) {
      for (let i = 0; i < 20; i++) {
        try {
          fs.rmSync(this.dataDir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100)); // Windows can hold handles briefly after exit
        }
      }
    }
  }
}
