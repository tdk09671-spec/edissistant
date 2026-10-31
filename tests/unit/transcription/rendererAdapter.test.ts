// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeSentence,
  startTranscription,
  transcriptToSegments,
  TRANSCRIPT_SCHEMA,
  TRANSCRIPT_SCHEMA_VERSION,
  type Transcript,
  type TranscriptionProgress,
  type TranscriptionResult,
} from '../../../src/renderer/lib/transcription';
import type { ElectronAPI } from '../../../src/renderer/types';

const transcript: Transcript = {
  schema: TRANSCRIPT_SCHEMA,
  version: TRANSCRIPT_SCHEMA_VERSION,
  id: 'abc',
  language: 'en',
  duration: 5,
  media: { path: 'C:\\Media\\Take 1.mov', name: 'Take 1.mov', size: 10, modifiedAt: '2026-01-01T00:00:00.000Z', fingerprint: 'f' },
  engine: { name: 'whisper.cpp', model: 'small.en', device: 'cpu', cpuFallback: false, threads: 4 },
  wordTiming: 'word',
  sentences: [
    makeSentence('s1', [{ text: 'Hello.', start: 0.5, end: 1 }]),
    makeSentence('s2', []),
    makeSentence('s3', [
      { text: 'Second', start: 2, end: 2.4 },
      { text: 'line.', start: 2.4, end: 3 },
    ]),
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  warnings: [],
};

afterEach(() => {
  delete (window as { electronAPI?: ElectronAPI }).electronAPI;
});

describe('transcriptToSegments', () => {
  it('creates one pending speaker segment per non-empty sentence', () => {
    const segments = transcriptToSegments(transcript);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ start: 0.5, end: 1, transcript: 'Hello.', visualMode: 'speaker', status: 'pending', instruction: '' });
    expect(segments[1]).toMatchObject({ start: 2, end: 3, transcript: 'Second line.' });
    expect(segments[0].id).not.toBe(segments[1].id);
  });
});

describe('startTranscription', () => {
  function mockApi(result: TranscriptionResult) {
    let listener: ((p: TranscriptionProgress) => void) | null = null;
    const api = {
      transcribe: vi.fn(async (jobId: string) => {
        listener?.({ jobId, stage: 'transcribing', progress: 0.5, message: '' });
        listener?.({ jobId: 'other-job', stage: 'transcribing', progress: 0.9, message: '' });
        return result;
      }),
      cancelTranscription: vi.fn(async () => true),
      onTranscriptionProgress: vi.fn((cb: (p: TranscriptionProgress) => void) => {
        listener = cb;
        return () => {
          listener = null;
        };
      }),
    };
    (window as { electronAPI?: unknown }).electronAPI = api;
    return api;
  }

  it('resolves with the transcript and only forwards its own progress', async () => {
    const api = mockApi({ ok: true, transcript, fromCache: false });
    const progress: number[] = [];
    const job = startTranscription('C:\\Media\\Take 1.mov', { language: 'en' }, (p) => progress.push(p.progress));
    await expect(job.result).resolves.toEqual({ transcript, fromCache: false });
    expect(api.transcribe).toHaveBeenCalledWith(job.jobId, { mediaPath: 'C:\\Media\\Take 1.mov', options: { language: 'en' } });
    expect(progress).toEqual([0.5]);
    await job.cancel();
    expect(api.cancelTranscription).toHaveBeenCalledWith(job.jobId);
  });

  it('rejects with a coded TranscriptionError', async () => {
    mockApi({ ok: false, error: { code: 'NO_AUDIO_STREAM', message: 'No audio' } });
    await expect(startTranscription('/a.mp4').result).rejects.toMatchObject({ code: 'NO_AUDIO_STREAM', message: 'No audio' });
  });

  it('rejects outside Electron', async () => {
    await expect(startTranscription('/a.mp4').result).rejects.toMatchObject({ code: 'ENGINE_NOT_FOUND' });
  });
});
