import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TranscriptionService } from '../../../src/main/transcription';
import { PipelineService } from '../../../src/main/pipeline/service';
import { validateSequence } from '../../../src/shared/animation';
import { planningInput, transcriptRows } from '../../../src/renderer/lib/pipeline';
import type { Preset, Project } from '../../../src/renderer/types';

// Media → transcript → sequence rows → plan → approvals → PR #2 sequence, with PR #1's real
// TranscriptionService (real FFmpeg audio extraction) and its stand-in whisper-cli, outside Electron.

const which = (name: string) => {
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const ffmpeg = which('ffmpeg');
const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures', 'transcription');
const FAKE = path.join(FIXTURES, 'fake-whisper-cli.cjs');

const preset: Preset = {
  id: 'preset-1',
  name: 'Podcast',
  clientName: 'Client',
  type: 'podcast-trailer',
  referenceLinks: [],
  referenceFiles: [],
  creativeBrief: 'Bold kinetic type.',
  fonts: 'Inter Bold',
  tracking: '',
  logoPath: '',
  brandingNotes: '',
  createdAt: '',
  updatedAt: '',
};

describe.skipIf(process.platform === 'win32' || !ffmpeg)('media → transcript → plan → animation specs', () => {
  let dir: string;
  let models: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-flow-'));
    models = path.join(dir, 'models');
    fs.mkdirSync(models);
    fs.writeFileSync(path.join(models, 'ggml-base.en.bin'), 'placeholder model');
    fs.chmodSync(FAKE, 0o755);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const transcription = (modelsDirectory = models) =>
    new TranscriptionService({ userDataPath: dir, getSettings: () => ({ ffmpegPath: ffmpeg, transcription: { whisperPath: FAKE, modelsDirectory } }) });

  it('turns a video into planned, approved, renderable segments', async () => {
    const service = transcription();
    const media = path.join(FIXTURES, 'clip.mov');
    const { transcript, fromCache } = await service.transcribe({ mediaPath: media }, { jobId: 'job-1' });
    expect(fromCache).toBe(false);

    // Transcript → sequence rows (what the sequence table shows).
    const rows = transcriptRows(transcript);
    expect(rows.length).toBe(transcript.sentences.filter((s) => s.text.trim()).length);
    expect(rows[0].transcript).toBe('Welcome back to the edit.');
    expect(rows.every((r) => r.words?.length)).toBe(true);
    // This fixture's transcript runs past the 2 s clip, so PR #1 clamps the later sentences to zero
    // length. They stay in the table for the editor but are never planned or rendered.
    const timed = rows.filter((r) => r.end > r.start);
    expect(timed.length).toBeGreaterThan(0);

    // Editing the transcript never re-runs the engine: the same file comes from the cache.
    expect((await service.transcribe({ mediaPath: media }, { jobId: 'job-2' })).fromCache).toBe(true);

    // Rows + preset → plan → approve all → PR #2 sequence (validated by PR #2's own validator).
    const project: Project = { id: 'proj-1', name: 'p', presetId: preset.id, presetName: preset.name, status: 'draft', createdAt: '', updatedAt: '', segments: rows };
    const pipeline = new PipelineService({ userDataPath: dir, getApiKey: async () => null });
    const input = planningInput(project, [preset]);
    const planned = await pipeline.plan(input);
    expect(planned.updates.map((u) => u.id)).toEqual(timed.map((r) => r.id));
    for (const row of timed) await pipeline.act({ ...input, segmentId: row.id, action: { type: 'approve' } });
    const built = await pipeline.build({ ...input, target: 'composite', width: 1280, height: 720, fps: 25, duration: Math.max(transcript.duration, rows[rows.length - 1].end) });
    expect(built.updates.every((u) => u.status === 'approved')).toBe(true);
    expect(validateSequence(built.sequence)).toMatchObject({ ok: true });
  });

  it('missing media and a missing model are coded errors', async () => {
    await expect(transcription().transcribe({ mediaPath: path.join(dir, 'gone.mp4') }, { jobId: 'job-3' })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    const empty = path.join(dir, 'empty-models');
    fs.mkdirSync(empty, { recursive: true });
    await expect(transcription(empty).transcribe({ mediaPath: path.join(FIXTURES, 'clip.mov'), options: { force: true } }, { jobId: 'job-4' })).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  });
});
