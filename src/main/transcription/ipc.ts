import type { IpcMain } from 'electron';
import { toErrorInfo, type TranscriptionRequest, type TranscriptionResult } from '../../shared/transcription';
import type { TranscriptionService } from './service';

function isRequest(value: unknown): value is TranscriptionRequest {
  const request = value as TranscriptionRequest;
  return !!request && typeof request.mediaPath === 'string' && (request.options === undefined || typeof request.options === 'object');
}

function isJobId(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{1,64}$/.test(value);
}

/**
 * Channels:
 *  - transcription:status                → TranscriptionStatus
 *  - transcription:transcribe (id, req)  → TranscriptionResult; progress arrives as `transcription:progress` events
 *  - transcription:cancel (id)           → boolean
 *  - transcription:getCached (req)       → TranscriptionResult | null
 *  - transcription:clearCache            → number of entries removed
 */
export function registerTranscriptionIpc(ipcMain: IpcMain, service: TranscriptionService): void {
  ipcMain.handle('transcription:status', () => service.status());

  ipcMain.handle('transcription:transcribe', async (event, jobId: unknown, request: unknown): Promise<TranscriptionResult> => {
    if (!isJobId(jobId) || !isRequest(request)) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid transcription request.' } };
    }
    const sender = event.sender;
    // Closing the window cancels its jobs so no FFmpeg/whisper process is left running.
    const onDestroyed = () => service.cancel(jobId);
    sender.once('destroyed', onDestroyed);
    try {
      const { transcript, fromCache } = await service.transcribe(request, {
        jobId,
        onProgress: (progress) => {
          if (!sender.isDestroyed()) sender.send('transcription:progress', progress);
        },
      });
      return { ok: true, transcript, fromCache };
    } catch (error) {
      return { ok: false, error: toErrorInfo(error) };
    } finally {
      sender.removeListener('destroyed', onDestroyed);
    }
  });

  ipcMain.handle('transcription:cancel', (_event, jobId: unknown) => isJobId(jobId) && service.cancel(jobId));

  ipcMain.handle('transcription:getCached', (_event, request: unknown): TranscriptionResult | null => {
    if (!isRequest(request)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid transcription request.' } };
    try {
      const transcript = service.getCached(request);
      return transcript ? { ok: true, transcript, fromCache: true } : null;
    } catch (error) {
      return { ok: false, error: toErrorInfo(error) };
    }
  });

  ipcMain.handle('transcription:clearCache', () => service.clearCache());
}
