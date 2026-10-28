import { expect, test, type Page } from '@playwright/test';
import type { Project } from '../../src/renderer/types';
import { FIXTURE_VIDEO, close, freshAppData, go, launch, makeProject, readData, segment, userDataDir, writeData } from './helpers';

const project = (dir: string) => (readData<Project[]>(dir, 'projects.json') ?? [])[0];

// New segments focus a text field, where Ctrl+Z is intentionally left to the field; blur like a user clicking away.
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

async function waitForVideo(page: Page) {
  const video = page.locator('video').first();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
  return video;
}

function seed(testInfo: Parameters<Parameters<typeof test>[1]>[1]) {
  const appData = freshAppData(testInfo);
  const data = userDataDir(appData);
  writeData(data, 'projects.json', [
    makeProject({ id: 'p1', name: 'Media Project', source: { path: FIXTURE_VIDEO, name: 'sample.mp4' }, segments: [segment(0, 1.5, 'First'), segment(1.5, 3, 'Second')] }),
  ]);
  return { appData, data };
}

test('video preview loads through the media protocol and seeks', async ({}, testInfo) => {
  const { appData } = seed(testInfo);
  const app = await launch(appData);
  await go(app.page, '#/projects/p1');
  const video = await waitForVideo(app.page);
  const state = await video.evaluate((v: HTMLVideoElement) => ({ duration: v.duration, error: v.error?.code ?? null, src: v.currentSrc }));
  expect(state.error).toBeNull();
  expect(state.duration).toBeCloseTo(3, 0);
  expect(state.src.startsWith('edissistant-media://')).toBe(true);
  const seeked = await video.evaluate(
    (v: HTMLVideoElement) =>
      new Promise<number>((resolve) => {
        v.addEventListener('seeked', () => resolve(v.currentTime), { once: true });
        v.currentTime = 2.2;
      })
  );
  expect(seeked).toBeCloseTo(2.2, 1);
  expect(app.errors).toEqual([]);
  await close(app);
});

test('workspace: add segment (N), undo (Ctrl+Z) and redo (Ctrl+Shift+Z) persist to disk', async ({}, testInfo) => {
  const { appData, data } = seed(testInfo);
  const app = await launch(appData);
  const { page } = app;
  await go(page, '#/projects/p1');
  await waitForVideo(page);
  await blur(page);

  await page.keyboard.press('n');
  await expect.poll(() => project(data).segments!.length).toBe(3);
  await blur(page);
  await page.keyboard.press('Control+z');
  await expect.poll(() => project(data).segments!.length).toBe(2);
  await blur(page);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => project(data).segments!.length).toBe(3);
  await close(app);
});

test('review: comment, resolve, save version and restore it', async ({}, testInfo) => {
  const { appData, data } = seed(testInfo);
  const app = await launch(appData);
  const { page } = app;
  await go(page, '#/projects/p1/review');
  await waitForVideo(page);

  // Comment
  await page.getByLabel('New comment').fill('Hold the logo two frames longer');
  await page.getByRole('button', { name: 'Add comment' }).click();
  await expect.poll(() => project(data).comments!.map((c) => c.text)).toEqual(['Hold the logo two frames longer']);

  // Resolve, then reopen
  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect.poll(() => project(data).comments![0].resolved).toBe(true);
  await page.getByRole('radio', { name: /Resolved/ }).click();
  await page.getByRole('button', { name: 'Reopen' }).click();
  await expect.poll(() => project(data).comments![0].resolved).toBe(false);

  // Save a version
  await page.getByRole('radio', { name: /Versions/ }).click();
  await page.getByRole('button', { name: 'Save current version' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save version' });
  await dialog.locator('#version-label').fill('V1 client review');
  await dialog.getByRole('button', { name: 'Save version' }).click();
  await expect.poll(() => project(data).versions!.map((v) => v.label)).toEqual(['V1 client review']);
  expect(project(data).versions![0].segments).toHaveLength(2);

  // Change segments on disk-backed state via the Edit tab, then restore the version
  await go(page, '#/projects/p1');
  await waitForVideo(page);
  await blur(page);
  await page.keyboard.press('n');
  await expect.poll(() => project(data).segments!.length).toBe(3);

  await go(page, '#/projects/p1/review');
  await page.getByRole('radio', { name: /Versions/ }).click();
  await page.getByRole('button', { name: 'Restore this version' }).click();
  await page.getByRole('dialog', { name: 'Restore this version?' }).getByRole('button', { name: 'Restore version' }).click();
  await expect.poll(() => project(data).segments!.length).toBe(2);
  await close(app);
});
