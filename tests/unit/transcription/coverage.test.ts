import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeSpeech, untranscribedSpeech, wavBytes } from '../../../src/main/transcription/onsets';
import { TranscriptionService } from '../../../src/main/transcription/service';
import { WhisperCppEngine } from '../../../src/main/transcription/whisperCpp';
import { scene, toInt16, RATE, type Sentence } from './speechScenes';
import { fakeWhisper, ffmpegPath, tempDir } from './helpers';

// Windows validation round 2 (a6fe66f), bug B: whisper.cpp 1.9.5 with small.en and -nfa (DTW)
// returned 7 segments ending at 32.0 s of a 40.2 s clip, so the last two sentences were missing,
// and the app accepted it with no warning. base.en was fine. Reproduced with whisper-cli directly,
// so the engine, not the parser, drops the speech. The app now checks the transcript against the
// speech in the audio and recovers, never silently.

const S = (words: string, length: number): Sentence => ({ words: words.split(' '), length });
// Five sentences, 1.0–1.5 s pauses, about 13 s.
const SENTENCES = [
  { sentence: S('One two three four.', 1.6), pauseBefore: 0 },
  { sentence: S('Five six seven.', 1.4), pauseBefore: 1.2 },
  { sentence: S('Eight nine ten eleven.', 1.8), pauseBefore: 1.0 },
  { sentence: S('Twelve thirteen.', 1.3), pauseBefore: 1.5 },
  { sentence: S('Fourteen fifteen sixteen.', 1.6), pauseBefore: 1.1 },
];

describe('speech without text (pure)', () => {
  const sc = scene(SENTENCES, { musicDb: -12, tail: 4 });
  const analysis = analyzeSpeech(toInt16(sc.mix), RATE);
  const cover = (upTo: number) => sc.placed.filter((p) => p.at < upTo).map((p) => ({ start: p.at, end: p.end }));

  it('finds nothing when every sentence has words, even with a music bed running to the end', () => {
    expect(untranscribedSpeech(analysis, cover(Infinity))).toEqual([]);
  });

  it('finds the dropped sentences at the end, where they are', () => {
    const lastTwo = sc.placed.slice(3);
    const gaps = untranscribedSpeech(analysis, cover(lastTwo[0].at - 0.01));
    expect(gaps).toHaveLength(1);
    expect(gaps[0].start).toBeCloseTo(lastTwo[0].at, 0);
    expect(gaps[0].end).toBeCloseTo(lastTwo[1].end, 0);
  });

  it('finds a dropped sentence in the middle too, and ignores short sounds', () => {
    const words = sc.placed.filter((_, i) => i !== 2).map((p) => ({ start: p.at, end: p.end }));
    const gaps = untranscribedSpeech(analysis, words);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].start).toBeCloseTo(sc.placed[2].at, 0);
    // 0.3 s of speech is below the 1 s minimum: not reported.
    const blip = scene([{ sentence: S('Hi.', 0.3), pauseBefore: 0 }]);
    expect(untranscribedSpeech(analyzeSpeech(toInt16(blip.mix), RATE), [])).toEqual([]);
  });
});

describe.skipIf(!ffmpegPath)('dropped speech is detected and recovered (real FFmpeg, stand-in whisper-cli)', () => {
  let root: string;
  let media: string;
  let truthEnd: number;
  beforeEach(() => {
    root = tempDir();
    const sc = scene(SENTENCES, { tail: 1.5 });
    truthEnd = sc.placed[sc.placed.length - 1].end;
    media = path.join(root, 'clip.wav');
    fs.writeFileSync(media, wavBytes(toInt16(sc.mix), RATE));
    const models = path.join(root, 'userData', 'models');
    fs.mkdirSync(models, { recursive: true });
    for (const m of ['base.en', 'small.en']) fs.writeFileSync(path.join(models, `ggml-${m}.bin`), 'fake model');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  // small.en with -nfa stops after 6 s here (Windows: 32 s of 40); --fake-truncate forces it anywhere.
  function service(extra: string[] = []) {
    const record = path.join(root, `runs-${Math.random().toString(36).slice(2)}.jsonl`);
    const svc = new TranscriptionService({
      userDataPath: path.join(root, 'userData'),
      getSettings: () => ({ ffmpegPath, transcription: { whisperPath: fakeWhisper } }),
      env: { PATH: '' },
      tempDir: root,
      createEngine: () => new WhisperCppEngine({ command: process.execPath, prefixArgs: [fakeWhisper, '--fake-mode=bursts', '--fake-truncate-nfa=small:6', `--fake-record=${record}`, ...extra] }),
    });
    const runs = () => fs.readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]).filter((a) => !a.includes('--help') && !a.includes('--version'));
    return { svc, runs };
  }
  const lastWordEnd = (t: { sentences: { end: number }[] }) => Math.max(...t.sentences.map((s) => s.end));
  const wordCount = (t: { sentences: { words: unknown[] }[] }) => t.sentences.reduce((n, s) => n + s.words.length, 0);

  it('base.en with DTW: complete on the first pass, DTW times, no fallback', async () => {
    const { svc, runs } = service();
    const { transcript } = await svc.transcribe({ mediaPath: media, options: { model: 'base.en', dtwAlignment: true } }, { jobId: 'b' });
    expect(transcript.coverage).toEqual({ complete: true, gaps: [], recovered: [] });
    expect(transcript.timing).toMatchObject({ source: 'dtw' });
    expect(transcript.timing?.dtwFallback).toBeUndefined();
    expect(lastWordEnd(transcript)).toBeGreaterThan(truthEnd - 0.5);
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toEqual(expect.arrayContaining(['-dtw', 'base.en', '-nfa']));
  });

  it('small.en with DTW: the truncated run is detected, redone without DTW, and says so', async () => {
    const { svc, runs } = service();
    const { transcript } = await svc.transcribe({ mediaPath: media, options: { model: 'small.en', dtwAlignment: true } }, { jobId: 's' });
    // The DTW pass dropped everything starting after 6 s (its text ends with the third sentence,
    // at 7.68 s); the plain pass has every sentence.
    expect(transcript.timing?.dtwFallback).toEqual({ reason: 'truncated', dtwEnd: 7.68 });
    expect(transcript.timing?.source).toBe('tokens');
    expect(transcript.coverage).toEqual({ complete: true, gaps: [], recovered: [] });
    expect(lastWordEnd(transcript)).toBeGreaterThan(truthEnd - 0.5);
    // Every spoken sentence is there (one transcript sentence each).
    expect(transcript.sentences).toHaveLength(SENTENCES.length);
    expect(wordCount(transcript)).toBeGreaterThanOrEqual(SENTENCES.length * 3);
    expect(transcript.warnings.join(' ')).toMatch(/With DTW alignment, small\.en returned no text for speech at .* made without DTW so no dialogue is lost/);
    const [first, second] = runs();
    expect(first).toEqual(expect.arrayContaining(['-dtw', 'small.en', '-nfa']));
    expect(second).not.toContain('-dtw');
    expect(second).not.toContain('-nfa');
  });

  it('small.en without DTW: complete, nothing to recover (the fast path is unchanged)', async () => {
    const { svc, runs } = service();
    const { transcript } = await svc.transcribe({ mediaPath: media, options: { model: 'small.en' } }, { jobId: 'n' });
    expect(transcript.coverage).toEqual({ complete: true, gaps: [], recovered: [] });
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).not.toContain('-nfa');
    expect(transcript.warnings.join(' ')).not.toMatch(/no text|skipped speech/);
  });

  it('an engine that drops the end even without DTW: the missing audio is transcribed in a second pass', async () => {
    const { svc, runs } = service(['--fake-truncate=6']);
    const { transcript } = await svc.transcribe({ mediaPath: media, options: { model: 'base.en' } }, { jobId: 'r' });
    expect(transcript.coverage?.complete).toBe(true);
    // The last two sentences, separated by a pause: two spans, each transcribed again.
    expect(transcript.coverage?.recovered).toHaveLength(2);
    expect(transcript.coverage!.recovered[0].start).toBeGreaterThan(6);
    expect(lastWordEnd(transcript)).toBeGreaterThan(truthEnd - 0.5);
    expect(transcript.warnings.join(' ')).toMatch(/skipped speech at .* second pass over just that audio/);
    // One extra engine run per missing span (each on a clip of just that audio, without DTW).
    expect(runs()).toHaveLength(3);
    for (const argv of runs().slice(1)) expect(argv).not.toContain('-dtw');
    // Recovered sentences start on the speech (their own onsets are checked too).
    const late = transcript.sentences.filter((s) => s.start > 6);
    expect(late.length).toBeGreaterThan(0);
  });

  it('speech that still has no text after the second pass is reported, never accepted silently', async () => {
    const { svc } = service(['--fake-truncate=6', '--fake-silent-under=12']);
    const { transcript } = await svc.transcribe({ mediaPath: media, options: { model: 'base.en' } }, { jobId: 'g' });
    expect(transcript.coverage?.complete).toBe(false);
    expect(transcript.coverage?.gaps.length).toBeGreaterThan(0);
    expect(transcript.coverage!.gaps[0].start).toBeGreaterThan(6);
    expect(transcript.warnings.join(' ')).toMatch(/Speech at .* has no text in the transcript/);
  });

  it('the dtwAlignment setting turns DTW on by default; a request can still turn it off', async () => {
    const record = path.join(root, 'setting.jsonl');
    const settings = { ffmpegPath, transcription: { whisperPath: fakeWhisper, dtwAlignment: true } };
    const svc = new TranscriptionService({
      userDataPath: path.join(root, 'userData'),
      getSettings: () => settings,
      env: { PATH: '' },
      tempDir: root,
      createEngine: () => new WhisperCppEngine({ command: process.execPath, prefixArgs: [fakeWhisper, '--fake-mode=bursts', `--fake-record=${record}`] }),
    });
    const runs = () => fs.readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]).filter((a) => a.includes('-m'));
    const on = await svc.transcribe({ mediaPath: media, options: { model: 'base.en' } }, { jobId: 'set' });
    expect(on.transcript.timing?.source).toBe('dtw');
    expect(runs().at(-1)).toEqual(expect.arrayContaining(['-dtw', 'base.en', '-nfa']));
    await svc.transcribe({ mediaPath: media, options: { model: 'base.en', dtwAlignment: false, force: true } }, { jobId: 'off' });
    expect(runs().at(-1)).not.toContain('-dtw');
    expect(runs().at(-1)).not.toContain('-nfa');
  });

  it('DTW stays opt-in: a request without dtwAlignment never passes -dtw or -nfa', async () => {
    const { svc, runs } = service();
    await svc.transcribe({ mediaPath: media, options: { model: 'base.en' } }, { jobId: 'o' });
    for (const argv of runs()) {
      expect(argv).not.toContain('-dtw');
      expect(argv).not.toContain('-nfa');
    }
  });
});
