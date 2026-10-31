import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import type { Project } from '../../src/renderer/types';
import { FIXTURE_VIDEO, close, freshAppData, go, launch, makeProject, readData, segment, userDataDir, writeData, type Launched } from './helpers';

// Round 3 (Task B): the editor corrects a graphic's on-screen in/out without touching the speech
// timing. At 29.97 (30000/1001) every change lands on an exact frame, re-renders only that graphic,
// survives a restart, and Reset brings back the speech timing (and the original render, from cache).

const which = (name: string) => {
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  } catch {
    return '';
  }
};
const HAS_FFMPEG = Boolean(which('ffmpeg') && which('ffprobe'));

const ROWS = [
  { ...segment(0, 1, 'Revenue grew from $2 million to $9 million.'), id: 'r1' },
  { ...segment(1, 2, 'First we listen, then we prototype, then we ship.'), id: 'r2' },
  { ...segment(2, 3, 'Book a demo today.'), id: 'r3' },
];
const FPS = 30000 / 1001;
const frameTime = (f: number) => (f * 1001) / 30000;

const project = (dir: string) => (readData<Project[]>(dir, 'projects.json') ?? [])[0];
const row = (dir: string, id: string) => project(dir)?.segments?.find((s) => s.id === id);

async function settle(page: Page, timeout = 240_000) {
  await expect(page.getByTestId('pipeline-job')).toBeHidden({ timeout });
  const error = page.getByTestId('pipeline-error');
  if (await error.count()) throw new Error(`Pipeline error: ${await error.textContent()}`);
}

let appData: string;
let data: string;
test.beforeEach(async ({}, testInfo) => {
  appData = freshAppData(testInfo);
  data = userDataDir(appData);
  writeData(data, 'projects.json', [
    makeProject({
      id: 'p1',
      name: 'Graphic timing',
      source: { path: FIXTURE_VIDEO, name: 'sample.mp4' },
      segments: ROWS,
      exportSettings: { format: 'full-motion', resolution: '640x360', frameRate: '29.97', destination: '', fileName: 'timing', allowFontFallback: true },
    }),
  ]);
});

test('the editor sets a graphic’s in/out on exact 29.97 frames; only it re-renders; it persists and resets to the speech timing', async () => {
  test.skip(!HAS_FFMPEG, 'needs FFmpeg and FFprobe on PATH to render the preview');
  test.setTimeout(10 * 60_000);
  let app: Launched = await launch(appData);
  let page = app.page;
  await go(page, '#/projects/p1');

  await page.getByRole('button', { name: 'Suggest visuals' }).click();
  await settle(page);
  const panel = page.getByTestId('suggestion-panel');
  for (const r of ROWS) {
    await page.locator('tbody tr').filter({ hasText: r.transcript }).click();
    await panel.getByRole('button', { name: 'Approve', exact: true }).click();
    await settle(page);
  }
  await page.getByRole('button', { name: 'Render preview' }).click();
  await settle(page);
  await expect.poll(() => project(data)?.render?.previewPath).toBeTruthy();
  const first = project(data)!.render!;
  const graphics = first.segments.filter((s) => s.status === 'renderable').map((s) => s.segmentId);
  expect(graphics).toContain('r1');

  // The graphic follows the speech timing until the editor changes it.
  await page.locator('tbody tr').filter({ hasText: ROWS[0].transcript }).click();
  const timing = page.getByTestId('graphic-timing');
  await expect(timing).toContainText('Follows the speech timing');
  await timing.getByRole('textbox', { name: 'Graphic in', exact: true }).fill('0.2');
  await timing.getByRole('textbox', { name: 'Graphic in', exact: true }).press('Enter');
  await timing.getByRole('textbox', { name: 'Graphic out', exact: true }).fill('0.9');
  await timing.getByRole('textbox', { name: 'Graphic out', exact: true }).press('Enter');
  // 0.2 s → frame 6 (0.2002 s), 0.9 s → frame 27 (0.9009 s): 21 frames, on the 30000/1001 grid.
  await expect(timing).toContainText('Adjusted');
  await expect(page.getByTestId('graphic-timing-frames')).toContainText('21 frames');
  await expect.poll(() => row(data, 'r1')?.visualTiming).toMatchObject({ start: frameTime(6), end: frameTime(27) });
  // One frame later with the nudge button: still exact.
  await timing.getByRole('button', { name: 'Graphic out one frame later' }).click();
  await expect.poll(() => row(data, 'r1')?.visualTiming?.end).toBe(frameTime(28));
  // An out point past the end of the video is refused with the reason.
  await timing.getByRole('textbox', { name: 'Graphic out', exact: true }).fill('9');
  await timing.getByRole('textbox', { name: 'Graphic out', exact: true }).press('Enter');
  await expect(timing).toContainText('can’t end after the end of the video');
  await expect.poll(() => row(data, 'r1')?.visualTiming?.end).toBe(frameTime(28));
  // The speech timing, transcript and approval are untouched.
  expect(row(data, 'r1')).toMatchObject({ start: 0, end: 1, transcript: ROWS[0].transcript, status: 'approved' });
  await expect(page.getByTestId('visual-adjusted')).toHaveCount(1);

  // Only the adjusted graphic re-renders.
  await page.getByRole('button', { name: 'Render preview' }).click();
  await settle(page);
  await expect(page.getByTestId('pipeline-notice')).toContainText('Rendered 1 graphic(s)');
  await expect.poll(() => project(data)?.render?.rendered).toEqual(['r1']);
  expect(project(data)!.render!.reused.sort()).toEqual(graphics.filter((g) => g !== 'r1').sort());
  expect(row(data, 'r1')!.plan).toMatchObject({ planStatus: 'approved' });
  expect(row(data, 'r1')!.plan!.stale).toBeUndefined();

  // Reopen: the adjusted timing is still there and still marked.
  expect(app.errors).toEqual([]);
  await close(app);
  app = await launch(appData);
  page = app.page;
  await go(page, '#/projects/p1');
  await page.locator('tbody tr').filter({ hasText: ROWS[0].transcript }).click();
  await expect(page.getByTestId('graphic-timing')).toContainText('Adjusted');
  await expect(page.getByTestId('graphic-timing-frames')).toContainText('22 frames');
  // The speech timing is still the transcribed one (1.000 s falls in frame 29 at 30000/1001).
  await expect(page.getByTestId('graphic-timing')).toContainText('Speech 00:00:00:00 → 00:00:00:29');

  // Reset: back to the speech timing, and the original render comes back from the cache.
  await page.getByTestId('graphic-timing').getByRole('button', { name: 'Reset to speech timing' }).click();
  await expect(page.getByTestId('graphic-timing')).toContainText('Follows the speech timing');
  await expect.poll(() => row(data, 'r1')?.visualTiming).toBeUndefined();
  await page.getByRole('button', { name: 'Render preview' }).click();
  await settle(page);
  await expect(page.getByTestId('pipeline-notice')).toContainText('Rendered 0 graphic(s)');
  await expect.poll(() => project(data)?.render?.rendered).toEqual([]);
  expect(app.errors).toEqual([]);
  await close(app);
});
