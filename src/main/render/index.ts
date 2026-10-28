// Wires the animation/render engine into the Electron main process.
import { app, ipcMain } from 'electron';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { chromiumFrameSourceFactory, type SandboxPage } from './chromiumFrameSource';
import { registerRenderIpc } from './ipc';
import { RenderService } from './service';
import { findTools } from './tools';

export { RenderService } from './service';

export interface RenderEngineOptions {
  userDataPath: string;
  /** Reads settings.json on demand (for ffmpegPath). */
  readSettings: () => { ffmpegPath?: string };
  isDev: boolean;
}

function sandboxPage(isDev: boolean): SandboxPage {
  if (isDev) {
    const origin = 'http://localhost:5173';
    return { url: `${origin}/render-sandbox.html`, isAllowed: (url) => url.startsWith(`${origin}/`) || url.startsWith('data:') || url.startsWith('blob:') };
  }
  const dir = path.join(__dirname, '../../renderer');
  const base = pathToFileURL(dir).href;
  return {
    url: pathToFileURL(path.join(dir, 'render-sandbox.html')).href,
    isAllowed: (url) => url.startsWith(`${base}/`) || url.startsWith('data:') || url.startsWith('blob:'),
  };
}

export function registerRenderEngine(options: RenderEngineOptions): RenderService {
  const service = new RenderService({
    cacheDir: path.join(options.userDataPath, 'renders'),
    findTools: () =>
      findTools({
        configured: options.readSettings().ffmpegPath,
        searchDirs: [path.join(options.userDataPath, 'bin')],
        env: process.env,
        platform: process.platform,
      }),
    createFrameSource: chromiumFrameSourceFactory(sandboxPage(options.isDev)),
  });
  const ipc = registerRenderIpc(ipcMain, service);
  app.on('before-quit', () => ipc.cancelAll());
  return service;
}
