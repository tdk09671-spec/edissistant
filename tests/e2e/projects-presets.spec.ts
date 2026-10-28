import { expect, test } from '@playwright/test';
import type { Preset, Project } from '../../src/renderer/types';
import { close, freshAppData, go, launch, makePreset, makeProject, readData, userDataDir, writeData } from './helpers';

const projectsOnDisk = (dir: string) => readData<Project[]>(dir, 'projects.json') ?? [];
const presetsOnDisk = (dir: string) => readData<Preset[]>(dir, 'presets.json') ?? [];

test('New Project dialog creates a project, opens it and saves it to disk', async ({}, testInfo) => {
  const appData = freshAppData(testInfo);
  const data = userDataDir(appData);
  const app = await launch(appData);
  const { page } = app;

  await page.getByRole('button', { name: 'New project' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.locator('#np-name').fill('E2E Created Project');
  await dialog.locator('#np-client').fill('E2E Client');
  await dialog.getByRole('button', { name: 'Create project' }).click();

  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/projects\/[^/]+$/);
  await expect.poll(() => projectsOnDisk(data).map((p) => p.name)).toEqual(['E2E Created Project']);
  expect(projectsOnDisk(data)[0].clientName).toBe('E2E Client');
  expect(app.errors).toEqual([]);
  await close(app);
});

test('project card menu renames, duplicates and deletes (with confirmation)', async ({}, testInfo) => {
  const appData = freshAppData(testInfo);
  const data = userDataDir(appData);
  writeData(data, 'projects.json', [makeProject({ id: 'alpha', name: 'Alpha' })]);
  const app = await launch(appData);
  const { page } = app;
  await go(page, '#/projects');

  // Rename
  await page.getByRole('button', { name: 'Actions for Alpha' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const renameDialog = page.getByRole('dialog', { name: 'Rename project' });
  await renameDialog.locator('#rename-project').fill('Alpha Renamed');
  await renameDialog.getByRole('button', { name: 'Rename' }).click();
  await expect.poll(() => projectsOnDisk(data).map((p) => p.name)).toEqual(['Alpha Renamed']);

  // Duplicate
  await page.getByRole('button', { name: 'Actions for Alpha Renamed' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect.poll(() => projectsOnDisk(data).length).toBe(2);
  const copy = projectsOnDisk(data).find((p) => p.id !== 'alpha')!;
  expect(copy.name).toContain('Alpha Renamed');

  // Delete the original — confirm dialog must appear first, and cancel must keep it
  await page.getByRole('button', { name: 'Actions for Alpha Renamed' }).first().click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete this project?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  expect(projectsOnDisk(data)).toHaveLength(2);

  await page.getByRole('button', { name: 'Actions for Alpha Renamed' }).first().click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete this project?' }).getByRole('button', { name: 'Delete project' }).click();
  await expect.poll(() => projectsOnDisk(data).length).toBe(1);
  await close(app);
});

test('preset wizard validates, keeps input across steps and saves', async ({}, testInfo) => {
  const appData = freshAppData(testInfo);
  const data = userDataDir(appData);
  const app = await launch(appData);
  const { page } = app;
  await go(page, '#/presets/new');

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('A preset name is required.')).toBeVisible();

  await page.locator('#preset-name').fill('E2E Preset');
  await page.locator('#preset-client').fill('E2E Client');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByLabel('Reference link 1').fill('vimeo.com/42');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/Enter a full URL/)).toBeVisible();
  await page.getByLabel('Reference link 1').fill('https://vimeo.com/42');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.locator('#brief').fill('Fast cuts on the beat');
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByLabel('Reference link 1')).toHaveValue('https://vimeo.com/42');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#brief')).toHaveValue('Fast cuts on the beat');

  // Continue through remaining steps until the save button appears
  for (let i = 0; i < 4 && !(await page.getByRole('button', { name: 'Save preset' }).isVisible()); i++) {
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await page.getByRole('button', { name: 'Save preset' }).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/presets');
  await expect.poll(() => presetsOnDisk(data).map((p) => p.name)).toEqual(['E2E Preset']);
  const saved = presetsOnDisk(data)[0];
  expect(saved.referenceLinks).toEqual(['https://vimeo.com/42']);
  expect(saved.creativeBrief).toBe('Fast cuts on the beat');
  await close(app);
});

test('preset card menu duplicates and deletes a preset', async ({}, testInfo) => {
  const appData = freshAppData(testInfo);
  const data = userDataDir(appData);
  writeData(data, 'presets.json', [makePreset({ id: 'p1', name: 'Brand Alpha' })]);
  const app = await launch(appData);
  const { page } = app;
  await go(page, '#/presets');

  await page.getByRole('button', { name: 'Actions for Brand Alpha' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect.poll(() => presetsOnDisk(data).length).toBe(2);

  await page.getByRole('button', { name: 'Actions for Brand Alpha' }).first().click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete preset' }).click();
  await expect.poll(() => presetsOnDisk(data).length).toBe(1);
  await close(app);
});
