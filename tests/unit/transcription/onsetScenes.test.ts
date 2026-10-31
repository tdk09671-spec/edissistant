import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { analyzeSpeech, refineAnchoredStarts, type OnsetResult } from '../../../src/main/transcription/onsets';
import { measuredOnset, scene, sceneFromStems, toInt16, whisperLikeWords, RATE, type Scene, type Sentence } from './speechScenes';
import { ffmpegPath } from './helpers';

// Windows validation round 2 (a6fe66f), bug C: without DTW, sentence starts were early by up to
// 0.92 s on clean speech and 2.03 s after long pauses, and with a music bed from t = 0 the first
// start stayed 0.92 s early with no warning (counted as neither refined nor unchecked).
//
// Ground truth never comes from the code under test: each sentence is rendered on its own dry stem
// and its onset measured there (first 1 ms above −45 dBFS RMS, as the Windows test measured its
// TTS stems), before music or other voices are mixed in. The engine side is shaped like whisper.cpp
// without DTW (segments start early in the pause; the first word "ends" before the speech).
//
// The rule checked everywhere: a start is either within one frame (50 ms) of the truth, or it is
// flagged uncertain on the word and counted. Nothing is silently wrong, and nothing silently early.

const TOLERANCE = 0.05;

function run(sc: Scene) {
  const { words, anchored } = whisperLikeWords(sc.placed);
  const result = refineAnchoredStarts(words, anchored, analyzeSpeech(toInt16(sc.mix), RATE));
  const rows = sc.placed.map((p, i) => {
    const w = result.words[anchored[i].index];
    return { first: p.sentence.words[0], truth: p.truth, engine: words[anchored[i].index].start, start: w.start, error: w.start - p.truth, flagged: Boolean(w.startUncertain), check: result.checks[i] };
  });
  return { result, rows };
}

function expectHonest(result: OnsetResult, rows: ReturnType<typeof run>['rows'], label: string) {
  // Every anchored start is accounted for exactly once.
  expect(result.refined + result.confirmed + result.uncertain + result.unchecked, label).toBe(rows.length);
  for (const r of rows) {
    const where = `${label}: "${r.first}…" truth ${r.truth.toFixed(3)} s, engine ${r.engine.toFixed(2)} s, got ${r.start.toFixed(3)} s (${r.check.result}${r.check.reason ? `: ${r.check.reason}` : ''})`;
    expect(r.flagged || Math.abs(r.error) <= TOLERANCE, where).toBe(true);
    expect(r.flagged, where).toBe(r.check.result === 'uncertain' || r.check.result === 'unchecked');
  }
}

const S = (words: string, length: number, extra: Partial<Sentence> = {}): Sentence => ({ words: words.split(' '), length, ...extra });
// Pauses of 0.25–2.5 s, quiet lead-in consonants down to −30 dB, and a second voice that starts
// 0.45 s before the first one ends (the shapes of Windows clip B).
const SENTENCES = [
  { sentence: S('Welcome to the studio.', 1.6), pauseBefore: 0 },
  { sentence: S('Short gap here.', 1.3), pauseBefore: 0.25 },
  { sentence: S('After a whole second.', 1.8, { leadIn: { seconds: 0.09, db: -26 } }), pauseBefore: 1.0 },
  { sentence: S('Two seconds of silence first.', 2.2), pauseBefore: 2.0 },
  { sentence: S('Fine soft start.', 1.4, { leadIn: { seconds: 0.12, db: -30 } }), pauseBefore: 2.5 },
  { sentence: S('Then a second voice.', 1.5, { pitch: 210 }), pauseBefore: 0.45, overlap: true },
  { sentence: S('Shh quiet now.', 1.2, { leadIn: { seconds: 0.1, db: -22 } }), pauseBefore: 0.8 },
];

describe('sentence starts on synthetic speech scenes (truth from the dry stems)', () => {
  it('the truth measurement agrees with where each sentence was placed', () => {
    const sc = scene(SENTENCES);
    // Within 10 ms: a quiet lead-in consonant ramps in, so it crosses −45 dBFS a few ms after it starts.
    for (const p of sc.placed) expect(Math.abs(p.truth - p.at)).toBeLessThan(0.01);
  });

  it('clean speech with pauses up to 2.5 s and quiet consonants: every start within 10 ms, none flagged but the overlap', () => {
    const { result, rows } = run(scene(SENTENCES));
    expectHonest(result, rows, 'clean');
    for (const r of rows.filter((x) => x.first !== 'Then')) {
      expect(r.flagged, r.first).toBe(false);
      expect(Math.abs(r.error), r.first).toBeLessThanOrEqual(0.01);
    }
    // The engine's starts were up to 2.4 s early (the 2.5 s pause); that's what was fixed.
    expect(Math.max(...rows.map((r) => r.truth - r.engine))).toBeGreaterThan(2);
  });

  it('a voice that starts under the previous one is flagged, never reported as measured', () => {
    const { rows } = run(scene(SENTENCES));
    const overlap = rows.find((r) => r.first === 'Then')!;
    expect(overlap.flagged).toBe(true);
    expect(overlap.check).toMatchObject({ result: 'uncertain', reason: expect.stringMatching(/overlapping voices/) });
  });

  it.each([-12, -6])('with a music bed at %i dB from t = 0, every start is within 50 ms or flagged, and counted', (musicDb) => {
    const { result, rows } = run(scene(SENTENCES, { musicDb }));
    expectHonest(result, rows, `music ${musicDb} dB`);
    // The bed is never mistaken for speech already in progress at t = 0 (the Windows bug).
    expect(rows[0].check.result).not.toBe('confirmed');
    expect(rows[0].start).toBeGreaterThan(0.4);
  });

  it('the exact Windows case: music from t = 0, speech at 0.92 s, engine start 0.00 s and first token ending at 0.40 s', () => {
    for (const musicDb of [undefined, -12, -6]) {
      const sc = scene([{ sentence: S('Northwind grew fast this year.', 2.0), pauseBefore: 0 }, { sentence: S('Then it grew again.', 1.6), pauseBefore: 1.2 }], { musicDb, firstAt: 0.92 });
      const mix = sc.mix;
      const truth = measuredOnset(sc.dry, 0);
      const words = [
        { text: 'Northwind', start: 0, end: 0.4 },
        { text: 'grew', start: 0.4, end: 1.1 },
        { text: 'fast', start: 1.1, end: 1.7 },
        { text: 'this', start: 1.7, end: 2.3 },
        { text: 'year.', start: 2.3, end: 3.0 },
      ];
      const r = refineAnchoredStarts(words, [{ index: 0, count: 5, estimated: false }], analyzeSpeech(toInt16(mix), RATE));
      const label = `music ${musicDb ?? 'none'}: got ${r.words[0].start} (${r.checks[0].result}), truth ${truth.toFixed(3)}`;
      expect(r.refined + r.confirmed + r.uncertain + r.unchecked, label).toBe(1);
      expect(Boolean(r.words[0].startUncertain) || Math.abs(r.words[0].start - truth) <= TOLERANCE, label).toBe(true);
      expect(Math.abs(r.words[0].start - truth), label).toBeLessThanOrEqual(0.12);
      if (musicDb === undefined) expect(r.checks[0].result, label).toBe('moved');
      // Later words that would have ended before the new start were spread again after it.
      for (let i = 1; i < 5; i++) expect(r.words[i].start, label).toBeGreaterThanOrEqual(r.words[i - 1].end - 1e-9);
      expect(r.words[4].end).toBe(3.0);
    }
  });
});

// Real speech: flite voices rendered by FFmpeg, with natural soft onsets ("Five", "She", "Thanks",
// "How") and a second voice overlapping the first. Needs an FFmpeg build with libflite (CI's Linux
// job has it; most Windows builds don't).
function hasFlite(): boolean {
  if (!ffmpegPath) return false;
  try {
    return /\bflite\b/.test(execFileSync(ffmpegPath, ['-hide_banner', '-filters'], { encoding: 'utf8' }));
  } catch {
    return false;
  }
}
const tts = (text: string, voice: string) => {
  const raw = execFileSync(ffmpegPath!, ['-v', 'error', '-f', 'lavfi', '-i', `flite=text='${text}':voice=${voice}`, '-ar', String(RATE), '-ac', '1', '-f', 's16le', 'pipe:1'], { maxBuffer: 1 << 26 });
  const samples = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
  return Float32Array.from(samples, (v) => v / 32768);
};

describe.skipIf(!hasFlite())('sentence starts on real TTS speech (truth from the dry stems)', () => {
  const LINES: [string, string, number, boolean?][] = [
    ['Welcome back to the studio', 'slt', 0],
    ['Five new projects started this week', 'kal', 0.25],
    ['She said the edit was finished', 'slt', 1.0],
    ['Thanks to everyone who helped', 'awb', 2.0],
    ['How did we get here so fast', 'rms', 2.5],
    ['Seven editors joined the team', 'kal', 0.8],
    ['and nobody noticed', 'slt', 0.45, true],
    ['Finally we shipped it on time', 'awb', 1.2],
  ];
  const stems = () => LINES.map(([text, voice, pauseBefore, overlap]) => ({ stem: tts(text, voice), words: text.split(' '), pauseBefore, overlap }));

  it('clean: every start within 30 ms except the overlapping voice, which is flagged', () => {
    const { result, rows } = run(sceneFromStems(stems(), { firstAt: 0.92 }));
    expectHonest(result, rows, 'tts clean');
    for (const r of rows) {
      if (r.first === 'and') expect(r.flagged).toBe(true);
      else {
        expect(r.flagged, r.first).toBe(false);
        expect(Math.abs(r.error), r.first).toBeLessThanOrEqual(0.03);
      }
    }
  });

  it.each([-12, -6])('with a music bed at %i dB: within 50 ms or flagged, every start counted', (musicDb) => {
    const { result, rows } = run(sceneFromStems(stems(), { firstAt: 0.92, musicDb }));
    expectHonest(result, rows, `tts music ${musicDb} dB`);
  });
});
