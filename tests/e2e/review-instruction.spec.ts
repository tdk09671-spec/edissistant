import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import type { Project } from '../../src/renderer/types';
import { FIXTURE_VIDEO, close, freshAppData, go, launch, makeProject, readData, segment, userDataDir, writeData, type Launched } from './helpers';

// Windows validation round 2 (a6fe66f), bug D, through the real UI: Review → a segment that is
// already approved → type a new editor instruction → Update preview. The preview used to report
// "Rendered 0, reused N" as a success and keep the old graphic; clicking the already-selected
// "Approved" did nothing. No transcription here (rows are typed), so this needs no stand-in engine
// and runs wherever FFmpeg is installed, Windows included.

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

const project = (dir: string) => (readData<Project[]>(dir, 'projects.json') ?? [])[0];
const row = (dir: string, id: string) => project(dir)?.segments?.find((s) => s.id === id);

async function settle(page: Page, timeout = 180_000) {
  await expect(page.getByTestId('pipeline-job')).toBeHidden({ timeout });
  const error = page.getByTestId('pipeline-error');
  if (await error.count()) throw new Error(`Pipeline error: ${await error.textContent()}`);
}

let app: Launched;
let data: string;
test.beforeEach(async ({}, testInfo) => {
  const appData = freshAppData(testInfo);
  data = userDataDir(appData);
  writeData(data, 'projects.json', [
    makeProject({
      id: 'p1',
      name: 'Review instruction',
      source: { path: FIXTURE_VIDEO, name: 'sample.mp4' },
      segments: ROWS,
      // Small and portable: the built-in preset's brand font isn't installed on test machines, and
      // fonts aren't what this test is about (the explicit Export setting allows a fallback).
      exportSettings: { format: 'full-motion', resolution: '640x360', frameRate: '25', destination: '', fileName: 'review', allowFontFallback: true },
    }),
  ]);
  app = await launch(appData);
  await go(app.page, '#/projects/p1');
});
test.afterEach(async () => {
  expect(app.errors).toEqual([]);
  await close(app);
});

async function planAndApproveAll(page: Page) {
  await page.getByRole('button', { name: 'Suggest visuals' }).click();
  await settle(page);
  await expect(page.getByTestId('row-suggestion')).toHaveCount(ROWS.length);
  const panel = page.getByTestId('suggestion-panel');
  for (const r of ROWS) {
    await page.locator('tbody tr').filter({ hasText: r.transcript }).click();
    await panel.getByRole('button', { name: 'Approve', exact: true }).click();
    await settle(page);
  }
  await expect.poll(() => project(data)?.segments?.every((s) => s.status === 'approved')).toBe(true);
}

test('an instruction edited in Review on an approved segment is applied and re-rendered, never silently ignored', async () => {
  test.skip(!HAS_FFMPEG, 'needs FFmpeg and FFprobe on PATH to render the preview');
  test.setTimeout(10 * 60_000);
  const { page } = app;
  await planAndApproveAll(page);

  await page.getByRole('button', { name: 'Render preview' }).click();
  await settle(page, 6 * 60_000);
  await expect(page.getByTestId('pipeline-notice')).toHaveAttribute('data-tone', 'success');
  await expect.poll(() => project(data)?.render?.previewPath).toBeTruthy();
  const first = project(data)!.render!;
  const graphics = first.segments.filter((s) => s.status === 'renderable').map((s) => s.segmentId);
  expect(graphics).toContain('r1');
  const before = row(data, 'r1')!.plan!.conceptId;
  const instruction = before === 'bar-comparison' ? 'make it a list' : 'Show it as bars.';
  const expected = before === 'bar-comparison' ? 'list-stack' : 'bar-comparison';

  // Review: the segment is approved; the editor types a new instruction.
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await page.getByRole('listitem', { name: /Segment 1/ }).click();
  await page.getByLabel('Editor instruction').fill(instruction);
  await expect.poll(() => row(data, 'r1')?.instruction).toBe(instruction);
  // The trap from the report: "Approved" is already selected, so clicking it can't do anything.
  await expect(page.getByRole('radiogroup', { name: 'Revision status' }).getByRole('radio', { name: 'Approved' })).toHaveAttribute('aria-checked', 'true');
  // Now the row says the instruction isn't applied yet.
  await expect(page.getByTestId('instruction-pending')).toContainText('Not applied yet');

  // Updating the preview before applying it renders nothing new and says so, as a warning.
  await page.getByRole('button', { name: 'Update preview' }).click();
  await settle(page, 6 * 60_000);
  const notice = page.getByTestId('pipeline-notice');
  await expect(notice).toHaveAttribute('data-tone', 'warning');
  await expect(notice).toContainText('instruction for segment 1 changed and hasn’t been applied');
  await expect.poll(() => project(data)?.render?.renderedAt).not.toBe(first.renderedAt);
  expect(project(data)!.render!.rendered).toEqual([]);
  expect(project(data)!.render!.segments.find((s) => s.segmentId === 'r1')?.status).not.toBe('renderable');

  // Apply it: replanned with the instruction and approved in one step.
  await page.getByTestId('instruction-pending').getByRole('button', { name: 'Apply instruction' }).click();
  await settle(page);
  await expect(page.getByText('Instruction applied', { exact: true })).toBeVisible();
  await expect.poll(() => row(data, 'r1')?.plan).toMatchObject({ conceptId: expected, planStatus: 'approved', plannedInstruction: instruction });
  await expect(page.getByTestId('instruction-pending')).toBeHidden();
  // Transcript and timing are untouched.
  expect(row(data, 'r1')).toMatchObject({ transcript: ROWS[0].transcript, start: 0, end: 1, instruction });

  // The preview re-renders only that graphic and reuses the rest.
  await page.getByRole('button', { name: 'Update preview' }).click();
  await settle(page, 6 * 60_000);
  await expect(page.getByTestId('pipeline-notice')).toHaveAttribute('data-tone', 'success');
  await expect(page.getByTestId('pipeline-notice')).toContainText('Rendered 1 graphic(s)');
  await expect.poll(() => project(data)?.render?.rendered).toEqual(['r1']);
  const after = project(data)!.render!;
  expect(after.rendered).toEqual(['r1']);
  expect(after.reused.sort()).toEqual(graphics.filter((g) => g !== 'r1').sort());
  expect(after.segments.find((s) => s.segmentId === 'r1')).toMatchObject({ status: 'renderable', conceptId: expected });
  expect(after.previewPath).not.toBe(first.previewPath);
});

test('an instruction the local planner can’t follow is reported, and the approved graphic can be kept explicitly', async () => {
  const { page } = app;
  await planAndApproveAll(page);
  const concept = row(data, 'r2')!.plan!.conceptId;
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await page.getByRole('listitem', { name: /Segment 2/ }).click();
  await page.getByLabel('Editor instruction').fill('make it feel more premium');
  await page.getByTestId('instruction-pending').getByRole('button', { name: 'Apply instruction' }).click();
  await settle(page);
  await expect(page.getByText('Instruction not applied', { exact: true })).toBeVisible();
  await expect(page.getByTestId('pipeline-notice')).toHaveAttribute('data-tone', 'warning');
  await expect.poll(() => row(data, 'r2')?.plan).toMatchObject({ conceptId: concept, planStatus: 'approved', plannedInstruction: '' });
  await expect(page.getByTestId('instruction-pending')).toBeVisible();

  // The Inspector offers the explicit choice to keep the approved graphic.
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await page.locator('tbody tr').filter({ hasText: ROWS[1].transcript }).click();
  const panel = page.getByTestId('suggestion-panel');
  await expect(panel.getByText('Instruction not applied yet')).toBeVisible();
  await panel.getByRole('button', { name: 'Keep current graphic' }).click();
  await settle(page);
  await expect.poll(() => row(data, 'r2')?.plan).toMatchObject({ conceptId: concept, planStatus: 'approved', plannedInstruction: 'make it feel more premium' });
  await expect.poll(() => row(data, 'r2')?.status).toBe('approved');
});

test('picking a concept that needs another visual mode says so on screen', async () => {
  const { page } = app;
  await page.getByRole('button', { name: 'Suggest visuals' }).click();
  await settle(page);
  await page.locator('tbody tr').filter({ hasText: ROWS[2].transcript }).click();
  await page.getByRole('radiogroup', { name: 'Visual mode' }).getByRole('radio', { name: 'Captions' }).click();
  await settle(page);
  await expect(page.getByTestId('suggestion-concept')).toHaveText('Emphasis captions');
  await page.locator('#seg-concept').selectOption({ label: 'Kinetic headline' });
  await settle(page);
  await expect(page.getByText('Visual mode switched', { exact: true })).toBeVisible();
  await expect(page.getByTestId('pipeline-notice')).toContainText('Kinetic headline needs Motion graphics, so the visual mode changed from Captions to Motion graphics.');
});
