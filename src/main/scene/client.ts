// App side of the render host: starts the host process, talks to it over a dedicated authenticated
// socket (see ipc.ts), pulls frames, and always cleans up safely.
//
// The host gets a scrubbed environment (display and system variables only: no API keys, no app
// variables, no NODE_OPTIONS) and an empty job folder of its own, so it shares nothing with the app.
// stdin is not used; stdout and stderr are collected as diagnostics only, never parsed as protocol.
//
// Process ownership (see processes.ts): the host and its helpers are recorded by PID + start time while
// the job runs; the host is stopped through its ChildProcess handle; leftovers are killed only after their
// identity is re-confirmed. No PID-only, tree or process-group kills.

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import type * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { IpcChannel, listenForHost, newIpcConfig, writeIpcFile, type IpcConfig } from './ipc';
import { killVerified, listProcesses, ownedTree, stillRunning, type CleanupReport, type OwnedProcess } from './processes';
import { DEFAULT_LIMITS, SceneError, type HostMessage, type SceneInfo, type SceneJob, type SceneLimits } from './protocol';
import { JOB_DIR_PREFIX, writeOwnerMarker } from './recovery';

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

/** Largest frame accepted from the host (8192 × 8192 RGBA). */
const MAX_FRAME = 8192 * 8192 * 4;

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
  /** Tests only: serve pages without the CSP, to check the other layers on their own. */
  testDisableCsp?: boolean;
  /** Tests only: fake camera/microphone devices, so permission denial (not "no device") is what's tested. */
  testFakeMedia?: boolean;
  /** Tests only: the host writes junk to stdout/stderr before connecting (B2 regression). */
  testStdoutNoise?: boolean;
  /** Extra environment for the host (tests only). */
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export class SceneHost {
  private child: ChildProcess | null = null;
  private dataDir = '';
  private channel: IpcChannel | null = null;
  private server: net.Server | null = null;
  private waiters: { match: (m: HostMessage) => boolean; resolve: (v: { msg: HostMessage; bin: Buffer | null }) => void; reject: (e: Error) => void }[] = [];
  private failure: Error | null = null;
  private nextId = 1;
  private diagnostics = '';
  private exited: Promise<void> = Promise.resolve();
  private hostIdentity: { pid: number; start: string } | null = null;
  private readonly ownedMap = new Map<string, OwnedProcess>();
  private closing: Promise<void> | null = null;
  readonly limits: SceneLimits;
  /** Connections to the job endpoint that were refused (wrong or missing proof). */
  readonly rejectedClients: string[] = [];
  versions: Record<string, string> = {};
  pid = 0;
  info: SceneInfo | null = null;
  ipc: IpcConfig | null = null;
  /** Filled in by close(): what was owned and what happened to each process. */
  cleanup: CleanupReport | null = null;

  constructor(private readonly options: SceneHostOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  /** Processes owned by this job (host and helpers), by PID + start time. */
  get owned(): OwnedProcess[] {
    return [...this.ownedMap.values()];
  }

  async start(): Promise<void> {
    if (this.options.signal?.aborted) throw new SceneError('CANCELLED', 'Cancelled.');
    this.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), JOB_DIR_PREFIX));
    writeOwnerMarker(this.dataDir);
    const config = newIpcConfig(this.dataDir);
    this.ipc = config;
    writeIpcFile(this.dataDir, config);
    const { server, accepted } = await listenForHost(config, { timeoutMs: this.limits.loadMs + 10_000, onRejected: (r) => this.rejectedClients.push(r) });
    this.server = server;
    const args = [
      this.options.hostScript,
      `--scene-host-data=${this.dataDir}`,
      ...(this.options.proxy ? [`--scene-proxy=${this.options.proxy}`] : []),
      ...(this.options.gpu ? ['--scene-gpu'] : []),
      ...(this.options.heapMB ? [`--scene-heap=${this.options.heapMB}`] : []),
      ...(this.options.testDisableCsp ? ['--scene-test-no-csp'] : []),
      ...(this.options.testFakeMedia ? ['--scene-test-fake-media'] : []),
      ...(this.options.testStdoutNoise ? ['--scene-test-stdout-noise'] : []),
    ];
    const child = spawn(this.options.electron, args, { env: { ...hostEnvironment(), ...this.options.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    this.exited = new Promise((resolve) => child.once('exit', () => resolve()));
    // Diagnostics only (Chromium logs, Electron's stray output): never parsed.
    const collect = (c: Buffer) => {
      this.diagnostics = (this.diagnostics + c.toString('utf8')).slice(-8000);
    };
    child.stdout!.on('data', collect);
    child.stderr!.on('data', collect);
    child.on('error', (e) => this.abort(new SceneError('HOST_FAILED', `Could not start the render host: ${e.message}`)));
    child.on('exit', (code, signal) => this.abort(new SceneError('HOST_FAILED', `The render host exited (${signal ?? code}).`)));
    this.options.signal?.addEventListener('abort', () => void this.close(new SceneError('CANCELLED', 'Cancelled.')), { once: true });

    const socket = await Promise.race([
      accepted,
      this.exited.then(() => Promise.reject(this.failure ?? new SceneError('HOST_FAILED', 'The render host exited before connecting.'))),
    ]).catch((e) => {
      throw e instanceof SceneError ? e : new SceneError('HOST_FAILED', (e as Error).message);
    });
    this.channel = new IpcChannel(
      socket,
      config.jobId,
      (h, bin) => this.dispatch(h as unknown as HostMessage, bin),
      (e) => this.abort(new SceneError('HOST_FAILED', e.message)),
      { maxHeader: 1 << 20, maxBinary: MAX_FRAME }
    );
    socket.on('close', () => this.abort(new SceneError('HOST_FAILED', 'The render host connection closed.')));
    const ready = await this.wait((m) => m.type === 'ready', this.limits.loadMs);
    if (ready.msg.type === 'ready') {
      this.pid = ready.msg.pid;
      this.versions = ready.msg.versions;
    }
    // The host is our unreaped child, so its PID can't have been reused yet: record its identity.
    const me = listProcesses().find((p) => p.pid === child.pid);
    if (me) this.hostIdentity = { pid: me.pid, start: me.start };
    this.snapshot();
  }

  /** Records the host's current process tree (only while the host is alive). */
  snapshot(): void {
    if (!this.hostIdentity || !this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    for (const p of ownedTree(this.hostIdentity, listProcesses())) this.ownedMap.set(`${p.pid}:${p.start}`, p);
  }

  /** Recent stdout/stderr from the host (Chromium logs), for diagnostics. */
  get log(): string {
    return this.diagnostics;
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
      // The app's own watchdog: the host must answer in time, or it is stopped.
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

  private async send(header: Record<string, unknown>, bin?: Uint8Array): Promise<void> {
    if (this.failure) throw this.failure;
    if (!this.channel) throw new SceneError('HOST_FAILED', 'The render host is not connected.');
    try {
      await this.channel.send(header, bin);
    } catch (e) {
      throw this.failure ?? new SceneError('HOST_FAILED', (e as Error).message);
    }
  }

  /** Sends the job's files and opens the scene. */
  async open(job: SceneJob): Promise<SceneInfo> {
    for (const f of job.files) await this.send({ type: 'file', path: f.path }, f.data);
    const { files: _files, ...rest } = job;
    const opened = this.wait((m) => m.type === 'opened', this.limits.loadMs * 2);
    await this.send({ type: 'open', job: rest, limits: this.limits });
    const r = await opened;
    if (r.msg.type !== 'opened') throw new SceneError('HOST_FAILED', 'Unexpected reply.');
    this.info = r.msg.info;
    this.snapshot(); // the renderer exists now
    return r.msg.info;
  }

  /** One output frame: the average of the given scene times (seconds), as straight RGBA. */
  async capture(times: number[], postCamera = false): Promise<{ rgba: Buffer; ms: number }> {
    const id = this.nextId++;
    const reply = this.wait((m) => (m.type === 'frame' || m.type === 'error') && (m as { id?: number }).id === id, this.limits.frameMs);
    await this.send({ type: 'capture', id, times, postCamera });
    const r = await reply;
    if (r.msg.type !== 'frame' || !r.bin) throw new SceneError('HOST_FAILED', 'Unexpected reply.');
    return { rgba: r.bin, ms: r.msg.ms };
  }

  /** Test hook: what the page put in window.__probe, plus every request the host blocked. */
  async probe(): Promise<{ page: unknown; blocked: string[] }> {
    const id = this.nextId++;
    const reply = this.wait((m) => m.type === 'probe' && m.id === id, 10_000);
    await this.send({ type: 'probe', id });
    const r = await reply;
    return JSON.parse((r.msg as { value: string }).value);
  }

  /** Stops the host (gracefully, then through its handle) and safely cleans up. Safe to call twice. */
  close(reason?: Error): Promise<void> {
    if (reason) this.abort(reason);
    if (!this.closing) this.closing = this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    const child = this.child;
    const alive = () => child !== null && child.exitCode === null && child.signalCode === null;
    if (alive()) {
      try {
        this.snapshot();
      } catch {
        // listing failed; use what was recorded
      }
      try {
        await Promise.race([this.channel?.send({ type: 'close' }), new Promise((r) => setTimeout(r, 500))]);
      } catch {
        // connection already gone
      }
      // Still our unreaped child: killing through the handle can't hit a reused PID.
      const killer = setTimeout(() => {
        if (alive()) child!.kill('SIGKILL');
      }, 2000);
      await this.exited;
      clearTimeout(killer);
    }
    this.channel?.close();
    this.server?.close();
    // Helpers normally exit with the host; give them a moment, then stop any that remain, verified.
    const owned = this.owned;
    const helpers = owned.filter((p) => p.role === 'helper');
    const report: CleanupReport = { owned, exited: [], killed: [], skipped: [] };
    try {
      let state = stillRunning(helpers, helpers.length ? listProcesses() : []);
      for (let i = 0; i < 15 && state.alive.length; i++) {
        await new Promise((r) => setTimeout(r, 200));
        state = stillRunning(helpers, listProcesses());
      }
      const k = killVerified(state.alive);
      report.killed = k.killed;
      report.skipped = [...state.reused.map((pid) => ({ pid, reason: 'reused' })), ...k.skipped];
      report.exited = helpers.map((h) => h.pid).filter((pid) => !report.killed.includes(pid) && !report.skipped.some((s) => s.pid === pid));
      if (this.hostIdentity) report.exited.unshift(this.hostIdentity.pid);
    } catch (e) {
      report.skipped.push({ pid: 0, reason: `process listing failed: ${(e as Error).message}` });
    }
    this.cleanup = report;
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
