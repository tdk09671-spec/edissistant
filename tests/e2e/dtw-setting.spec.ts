import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { AppSettings, Project } from '../../src/renderer/types';
import { FIXTURE_VIDEO, close, freshAppData, go, launch, makeProject, readData, userDataDir, writeData } from './helpers';

// Windows round 3 (Task C): DTW word alignment could only be requested programmatically. It is now
// an advanced setting (off by default), and every transcript says which timing it ended up with.
// Uses the stand-in whisper-cli through a shell wrapper that records each command line, so it runs
// on macOS/Linux only (Windows needs a real whisper-cli.exe; see docs/INTEGRATION.md).
const FAKE_WHISPER = path.resolve(__dirname, '..', 'fixtures', 'transcription', 'fake-whisper-cli.cjs');
const ffmpeg = (() => {
  try {
    return execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
})();

test.skip(process.platform === 'win32' || !ffmpeg, 'needs FFmpeg and a POSIX shell to run the stand-in engine');

async function settle(page: Page) {
  await expect(page.getByTestId('pipeline-job')).toBeHidden({ timeout: 120_000 });
  const error = page.getByTestId('pipeline-error');
  if (await error.count()) throw new Error(`Pipeline error: ${await error.textContent()}`);
}

test('the DTW setting is off by default, reaches whisper-cli when on, and the transcript says which timing it used', async ({}, testInfo) => {
  const appData = freshAppData(testInfo);
  const data = userDataDir(appData);
  const record = testInfo.outputPath('whisper-runs.jsonl');
  const wrapper = testInfo.outputPath('whisper-cli');
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_WHISPER}" "--fake-record=${record}" "$@"\n`, { mode: 0o755 });
  writeData(data, 'settings.json', { ffmpegPath: ffmpeg, transcription: { whisperPath: wrapper } });
  writeData(path.join(data, 'models'), 'ggml-base.en.bin', 'fake model');
  writeData(data, 'projects.json', [makeProject({ id: 'p1', name: 'DTW', source: { path: FIXTURE_VIDEO, name: 'sample.mp4' } })]);
  const runs = () => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]).filter((a) => a.includes('-m')) : []);
  const settings = () => readData<AppSettings>(data, 'settings.json');
  const project = () => readData<Project[]>(data, 'projects.json')?.[0];

  const app = await launch(appData);
  const { page } = app;

  // Off by default, and explained.
  await go(page, '#/settings');
  const toggle = page.getByRole('switch', { name: 'Precise word timing (DTW)' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText(/some models drop speech with it/)).toBeVisible();

  // Off: the fast path, no -dtw or -nfa.
  await go(page, '#/projects/p1');
  await page.getByRole('button', { name: 'Transcribe source' }).click();
  await settle(page);
  await expect(page.getByTestId('pipeline-notice')).toContainText('Word timing: standard.');
  expect(runs().at(-1)).not.toContain('-dtw');
  expect(runs().at(-1)).not.toContain('-nfa');
  await expect.poll(() => project()?.transcription?.timingMode).toBe('standard');

  // On: saved with the rest of the transcription settings, passed to whisper-cli with -nfa.
  await go(page, '#/settings');
  await page.getByRole('switch', { name: 'Precise word timing (DTW)' }).click();
  await expect.poll(() => settings()?.transcription).toMatchObject({ dtwAlignment: true, whisperPath: wrapper });
  await go(page, '#/projects/p1');
  // The sequence has rows now, so the toolbar's Transcribe asks before replacing them.
  await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
  await page.getByRole('button', { name: 'Transcribe and replace' }).click();
  await settle(page);
  expect(runs().at(-1)).toEqual(expect.arrayContaining(['-dtw', 'base.en', '-nfa']));
  await expect(page.getByTestId('pipeline-notice')).toContainText('Word timing: DTW alignment.');
  await expect.poll(() => project()?.transcription?.timingMode).toBe('dtw');
  expect(app.errors).toEqual([]);
  await close(app);
});
