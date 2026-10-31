import { app, BrowserWindow, ipcMain, session, protocol, dialog, shell, safeStorage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { Readable } from 'stream';
import { registerRenderEngine } from './render';
import { migrateLegacyFolder } from './migration';
import { registerPipeline } from './pipeline';
import { registerTranscriptionIpc, TranscriptionService, type ServiceSettings } from './transcription';

// Dev mode (Vite dev server) is opt-in via --dev so `npm start` runs the built renderer.
const isDev = !app.isPackaged && process.argv.includes('--dev');

// Custom scheme used to stream local media into the renderer (supports range requests for seeking).
const MEDIA_SCHEME = 'edissistant-media';
const MEDIA_EXTENSIONS: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { stream: true, supportFetchAPI: true, secure: true, standard: true } },
]);

// The app was first released under the misspelled name "edissisant"; carry its data folder over once.
function migrateLegacyUserData(): void {
  const legacy = path.join(app.getPath('appData'), 'edissisant');
  try {
    migrateLegacyFolder(legacy, app.getPath('userData'));
  } catch {
    // Folder is locked (e.g. another instance is running) — keep using it rather than start empty.
    app.setPath('userData', legacy);
  }
}

migrateLegacyUserData();

function getUserDataPath(filename: string): string {
  return path.join(app.getPath('userData'), filename);
}

function readJsonFile(filepath: string): unknown {
  for (const candidate of [filepath, `${filepath}.bak`]) {
    try {
      if (fs.existsSync(candidate)) {
        return JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      }
    } catch {
      // Fall through to the backup copy on parse error
    }
  }
  return null;
}

// Atomic write: write to a temp file, keep the previous version as .bak, then rename.
function writeJsonFile(filepath: string, data: unknown): void {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = `${filepath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  if (fs.existsSync(filepath)) {
    fs.copyFileSync(filepath, `${filepath}.bak`);
  }
  fs.renameSync(tmp, filepath);
}

// --- Settings (read early so performance preferences apply before the app is ready) ---

const PRESETS_FILE = 'presets.json';
const PROJECTS_FILE = 'projects.json';
const SETTINGS_FILE = 'settings.json';
const SECRETS_FILE = 'secrets.bin';

const startupSettings = (readJsonFile(getUserDataPath(SETTINGS_FILE)) || {}) as Record<string, unknown>;
if (startupSettings.hardwareAcceleration === false) {
  app.disableHardwareAcceleration();
}

// --- Secrets: stored encrypted with the OS credential store (DPAPI / Keychain / libsecret) ---

type SecretName = 'claudeApiKey';
const SECRET_NAMES: SecretName[] = ['claudeApiKey'];

async function readSecrets(): Promise<Partial<Record<SecretName, string>>> {
  try {
    const file = getUserDataPath(SECRETS_FILE);
    if (!fs.existsSync(file) || !(await safeStorage.isAsyncEncryptionAvailable())) return {};
    const { result } = await safeStorage.decryptStringAsync(fs.readFileSync(file));
    return JSON.parse(result);
  } catch {
    return {};
  }
}

async function writeSecrets(secrets: Partial<Record<SecretName, string>>): Promise<void> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error('Secure credential storage is not available on this system.');
  }
  fs.writeFileSync(getUserDataPath(SECRETS_FILE), await safeStorage.encryptStringAsync(JSON.stringify(secrets)));
}

// Moves any plaintext API key left in settings.json by earlier versions into secure storage.
async function migratePlaintextSecrets(): Promise<void> {
  const file = getUserDataPath(SETTINGS_FILE);
  const settings = readJsonFile(file) as Record<string, unknown> | null;
  if (!settings || typeof settings.claudeApiKey !== 'string') return;
  const key = settings.claudeApiKey;
  const available = await safeStorage.isAsyncEncryptionAvailable();
  if (key && available) {
    await writeSecrets({ ...(await readSecrets()), claudeApiKey: key });
  }
  if (!key || available) {
    delete settings.claudeApiKey;
    writeJsonFile(file, settings);
    try {
      fs.rmSync(`${file}.bak`, { force: true });
    } catch {
      // Ignore cleanup failure
    }
  }
}

// --- Window ---

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0c0d10',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => win.webContents.send('window:maximized-changed', true));
  win.on('unmaximize', () => win.webContents.send('window:maximized-changed', false));

  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function senderWindow(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

// Window controls
ipcMain.on('window:minimize', (event) => senderWindow(event)?.minimize());
ipcMain.on('window:maximize', (event) => {
  const win = senderWindow(event);
  if (!win) return;
  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
});
ipcMain.on('window:close', (event) => senderWindow(event)?.close());
ipcMain.handle('window:isMaximized', (event) => senderWindow(event)?.isMaximized() ?? false);

// --- IPC Handlers for local data persistence ---

ipcMain.handle('presets:load', () => {
  return readJsonFile(getUserDataPath(PRESETS_FILE)) || [];
});

ipcMain.handle('presets:save', (_event, presets: unknown) => {
  if (!Array.isArray(presets)) throw new Error('Invalid presets data');
  writeJsonFile(getUserDataPath(PRESETS_FILE), presets);
  return true;
});

ipcMain.handle('projects:load', () => {
  return readJsonFile(getUserDataPath(PROJECTS_FILE)) || [];
});

ipcMain.handle('projects:save', (_event, projects: unknown) => {
  if (!Array.isArray(projects)) throw new Error('Invalid projects data');
  writeJsonFile(getUserDataPath(PROJECTS_FILE), projects);
  return true;
});

ipcMain.handle('settings:load', () => {
  return readJsonFile(getUserDataPath(SETTINGS_FILE)) || {};
});

ipcMain.handle('settings:save', (_event, settings: unknown) => {
  if (typeof settings !== 'object' || settings === null) throw new Error('Invalid settings data');
  // Never persist secrets in the plaintext settings file.
  const { claudeApiKey: _discard, ...safe } = settings as Record<string, unknown>;
  writeJsonFile(getUserDataPath(SETTINGS_FILE), safe);
  return true;
});

// --- Secrets ---

ipcMain.handle('secrets:status', async () => {
  const secrets = await readSecrets();
  return {
    encryptionAvailable: await safeStorage.isAsyncEncryptionAvailable(),
    claudeApiKey: Boolean(secrets.claudeApiKey),
  };
});

ipcMain.handle('secrets:set', async (_event, name: unknown, value: unknown) => {
  if (!SECRET_NAMES.includes(name as SecretName)) throw new Error('Unknown secret');
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid secret value');
  const key = value.trim();
  if (key.length < 20 || key.length > 512 || /\s/.test(key)) throw new Error('That doesn’t look like an API key. Copy the whole key from the Anthropic Console.');
  await writeSecrets({ ...(await readSecrets()), [name as SecretName]: key });
  pipeline.ai.keyChanged();
  return true;
});

ipcMain.handle('secrets:delete', async (_event, name: unknown) => {
  if (!SECRET_NAMES.includes(name as SecretName)) throw new Error('Unknown secret');
  const secrets = await readSecrets();
  delete secrets[name as SecretName];
  if (Object.keys(secrets).length === 0) {
    fs.rmSync(getUserDataPath(SECRETS_FILE), { force: true });
  } else {
    await writeSecrets(secrets);
  }
  pipeline.ai.keyChanged();
  return true;
});

// --- Dialogs & files ---

const FILE_FILTERS: Record<string, Electron.FileFilter[]> = {
  video: [{ name: 'Video', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv'] }],
  media: [{ name: 'Video & audio', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'mp3', 'wav', 'm4a', 'aac'] }],
  captions: [{ name: 'Captions & transcripts', extensions: ['srt', 'vtt', 'txt'] }],
  image: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg'] }],
  // Preset references: videos stay local (analysed on this computer); still images can be shown to
  // Claude when the editor ticks them for a run.
  reference: [{ name: 'Reference videos & images', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'png', 'jpg', 'jpeg', 'webp'] }],
};

ipcMain.handle('dialog:openFiles', async (event, options: { kind?: string; multiple?: boolean; title?: string }) => {
  const win = senderWindow(event);
  const opts: Electron.OpenDialogOptions = {
    title: options?.title,
    properties: options?.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: FILE_FILTERS[options?.kind ?? ''] ?? undefined,
  };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('dialog:openDirectory', async (event, options: { title?: string; defaultPath?: string }) => {
  const win = senderWindow(event);
  const opts: Electron.OpenDialogOptions = {
    title: options?.title,
    defaultPath: options?.defaultPath || undefined,
    properties: ['openDirectory', 'createDirectory'],
  };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('file:readText', (_event, filePath: unknown) => {
  if (typeof filePath !== 'string') throw new Error('Invalid path');
  const ext = path.extname(filePath).toLowerCase();
  if (!['.srt', '.vtt', '.txt'].includes(ext)) throw new Error('Unsupported file type');
  const stat = fs.statSync(filePath);
  if (stat.size > 5 * 1024 * 1024) throw new Error('File is too large (max 5 MB)');
  return fs.readFileSync(filePath, 'utf-8');
});

// Writes text to a location the user explicitly chooses in a save dialog.
ipcMain.handle(
  'file:saveText',
  async (event, options: { defaultPath?: string; content?: string; extensions?: string[]; name?: string }) => {
    if (typeof options?.content !== 'string') throw new Error('Invalid content');
    const win = senderWindow(event);
    const opts: Electron.SaveDialogOptions = {
      defaultPath: options.defaultPath,
      filters: options.extensions ? [{ name: options.name || 'File', extensions: options.extensions }] : undefined,
    };
    const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, options.content, 'utf-8');
    return result.filePath;
  }
);

ipcMain.handle('file:exists', (_event, filePath: unknown) => {
  return typeof filePath === 'string' && fs.existsSync(filePath);
});

// Only folders can be opened, so this can never launch an executable.
ipcMain.handle('shell:openFolder', async (_event, folderPath: unknown) => {
  if (typeof folderPath !== 'string' || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    throw new Error('Folder not found');
  }
  const error = await shell.openPath(folderPath);
  if (error) throw new Error(error);
  return true;
});

ipcMain.handle('shell:showItem', (_event, filePath: unknown) => {
  if (typeof filePath !== 'string' || !fs.existsSync(filePath)) throw new Error('File not found');
  shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: `${process.platform} ${process.arch}`,
  userDataPath: app.getPath('userData'),
  videosPath: app.getPath('videos'),
  hardwareAcceleration: startupSettings.hardwareAcceleration !== false,
}));

// --- Local transcription (FFmpeg + whisper.cpp, runs entirely on this machine) ---

const transcription = new TranscriptionService({
  userDataPath: app.getPath('userData'),
  getSettings: () => (readJsonFile(getUserDataPath(SETTINGS_FILE)) || {}) as ServiceSettings,
});
registerTranscriptionIpc(ipcMain, transcription);
// Hold the quit until cancelled jobs have killed their processes and deleted their temp audio
// (otherwise the WAV, ~115 MB per hour of media, is left in %TEMP%). Give up after 5 s.
let transcriptionStopped = false;
app.on('before-quit', (event) => {
  if (transcriptionStopped || !transcription.hasActiveJobs) return;
  event.preventDefault();
  transcriptionStopped = true;
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
  void Promise.race([transcription.cancelAll(), timeout]).finally(() => app.quit());
});

// --- Creative planning + sequence building (local planner; Claude only when the editor runs it) ---

// Test mode only: the E2E launcher (tests/e2e/launcher.cjs) sets EDISSISTANT_TEST_APPDATA, and the
// tests point Claude at a mock server on this machine. Never honoured otherwise, and only for a
// loopback address, so a stray environment variable can't send the key anywhere else.
function testAnthropicBaseURL(): string | undefined {
  const url = process.env.EDISSISTANT_ANTHROPIC_BASE_URL;
  if (!url || !process.env.EDISSISTANT_TEST_APPDATA || app.isPackaged) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ? url : undefined;
  } catch {
    return undefined;
  }
}

const pipeline = registerPipeline(ipcMain, {
  userDataPath: app.getPath('userData'),
  readSettings: () => (readJsonFile(getUserDataPath(SETTINGS_FILE)) || {}) as { ffmpegPath?: string },
  // Read from the encrypted store on every request; never cached, logged or sent to the renderer.
  getApiKey: async () => (await readSecrets()).claudeApiKey ?? null,
  encryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
  anthropicBaseURL: testAnthropicBaseURL(),
});

// --- Local media protocol ---

function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const mime = MEDIA_EXTENSIONS[path.extname(filePath).toLowerCase()];
      if (!mime || !path.isAbsolute(filePath) || !fs.existsSync(filePath)) {
        return new Response('Not found', { status: 404 });
      }
      const size = fs.statSync(filePath).size;
      const range = request.headers.get('range');
      const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;

      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? Math.min(parseInt(match[2], 10), size - 1) : size - 1;
        if (start >= size || start > end) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        }
        const stream = Readable.toWeb(fs.createReadStream(filePath, { start, end })) as ReadableStream;
        return new Response(stream, {
          status: 206,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
          },
        });
      }

      const stream = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream;
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': mime, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
      });
    } catch {
      return new Response('Error', { status: 500 });
    }
  });
}

app.whenReady().then(async () => {
  await migratePlaintextSecrets().catch(() => undefined);
  registerMediaProtocol();
  registerRenderEngine({
    userDataPath: app.getPath('userData'),
    readSettings: () => (readJsonFile(getUserDataPath(SETTINGS_FILE)) || {}) as { ffmpegPath?: string },
    isDev,
  });

  // Set CSP headers
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const media = `${MEDIA_SCHEME}:`;
    const csp = isDev
      ? `default-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:* ws://localhost:*; img-src 'self' data: ${media}; media-src 'self' ${media}; font-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' http://localhost:* ws://localhost:*`
      : `default-src 'self'; script-src 'self'; img-src 'self' data: ${media}; media-src 'self' ${media}; style-src 'self' 'unsafe-inline'; font-src 'self' data:`;
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
