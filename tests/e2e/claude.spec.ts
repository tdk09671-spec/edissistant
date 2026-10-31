import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Project } from '../../src/renderer/types';
import { FIXTURE_VIDEO, close, freshAppData, go, launch, makePreset, makeProject, readData, segment, userDataDir, writeData, type Launched } from './helpers';
import { GOOD_KEY, keyOf, MockAnthropic } from './mockAnthropic';

// Claude (V1, bring your own key) through the real UI, the real Anthropic SDK and the real main
// process, against a local mock of the Anthropic API. No real key, no network, no cost.

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
  { ...segment(1.5, 3, 'First we listen, then we prototype, then we ship.'), id: 'r2' },
  { ...segment(3, 4.5, 'Book a demo today.'), id: 'r3' },
];

const project = (dir: string) => (readData<Project[]>(dir, 'projects.json') ?? [])[0];

// The client's own words (Windows round 5: these must reach Claude word for word when ticked).
const BRIEF = 'Feels like a late-night radio show — warm, intimate, never shouty.\nUse the client’s "Quiet Hours" tagline once, near the end; 3 graphics max per minute!';
const BRANDING = 'Navy #0B1F3A with a single amber accent. Never use drop shadows.';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082', 'hex');
let lookPng: string;
let brokenPng: string;

/** The text blocks of the system prompt a recorded Messages request carried. */
const systemText = (body: string) => (JSON.parse(body).system as { text: string }[]).map((b) => b.text).join('\n');

async function settle(page: Page, timeout = 120_000) {
  await expect(page.getByTestId('pipeline-job')).toBeHidden({ timeout });
}

// Secret-leak checks (Windows round 5). While the app runs, Chromium keeps some of its own files in
// the data folder (caches, Local Storage, cookies) open and Windows locks them, so live checks read
// only what Edissistant itself writes. After every test the app is closed and the WHOLE data folder,
// Chromium's storage included, is scanned; a file that can't be read even then fails the test.

/** Files Edissistant writes in its data folder (main.ts, planning, transcription, render caches). */
const OWNED_TOP = /^(settings|projects|presets)\.json(\.bak|\.tmp)?$|^secrets\.bin$/;
const OWNED_DIRS = ['planning', 'transcripts', 'renders'];
const MAX_SCAN = 5 * 1024 * 1024; // rendered video in renders/ can't hold a key; skip big media

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
}

function ownedFiles(root: string): string[] {
  const top = fs.existsSync(root) ? fs.readdirSync(root).filter((f) => OWNED_TOP.test(f)).map((f) => path.join(root, f)) : [];
  return [...top, ...OWNED_DIRS.flatMap((d) => walk(path.join(root, d)))];
}

/** Reads a file, waiting briefly for Windows to release a handle the closed app may still hold. */
async function readSettled(file: string): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.readFileSync(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return Buffer.alloc(0); // removed while we listed (e.g. a journal file)
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '') || attempt >= 40) {
        throw new Error(`Couldn’t read ${file} for the secret scan after the app closed (${code}); the scan can’t be completed.`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

async function expectNoKeyIn(files: string[]) {
  for (const file of files) {
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_SCAN) continue;
    const text = (await readSettled(file)).toString('latin1');
    const wide = Buffer.from(GOOD_KEY.slice(0, 24), 'utf16le').toString('latin1'); // UTF-16 stores (leveldb, SQLite)
    expect(text.includes(GOOD_KEY.slice(0, 24)), `the key (or part of it) is in ${file}`).toBe(false);
    expect(text.includes(wide), `the key (UTF-16) is in ${file}`).toBe(false);
  }
}

/** While the app runs: Edissistant's own files, the logs and the page. */
async function expectNoKeyAnywhere(data: string, logs: string[], page?: string) {
  await expectNoKeyIn(ownedFiles(data));
  expect(logs.join('\n')).not.toContain(GOOD_KEY.slice(0, 24));
  if (page !== undefined) expect(page).not.toContain(GOOD_KEY.slice(0, 24));
}

let mock: MockAnthropic;
let app: Launched;
let appData: string;
let data: string;
let out: string;
let logs: string[];

async function start() {
  app = await launch(appData, { EDISSISTANT_ANTHROPIC_BASE_URL: mock.url });
  // Main-process output and every renderer console message, kept across restarts.
  app.app.process().stdout?.on('data', (d) => logs.push(String(d)));
  app.app.process().stderr?.on('data', (d) => logs.push(String(d)));
  app.page.on('console', (m) => logs.push(m.text()));
}

test.beforeEach(async ({}, testInfo) => {
  mock = new MockAnthropic();
  await mock.start();
  appData = freshAppData(testInfo);
  data = userDataDir(appData);
  logs = [];
  out = testInfo.outputPath('exports');
  fs.mkdirSync(out, { recursive: true });
  const refs = testInfo.outputPath('refs');
  fs.mkdirSync(refs, { recursive: true });
  lookPng = path.join(refs, 'look.png');
  brokenPng = path.join(refs, 'broken.png');
  fs.writeFileSync(lookPng, PNG);
  fs.writeFileSync(brokenPng, 'not really a png');
  writeData(data, 'presets.json', [
    makePreset({ id: 'preset-claude', name: 'Quiet Hours', clientName: 'Quiet Hours FM', creativeBrief: BRIEF, brandingNotes: BRANDING, referenceFiles: [FIXTURE_VIDEO, lookPng, brokenPng] }),
  ]);
  writeData(data, 'projects.json', [
    makeProject({
      id: 'p1',
      name: 'Claude trailer',
      presetId: 'preset-claude',
      presetName: 'Quiet Hours',
      source: { path: FIXTURE_VIDEO, name: 'sample.mp4' },
      segments: ROWS,
      exportSettings: { format: 'full-motion', resolution: '640x360', frameRate: '25', destination: out, fileName: 'claude', allowFontFallback: true },
    }),
  ]);
  await start();
});
test.afterEach(async () => {
  expect(app.errors).toEqual([]);
  await close(app);
  await mock.stop();
  // The app is closed: nothing is locked now, so every file it left is scanned, Chromium's included.
  const files = walk(data);
  expect(files.some((f) => f.endsWith('projects.json'))).toBe(true); // the scan really looked
  await expectNoKeyIn(files);
  expect(logs.join('\n')).not.toContain(GOOD_KEY.slice(0, 24));
});

/** Stores the key and chooses Claude through the same IPC the Settings page uses. */
async function enableClaude(page: Page) {
  await page.evaluate(async (key) => {
    await window.electronAPI!.setSecret('claudeApiKey', key);
    await window.electronAPI!.setAiProvider('anthropic');
  }, GOOD_KEY);
}

async function generate(page: Page) {
  await go(page, '#/projects/p1');
  await page.getByTestId('generate-claude').click();
  const dialog = page.getByTestId('claude-dialog');
  await expect(dialog.getByTestId('claude-estimate')).toBeVisible();
  return dialog;
}

test('Settings: the key is saved, tested, replaced and removed, and never reaches the page, files or logs', async () => {
  const { page } = app;
  await go(page, '#/settings');
  const section = page.locator('#claude');
  await expect(section.getByRole('radiogroup', { name: 'Planning provider' }).getByRole('radio', { name: 'Local only' })).toHaveAttribute('aria-checked', 'true');
  await section.getByRole('radio', { name: 'Anthropic Claude' }).click();
  await expect(section.getByTestId('claude-connection')).toContainText('No key');

  // Save → the field is cleared and only "stored securely" remains.
  await section.getByLabel('Anthropic API key').fill(GOOD_KEY);
  await section.getByRole('button', { name: 'Save key' }).click();
  await expect(section.getByText('API key stored securely')).toBeVisible();
  await expect(section.getByTestId('claude-connection')).toContainText('Not tested');
  expect(await page.content()).not.toContain(GOOD_KEY.slice(0, 24));

  // Test (free Models API) → Connected.
  await section.getByRole('button', { name: 'Test connection' }).click();
  await expect(section.getByTestId('claude-connection')).toContainText('Connected · Claude Opus 5.5');
  expect(mock.requests.map((r) => `${r.method} ${r.path.split('?')[0]}`)).toEqual(['GET /v1/models/claude-opus-5-5']);
  expect(keyOf(mock.requests[0].headers)).toBe(GOOD_KEY); // sent only to Anthropic (here, the mock)
  expect(mock.messageRequests).toHaveLength(0);

  // The IPC status carries no key, only booleans.
  const status = await page.evaluate(() => window.electronAPI!.getAiStatus());
  expect(JSON.stringify(status)).not.toContain('sk-ant');

  // Replace with a wrong key → the old test result is cleared; testing it fails clearly.
  await section.getByRole('button', { name: 'Replace' }).click();
  await section.getByLabel('Anthropic API key').fill('sk-ant-api03-WRONG-0000000000000000000000');
  await section.getByRole('button', { name: 'Save key' }).click();
  await expect(section.getByTestId('claude-connection')).toContainText('Not tested');
  await section.getByRole('button', { name: 'Test connection' }).click();
  await expect(section.getByTestId('claude-connection')).toContainText('Failed');
  await expect(section.getByText('The last test failed')).toBeVisible();
  await expect(section).toContainText('API key was rejected');
  expect(await page.content()).not.toContain('WRONG-0000');

  // A model this key can't use is named.
  await section.getByRole('button', { name: 'Replace' }).click();
  await section.getByLabel('Anthropic API key').fill(GOOD_KEY);
  await section.getByRole('button', { name: 'Save key' }).click();
  await section.getByLabel('Model').fill('claude-imaginary-9');
  await section.getByLabel('Model').press('Enter');
  await expect.poll(() => readData<{ models?: Record<string, string> }>(path.join(data, 'planning'), 'config.json')?.models?.['creative-planning']).toBe('claude-imaginary-9');
  await section.getByRole('button', { name: 'Test connection' }).click();
  await expect(section).toContainText('“claude-imaginary-9” isn’t available');
  await section.getByLabel('Model').fill('');
  await section.getByLabel('Model').press('Enter');
  await expect(section.getByLabel('Model')).toHaveValue('claude-opus-5-5');

  // Limits are saved, with the note that they are not Anthropic billing caps.
  await section.getByLabel('Project limit').fill('2.50');
  await section.getByLabel('Project limit').press('Enter');
  await section.getByLabel('Monthly limit (all projects)').fill('10');
  await section.getByLabel('Monthly limit (all projects)').press('Enter');
  await expect.poll(() => readData<{ budget?: { hardLimit?: number }; monthlyLimit?: number }>(path.join(data, 'planning'), 'config.json')).toMatchObject({ budget: { hardLimit: 2.5 }, monthlyLimit: 10 });
  await expect(section).toContainText('not Anthropic billing caps');

  await expectNoKeyAnywhere(data, logs, await page.content());
  // The encrypted file exists and doesn't hold the key in readable form.
  expect(fs.existsSync(path.join(data, 'secrets.bin'))).toBe(true);

  // Remove → deleted from disk; Claude runs are refused.
  await section.getByRole('button', { name: 'Remove' }).click();
  await expect(section.getByTestId('claude-connection')).toContainText('No key');
  expect(fs.existsSync(path.join(data, 'secrets.bin'))).toBe(false);
  expect(mock.messageRequests).toHaveLength(0);
});

test('Generate with Claude: consent first, Claude rows to review, approval, and reopening never sends again', async () => {
  const { page } = app;
  await enableClaude(page);
  const dialog = await generate(page);

  // Nothing sent yet; the dialog says what would go and what never goes.
  expect(mock.messageRequests).toHaveLength(0);
  await expect(dialog).toContainText('3 transcript row(s)');
  await expect(dialog).toContainText('Your source video and audio');
  await expect(dialog.getByTestId('claude-estimate')).toContainText('claude-opus-5-5');
  await expect(dialog.getByTestId('claude-estimate')).toContainText('1 to send');
  await expect(dialog.getByTestId('claude-limits')).toContainText('Project limit: none');
  await expect(dialog.getByTestId('claude-limits')).toContainText('Monthly limit: none');
  // The editor's own words are offered word for word (ticked); images only when ticked; videos never.
  await expect(dialog.getByLabel(/Creative brief, word for word/)).toBeChecked();
  await expect(dialog.getByLabel(/Branding notes, word for word/)).toBeChecked();
  await expect(dialog.getByLabel('Reference image look.png (adds roughly 1,600 input tokens)')).not.toBeChecked();
  await expect(dialog).toContainText('and the 1 reference video(s) in the preset');
  await expect(dialog.getByTestId('claude-style-summary')).toContainText('Client style profile');
  await dialog.getByLabel(/Branding notes, word for word/).uncheck(); // the editor leaves one out
  await expect(page.getByTestId('claude-confirm')).toBeEnabled();
  await page.getByTestId('claude-confirm').click();
  await settle(page);

  await expect(page.getByText('Claude suggested visuals for 3 segment(s)', { exact: true })).toBeVisible();
  const notice = page.getByTestId('pipeline-notice');
  await expect(notice).toContainText('input 2,400 tokens');
  await expect(notice).toContainText('output 900 tokens');
  await expect(notice).toContainText('cost calculated from these counts');
  await expect(page.getByTestId('row-source-claude')).toHaveCount(3);
  expect(mock.messageRequests).toHaveLength(1);
  const sent = mock.messageRequests[0].body;
  expect(sent).toContain('Revenue grew from $2 million to $9 million.');
  expect(systemText(sent)).toContain(BRIEF); // word for word: punctuation, quotes, line break
  expect(sent).not.toContain('Never use drop shadows'); // unticked
  for (const never of [FIXTURE_VIDEO, 'sample.mp4', 'look.png', 'broken.png', PNG.toString('base64')]) expect(sent).not.toContain(never);
  expect(JSON.stringify(JSON.parse(sent).messages)).not.toContain('"type":"image"');
  expect(JSON.parse(sent)).toMatchObject({ model: 'claude-opus-5-5', output_config: { format: { type: 'json_schema' } } });

  // Rows are suggestions, never approved for the editor.
  await expect.poll(() => project(data)?.segments?.every((s) => s.plan)).toBe(true);
  const rows = project(data)!.segments!;
  expect(rows.every((s) => s.plan?.source === 'model' && s.plan.planStatus === 'suggested' && s.status === 'pending')).toBe(true);
  expect(rows.find((s) => s.id === 'r1')?.plan?.conceptId).toBe('counter-hero');
  expect(rows.find((s) => s.id === 'r2')?.plan?.conceptId).toBe('process-steps');

  // Approve one; reject another and see it go back to Claude next time (with the rejection).
  await page.locator('tbody tr').filter({ hasText: ROWS[0].transcript }).click();
  await page.getByTestId('suggestion-panel').getByRole('button', { name: 'Approve', exact: true }).click();
  await settle(page);
  await expect.poll(() => project(data)?.segments?.find((s) => s.id === 'r1')?.status).toBe('approved');

  // Running Claude again on an unchanged project: nothing to send, the button is disabled.
  await page.getByTestId('generate-claude').click();
  await expect(page.getByTestId('claude-dialog')).toContainText('Nothing to send');
  await expect(page.getByTestId('claude-confirm')).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Usage: per project in the dialog and in Settings.
  await go(page, '#/settings');
  await expect(page.getByTestId('claude-usage')).toContainText('Claude trailer');
  await expect(page.getByTestId('claude-usage')).toContainText('Input tokens');
  await expect(page.getByTestId('claude-usage').locator('tbody tr').first()).toContainText('2,400');
  await expect(page.getByTestId('claude-usage').locator('tbody tr').first()).toContainText('900');

  // Reopen the app: the plan, the Claude marks and the approval are all there; nothing is sent.
  await close(app);
  await start();
  await go(app.page, '#/projects/p1');
  await expect(app.page.getByTestId('row-source-claude')).toHaveCount(3);
  await expect.poll(() => project(data)?.segments?.find((s) => s.id === 'r1')?.status).toBe('approved');
  expect(mock.messageRequests).toHaveLength(1);
  await expectNoKeyAnywhere(data, logs, await app.page.content());
});

test('a preview and an export of a Claude plan use the saved plan: no new request', async () => {
  test.skip(!HAS_FFMPEG, 'needs FFmpeg and FFprobe on PATH to render and export');
  test.setTimeout(10 * 60_000);
  const { page } = app;
  await enableClaude(page);
  const dialog = await generate(page);
  await page.getByTestId('claude-confirm').click();
  await settle(page);
  for (const r of ROWS) {
    await page.locator('tbody tr').filter({ hasText: r.transcript }).click();
    await page.getByTestId('suggestion-panel').getByRole('button', { name: 'Approve', exact: true }).click();
    await settle(page);
  }
  expect(mock.messageRequests).toHaveLength(1);

  await page.getByRole('button', { name: 'Render preview' }).click();
  await settle(page, 6 * 60_000);
  await expect(page.getByTestId('pipeline-notice')).toHaveAttribute('data-tone', 'success');
  await expect.poll(() => project(data)?.render?.previewPath).toBeTruthy();
  const rendered = project(data)!.render!.segments.filter((s) => s.status === 'renderable').map((s) => s.conceptId);
  expect(rendered).toEqual(expect.arrayContaining(['counter-hero', 'process-steps']));

  await page.getByRole('link', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Start render' }).click();
  await settle(page, 6 * 60_000);
  await expect(page.getByText('Export complete', { exact: true })).toBeVisible();
  expect(fs.readdirSync(out).some((f) => f.startsWith('claude'))).toBe(true);
  expect(mock.messageRequests).toHaveLength(1);
});

test('failures (bad key, no credit, rate limit, network, invalid answer) change nothing and are never retried', async () => {
  const { page } = app;
  await enableClaude(page);
  // Plan locally first, so there is a plan that must survive every failure untouched.
  await go(page, '#/projects/p1');
  await page.getByRole('button', { name: 'Suggest visuals' }).click();
  await settle(page);
  await expect.poll(() => project(data)?.segments?.every((s) => s.plan?.source === 'local')).toBe(true);
  const before = JSON.stringify(project(data)!.segments);

  const cases = [
    { mode: '401', title: 'API key rejected', text: 'Anthropic rejected the API key' },
    { mode: '402', title: 'No Anthropic credit left', text: 'no credit left' },
    { mode: '429', title: 'Rate limited by Anthropic', text: 'Nothing was retried automatically' },
    { mode: 'drop', title: 'No connection to Anthropic', text: 'Couldn’t reach Anthropic' },
    { mode: 'invalid-json', title: 'Claude’s answer was rejected', text: 'didn’t pass the app’s checks' },
  ] as const;
  for (const c of cases) {
    mock.mode = c.mode;
    const sentBefore = mock.messageRequests.length;
    const dialog = await generate(page);
    await page.getByTestId('claude-confirm').click();
    await settle(page);
    const error = page.getByTestId('pipeline-error');
    await expect(error).toContainText(c.text);
    await expect(page.getByText(c.title, { exact: true })).toBeVisible();
    await expect(error).toContainText('Nothing was changed');
    expect(mock.messageRequests.length - sentBefore, `${c.mode}: one request, no retry`).toBe(1);
    expect(JSON.stringify(project(data)!.segments)).toBe(before);
  }
  // A billed but invalid answer is still recorded in usage.
  const usage = await page.evaluate(() => window.electronAPI!.getAiUsage('p1'));
  expect(usage.ok && usage.result.history?.length).toBe(1);
  await expectNoKeyAnywhere(data, logs, await page.content());
});

test('a run in progress can be cancelled; a project limit refuses a run before anything is sent', async () => {
  const { page } = app;
  await enableClaude(page);
  mock.mode = 'hang';
  const dialog = await generate(page);
  await page.getByTestId('claude-confirm').click();
  await expect(page.getByTestId('pipeline-job')).toContainText('Generating with Claude');
  await expect.poll(() => mock.messageRequests.length).toBe(1);
  await page.getByTestId('pipeline-job').getByRole('button', { name: 'Cancel' }).click();
  await settle(page);
  await expect(page.getByText('Generating with Claude cancelled', { exact: true })).toBeVisible();
  await expect(page.getByTestId('pipeline-notice')).toContainText('may still be billed');
  expect(project(data)!.segments!.every((s) => !s.plan)).toBe(true);

  // A limit lower than the run's upper bound: refused in the dialog, nothing sent.
  await page.evaluate(() => window.electronAPI!.setAiConfig({ hardLimit: 0.001 }));
  mock.mode = 'ok';
  const limited = await generate(page);
  await expect(limited.getByTestId('claude-blocked')).toContainText('project’s limit of $0.00');
  await expect(page.getByTestId('claude-confirm')).toBeDisabled();
  expect(mock.messageRequests).toHaveLength(1);
});

test('warn-at, limit labels, an invalid reference image, and toasts kept clear of the dialog', async () => {
  const { page } = app;
  await enableClaude(page);
  await page.evaluate(() => window.electronAPI!.setAiConfig({ softLimit: 0.01, hardLimit: 5, monthlyLimit: 10 }));
  const dialog = await generate(page);
  await expect(dialog.getByTestId('claude-limits')).toContainText('Project limit: $5.00');
  await expect(dialog.getByTestId('claude-limits')).toContainText('Monthly limit: $10.00');
  await expect(dialog.getByTestId('claude-soft-warning')).toContainText('past your warning amount of $0.01');

  // While a dialog is open, toasts sit at the top, away from the Send button.
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('modal-open'))).toBe(true);
  expect(await page.getByTestId('toasts').evaluate((el) => getComputedStyle(el).top)).toBe('24px');

  // An invalid image: the error shows and the image choices stay, so it can be unticked again.
  const broken = dialog.getByLabel('Reference image broken.png (adds roughly 1,600 input tokens)');
  await broken.check();
  await expect(dialog.getByTestId('claude-error')).toContainText("broken.png isn't a valid PNG image");
  await expect(broken).toBeVisible();
  await expect(dialog.getByLabel('Reference image look.png (adds roughly 1,600 input tokens)')).toBeVisible();
  await expect(page.getByTestId('claude-confirm')).toBeDisabled();
  await broken.uncheck();
  await expect(dialog.getByTestId('claude-error')).toHaveCount(0);
  await expect(dialog.getByTestId('claude-estimate')).toBeVisible();
  expect(mock.messageRequests).toHaveLength(0);

  await page.getByTestId('claude-confirm').click();
  await settle(page);
  await expect(page.getByTestId('pipeline-notice')).toHaveAttribute('data-tone', 'warning');
  await expect(page.getByTestId('pipeline-notice')).toContainText('has passed your warning amount of $0.01');
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('modal-open'))).toBe(false);
  expect(await page.getByTestId('toasts').evaluate((el) => getComputedStyle(el).bottom)).toBe('24px');
  expect(mock.messageRequests).toHaveLength(1);
});

test('the secret scan itself catches a planted key (owned files and Chromium storage, UTF-8 and UTF-16)', async ({}, testInfo) => {
  const dir = testInfo.outputPath('planted');
  fs.mkdirSync(path.join(dir, 'Local Storage', 'leveldb'), { recursive: true });
  const owned = path.join(dir, 'settings.json');
  const chromium = path.join(dir, 'Local Storage', 'leveldb', '000003.log');
  fs.writeFileSync(owned, JSON.stringify({ note: `oops ${GOOD_KEY}` }));
  fs.writeFileSync(chromium, Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(GOOD_KEY, 'utf16le')]));
  await expect(expectNoKeyIn([owned])).rejects.toThrow(/settings\.json/);
  await expect(expectNoKeyIn([chromium])).rejects.toThrow(/000003\.log/);
  expect(ownedFiles(dir)).toEqual([owned]); // Chromium files are left to the after-close scan
  expect(walk(dir).sort()).toEqual([chromium, owned].sort());
});
