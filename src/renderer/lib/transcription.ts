// Sequence-editor integration for the local transcription engine. The UI doesn't call this yet;
// it is the supported entry point for wiring transcription into Workspace/Inspector.

import { v4 as uuid } from 'uuid';
import {
  sentencesToSegmentDrafts,
  serializeTranscript,
  transcriptToSrt,
  TranscriptionError,
  type SrtOptions,
  type Transcript,
  type TranscriptionOptions,
  type TranscriptionProgress,
} from '../../shared/transcription';
import type { Segment } from '../types';
import { createSegment } from './project';

export * from '../../shared/transcription';

/** One pending-review segment per transcript sentence. */
export function transcriptToSegments(transcript: Transcript): Segment[] {
  return sentencesToSegmentDrafts(transcript.sentences).map((d) => createSegment(d.start, d.end, { transcript: d.transcript }));
}

export interface TranscriptionJob {
  jobId: string;
  /** Resolves with the transcript, or rejects with a `TranscriptionError` (code `CANCELLED` on cancel). */
  result: Promise<{ transcript: Transcript; fromCache: boolean }>;
  cancel: () => Promise<boolean>;
}

/** Starts a transcription over IPC with progress callbacks and cancellation. */
export function startTranscription(
  mediaPath: string,
  options: TranscriptionOptions = {},
  onProgress?: (progress: TranscriptionProgress) => void
): TranscriptionJob {
  const api = window.electronAPI;
  const jobId = uuid();
  if (!api) {
    const error = new TranscriptionError('ENGINE_NOT_FOUND', 'Transcription needs the desktop app.');
    return { jobId, result: Promise.reject(error), cancel: async () => false };
  }
  const unsubscribe = onProgress ? api.onTranscriptionProgress((p) => p.jobId === jobId && onProgress(p)) : () => {};
  const result = api
    .transcribe(jobId, { mediaPath, options })
    .then((r) => {
      if (!r.ok) throw new TranscriptionError(r.error.code, r.error.message, r.error.details);
      return { transcript: r.transcript, fromCache: r.fromCache };
    })
    .finally(unsubscribe);
  return { jobId, result, cancel: () => api.cancelTranscription(jobId) };
}

/** Saves the transcript as JSON or SRT through the OS save dialog. Returns the chosen path or null. */
export async function saveTranscriptFile(transcript: Transcript, format: 'json' | 'srt', srtOptions?: SrtOptions): Promise<string | null> {
  const api = window.electronAPI;
  if (!api) return null;
  const base = transcript.media.name.replace(/\.[^.]+$/, '') || 'transcript';
  return api.saveTextFile({
    defaultPath: format === 'json' ? `${base}.transcript.json` : `${base}.srt`,
    content: format === 'json' ? serializeTranscript(transcript) : transcriptToSrt(transcript, srtOptions),
    extensions: [format],
    name: format === 'json' ? 'Transcript' : 'SubRip subtitles',
  });
}
