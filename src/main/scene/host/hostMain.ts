// Render host: a separate Electron process that runs untrusted scene code (Claude-written HTML/CSS/
// SVG/JS) in one locked-down, off-screen Chromium page and returns frames to the app over a dedicated,
// authenticated socket (ipc.ts). stdin is unused; stdout/stderr are diagnostics only.
//
// It is started by the app (or a test) with a scrubbed environment and its own empty data folder.
// It never receives the API key, settings, project paths or app IPC. Only the job's files are
// served to the page, from memory, under a random origin. See docs/PRODUCTION-PHASE0.md.
//
// Trusted code here; the page is not. The page gets: no Node, no preload, no IPC, no network (all
// requests except its own job origin are cancelled; DNS and the proxy are dead ends), no navigation,
// pop-ups, downloads, dialogs or permissions, and a strict CSP. Frames are captured through the
// DevTools protocol, which the page cannot reach.

import * as crypto from 'crypto';
import { app, BrowserWindow, protocol, session, type WebContents } from 'electron';
import { connectToApp, IpcChannel, takeIpcFile, type IpcConfig } from '../ipc';
import { decodePng } from '../png';
import { Accumulator, applyCamera, premultiply, type CameraState } from '../pixels';
import { type HostCommand, type HostMessage, type SceneErrorCode, type SceneInfo, type SceneJob, type SceneLimits } from '../protocol';
import { determinismShim } from '../shim';

const SCHEME = 'edissistant-scene';
const DEBUG = process.env.EDISSISTANT_SCENE_DEBUG === '1';
const debug = (...a: unknown[]) => DEBUG && process.stderr.write(`[scene-host] ${a.map(String).join(' ')}\n`);
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

// --- Process-wide lockdown (before ready) ---------------------------------------------------------

const dataDir = arg('scene-host-data');
if (!dataDir) {
  process.stderr.write('scene host: --scene-host-data is required\n');
  process.exit(2);
}
// The connection file is read and deleted at once (it holds the job's secret).
let ipcConfig: IpcConfig;
try {
  ipcConfig = takeIpcFile(dataDir);
} catch (e) {
  process.stderr.write(`scene host: no valid IPC file (${(e as Error).message})\n`);
  process.exit(2);
}
// Test hook (B2 regression): Electron on Windows writes stray bytes to stdout; prove they can't matter.
if (process.argv.includes('--scene-test-stdout-noise')) {
  process.stdout.write('\r\n\r\nnoise on stdout: not protocol\r\n');
  process.stderr.write('noise on stderr\r\n');
}
app.setPath('userData', dataDir);
app.setPath('sessionData', dataDir);
const sw = (k: string, v?: string) => app.commandLine.appendSwitch(k, v);
sw('force-color-profile', 'srgb');
sw('disable-lcd-text');
// No network at all: every hostname fails to resolve and every request goes to a dead proxy
// (including loopback, which Chromium otherwise bypasses).
sw('host-resolver-rules', 'MAP * ~NOTFOUND');
sw('proxy-server', arg('scene-proxy') ?? '127.0.0.1:9');
sw('proxy-bypass-list', '<-loopback>');
sw('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
sw('disable-background-networking');
sw('disable-component-update');
sw('disable-domain-reliability');
sw('disable-sync');
sw('no-pings');
sw('disable-breakpad');
sw(
  'disable-features',
  [
    'MediaRouter', 'OptimizationHints', 'Translate', 'AutofillServerCommunication', 'CertificateTransparencyComponentUpdater', 'DialMediaRouteProvider', 'SpareRendererForSitePerProcess',
    // WebRTC: no mDNS hostname candidates (the Windows run saw mDNS UDP sockets) …
    'WebRtcHideLocalIpsWithMdns',
    // … and no WebGPU service (exposed in GPU mode on Windows).
    'WebGPUService', 'Vulkan',
  ].join(',')
);
// Remove device and GPU APIs from the page entirely (Blink runtime features).
sw('disable-blink-features', 'WebGPU,WebUSB,WebBluetooth,WebHID,Serial,WebXR,WebNFC,DirectSockets');
if (process.argv.includes('--scene-test-fake-media')) {
  // Test hook: fake camera/microphone, so the permission denial (not "no device") is what's exercised.
  // (Never --use-fake-ui-for-media-stream: that would auto-grant.)
  sw('use-fake-device-for-media-stream');
}
sw('js-flags', `--max-old-space-size=${Number(arg('scene-heap')) || 1024}`);
if (!process.argv.includes('--scene-gpu')) {
  // Software rasterisation: the same pixels on every machine, whatever the GPU.
  app.disableHardwareAcceleration();
  sw('disable-gpu');
}
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: false } }]);
app.on('window-all-closed', () => undefined);

const CSP = [
  "default-src 'none'",
  `script-src ${SCHEME}: 'unsafe-inline'`,
  `style-src ${SCHEME}: 'unsafe-inline'`,
  `img-src ${SCHEME}: data: blob:`,
  `font-src ${SCHEME}: data: blob:`,
  `media-src ${SCHEME}: data: blob:`,
  // Its own job files only (e.g. JSON timing data); other job tokens get a 404 from the handler.
  `connect-src ${SCHEME}:`,
  "worker-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "navigate-to 'none'",
  // Browser-enforced document sandbox: scripts and its own origin only. No modals (alert, confirm, print),
  // pop-ups, top-level navigation, forms, downloads, pointer lock or presentation, in this document and
  // in any frame it creates (sandbox flags are inherited, also by about:blank frames).
  'sandbox allow-scripts allow-same-origin',
].join('; ');

// Every powerful feature off for the page and anything it embeds (a second layer to the permission handlers).
const PERMISSIONS_POLICY = [
  'camera', 'microphone', 'geolocation', 'display-capture', 'usb', 'serial', 'hid', 'bluetooth', 'payment', 'clipboard-read', 'clipboard-write',
  'screen-wake-lock', 'web-share', 'xr-spatial-tracking', 'midi', 'publickey-credentials-get', 'idle-detection', 'local-fonts', 'window-management', 'gamepad',
].map((f) => `${f}=()`).join(', ');

// Test hook (set only by the test suite): serve pages without the CSP, to prove the network and
// navigation layers block everything on their own.
const CSP_OFF = process.argv.includes('--scene-test-no-csp');

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

// --- Messaging (the authenticated socket; see ipc.ts) ------------------------------------------------

let channel: IpcChannel | null = null;
function send(message: HostMessage, bin?: Uint8Array): Promise<void> {
  if (!channel) return Promise.reject(new Error('not connected'));
  return channel.send(message as unknown as Record<string, unknown>, bin);
}

async function fail(code: SceneErrorCode, message: string, id?: number): Promise<never> {
  await send({ type: 'error', code, message: message.slice(0, 2000), ...(id !== undefined ? { id } : {}) }).catch(() => undefined);
  setTimeout(() => app.exit(3), 50);
  return new Promise<never>(() => undefined);
}

// --- The job ---------------------------------------------------------------------------------------

const files = new Map<string, Buffer>();
const blocked: string[] = [];
let wc: WebContents | null = null;
let win: BrowserWindow | null = null;
let job: Omit<SceneJob, 'files'> | null = null;
let limits: SceneLimits | null = null;
let info: SceneInfo | null = null;
let drawExpr: (t: number) => string = () => '';
let pageErrors: string[] = [];

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error('timeout'));
    }, ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e))
    );
  });
}

async function cdp<T = Record<string, unknown>>(method: string, params: object = {}): Promise<T> {
  return (await wc!.debugger.sendCommand(method, params)) as T;
}

async function evaluate(expression: string, awaitPromise = false): Promise<unknown> {
  const r = await cdp<{ result: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw Object.assign(new Error(d.exception?.description ?? d.text ?? 'The scene threw an error.'), { scene: true });
  }
  return r.result.value;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

async function open(cmd: Extract<HostCommand, { type: 'open' }>): Promise<void> {
  job = cmd.job;
  limits = cmd.limits;
  if (!files.has(job.entry)) return fail('INVALID_JOB', `The entry file ${job.entry} was not sent.`);
  if (!(job.width > 0 && job.height > 0 && job.deviceScale > 0 && job.deviceScale <= 4)) return fail('INVALID_JOB', 'Invalid size or device scale.');
  // The page's origin: random per job, so no two jobs (or guesses) share it.
  const token = crypto.randomBytes(12).toString('hex');
  const origin = `${SCHEME}://${token}/`;
  const ses = session.fromPartition(`scene-${token}`, { cache: false });
  const record = (what: string) => {
    if (blocked.length < 200 && !blocked.includes(what)) blocked.push(what);
  };
  // Everything denied, and recorded (camera, microphone, notifications, openExternal for mailto:/custom
  // protocols, …).
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    record(`permission:${permission}`);
    cb(false);
  });
  ses.setPermissionCheckHandler((_wc, permission) => {
    record(`permission-check:${permission}`);
    return false;
  });
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => {
    const ok = d.url.startsWith(origin) || d.url.startsWith('data:') || d.url.startsWith('blob:') || d.url.startsWith('devtools:');
    if (!ok && blocked.length < 200) blocked.push(d.url.slice(0, 200));
    cb({ cancel: !ok });
  });
  ses.protocol.handle(SCHEME, (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    if (u.host !== token || rel.split('/').some((p) => p === '..' || p === '.') || !files.has(rel)) {
      if (blocked.length < 200) blocked.push(req.url.slice(0, 200));
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    const ext = rel.split('.').pop()!.toLowerCase();
    return new Response(new Uint8Array(files.get(rel)!), {
      status: 200,
      headers: {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        ...(CSP_OFF ? {} : { 'content-security-policy': CSP }),
        'permissions-policy': PERMISSIONS_POLICY,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  });

  debug('creating window');
  win = new BrowserWindow({
    show: false,
    width: job.width,
    height: job.height,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    frame: false,
    transparent: job.alpha,
    backgroundColor: job.alpha ? '#00000000' : '#ffffffff',
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      webgl: false,
      plugins: false,
      experimentalFeatures: false,
      enableWebSQL: false,
      spellcheck: false,
      backgroundThrottling: false,
      navigateOnDragDrop: false,
      disableDialogs: true,
      autoplayPolicy: 'document-user-activation-required',
      v8CacheOptions: 'none',
      // Off-screen rendering: no native window at all, and the page keeps painting while hidden (a
      // hidden normal window stops producing frames after it navigates, so screenshots would hang).
      offscreen: true,
    },
  });
  wc = win.webContents;
  wc.setAudioMuted(true);
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.on('will-frame-navigate', (e) => {
    if (!e.url.startsWith(origin) || !e.isMainFrame) e.preventDefault();
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.on('render-process-gone', (_e, d) => void fail(d.reason === 'oom' ? 'MEMORY_LIMIT' : 'RENDERER_CRASHED', `The scene renderer stopped (${d.reason}).`));
  wc.debugger.on('message', (_e, method, params: { exceptionDetails?: { exception?: { description?: string }; text?: string } }) => {
    if (method === 'Runtime.exceptionThrown' && pageErrors.length < 20) {
      pageErrors.push((params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'error').slice(0, 500));
    }
  });
  // A new window has no renderer until it navigates; DevTools commands would wait forever.
  await wc.loadURL('about:blank');
  wc.debugger.attach('1.3');
  debug('debugger attached');
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: determinismShim(job.seed) });
  await cdp('Emulation.setDeviceMetricsOverride', { width: job.width, height: job.height, deviceScaleFactor: job.deviceScale, mobile: false });
  if (job.alpha) await cdp('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

  // Memory watchdog for the renderer process.
  const pid = () => wc?.getOSProcessId();
  setInterval(() => {
    const m = app.getAppMetrics().find((p) => p.pid === pid());
    if (m && m.memory.workingSetSize > limits!.memoryMB * 1024) {
      wc?.forcefullyCrashRenderer();
      void fail('MEMORY_LIMIT', `The scene used more than ${limits!.memoryMB} MB of memory.`);
    }
  }, 250).unref();

  debug('cdp ready');
  const url = `${origin}${job.entry.split('/').map(encodeURIComponent).join('/')}${job.query ? `?${job.query}` : ''}`;
  try {
    debug('loading', url);
    try {
      await withTimeout(wc.loadURL(url), limits.loadMs, () => wc?.forcefullyCrashRenderer());
    } catch (e) {
      // A page that tries to navigate away makes loadURL reject with ERR_ABORTED once the navigation is
      // blocked. If the scene is still on its own origin, the block worked: keep going.
      if ((e as Error).message === 'timeout' || !/ERR_ABORTED/.test((e as Error).message) || !wc.getURL().startsWith(origin)) throw e;
      debug('a navigation away from the scene was blocked');
    }
    debug('loaded');
    await withTimeout(
      evaluate(
        `(async () => { if (document.readyState !== 'complete') await new Promise((r) => addEventListener('load', r, { once: true })); await document.fonts.ready; await Promise.all([...document.images].map((i) => i.decode().catch(() => undefined))); return true; })()`,
        true
      ),
      limits.loadMs,
      () => wc?.forcefullyCrashRenderer()
    );
  } catch (e) {
    const msg = (e as Error).message;
    return msg === 'timeout'
      ? fail('LOAD_TIMEOUT', `The scene didn't finish loading within ${Math.round(limits.loadMs / 1000)} s.`)
      : fail((e as { scene?: boolean }).scene ? 'SCENE_ERROR' : 'LOAD_FAILED', `The scene failed to load: ${msg}`);
  }
  if (pageErrors.length) return fail('SCENE_ERROR', `The scene threw while loading: ${pageErrors[0]}`);

  // Entry adapter.
  const a = job.adapter;
  let duration = 0;
  let offset = 0;
  let scenes: SceneInfo['scenes'];
  try {
    if (a.kind === 'static') {
      duration = 0;
      drawExpr = (t) => `__edissistant.frame(${JSON.stringify(t)}, () => null)`;
    } else if (a.kind === 'scene') {
      const d = (await evaluate(`(() => { const S = window.SCENE; if (!S || typeof S.render !== 'function') return null; return Number(S.dur); })()`)) as number | null;
      if (d === null) return fail('NO_SCENE', 'The page defines no window.SCENE with a render(t) function.');
      duration = d;
      drawExpr = (t) => `__edissistant.frame(${JSON.stringify(t)}, () => { window.SCENE.render(${JSON.stringify(t)}); return null; })`;
    } else {
      const list = a.list ?? 'SCENES';
      const render = a.render ?? 'renderAt';
      const camera = a.camera ?? '';
      if (![list, render].every((n) => IDENT.test(n)) || (camera && !IDENT.test(camera))) return fail('INVALID_JOB', 'Invalid adapter names.');
      scenes = (await evaluate(
        `(() => { const L = window[${JSON.stringify(list)}]; if (!Array.isArray(L) || typeof window[${JSON.stringify(render)}] !== 'function') return null; return L.map((s) => ({ id: String(s.id), t0: Number(s.t0), t1: Number(s.t1) })); })()`
      )) as SceneInfo['scenes'] | null ?? undefined;
      const sc = scenes?.find((s) => s.id === a.sceneId);
      if (!scenes || !sc) return fail('NO_SCENE', `The page has no registry scene "${a.sceneId}" (window.${list} / window.${render}).`);
      duration = sc.t1 - sc.t0;
      offset = sc.t0;
      const cam = camera ? `(typeof window[${JSON.stringify(camera)}] === 'function' ? window[${JSON.stringify(camera)}](T) : null)` : 'null';
      drawExpr = (t) => `(() => { const T = ${JSON.stringify(t)}; return __edissistant.frame(T, () => { window[${JSON.stringify(render)}](T); return ${cam}; }); })()`;
    }
  } catch (e) {
    return fail('SCENE_ERROR', `The scene failed while starting: ${(e as Error).message}`);
  }
  if (!(a.kind === 'static' || (duration > 0 && duration < 3600))) return fail('NO_SCENE', `The scene duration (${duration}) isn't a positive number of seconds.`);
  const fontFamilies = ((await evaluate(`[...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/^["']|["']$/g, ''))`)) as string[]) ?? [];
  info = {
    duration,
    offset,
    ...(scenes ? { scenes } : {}),
    outputWidth: Math.round(job.width * job.deviceScale),
    outputHeight: Math.round(job.height * job.deviceScale),
    fontFamilies: [...new Set(fontFamilies)],
  };
  await send({ type: 'opened', info, warnings: [] });
}

async function captureOnce(t: number): Promise<{ rgba: Uint8Array; camera: CameraState | null }> {
  debug('draw', t);
  const cam = (await evaluate(drawExpr(t))) as CameraState | null;
  debug('drawn');
  if (pageErrors.length) throw Object.assign(new Error(pageErrors[0]), { scene: true });
  const shot = await cdp<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  debug('captured');
  const img = decodePng(Buffer.from(shot.data, 'base64'));
  if (img.width !== info!.outputWidth || img.height !== info!.outputHeight) {
    throw new Error(`Captured ${img.width}×${img.height}, expected ${info!.outputWidth}×${info!.outputHeight}.`);
  }
  if (cam !== null && (typeof cam !== 'object' || !(Number(cam.scale) > 0))) throw Object.assign(new Error('The camera function must return { scale, originX?, originY?, x?, y? }.'), { scene: true });
  return { rgba: img.data, camera: cam };
}

async function capture(cmd: Extract<HostCommand, { type: 'capture' }>): Promise<void> {
  if (!info || !wc) return fail('INVALID_JOB', 'No scene is open.', cmd.id);
  const started = Date.now();
  const work = async () => {
    const W = info!.outputWidth;
    const H = info!.outputHeight;
    const dpr = job!.deviceScale;
    // Single sample, no camera: Chromium's own pixels, untouched.
    if (cmd.times.length === 1 && !cmd.postCamera) return (await captureOnce(info!.offset + cmd.times[0])).rgba;
    const acc = new Accumulator(W, H);
    for (const t of cmd.times) {
      const { rgba, camera } = await captureOnce(info!.offset + t);
      if (cmd.postCamera && camera) {
        // Camera values are in CSS pixels; the capture is at device scale.
        const c = { scale: camera.scale, originX: camera.originX !== undefined ? camera.originX * dpr : undefined, originY: camera.originY !== undefined ? camera.originY * dpr : undefined, x: (camera.x ?? 0) * dpr, y: (camera.y ?? 0) * dpr };
        acc.addPremultiplied(applyCamera(premultiply(rgba), W, H, c));
      } else acc.addStraight(rgba);
    }
    return acc.toStraight();
  };
  let rgba: Uint8Array;
  try {
    rgba = await withTimeout(work(), limits!.frameMs, () => wc?.forcefullyCrashRenderer());
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === 'timeout') return fail('FRAME_TIMEOUT', `A frame took longer than ${Math.round(limits!.frameMs / 1000)} s to draw (an endless loop or a very heavy scene).`, cmd.id);
    return fail('SCENE_ERROR', `The scene failed at ${cmd.times[0].toFixed(3)} s: ${msg}`, cmd.id);
  }
  await send({ type: 'frame', id: cmd.id, width: info.outputWidth, height: info.outputHeight, bin: rgba.byteLength, ms: Date.now() - started }, rgba);
}

async function probe(cmd: Extract<HostCommand, { type: 'probe' }>): Promise<void> {
  let page: unknown = null;
  try {
    page = await withTimeout(evaluate(`(() => { try { return JSON.stringify(window.__probe ?? null); } catch (e) { return null; } })()`), 5000, () => undefined);
  } catch {
    page = null;
  }
  await send({ type: 'probe', id: cmd.id, value: JSON.stringify({ page: typeof page === 'string' ? JSON.parse(page) : null, blocked }) });
}

// --- Command loop ----------------------------------------------------------------------------------

let filesBytes = 0;
const MAX_JOB_BYTES = 1024 * 1024 * 1024;

app.whenReady().then(async () => {
  let socket;
  try {
    socket = await connectToApp(ipcConfig);
  } catch (e) {
    process.stderr.write(`scene host: could not connect to the app (${(e as Error).message})\n`);
    app.exit(4);
    return;
  }
  let queue: Promise<void> = Promise.resolve();
  channel = new IpcChannel(
    socket,
    ipcConfig.jobId,
    (header, bin) => {
      const cmd = header as unknown as HostCommand;
      queue = queue
        .then(async () => {
          debug('command', cmd.type);
          switch (cmd.type) {
            case 'file':
              if (!/^[A-Za-z0-9 _.()+-]+(\/[A-Za-z0-9 _.()+-]+)*$/.test(cmd.path) || cmd.path.split('/').some((p) => p === '..' || p === '.')) return void fail('INVALID_JOB', `Invalid file path ${cmd.path}.`);
              filesBytes += bin?.length ?? 0;
              if (filesBytes > MAX_JOB_BYTES) return void fail('INVALID_JOB', 'The job files are too large.');
              files.set(cmd.path, bin ?? Buffer.alloc(0));
              return;
            case 'open':
              return open(cmd);
            case 'capture':
              return capture(cmd);
            case 'probe':
              return probe(cmd);
            case 'close':
              win?.destroy();
              setTimeout(() => app.exit(0), 20);
              return;
          }
        })
        .catch((e) => void fail('HOST_FAILED', (e as Error).message));
    },
    (e) => {
      process.stderr.write(`scene host: connection error (${e.message})\n`);
      app.exit(5);
    },
    { maxHeader: 1 << 20, maxBinary: 512 * 1024 * 1024 }
  );
  // The app went away (or closed the job): stop at once.
  socket.on('close', () => app.exit(0));
  void send({ type: 'ready', pid: process.pid, versions: { electron: process.versions.electron, chrome: process.versions.chrome } });
});
