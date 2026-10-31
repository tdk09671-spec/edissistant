import { _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import type { Preset, Project } from '../../src/renderer/types';

export const FIXTURE_VIDEO = path.resolve(__dirname, '..', 'fixtures', 'sample.mp4');
const LAUNCHER = path.join(__dirname, 'launcher.cjs');

/** A fresh, empty appData folder unique to this test (under test-results/). */
export function freshAppData(testInfo: TestInfo): string {
  const dir = testInfo.outputPath('appdata');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const userDataDir = (appData: string) => path.join(appData, 'edissistant');
export const legacyDataDir = (appData: string) => path.join(appData, 'edissisant');

export function writeData(dir: string, file: string, data: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

export function readData<T = unknown>(dir: string, file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as T;
  } catch {
    return null;
  }
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
  errors: string[];
}

export async function launch(appData: string, env: Record<string, string> = {}): Promise<Launched> {
  const app = await electron.launch({
    args: [LAUNCHER],
    env: { ...process.env, ...env, EDISSISTANT_TEST_APPDATA: appData } as Record<string, string>,
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  await expect(page.locator('main')).toBeVisible();
  return { app, page, errors };
}

/** Closes the app and waits for pending writes to settle. */
export async function close(launched: Launched): Promise<void> {
  await launched.page.waitForTimeout(300);
  await launched.app.close();
}

export async function go(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => (location.hash = h), hash);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(hash);
}

const now = '2026-01-01T00:00:00.000Z';

export function makePreset(partial: Partial<Preset> = {}): Preset {
  return {
    id: `preset-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Test preset',
    clientName: 'Test client',
    type: 'custom',
    referenceLinks: [],
    referenceFiles: [],
    creativeBrief: '',
    fonts: '',
    tracking: '',
    logoPath: '',
    brandingNotes: '',
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

export function makeProject(partial: Partial<Project> = {}): Project {
  return {
    id: `project-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Test project',
    presetId: 'builtin-product-animation',
    presetName: 'Product Animation',
    presetType: 'product-animation',
    status: 'draft',
    segments: [],
    comments: [],
    versions: [],
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

export function segment(start: number, end: number, transcript = '') {
  return {
    id: `seg-${start}-${end}`,
    start,
    end,
    transcript,
    visualMode: 'speaker' as const,
    instruction: '',
    aiSuggestion: '',
    status: 'pending' as const,
  };
}
