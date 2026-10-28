import { expect, test } from '@playwright/test';
import { close, freshAppData, launch, userDataDir } from './helpers';

test('launches against the isolated data folder with the preload API', async ({}, testInfo) => {
  const appData = freshAppData(testInfo);
  const app = await launch(appData);
  const info = await app.page.evaluate(() => window.electronAPI!.getAppInfo());
  expect(info.userDataPath.toLowerCase()).toBe(userDataDir(appData).toLowerCase());
  expect(app.errors).toEqual([]);
  await close(app);
});

test('sidebar navigates between the main screens', async ({}, testInfo) => {
  const app = await launch(freshAppData(testInfo));
  const { page } = app;
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const [label, hash, heading] of [
    ['Projects', '#/projects', 'Projects'],
    ['Presets', '#/presets', 'Presets'],
    ['Home', '#/', 'What are we'],
  ] as const) {
    await nav.getByRole('link', { name: label }).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(hash);
    await expect(page.locator('main h1').first()).toContainText(heading);
  }
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/settings');
  await expect(page.locator('main h1').first()).toContainText('Settings');
  expect(app.errors).toEqual([]);
  await close(app);
});
