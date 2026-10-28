import { expect, test } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { TranscriptionProgress } from '../../src/renderer/types';
import { close, FIXTURE_VIDEO, freshAppData, launch, userDataDir, writeData } from './helpers';

// Drives transcription through the real main process, preload bridge and IPC, with real FFmpeg and
// the stand-in whisper-cli (a Node script). The stand-in is run directly via its shebang, which
// Windows can't do, so this spec only runs on macOS/Linux; Windows needs a real whisper-cli.exe.
const FAKE_WHISPER = path.resolve(__dirname, '..', 'fixtures', 'transcription', 'fake-whisper-cli.cjs');
const ffmpeg = (() => {
  try {
    return execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
})();

test.skip(process.platform === 'win32' || !ffmpeg, 'needs FFmpeg and a POSIX shell to run the stand-in engine');

test('transcribes over IPC with progress, caching and coded errors', async ({}, testInfo) => {
  const appData = freshAppData(testInfo);
  const userData = userDataDir(appData);
  writeData(userData, 'settings.json', { ffmpegPath: ffmpeg, transcription: { whisperPath: FAKE_WHISPER } });
  writeData(path.join(userData, 'models'), 'ggml-base.en.bin', 'fake model');
  fs.chmodSync(FAKE_WHISPER, 0o755);

  const app = await launch(appData);
  const { page } = app;

  const status = await page.evaluate(() => window.electronAPI!.getTranscriptionStatus());
  expect(status).toMatchObject({ ready: true, defaultModel: 'base.en', engine: { available: true, version: '0.0.0-fake' } });

  const run = (jobId: string) =>
    page.evaluate(
      async ({ jobId, mediaPath }) => {
        const api = window.electronAPI!;
        const events: TranscriptionProgress[] = [];
        const off = api.onTranscriptionProgress((p) => events.push(p));
        const result = await api.transcribe(jobId, { mediaPath });
        off();
        return { result, events };
      },
      { jobId, mediaPath: FIXTURE_VIDEO }
    );

  const first = await run('job-1');
  expect(first.result.ok).toBe(true);
  if (!first.result.ok) return;
  expect(first.result.fromCache).toBe(false);
  expect(first.result.transcript.sentences[0].text).toBe('Welcome back to the edit.');
  expect(first.events.map((e) => e.stage)).toContain('transcribing');
  expect(first.events[first.events.length - 1]).toMatchObject({ jobId: 'job-1', stage: 'done', progress: 1 });
  expect(fs.readdirSync(path.join(userData, 'transcripts'))).toEqual([`${first.result.transcript.id}.json`]);

  const second = await run('job-2');
  expect(second.result).toMatchObject({ ok: true, fromCache: true });
  const cached = await page.evaluate((mediaPath) => window.electronAPI!.getCachedTranscript({ mediaPath }), FIXTURE_VIDEO);
  expect(cached).toMatchObject({ ok: true, fromCache: true });

  const bad = await page.evaluate(() => window.electronAPI!.transcribe('job-3', { mediaPath: '/no/such/file.mov' }));
  expect(bad).toEqual({ ok: false, error: { code: 'FILE_NOT_FOUND', message: 'Media file not found: /no/such/file.mov' } });
  expect(await page.evaluate(() => window.electronAPI!.cancelTranscription('nothing-running'))).toBe(false);

  expect(await page.evaluate(() => window.electronAPI!.clearTranscriptCache())).toBe(1);
  expect(app.errors).toEqual([]);
  await close(app);
});
