// Wires the end-to-end pipeline (planning, sequence building, media checks) into the main process.
// Transcription (PR #1) and rendering (PR #2) keep their own services and channels.

import type { IpcMain } from 'electron';
import * as path from 'path';
import { findTools } from '../render/tools';
import { registerPipelineIpc } from './ipc';
import { PipelineService } from './service';

export { PipelineService } from './service';

export interface PipelineOptions {
  userDataPath: string;
  /** Reads settings.json on demand (ffmpegPath). */
  readSettings: () => { ffmpegPath?: string };
  /** The Claude key from the encrypted secrets store; read per request, never cached. */
  getApiKey: () => Promise<string | null | undefined>;
}

export function registerPipeline(ipcMain: IpcMain, options: PipelineOptions): PipelineService {
  const service = new PipelineService({ userDataPath: options.userDataPath, getApiKey: options.getApiKey });
  const ffprobe = () =>
    findTools({ configured: options.readSettings().ffmpegPath, searchDirs: [path.join(options.userDataPath, 'bin')], env: process.env, platform: process.platform }).ffprobe;
  registerPipelineIpc(ipcMain, service, ffprobe);
  return service;
}
