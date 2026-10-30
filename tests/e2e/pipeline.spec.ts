import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Project } from '../../src/renderer/types';
import { close, freshAppData, launch, makePreset, readData, userDataDir, writeData, type Launched } from './helpers';

// The whole editing pipeline through the real app: New project → link footage → Transcribe (PR #1
// service with real FFmpeg extraction) → Suggest visuals (PR #3, local planner) → approve/reject →
// Render preview (PR #2 sandboxed renderer + FFmpeg composite over the footage, with its audio) →
// export the three deliverables → reopen → revise one segment → only that segment re-renders.
//
// The footage is synthetic (flite speech, generated per run). The one stand-in is whisper-cli: PR #1's
// fake engine returns the transcript of that speech, so no model download is needed. POSIX-only.

const which = (name: string) => {
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const FFMPEG = which('ffmpeg');
const FFPROBE = which('ffprobe');
const hasFlite = (() => {
  try {
    return FFMPEG ? execFileSync(FFMPEG, ['-hide_banner', '-filters'], { encoding: 'utf8' }).includes(' flite ') : false;
  } catch {
    return false;
  }
})();

test.skip(process.platform === 'win32' || !FFMPEG || !FFPROBE || !hasFlite, 'needs FFmpeg with flite, FFprobe and a POSIX shell for the stand-in whisper-cli');

const MEDIA = path.resolve(__dirname, '..', '..', 'test-results', 'pipeline-media');
const VIDEO = path.join(MEDIA, 'trailer.mp4');
interface Script {
  fps: string;
  duration: number;
  sentences: { text: string; start: number; end: number }[];
}
let script: Script;

test.beforeAll(() => {
  if (!fs.existsSync(VIDEO)) {
    execFileSync(process.execPath, [path.resolve(__dirname, '..', 'fixtures', 'pipeline', 'make-trailer.cjs'), MEDIA, `--ffmpeg=${FFMPEG}`], { stdio: 'inherit' });
  }
  script = JSON.parse(fs.readFileSync(path.join(MEDIA, 'script.json'), 'utf8'));
});

const PRESET = makePreset({
  id: 'preset-cutting-room',
  name: 'Cutting Room podcast',
  clientName: 'The Cutting Room',
  type: 'podcast-trailer',
  creativeBrief: 'Bold, editorial podcast trailer. Kinetic type on key lines, big numbers for stats. No bouncy motion.',
  fonts: 'Inter Bold, Inter Medium',
  tracking: 'Tight',
  brandColors: ['#111216', '#E9A94B'],
});

function setup(appData: string, whisper = path.join(MEDIA, 'whisper-cli'), models = path.join(MEDIA, 'models')) {
  const userData = userDataDir(appData);
  writeData(userData, 'settings.json', { ffmpegPath: FFMPEG, autoSave: true, transcription: { whisperPath: whisper, modelsDirectory: models } });
  writeData(userData, 'presets.json', [PRESET]);
  return userData;
}

/** Makes the next OS file/folder dialog return `file` (the dialog itself can't be driven). */
async function nextDialogReturns(app: ElectronApplication, file: string) {
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as typeof dialog.showOpenDialog;
  }, file);
}

const project = (userData: string) => readData<Project[]>(userData, 'projects.json')?.[0];

async function settle(page: Page, timeout = 120_000) {
  await expect(page.getByTestId('pipeline-job')).toBeHidden({ timeout });
  const error = page.getByTestId('pipeline-error');
  if (await error.count()) throw new Error(`Pipeline error: ${await error.textContent()}`);
}

async function createProject(page: Page, app: ElectronApplication) {
  await page.evaluate(() => (location.hash = '#/projects'));
  await page.getByRole('button', { name: 'New project' }).first().click();
  await page.locator('#np-name').fill('Cutting Room trailer');
  await page.getByRole('radio', { name: /Cutting Room podcast/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Sequence' })).toBeVisible();
  await nextDialogReturns(app, VIDEO);
  await page.getByRole('button', { name: 'Choose video…' }).click();
}

/** Grey 64×36 thumbnail of the frame at `seconds` (accurate seek). */
function frame(file: string, seconds: number): Buffer {
  return execFileSync(FFMPEG, ['-v', 'error', '-ss', seconds.toFixed(4), '-i', file, '-frames:v', '1', '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', 'pipe:1']);
}
/** Share of pixels that differ clearly between two thumbnails. */
function changed(a: Buffer, b: Buffer): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 40) n++;
  return n / a.length;
}

function probe(file: string) {
  return JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-count_packets', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' })) as {
    streams: { codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate: string; nb_read_packets: string; pix_fmt?: string }[];
    format: { duration: string };
  };
}

test('transcribe → plan → approve → render → export → reopen → revise one segment', async ({}, testInfo) => {
  test.setTimeout(15 * 60_000);
  const appData = freshAppData(testInfo);
  const userData = setup(appData);
  const out = testInfo.outputPath('exports');
  fs.mkdirSync(out, { recursive: true });
  let app: Launched = await launch(appData);
  const { page } = app;

  // 1. Import: new project with the client preset, link the footage; its 29.97 fps timing is adopted.
  await createProject(page, app.app);
  await expect.poll(() => project(userData)?.exportSettings?.frameRate, { timeout: 15_000 }).toBe('29.97');
  expect(project(userData)?.source).toMatchObject({ path: VIDEO });
  expect(project(userData)?.source?.duration).toBeCloseTo(script.duration, 1);

  // 2. Transcription through PR #1's service; one row per sentence, timed from the speech.
  await page.getByRole('button', { name: 'Transcribe source' }).click();
  await settle(page);
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(script.sentences.length);
  await expect(page.getByTestId('pipeline-notice')).toContainText('model base.en');
  await expect.poll(() => project(userData)?.segments?.length).toBe(script.sentences.length);
  const transcribed = [...project(userData)!.segments!].sort((a, b) => a.start - b.start);
  transcribed.forEach((s, i) => {
    expect(s.transcript).toBe(script.sentences[i].text);
    expect(Math.abs(s.start - script.sentences[i].start)).toBeLessThan(0.02);
    expect(Math.abs(s.end - script.sentences[i].end)).toBeLessThan(0.02);
    expect(s.words?.length).toBeGreaterThan(2);
  });
  expect(project(userData)?.transcription).toMatchObject({ language: 'en', model: 'base.en', wordTiming: 'interpolated' });

  // 3. Local creative plan: every row gets a concept and reasoning; nothing is approved yet.
  await page.getByRole('button', { name: 'Suggest visuals' }).click();
  await settle(page);
  await expect(page.getByTestId('row-suggestion')).toHaveCount(script.sentences.length);
  await expect.poll(() => project(userData)?.segments?.every((s) => s.plan && s.status === 'pending')).toBe(true);
  const firstPlan = Object.fromEntries(project(userData)!.segments!.map((s) => [s.id, s.plan!.conceptId]));

  // 4. Editor decisions: reject one idea and ask for another, approve everything.
  const byText = (text: string) => rows.filter({ hasText: text });
  await byText('So we asked one question.').click();
  const panel = page.getByTestId('suggestion-panel');
  await panel.getByRole('button', { name: 'Reject' }).click();
  await settle(page);
  await expect.poll(() => project(userData)?.segments?.find((s) => s.transcript === 'So we asked one question.')?.status).toBe('needs-revision');
  await page.getByRole('button', { name: 'Suggest visuals' }).click();
  await settle(page);
  const rejectedRow = () => project(userData)!.segments!.find((s) => s.transcript === 'So we asked one question.')!;
  await expect.poll(() => rejectedRow().plan?.planStatus).toBe('suggested');
  expect(rejectedRow().plan!.conceptId).not.toBe(firstPlan[rejectedRow().id]);

  for (const sentence of script.sentences) {
    await byText(sentence.text).click();
    await panel.getByRole('button', { name: 'Approve', exact: true }).click();
    await settle(page);
  }
  await expect.poll(() => project(userData)?.segments?.every((s) => s.status === 'approved')).toBe(true);
  const approved = project(userData)!.segments!;
  // Approval never touches the transcript, timing or instructions.
  approved.forEach((s) => expect(transcribed.find((t) => t.id === s.id)).toMatchObject({ transcript: s.transcript, start: s.start, end: s.end, instruction: s.instruction }));

  // 5. Render: approved graphics through PR #2, composited over the footage with its audio.
  await page.getByRole('button', { name: 'Render preview' }).click();
  await settle(page, 10 * 60_000);
  await expect(page.getByTestId('pipeline-notice')).toContainText('Rendered');
  await expect.poll(() => project(userData)?.render?.previewPath).toBeTruthy();
  const render = project(userData)!.render!;
  const graphics = render.segments.filter((r) => r.status === 'renderable').map((r) => r.segmentId);
  expect(graphics.length).toBeGreaterThanOrEqual(4);
  expect(render.rendered.sort()).toEqual([...graphics].sort());
  expect(render.reused).toEqual([]);
  await expect(page.getByRole('radio', { name: 'Rendered preview' })).toHaveAttribute('aria-checked', 'true');

  const preview = probe(render.previewPath);
  const pv = preview.streams.find((s) => s.codec_type === 'video')!;
  expect(pv.r_frame_rate).toBe('30000/1001');
  expect(preview.streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac')).toBe(true);
  expect(Math.abs(Number(pv.nb_read_packets) - Math.round((script.duration * 30000) / 1001))).toBeLessThanOrEqual(1);

  // Graphic timing: no graphic shows before its first frame (snapped to the 30000/1001 grid), and a
  // full-frame graphic is on screen from exactly that frame. -ss returns the first frame at or after
  // the time, so aim just before frame f's timestamp.
  const fps = 30000 / 1001;
  const at = (f: number) => (f - 0.25) / fps;
  let exact = 0;
  for (const id of graphics) {
    const seg = approved.find((s) => s.id === id)!;
    const first = Math.round(seg.start * fps);
    expect(changed(frame(render.previewPath, at(first - 1)), frame(VIDEO, at(first - 1)))).toBeLessThan(0.02);
    const mid = Math.round(((seg.start + seg.end) / 2) * fps);
    if (changed(frame(render.previewPath, at(mid)), frame(VIDEO, at(mid))) > 0.3) {
      expect(changed(frame(render.previewPath, at(first)), frame(VIDEO, at(first)))).toBeGreaterThan(0.3);
      exact++;
    }
  }
  expect(exact).toBeGreaterThanOrEqual(2);

  // 6. Export the three deliverables; every file is checked by the app and again here.
  await page.getByRole('link', { name: 'Export' }).click();
  await nextDialogReturns(app.app, out);
  await page.getByRole('button', { name: 'Browse…' }).click();
  await expect(page.getByRole('button', { name: 'Start render' })).toBeEnabled();
  await page.getByRole('button', { name: 'Start render' }).click();
  await settle(page, 10 * 60_000);
  await expect(page.getByTestId('last-export')).toBeVisible();
  const mp4 = path.join(out, 'Cutting Room trailer.mp4');
  const full = probe(mp4);
  expect(full.streams.find((s) => s.codec_type === 'video')).toMatchObject({ codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30000/1001' });
  expect(full.streams.find((s) => s.codec_type === 'audio')).toMatchObject({ codec_name: 'aac' });
  expect(Number(full.format.duration)).toBeCloseTo(script.duration, 0);

  await page.getByRole('radio', { name: /Transparent motion graphics/ }).click();
  await page.getByRole('button', { name: 'Start render' }).click();
  await settle(page, 10 * 60_000);
  const alpha = fs.readdirSync(out).filter((f) => f.endsWith('.mov') && !f.includes('_captions'));
  expect(alpha).toHaveLength(graphics.length);
  for (const f of alpha) {
    const v = probe(path.join(out, f)).streams[0];
    expect(v.codec_name).toBe('prores');
    expect(v.pix_fmt).toMatch(/^yuva444p/);
  }

  await page.getByRole('radio', { name: /Transparent captions/ }).click();
  await page.getByRole('button', { name: 'Start render' }).click();
  await settle(page, 10 * 60_000);
  expect(fs.readdirSync(out).filter((f) => f.endsWith('_captions.mov'))).toHaveLength(script.sentences.length);
  await expect.poll(() => project(userData)?.exports?.map((e) => e.target)).toEqual(['captions', 'alpha', 'composite']);
  expect(app.errors).toEqual([]);
  await close(app);

  // 7. Reopen: the plan, approvals, preview and exports are all still there.
  app = await launch(appData);
  await app.page.evaluate((id) => (location.hash = `#/projects/${id}`), project(userData)!.id);
  await expect(app.page.locator('tbody tr')).toHaveCount(script.sentences.length);
  await expect(app.page.getByRole('radio', { name: 'Rendered preview' })).toBeVisible();
  expect(project(userData)!.segments!.every((s) => s.status === 'approved' && s.plan)).toBe(true);

  // 8. Revision in Review: comment, change one instruction, approve, update the preview.
  const target = approved.find((s) => s.transcript.startsWith('Their average turnaround'))!;
  const p2 = app.page;
  await p2.getByRole('link', { name: 'Review' }).click();
  await p2.getByRole('listitem', { name: /Segment 6/ }).click();
  await p2.getByLabel('New comment').fill('Client: show the drop as bars.');
  await p2.getByRole('button', { name: /Add|Post|Comment/ }).first().click();
  const instruction = target.plan!.conceptId === 'bar-comparison' ? 'Make it a big number counter.' : 'Show it as bars.';
  await p2.getByLabel('Editor instruction').fill(instruction);
  await expect.poll(() => project(userData)?.segments?.find((s) => s.id === target.id)?.instruction).toBe(instruction);
  await p2.getByRole('radiogroup', { name: 'Revision status' }).getByRole('radio', { name: 'Approved' }).click();
  await settle(p2);
  await expect.poll(() => project(userData)?.segments?.find((s) => s.id === target.id)?.plan?.planStatus).toBe('approved');
  const revised = project(userData)!.segments!.find((s) => s.id === target.id)!;
  expect(revised.plan!.conceptId).toBe(instruction.includes('bars') ? 'bar-comparison' : 'counter-hero');
  await p2.getByRole('button', { name: 'Update preview' }).click();
  await settle(p2, 10 * 60_000);
  await expect.poll(() => project(userData)?.render?.rendered).toEqual([target.id]);
  expect(project(userData)!.render!.reused.sort()).toEqual(graphics.filter((g) => g !== target.id).sort());
  expect(app.errors).toEqual([]);
  await close(app);
});

test('cancellation, missing media and a missing model fail clearly', async ({}, testInfo) => {
  test.setTimeout(5 * 60_000);
  const appData = freshAppData(testInfo);
  const slow = testInfo.outputPath('whisper-slow');
  fs.writeFileSync(slow, `#!/bin/sh\nexec "${process.execPath}" "${path.resolve(__dirname, '..', 'fixtures', 'transcription', 'fake-whisper-cli.cjs')}" --fake-mode=slow --fake-output="${path.join(MEDIA, 'trailer.whisper.json')}" "$@"\n`);
  fs.chmodSync(slow, 0o755);
  const userData = setup(appData, slow);
  const app = await launch(appData);
  const { page } = app;
  await createProject(page, app.app);
  await expect.poll(() => project(userData)?.exportSettings?.frameRate, { timeout: 15_000 }).toBe('29.97');

  // Cancel a running transcription: nothing changes, no segments appear.
  await page.getByRole('button', { name: 'Transcribe source' }).click();
  const job = page.getByTestId('pipeline-job');
  await expect(job.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  await job.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('pipeline-notice')).toContainText('Nothing was changed');
  expect(project(userData)?.segments ?? []).toEqual([]);

  // A missing model is a clear, coded error.
  writeData(userData, 'settings.json', { ffmpegPath: FFMPEG, autoSave: true, transcription: { whisperPath: slow, modelsDirectory: testInfo.outputPath('no-models') } });
  await page.getByRole('button', { name: 'Transcribe source' }).click();
  await expect(page.getByTestId('pipeline-error')).toContainText('MODEL_NOT_FOUND');

  // Transcribe for real (fast engine), approve two rows and cancel the render part-way.
  setup(appData);
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.getByRole('button', { name: 'Transcribe source' }).click();
  await settle(page);
  await page.getByRole('button', { name: 'Suggest visuals' }).click();
  await settle(page);
  for (const text of ['We talked to 120 editors', 'Their average turnaround']) {
    await page.locator('tbody tr').filter({ hasText: text }).click();
    await page.getByTestId('suggestion-panel').getByRole('button', { name: 'Approve', exact: true }).click();
    await settle(page);
  }
  await page.getByRole('button', { name: 'Render preview' }).click();
  await expect(job.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  await page.waitForTimeout(500);
  await job.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Rendering preview cancelled')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('pipeline-notice')).toContainText('Nothing was changed');
  expect(project(userData)?.render ?? null).toBeNull();

  // Missing source: the file was moved after linking.
  const moved = testInfo.outputPath('moved.mp4');
  fs.copyFileSync(VIDEO, moved);
  await nextDialogReturns(app.app, moved);
  await page.getByRole('radiogroup', { name: 'Inspector' }).getByRole('radio', { name: 'Source' }).click();
  await page.getByRole('button', { name: 'Replace…' }).click();
  await expect.poll(() => project(userData)?.source?.path).toBe(moved);
  fs.rmSync(moved);
  await page.getByRole('button', { name: 'Render preview' }).click();
  await expect(page.getByTestId('pipeline-error')).toContainText('moved or deleted');
  await close(app);
});
