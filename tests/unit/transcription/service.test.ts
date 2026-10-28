import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TranscriptionService, type ServiceSettings } from '../../../src/main/transcription/service';
import { WhisperCppEngine } from '../../../src/main/transcription/whisperCpp';
import { parseTranscript, transcriptToSrt, type TranscriptionProgress } from '../../../src/shared/transcription';
import { copyFixture, fakeWhisper, ffmpegPath, tempDir } from './helpers';

let root: string;
let userData: string;
let media: string;
let record: string;
let settings: ServiceSettings;
let mode: string;

function service(overrides: Partial<ConstructorParameters<typeof TranscriptionService>[0]> = {}) {
  return new TranscriptionService({
    userDataPath: userData,
    getSettings: () => settings,
    env: { PATH: '' },
    tempDir: path.join(root, 'tmp'),
    createEngine: () => new WhisperCppEngine({ command: process.execPath, prefixArgs: [fakeWhisper, `--fake-mode=${mode}`, `--fake-record=${record}`] }),
    ...overrides,
  });
}

function engineRuns(): number {
  return fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').filter((l) => !l.includes('--version')).length : 0;
}

beforeEach(() => {
  root = tempDir();
  userData = path.join(root, 'userData');
  fs.mkdirSync(path.join(userData, 'models'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'));
  fs.writeFileSync(path.join(userData, 'models', 'ggml-base.en.bin'), 'fake model');
  // The engine path must exist; the stand-in is run through node by createEngine.
  settings = { ffmpegPath, transcription: { whisperPath: fakeWhisper } };
  media = copyFixture('../sample.mp4', root, 'Interview Take 1.mp4');
  record = path.join(root, 'runs.jsonl');
  mode = 'normal';
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('TranscriptionService validation', () => {
  it('rejects bad requests before running anything', async () => {
    const s = service();
    await expectCode(s.transcribe({ mediaPath: '' }, { jobId: 'a' }), 'INVALID_REQUEST');
    await expectCode(s.transcribe({ mediaPath: 'relative.mp4' }, { jobId: 'b' }), 'INVALID_REQUEST');
    await expectCode(s.transcribe({ mediaPath: path.join(root, 'notes.txt') }, { jobId: 'c' }), 'UNSUPPORTED_FORMAT');
    await expectCode(s.transcribe({ mediaPath: path.join(root, 'missing.mov') }, { jobId: 'd' }), 'FILE_NOT_FOUND');
    fs.writeFileSync(path.join(root, 'empty.wav'), '');
    await expectCode(s.transcribe({ mediaPath: path.join(root, 'empty.wav') }, { jobId: 'e' }), 'UNSUPPORTED_FORMAT');
    expect(engineRuns()).toBe(0);
  });

  it('reports missing tools and models with specific codes', async () => {
    settings = { ffmpegPath: path.join(root, 'nope'), transcription: { whisperPath: fakeWhisper } };
    await expectCode(service().transcribe({ mediaPath: media }, { jobId: 'a' }), 'FFMPEG_NOT_FOUND');
    settings = { ffmpegPath: ffmpegPath ?? fakeWhisper, transcription: { whisperPath: path.join(root, 'nope') } };
    await expectCode(service().transcribe({ mediaPath: media }, { jobId: 'b' }), 'ENGINE_NOT_FOUND');
    settings = { ffmpegPath: ffmpegPath ?? fakeWhisper, transcription: { whisperPath: fakeWhisper, modelsDirectory: path.join(root, 'empty') } };
    await expectCode(service().transcribe({ mediaPath: media }, { jobId: 'c' }), 'MODEL_NOT_FOUND');
  });

  it('describes its status', async () => {
    const status = await service().status();
    expect(status.models.map((m) => m.name)).toEqual(['base.en']);
    expect(status.defaultModel).toBe('base.en');
    expect(status.engine).toMatchObject({ available: true, version: '0.0.0-fake' });
    expect(status.ffmpeg.available).toBe(Boolean(ffmpegPath));
    settings = {};
    const empty = await service().status();
    expect(empty.ready).toBe(false);
    expect(empty.problems).toHaveLength(2);
  });
});

describe.skipIf(!ffmpegPath)('TranscriptionService end to end (real FFmpeg, stand-in whisper-cli)', () => {
  it('transcribes a video into sentences with word timing and reports ordered progress', async () => {
    const events: TranscriptionProgress[] = [];
    const { transcript, fromCache } = await service().transcribe({ mediaPath: media }, { jobId: 'job1', onProgress: (p) => events.push(p) });

    expect(fromCache).toBe(false);
    expect(parseTranscript(JSON.parse(JSON.stringify(transcript)))).toEqual(transcript);
    expect(transcript.media).toMatchObject({ path: media, name: 'Interview Take 1.mp4', size: fs.statSync(media).size });
    expect(transcript.engine).toMatchObject({ name: 'whisper.cpp', version: '0.0.0-fake', model: 'base.en', device: 'cpu', cpuFallback: false });
    expect(transcript.language).toBe('en');
    expect(transcript.wordTiming).toBe('word');
    expect(transcript.duration).toBe(3);
    // The canned output runs to 10.5 s, but the media is 3 s long: words are clamped to the media.
    expect(transcript.sentences[0]).toMatchObject({ text: 'Welcome back to the edit.', start: 0, end: 1.45 });
    for (const s of transcript.sentences) for (const w of s.words) expect(w.end).toBeLessThanOrEqual(3);
    expect(transcriptToSrt(transcript)).toMatch(/^1\n00:00:00,000 --> 00:00:01,450\nWelcome back to the edit\.\n/);

    expect(events.every((e) => e.jobId === 'job1')).toBe(true);
    const stages = [...new Set(events.map((e) => e.stage))];
    expect(stages).toEqual(['queued', 'preparing', 'extracting-audio', 'transcribing', 'grouping', 'done']);
    expect(events.every((e, i) => i === 0 || e.progress >= events[i - 1].progress)).toBe(true);
    expect(events[events.length - 1].progress).toBe(1);
    // Scratch audio is cleaned up.
    expect(fs.readdirSync(path.join(root, 'tmp'))).toEqual([]);
  });

  it('serves unchanged media from the cache, even after a move, and re-runs on change or force', async () => {
    const s = service();
    const first = await s.transcribe({ mediaPath: media }, { jobId: '1' });
    expect(engineRuns()).toBe(1);

    const events: TranscriptionProgress[] = [];
    const second = await s.transcribe({ mediaPath: media }, { jobId: '2', onProgress: (p) => events.push(p) });
    expect(second.fromCache).toBe(true);
    expect(second.transcript.sentences).toEqual(first.transcript.sentences);
    expect(events.some((e) => e.stage === 'cache-hit')).toBe(true);
    expect(engineRuns()).toBe(1);

    // A moved/renamed file keeps its content and mtime, so it still hits the cache.
    const moved = path.join(root, 'renamed.mp4');
    fs.renameSync(media, moved);
    const third = await s.transcribe({ mediaPath: moved }, { jobId: '3' });
    expect(third.fromCache).toBe(true);
    expect(third.transcript.media.path).toBe(moved);
    expect(s.getCached({ mediaPath: moved })?.id).toBe(first.transcript.id);

    // Different language → different cache entry.
    await s.transcribe({ mediaPath: moved, options: { language: 'de' } }, { jobId: '4' });
    expect(engineRuns()).toBe(2);

    await s.transcribe({ mediaPath: moved, options: { force: true } }, { jobId: '5' });
    expect(engineRuns()).toBe(3);

    // Re-exported media (new mtime) misses the cache.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(moved, later, later);
    expect(s.getCached({ mediaPath: moved })).toBeNull();
    const sixth = await s.transcribe({ mediaPath: moved }, { jobId: '6' });
    expect(sixth.fromCache).toBe(false);
    expect(engineRuns()).toBe(4);

    expect(s.clearCache()).toBeGreaterThan(0);
    expect(s.getCached({ mediaPath: moved })).toBeNull();
  });

  it('applies the caller’s sentence grouping, including on cache hits', async () => {
    const s = service();
    const settingsWithAudio = { mediaPath: copyFixture('tone.wav', root) };
    await s.transcribe(settingsWithAudio, { jobId: '1' });
    const grouped = await s.transcribe({ ...settingsWithAudio, options: { grouping: { maxChars: 12 } } }, { jobId: '2' });
    expect(grouped.fromCache).toBe(true);
    expect(grouped.transcript.sentences.every((x) => x.text.length <= 12 || x.words.length === 1)).toBe(true);
    expect(grouped.transcript.sentences.length).toBeGreaterThan(3);
  });

  it('accepts MOV, WAV and MP3', async () => {
    const s = service();
    for (const file of ['clip.mov', 'tone.wav', 'tone.mp3']) {
      const { transcript } = await s.transcribe({ mediaPath: copyFixture(file, root) }, { jobId: file.replace('.', '-') });
      expect(transcript.sentences.length).toBeGreaterThan(0);
      // MP3 decoding adds a few ms of encoder padding.
      expect(transcript.duration).toBeGreaterThanOrEqual(2);
      expect(transcript.duration).toBeLessThan(2.1);
    }
  });

  it('reports NO_AUDIO_STREAM for silent video', async () => {
    await expectCode(service().transcribe({ mediaPath: copyFixture('no-audio.mp4', root) }, { jobId: 'x' }), 'NO_AUDIO_STREAM');
    expect(fs.readdirSync(path.join(root, 'tmp'))).toEqual([]);
  });

  it('falls back to CPU and records it', async () => {
    mode = 'gpu-fail';
    const { transcript } = await service().transcribe({ mediaPath: media }, { jobId: 'x' });
    expect(transcript.engine).toMatchObject({ device: 'cpu', cpuFallback: true });
    expect(transcript.warnings.join(' ')).toMatch(/retried on the CPU/);
  });

  it('cancels a running job, cleans up, and keeps the queue working', async () => {
    mode = 'slow';
    const s = service();
    const running = s.transcribe({ mediaPath: media }, {
      jobId: 'slow',
      onProgress: (p) => p.stage === 'transcribing' && p.progress > 0.3 && s.cancel('slow'),
    });
    const queued = expectCode(s.transcribe({ mediaPath: copyFixture('tone.wav', root) }, { jobId: 'queued' }), 'CANCELLED');
    const third = s.transcribe({ mediaPath: copyFixture('tone.mp3', root) }, { jobId: 'third' });
    expect(s.cancel('queued')).toBe(true);

    await expectCode(running, 'CANCELLED');
    await queued;
    mode = 'normal';
    const done = await third;
    expect(done.transcript.sentences.length).toBeGreaterThan(0);
    expect(s.cancel('slow')).toBe(false);
    expect(fs.readdirSync(path.join(root, 'tmp'))).toEqual([]);
    // Nothing from the cancelled job was cached.
    expect(s.getCached({ mediaPath: media })).toBeNull();
  });

  it('regression: cancelAll resolves only after running jobs have deleted their temp audio (app quit)', async () => {
    mode = 'slow';
    const s = service();
    let reachedEngine!: () => void;
    const transcribing = new Promise<void>((resolve) => (reachedEngine = resolve));
    const running = s.transcribe({ mediaPath: media }, {
      jobId: 'quit',
      onProgress: (p) => p.stage === 'transcribing' && p.progress > 0.3 && reachedEngine(),
    });
    const outcome = running.catch((error) => error);
    await transcribing;
    expect(s.hasActiveJobs).toBe(true);
    expect(fs.readdirSync(path.join(root, 'tmp'))).toHaveLength(1);

    await s.cancelAll();
    // Checked right after cancelAll settles, before anything else gets a turn: this is when the app exits.
    expect(fs.readdirSync(path.join(root, 'tmp'))).toEqual([]);
    expect(s.hasActiveJobs).toBe(false);
    expect(await outcome).toMatchObject({ code: 'CANCELLED' });
    await expect(s.cancelAll()).resolves.toBeUndefined();
  });

  it('refuses duplicate job ids', async () => {
    const s = service();
    const a = s.transcribe({ mediaPath: media }, { jobId: 'same' });
    await expectCode(s.transcribe({ mediaPath: media }, { jobId: 'same' }), 'INVALID_REQUEST');
    await a;
  });
});
