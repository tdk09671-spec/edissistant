import type { IpcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { RenderResult } from '../../shared/animation/api';
import { RenderError, toRenderErrorInfo } from '../../shared/animation/errors';
import type { RenderService } from './service';

function isJobId(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{1,64}$/.test(value);
}

function isOptions(value: unknown): value is Record<string, unknown> | undefined {
  return value === undefined || (typeof value === 'object' && value !== null && !Array.isArray(value));
}

const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f]/;

/** Copies a cached render out to a folder without overwriting existing files. */
export function exportRender(service: RenderService, sourcePath: unknown, destinationDir: unknown, fileName: unknown): string {
  if (typeof sourcePath !== 'string' || !service.cache.contains(sourcePath) || !fs.existsSync(sourcePath)) {
    throw new RenderError('INVALID_REQUEST', 'Only rendered files can be exported.');
  }
  if (typeof destinationDir !== 'string' || !path.isAbsolute(destinationDir) || !fs.existsSync(destinationDir) || !fs.statSync(destinationDir).isDirectory()) {
    throw new RenderError('INVALID_REQUEST', 'Choose an existing export folder.');
  }
  if (typeof fileName !== 'string' || !fileName.trim() || BAD_NAME.test(fileName) || fileName.length > 200) {
    throw new RenderError('INVALID_REQUEST', 'The file name contains characters that are not allowed.');
  }
  const ext = path.extname(sourcePath);
  const base = fileName.trim().replace(new RegExp(`${ext.replace('.', '\\.')}$`, 'i'), '');
  let target = path.join(destinationDir, `${base}${ext}`);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(destinationDir, `${base} (${n})${ext}`);
  fs.copyFileSync(sourcePath, target, fs.constants.COPYFILE_EXCL);
  return target;
}

/**
 * Channels:
 *  - render:status                           → RenderStatus
 *  - render:segment (jobId, spec, options)   → RenderResult<SegmentRenderResult>
 *  - render:sequence (jobId, seq, options)   → RenderResult<SequenceRenderResult>
 *  - render:cancel (jobId)                   → boolean
 *  - render:export (source, folder, name)    → RenderResult<string>
 *  - render:clearCache                       → number of entries removed
 *  - event render:progress                   → RenderProgress
 */
export function registerRenderIpc(ipcMain: IpcMain, service: RenderService): { cancelAll: () => void } {
  const jobs = new Map<string, AbortController>();

  const run = async <T>(event: Electron.IpcMainInvokeEvent, jobId: unknown, options: unknown, start: (h: { jobId: string; signal: AbortSignal }) => Promise<T>): Promise<RenderResult<T>> => {
    if (!isJobId(jobId) || !isOptions(options)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid render request.' } };
    if (jobs.has(jobId)) return { ok: false, error: { code: 'INVALID_REQUEST', message: `Job ${jobId} is already running.` } };
    const controller = new AbortController();
    jobs.set(jobId, controller);
    // Closing the window cancels its renders so no FFmpeg or sandbox is left running.
    const sender = event.sender;
    const onDestroyed = () => controller.abort();
    sender.once('destroyed', onDestroyed);
    try {
      return { ok: true, result: await start({ jobId, signal: controller.signal }) };
    } catch (error) {
      return { ok: false, error: toRenderErrorInfo(error) };
    } finally {
      jobs.delete(jobId);
      sender.removeListener('destroyed', onDestroyed);
    }
  };

  const progress = (event: Electron.IpcMainInvokeEvent) => (p: unknown) => {
    if (!event.sender.isDestroyed()) event.sender.send('render:progress', p);
  };

  ipcMain.handle('render:status', () => service.status());
  ipcMain.handle('render:segment', (event, jobId: unknown, spec: unknown, options: unknown) =>
    run(event, jobId, options, (h) => service.renderSegment(spec, (options ?? {}) as object, { ...h, onProgress: progress(event) }))
  );
  ipcMain.handle('render:sequence', (event, jobId: unknown, sequence: unknown, options: unknown) =>
    run(event, jobId, options, (h) => service.renderSequence(sequence, (options ?? {}) as object, { ...h, onProgress: progress(event) }))
  );
  ipcMain.handle('render:cancel', (_event, jobId: unknown) => {
    const controller = isJobId(jobId) ? jobs.get(jobId) : undefined;
    controller?.abort();
    return Boolean(controller);
  });
  ipcMain.handle('render:export', (_event, source: unknown, folder: unknown, name: unknown): RenderResult<string> => {
    try {
      return { ok: true, result: exportRender(service, source, folder, name) };
    } catch (error) {
      return { ok: false, error: toRenderErrorInfo(error) };
    }
  });
  ipcMain.handle('render:clearCache', () => service.cache.clear());

  return { cancelAll: () => jobs.forEach((c) => c.abort()) };
}
