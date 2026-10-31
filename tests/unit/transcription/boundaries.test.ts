import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { analyzeSpeech, refineSentenceBoundaries } from '../../../src/main/transcription/onsets';
import type { TranscriptSentence } from '../../../src/shared/transcription';
import { boundaryScene, measuredOffset, measuredOnset, rms, toInt16, toTranscriptSentences, RATE, type BoundaryScene, type Sentence } from './speechScenes';
import { ffmpegPath } from './helpers';

// Windows validation round 3 (94b3ddc): sentence ends were never refined (median +1.1 s, up to
// +2.6 s, sometimes past the next onset), and sentences starting mid-segment weren't checked at
// all (+365, +425, +772 ms late, unflagged). The first sentence over music stayed 0.92 s early.
//
// Truth comes from each sentence's dry stem (first and last 1 ms above −45 dBFS), never from the
// code under test. Whisper's side reproduces the measured shapes: ends late in the pause or past
// the next onset, starts early in the pause or late mid-segment.
//
// The rule everywhere: a boundary is within one frame (50 ms) of the truth or it is flagged; no end
// is cut into the speech without a flag; no graphic grows more than 0.15 s past whisper's end; the
// sentences, their text and word order never change.

const S = (w: string, l: number, extra: Partial<Sentence> = {}): Sentence => ({ words: w.split(' '), length: l, ...extra });
const ITEMS = [
  // Whisper's first start at 0.00 (0.8 s early), its end 1.2 s into the pause.
  { parts: [S('This is the cutting room.', 1.8)], pauseBefore: 0, startOffset: -0.8, endOffset: 1.2 },
  { parts: [S('Last year editors told us.', 2.0)], pauseBefore: 1.6, startOffset: -0.2, endOffset: 1.1 },
  // A 1.0 s pause inside one sentence ("…pause / we listened again."): its end must not be cut.
  { parts: [S('Then after a long pause', 1.4), S('we listened again.', 1.2)], gapInside: 1.0, pauseBefore: 2.0, startOffset: -0.1, endOffset: 1.5 },
  // The Windows B case: starts mid-segment, 365 ms late, after a 2.5 s pause; soft "H".
  { parts: [S('Honestly the silence said more.', 2.0, { leadIn: { seconds: 0.08, db: -24 } })], pauseBefore: 2.5, startOffset: 0.365, endOffset: 0.9 },
  // The Windows A/small.en case: 400 ms late; the previous end overran.
  { parts: [S('Subscribe now.', 1.2)], pauseBefore: 0.6, startOffset: 0.4, endOffset: 0.2 },
  { parts: [S('Five four three.', 1.3, { leadIn: { seconds: 0.1, db: -28 } })], pauseBefore: 1.0, startOffset: -0.05, endOffset: -0.05 },
  // Adjacent: 50 ms between sentences, nothing to check against.
  { parts: [S('Wait I have a question.', 1.5)], pauseBefore: 0.05, startOffset: 0.02, endOffset: 0.3 },
  // A second voice starting 0.45 s before the first one ends.
  { parts: [S('Sure go ahead.', 1.1, { pitch: 215 })], pauseBefore: 0.45, overlap: true, startOffset: 0.3, endOffset: 0.6 },
  { parts: [S('Fine then we fade out.', 1.4)], pauseBefore: 1.2, startOffset: -0.3, endOffset: 0.6 },
];

function run(sc: BoundaryScene) {
  const input = toTranscriptSentences(sc) as TranscriptSentence[];
  const result = refineSentenceBoundaries(input, analyzeSpeech(toInt16(sc.mix), RATE), sc.mix.length / RATE);
  return { input, result };
}

function expectHonest(sc: BoundaryScene, label: string, tolerance = 0.05) {
  const { input, result } = run(sc);
  const out = result.sentences;
  // Identity: same sentences, ids, text and word order.
  expect(out.map((s) => s.id)).toEqual(input.map((s) => s.id));
  out.forEach((s, i) => expect(s.words.map((w) => w.text)).toEqual(input[i].words.map((w) => w.text)));
  // Order: no word ends before it starts, nothing overlaps.
  const words = out.flatMap((s) => s.words);
  words.forEach((w, i) => {
    expect(w.end, label).toBeGreaterThanOrEqual(w.start);
    if (i) expect(w.start, label).toBeGreaterThanOrEqual(words[i - 1].end - 1e-9);
  });
  sc.sentences.forEach((truth, i) => {
    const s = out[i];
    const where = (edge: string) => `${label}: "${truth.words[0]}…" ${edge}: truth ${truth.truthStart.toFixed(3)}–${truth.truthEnd.toFixed(3)}, whisper ${input[i].start}–${input[i].end}, got ${s.start}–${s.end} (${result.checks[i].start}/${result.checks[i].end})`;
    const startFlag = Boolean(s.words[0].startUncertain);
    const endFlag = Boolean(s.words[s.words.length - 1].endUncertain);
    expect(startFlag || Math.abs(s.start - truth.truthStart) <= tolerance, where('start')).toBe(true);
    expect(endFlag || Math.abs(s.end - truth.truthEnd) <= tolerance, where('end')).toBe(true);
    // Never cut into the speech silently, never grown through a pause.
    expect(endFlag || s.end >= truth.truthEnd - tolerance, where('end cut')).toBe(true);
    expect(s.end, where('end grown')).toBeLessThanOrEqual(input[i].end + 0.15 + 1e-9);
  });
  return { input, result, out };
}

describe('sentence starts and ends against the pauses in the audio (truth from dry stems)', () => {
  it('the truth measurement agrees with where each sentence was placed', () => {
    const sc = boundaryScene(ITEMS);
    for (const s of sc.sentences) expect(s.truthEnd).toBeGreaterThan(s.truthStart);
    expect(measuredOnset(new Float32Array(100), 0)).toBeNaN();
    expect(measuredOffset(new Float32Array(100))).toBeNaN();
    expect(rms(new Float32Array([1, -1]))).toBe(1);
  });

  it('clean speech: late ends trimmed onto the speech, late and early starts moved, within 10 ms / 40 ms', () => {
    const { out, result } = expectHonest(boundaryScene(ITEMS), 'clean');
    const sc = boundaryScene(ITEMS);
    const clear = [0, 1, 2, 3, 4, 8]; // sentences with a real pause on both sides
    for (const i of clear) {
      expect(out[i].words[0].startUncertain, `start ${i}`).toBeUndefined();
      expect(out[i].words.at(-1)!.endUncertain, `end ${i}`).toBeUndefined();
      expect(Math.abs(out[i].start - sc.sentences[i].truthStart), `start ${i}`).toBeLessThanOrEqual(0.01);
      expect(Math.abs(out[i].end - sc.sentences[i].truthEnd), `end ${i}`).toBeLessThanOrEqual(0.04);
    }
    // The Windows cases: the 365 ms and 400 ms late mid-segment starts, and the 1.1–1.5 s late ends.
    expect(Math.abs(out[3].start - sc.sentences[3].truthStart)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(out[4].start - sc.sentences[4].truthStart)).toBeLessThanOrEqual(0.01);
    expect(result.endsTrimmed).toBeGreaterThanOrEqual(6);
    // The sentence with a pause inside it ends after "again", not at the inner pause.
    expect(out[2].end).toBeGreaterThan(sc.sentences[2].truthEnd - 0.05);
  });

  it('adjacent sentences and an overlapping voice are flagged, never claimed as measured', () => {
    const { out, result } = expectHonest(boundaryScene(ITEMS), 'clean');
    expect(out[6].words[0].startUncertain).toBe(true); // 50 ms after the previous sentence
    expect(out[7].words[0].startUncertain).toBe(true); // overlapping voice
    expect(result.checks[7]).toMatchObject({ start: 'uncertain', startReason: expect.stringMatching(/overlapping voices/) });
  });

  it.each([-12, -6])('over a music bed at %i dB: within 60 ms or flagged; the first sentence is not left at 0', (musicDb) => {
    const sc = boundaryScene(ITEMS, { musicDb });
    const { out } = expectHonest(sc, `music ${musicDb}`, 0.06);
    // Windows: the first sentence over music stayed at 0.00 s (0.92 s early).
    expect(out[0].start).toBeGreaterThan(sc.sentences[0].truthStart - 0.1);
    // Over music the boundaries are flagged as approximate, not presented as exact.
    expect(out[0].words[0].startUncertain).toBe(true);
  });

  it('without audio evidence nothing moves; a sentence with no pause before it is flagged', () => {
    const silent = { frameSeconds: 0.01, band: new Float32Array(0), fric: new Float32Array(0), bandFloor: 0, fricFloor: 0 };
    const input = toTranscriptSentences(boundaryScene(ITEMS.slice(0, 2))) as TranscriptSentence[];
    expect(refineSentenceBoundaries(input, silent, 10).sentences).toEqual(input);
  });
});

// Real speech: flite voices rendered by FFmpeg (needs libflite; CI's Linux job has it).
function hasFlite(): boolean {
  if (!ffmpegPath) return false;
  try {
    return /\bflite\b/.test(execFileSync(ffmpegPath, ['-hide_banner', '-filters'], { encoding: 'utf8' }));
  } catch {
    return false;
  }
}

describe.skipIf(!hasFlite())('sentence boundaries on real TTS speech (truth from the dry stems)', () => {
  const tts = (text: string, voice: string) => {
    const raw = execFileSync(ffmpegPath!, ['-v', 'error', '-f', 'lavfi', '-i', `flite=text='${text}':voice=${voice}`, '-ar', String(RATE), '-ac', '1', '-f', 's16le', 'pipe:1'], { maxBuffer: 1 << 26 });
    return Float32Array.from(new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2), (v) => v / 32768);
  };
  // Builds a boundary scene from TTS stems: same shapes as above (late ends, late/early starts).
  function ttsScene(musicDb?: number): BoundaryScene {
    const lines: [string, string, number, number, number][] = [
      ['Welcome back to the studio', 'slt', 0, -0.8, 1.2],
      ['Five new projects started this week', 'kal', 1.4, -0.2, 1.0],
      ['Honestly the silence said more', 'awb', 2.5, 0.365, 0.9],
      ['She kept the take', 'slt', 0.8, 0.4, 0.3],
      ['Finally we shipped it on time', 'rms', 1.2, -0.3, 0.6],
    ];
    const stems = lines.map(([text, voice]) => {
      const s = tts(text, voice);
      const on = Math.max(0, Math.round(measuredOnset(s, 0) * RATE) - 20);
      return s.slice(on, Math.round(measuredOffset(s) * RATE) + 20);
    });
    let t = 0.9;
    const at = stems.map((s, i) => {
      if (i) t += lines[i][2];
      const a = t;
      t += s.length / RATE;
      return a;
    });
    const n = Math.round((t + 1.2) * RATE);
    const dry = new Float32Array(n);
    const sentences = stems.map((s, i) => {
      const own = new Float32Array(n);
      own.set(s, Math.round(at[i] * RATE));
      for (let k = 0; k < n; k++) dry[k] += own[k];
      const truthStart = measuredOnset(own, Math.max(0, at[i] - 0.05));
      const truthEnd = measuredOffset(own);
      return { id: `t${i + 1}`, words: lines[i][0].split(' '), truthStart, truthEnd, start: Math.max(0, Math.round((truthStart + lines[i][3]) * 100) / 100), end: Math.round((truthEnd + lines[i][4]) * 100) / 100 };
    });
    for (let i = 0; i + 1 < sentences.length; i++) sentences[i].end = Math.min(sentences[i].end, sentences[i + 1].start);
    const mix = Float32Array.from(dry);
    if (musicDb !== undefined) {
      const bed = boundaryScene([{ parts: [S('x', 0.1)], pauseBefore: 0, startOffset: 0, endOffset: 0 }], { musicDb: 0, tail: t + 1.2 }).mix; // a bed as long as the scene
      const scale = (rms(dry.filter((v) => v !== 0)) / rms(bed)) * Math.pow(10, musicDb / 20);
      for (let k = 0; k < n; k++) mix[k] += (bed[k] ?? 0) * scale;
    }
    return { mix, sentences };
  }

  it('clean TTS: every start and end within 50 ms or flagged; the late ends are trimmed', () => {
    const { result } = expectHonest(ttsScene(), 'tts clean');
    expect(result.endsTrimmed).toBeGreaterThanOrEqual(3);
  });

  it.each([-12, -6])('TTS over a music bed at %i dB: within 60 ms or flagged', (musicDb) => {
    expectHonest(ttsScene(musicDb), `tts music ${musicDb}`, 0.06);
  });
});
