// Production frame source: draws frames with the trusted engine in a hidden, sandboxed Chromium
// renderer and reads them back as straight RGBA.
//
// Security boundary (see docs/RENDERING.md):
//  - sandbox: true, contextIsolation, no Node integration; the preload exposes only send/onCommand.
//  - Its own in-memory session: every network request except the sandbox page itself is cancelled,
//    all permission requests are denied, navigation and new windows are blocked.
//  - It receives a validated spec plus font/image bytes; it never sees file paths, settings or keys.
//  - Messages are accepted only from this window's webContents and are size-checked.

import { BrowserWindow, ipcMain, session, type WebContents } from 'electron';
import * as path from 'path';
import { cancelled, RenderError } from '../../shared/animation/errors';
import {
  SANDBOX_COMMAND_CHANNEL,
  SANDBOX_MESSAGE_CHANNEL,
  type SandboxCommand,
  type SandboxMessage,
} from '../../shared/animation/sandboxProtocol';
import { frameCount } from '../../shared/animation/timeline';
import type { FrameJob, FrameSource, FrameSourceFactory } from './frameSource';

export const SANDBOX_PARTITION = 'edissistant-render-sandbox';

export interface SandboxPage {
  /** URL of render-sandbox.html (file:// in production, the Vite server in dev). */
  url: string;
  /** Whether the sandbox may load this URL (its own page and scripts only). */
  isAllowed(url: string): boolean;
}

const SANDBOX_CSP = "default-src 'none'; script-src 'self'; img-src data: blob:; font-src data: blob:; style-src 'unsafe-inline'";
const READY_TIMEOUT = 20_000;
const INIT_TIMEOUT = 60_000;
const FRAME_TIMEOUT = 60_000;

const routes = new Map<number, (message: SandboxMessage) => void>();
let listening = false;
let securedFor: SandboxPage | null = null;

function listen(): void {
  if (listening) return;
  listening = true;
  ipcMain.on(SANDBOX_MESSAGE_CHANNEL, (event, message: SandboxMessage) => {
    // Only the window that owns a route can talk to it.
    routes.get(event.sender.id)?.(message);
  });
}

function secureSession(page: SandboxPage): Electron.Session {
  const ses = session.fromPartition(SANDBOX_PARTITION);
  if (securedFor !== page) {
    securedFor = page;
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !page.isAllowed(details.url) }));
    ses.webRequest.onHeadersReceived((details, callback) =>
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [SANDBOX_CSP] } })
    );
  }
  return ses;
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class ChromiumFrameSource implements FrameSource {
  private win: BrowserWindow | null = null;
  private contents: WebContents | null = null;
  private readonly jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  private readonly frames = new Map<number, Promise<Uint8Array>>();
  private readonly frameWaiters = new Map<number, Waiter<Uint8Array>>();
  private readyWaiter: Waiter<void> | null = null;
  private initWaiter: Waiter<string[]> | null = null;
  private failure: Error | null = null;
  private readonly total: number;
  private readonly frameBytes: number;

  constructor(private readonly job: FrameJob, private readonly page: SandboxPage, private readonly preload: string) {
    this.total = frameCount(job.spec.duration, job.spec.fps);
    this.frameBytes = job.width * job.height * 4;
  }

  private waiter<T>(timeout: number, label: string, assign: (w: Waiter<T> | null) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      const timer = setTimeout(() => {
        assign(null);
        reject(new RenderError('SANDBOX_FAILED', `The render sandbox did not respond (${label}).`));
      }, timeout);
      assign({ resolve, reject, timer });
    });
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const w of [this.readyWaiter, this.initWaiter, ...this.frameWaiters.values()]) {
      if (!w) continue;
      clearTimeout(w.timer);
      w.reject(error);
    }
    this.readyWaiter = null;
    this.initWaiter = null;
    this.frameWaiters.clear();
  }

  private onMessage(message: SandboxMessage): void {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      if (this.readyWaiter) {
        clearTimeout(this.readyWaiter.timer);
        this.readyWaiter.resolve();
        this.readyWaiter = null;
      }
      return;
    }
    if (message.jobId !== this.jobId) return;
    if (message.type === 'init-result' && this.initWaiter) {
      const w = this.initWaiter;
      this.initWaiter = null;
      clearTimeout(w.timer);
      if (message.ok) w.resolve(Array.isArray(message.warnings) ? message.warnings.map(String) : []);
      else w.reject(new RenderError(message.error.code, message.error.message, { details: message.error.details }));
      return;
    }
    if (message.type === 'frame' || message.type === 'frame-error') {
      const w = this.frameWaiters.get(message.index);
      if (!w) return;
      this.frameWaiters.delete(message.index);
      clearTimeout(w.timer);
      if (message.type === 'frame-error') {
        w.reject(new RenderError('RENDER_FAILED', `Frame ${message.index} failed to draw: ${message.message}`));
        return;
      }
      const data = message.data;
      if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.byteLength !== this.frameBytes) {
        w.reject(new RenderError('SANDBOX_FAILED', `Frame ${message.index} came back with the wrong size.`));
        return;
      }
      w.resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
  }

  private send(command: SandboxCommand): void {
    if (!this.contents || this.contents.isDestroyed()) throw this.failure ?? new RenderError('SANDBOX_FAILED', 'The render sandbox is closed.');
    this.contents.send(SANDBOX_COMMAND_CHANNEL, command);
  }

  async open(signal?: AbortSignal): Promise<{ warnings: string[] }> {
    if (signal?.aborted) throw cancelled();
    listen();
    const ses = secureSession(this.page);
    const win = new BrowserWindow({
      show: false,
      width: 64,
      height: 64,
      webPreferences: {
        session: ses,
        preload: this.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
        spellcheck: false,
        webgl: false,
        navigateOnDragDrop: false,
        disableDialogs: true,
      },
    });
    this.win = win;
    this.contents = win.webContents;
    routes.set(win.webContents.id, (m) => this.onMessage(m));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('render-process-gone', (_event, details) => this.fail(new RenderError('SANDBOX_FAILED', `The render sandbox stopped (${details.reason}).`)));
    signal?.addEventListener('abort', () => this.fail(cancelled()), { once: true });

    const ready = this.waiter<void>(READY_TIMEOUT, 'startup', (w) => (this.readyWaiter = w));
    await win.loadURL(this.page.url).catch((error) => this.fail(new RenderError('SANDBOX_FAILED', 'The render sandbox page could not be loaded.', { details: String(error) })));
    await ready;

    const init = this.waiter<string[]>(INIT_TIMEOUT, 'loading fonts and images', (w) => (this.initWaiter = w));
    this.send({
      type: 'init',
      jobId: this.jobId,
      spec: this.job.spec,
      width: this.job.width,
      height: this.job.height,
      scale: this.job.scale,
      fonts: this.job.assets.fonts,
      images: this.job.assets.images,
    });
    return { warnings: await init };
  }

  private request(index: number): Promise<Uint8Array> {
    let promise = this.frames.get(index);
    if (!promise) {
      promise = this.waiter<Uint8Array>(FRAME_TIMEOUT, `frame ${index}`, (w) => {
        if (w) this.frameWaiters.set(index, w);
        else this.frameWaiters.delete(index);
      });
      this.frames.set(index, promise);
      promise.catch(() => undefined);
      this.send({ type: 'frame', jobId: this.jobId, index });
    }
    return promise;
  }

  async frame(index: number): Promise<Uint8Array> {
    // Keep the sandbox one frame ahead so drawing overlaps encoding.
    if (index + 1 < this.total) this.request(index + 1);
    const data = await this.request(index);
    this.frames.delete(index);
    return data;
  }

  async close(): Promise<void> {
    if (this.contents) routes.delete(this.contents.id);
    this.fail(new RenderError('SANDBOX_FAILED', 'The render sandbox was closed.'));
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.contents = null;
  }
}

export function chromiumFrameSourceFactory(page: SandboxPage): FrameSourceFactory {
  const preload = path.join(__dirname, 'sandboxPreload.js');
  return (job) => new ChromiumFrameSource(job, page, preload);
}
