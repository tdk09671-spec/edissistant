import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Project } from '../../src/renderer/types';
import { FIXTURE_VIDEO, close, freshAppData, go, launch, makeProject, readData, segment, userDataDir, writeData, type Launched } from './helpers';

// Windows round 3 (Task D): an unapplied editor instruction was only mentioned after the export had
// been written. The Export page now names it before anything is written, offers Review, and an
// export made anyway is recorded as outdated.

const which = (name: string) => {
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  } catch {
    return '';
  }
};
const HAS_FFMPEG = Boolean(which('ffmpeg') && which('ffprobe'));

const ROWS = [
  { ...segment(0, 1.5, 'Revenue grew from $2 million to $9 million.'), id: 'r1' },
  { ...segment(1.5, 3, 'Book a demo today.'), id: 'r2' },
];
const project = (dir: string) => (readData<Project[]>(dir, 'projects.json') ?? [])[0];

async function settle(page: Page, timeout = 240_000) {
  await expect(page.getByTestId('pipeline-job')).toBeHidden({ timeout });
  const error = page.getByTestId('pipeline-error');
  if (await error.count()) throw new Error(`Pipeline error: ${await error.textContent()}`);
}

let app: Launched;
let data: string;
let out: string;
test.beforeEach(async ({}, testInfo) => {
  const appData = freshAppData(testInfo);
  data = userDataDir(appData);
  out = testInfo.outputPath('exports');
  fs.mkdirSync(out, { recursive: true });
  writeData(data, 'projects.json', [
    makeProject({
      id: 'p1',
      name: 'Export warning',
      source: { path: FIXTURE_VIDEO, name: 'sample.mp4' },
      segments: ROWS,
      exportSettings: { format: 'full-motion', resolution: '640x360', frameRate: '25', destination: out, fileName: 'warned', allowFontFallback: true },
    }),
  ]);
  app = await launch(appData);
  await go(app.page, '#/projects/p1');
  // Plan, approve both, then change r1's instruction in Review without applying it.
  const { page } = app;
  await page.getByRole('button', { name: 'Suggest visuals' }).click();
  await settle(page);
  for (const r of ROWS) {
    await page.locator('tbody tr').filter({ hasText: r.transcript }).click();
    await page.getByTestId('suggestion-panel').getByRole('button', { name: 'Approve', exact: true }).click();
    await settle(page);
  }
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await page.getByRole('listitem', { name: /Segment 1/ }).click();
  await page.getByLabel('Editor instruction').fill('make it a list');
  await expect(page.getByTestId('instruction-pending')).toBeVisible();
});
test.afterEach(async () => {
  expect(app.errors).toEqual([]);
  await close(app);
});

test('the Export page names an unapplied instruction before exporting and leads back to Review', async () => {
  const { page } = app;
  await page.getByRole('link', { name: 'Export', exact: true }).click();
  const warning = page.getByTestId('export-pending-changes');
  await expect(warning).toContainText('instruction for segment 1 changed and hasn’t been applied');
  // Start render asks first; Cancel writes nothing.
  await page.getByRole('button', { name: 'Start render' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export without the pending changes?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(fs.readdirSync(out)).toEqual([]);
  expect(project(data)?.exports ?? []).toEqual([]);
  // Go to Review from the warning, apply, and the Export page is clean again.
  await page.getByRole('button', { name: 'Go to Review' }).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/projects/p1/review');
  await page.getByRole('listitem', { name: /Segment 1/ }).click();
  await page.getByTestId('instruction-pending').getByRole('button', { name: 'Apply instruction' }).click();
  await settle(page);
  await page.getByRole('link', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start render' })).toBeVisible();
  await expect(page.getByTestId('export-pending-changes')).toHaveCount(0);
});

test('an export made anyway is recorded and shown as outdated', async () => {
  test.skip(!HAS_FFMPEG, 'needs FFmpeg and FFprobe on PATH to export');
  test.setTimeout(8 * 60_000);
  const { page } = app;
  await page.getByRole('link', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Start render' }).click();
  await page.getByRole('dialog', { name: 'Export without the pending changes?' }).getByRole('button', { name: 'Export anyway' }).click();
  await settle(page);
  await expect(page.getByTestId('pipeline-notice')).toHaveAttribute('data-tone', 'warning');
  await expect(page.getByTestId('last-export-outdated')).toContainText('instruction for segment 1');
  await expect.poll(() => project(data)?.exports?.[0]?.outdated).toMatch(/segment 1/);
  expect(fs.readdirSync(out).some((f) => f.startsWith('warned'))).toBe(true);
});
