import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import type { Preset, Project } from '../../src/renderer/types';
import { close, freshAppData, go, launch, legacyDataDir, makePreset, makeProject, readData, userDataDir, writeData } from './helpers';

test.describe('persistence', () => {
  test('projects, presets and settings survive a restart; saves keep a .bak of the previous version', async ({}, testInfo) => {
    const appData = freshAppData(testInfo);
    const data = userDataDir(appData);

    let app = await launch(appData);
    await app.page.getByRole('button', { name: 'New project' }).first().click();
    await app.page.locator('#np-name').fill('Survives Restart');
    await app.page.getByRole('button', { name: 'Create project' }).click();
    await expect.poll(() => (readData<Project[]>(data, 'projects.json') ?? []).length).toBe(1);

    await go(app.page, '#/settings');
    const confirmToggle = app.page.getByRole('switch', { name: 'Confirm before deleting' });
    await expect(confirmToggle).toHaveAttribute('aria-checked', 'true');
    await confirmToggle.click();
    await expect.poll(() => readData<{ confirmBeforeDelete?: boolean }>(data, 'settings.json')?.confirmBeforeDelete).toBe(false);
    await close(app);

    // Seed a preset while the app is closed, then restart
    writeData(data, 'presets.json', [makePreset({ name: 'Survives Restart Preset' })]);
    app = await launch(appData);
    await go(app.page, '#/projects');
    await expect(app.page.getByText('Survives Restart', { exact: true }).first()).toBeVisible();
    await go(app.page, '#/presets');
    await expect(app.page.getByText('Survives Restart Preset').first()).toBeVisible();
    await go(app.page, '#/settings');
    await expect(app.page.getByRole('switch', { name: 'Confirm before deleting' })).toHaveAttribute('aria-checked', 'false');

    // A second save of projects.json must keep the previous version as .bak
    await go(app.page, '#/projects');
    await app.page.getByRole('button', { name: 'Actions for Survives Restart' }).click();
    await app.page.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect.poll(() => (readData<Project[]>(data, 'projects.json') ?? []).length).toBe(2);
    expect(readData<Project[]>(data, 'projects.json.bak')).toHaveLength(1);
    await close(app);
  });
});

test.describe('backup recovery', () => {
  test('a corrupt presets.json falls back to presets.json.bak', async ({}, testInfo) => {
    const appData = freshAppData(testInfo);
    const data = userDataDir(appData);
    writeData(data, 'presets.json', '{ this is not json');
    writeData(data, 'presets.json.bak', [makePreset({ name: 'Recovered From Bak' })]);
    const app = await launch(appData);
    await go(app.page, '#/presets');
    await expect(app.page.getByText('Recovered From Bak').first()).toBeVisible();
    await close(app);
  });

  test('corrupt data and backup: app starts empty and does not overwrite the files on launch', async ({}, testInfo) => {
    const appData = freshAppData(testInfo);
    const data = userDataDir(appData);
    writeData(data, 'projects.json', 'garbage');
    writeData(data, 'projects.json.bak', 'also garbage');
    const app = await launch(appData);
    await go(app.page, '#/projects');
    await expect(app.page.locator('main h1').first()).toContainText('Projects');
    await app.page.waitForTimeout(500);
    expect(fs.readFileSync(path.join(data, 'projects.json'), 'utf-8')).toBe('garbage');
    expect(fs.readFileSync(path.join(data, 'projects.json.bak'), 'utf-8')).toBe('also garbage');
    await close(app);
  });

  test('a valid empty file is trusted (the .bak is not loaded automatically)', async ({}, testInfo) => {
    // Documents current behaviour: .bak is only used when the main file cannot be parsed.
    const appData = freshAppData(testInfo);
    const data = userDataDir(appData);
    writeData(data, 'projects.json', []);
    writeData(data, 'projects.json.bak', [makeProject({ name: 'Only In Bak' })]);
    const app = await launch(appData);
    await go(app.page, '#/projects');
    await expect(app.page.getByText('Only In Bak')).toHaveCount(0);
    expect(readData<Project[]>(data, 'projects.json.bak')).toHaveLength(1);
    await close(app);
  });
});

test.describe('data migration', () => {
  test('legacy "edissisant" folder is moved to "edissistant" when no current data exists', async ({}, testInfo) => {
    const appData = freshAppData(testInfo);
    const legacy = legacyDataDir(appData);
    writeData(legacy, 'presets.json', [makePreset({ name: 'Legacy Preset' })]);
    writeData(legacy, 'projects.json', [makeProject({ name: 'Legacy Project' })]);
    const app = await launch(appData);
    await go(app.page, '#/projects');
    await expect(app.page.getByText('Legacy Project').first()).toBeVisible();
    await go(app.page, '#/presets');
    await expect(app.page.getByText('Legacy Preset').first()).toBeVisible();
    expect(fs.existsSync(legacy)).toBe(false);
    expect(readData<Preset[]>(userDataDir(appData), 'presets.json')?.[0].name).toBe('Legacy Preset');
    await close(app);
  });

  test('existing current data wins; the legacy folder is left untouched', async ({}, testInfo) => {
    const appData = freshAppData(testInfo);
    const legacy = legacyDataDir(appData);
    writeData(legacy, 'projects.json', [makeProject({ name: 'Old Legacy Project' })]);
    writeData(userDataDir(appData), 'projects.json', [makeProject({ name: 'Current Project' })]);
    const app = await launch(appData);
    await go(app.page, '#/projects');
    await expect(app.page.getByText('Current Project').first()).toBeVisible();
    await expect(app.page.getByText('Old Legacy Project')).toHaveCount(0);
    expect(readData<Project[]>(legacy, 'projects.json')?.[0].name).toBe('Old Legacy Project');
    await close(app);
  });

  test('regression: "Local State" alone in the current folder does not block the migration', async ({}, testInfo) => {
    // This is how real legacy data was stranded in %APPDATA%\edissisant.
    const appData = freshAppData(testInfo);
    const legacy = legacyDataDir(appData);
    writeData(legacy, 'projects.json', [makeProject({ name: 'Stranded Legacy Project' })]);
    writeData(legacy, 'projects.json.bak', [makeProject({ name: 'Older Legacy Project' })]);
    writeData(userDataDir(appData), 'Local State', '{}');
    const app = await launch(appData);
    await go(app.page, '#/projects');
    await expect(app.page.getByText('Stranded Legacy Project').first()).toBeVisible();
    expect(fs.existsSync(legacy)).toBe(false);
    expect(readData<Project[]>(userDataDir(appData), 'projects.json.bak')?.[0].name).toBe('Older Legacy Project');
    await close(app);
  });

  test('deleted presets and projects are not restored from the legacy folder', async ({}, testInfo) => {
    const appData = freshAppData(testInfo);
    const legacy = legacyDataDir(appData);
    writeData(legacy, 'presets.json', [makePreset({ name: 'Deleted Test Preset' })]);
    writeData(legacy, 'projects.json', [makeProject({ name: 'Deleted Test Project' })]);
    writeData(userDataDir(appData), 'presets.json', []);
    writeData(userDataDir(appData), 'projects.json', []);
    writeData(userDataDir(appData), 'Local State', '{}');
    const app = await launch(appData);
    await go(app.page, '#/projects');
    await expect(app.page.getByText('Deleted Test Project')).toHaveCount(0);
    await go(app.page, '#/presets');
    await expect(app.page.getByText('Deleted Test Preset')).toHaveCount(0);
    expect(readData<Project[]>(legacy, 'projects.json')).toHaveLength(1);
    await close(app);
  });

  test('a plaintext API key in settings.json is moved to encrypted storage', async ({}, testInfo) => {
    const appData = freshAppData(testInfo);
    const data = userDataDir(appData);
    writeData(data, 'settings.json', { claudeApiKey: 'sk-ant-test-not-a-real-key', autoSave: true });
    const app = await launch(appData);
    const status = await app.page.evaluate(() => window.electronAPI!.getSecretStatus());
    expect(status).toEqual({ encryptionAvailable: true, claudeApiKey: true });
    expect(fs.existsSync(path.join(data, 'secrets.bin'))).toBe(true);
    expect(fs.readFileSync(path.join(data, 'settings.json'), 'utf-8')).not.toContain('sk-ant');
    expect(fs.readFileSync(path.join(data, 'secrets.bin')).toString('latin1')).not.toContain('sk-ant');
    expect(readData<{ autoSave?: boolean }>(data, 'settings.json')?.autoSave).toBe(true);
    await close(app);
  });
});
