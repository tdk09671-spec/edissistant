import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { energyEnvelope, readWav16, refineAnchoredStarts, speechThreshold } from '../../../src/main/transcription/onsets';
import { TIMING_VERSION, TranscriptionService } from '../../../src/main/transcription/service';
import { WhisperCppEngine } from '../../../src/main/transcription/whisperCpp';
import { parseWhisperCppJson } from '../../../src/shared/transcription';
import { fakeWhisper, ffmpegPath, tempDir } from './helpers';

// Regression (Windows, real whisper.cpp): sentence starts fell on whole seconds and graphics showed
// up to ~0.9 s before the speech. Without DTW, whisper.cpp pins each segment's first token to the
// segment start, usually where the previous segment ended. Those starts are now moved to the speech
// onset measured in the audio; measured word times are never shifted.

const RATE = 16000;
/** Low noise floor with speech-like bursts (two tones) over [start, end) spans. */
function signal(seconds: number, bursts: [number, number][]): Int16Array {
  const out = new Int16Array(Math.round(seconds * RATE));
  let seed = 7;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const t = i / RATE;
    const on = bursts.some(([a, b]) => t >= a && t < b);
    out[i] = Math.round(((seed % 61) - 30) + (on ? 9000 * Math.sin(2 * Math.PI * 180 * t) + 4000 * Math.sin(2 * Math.PI * 720 * t) : 0));
  }
  return out;
}
const words = (spec: [string, number, number][]) => spec.map(([text, start, end]) => ({ text, start, end }));
/** Token-timed anchors (first word of a 2-word segment, as in the fixture below). */
const at = (...indices: number[]) => indices.map((index) => ({ index, count: 2, estimated: false }));

describe('speech onsets for anchored sentence starts', () => {
  // Speech at 1.237–2.1, 2.48–3.3 (a 0.38 s pause), 4.905–6.0. Engine starts: early whole seconds
  // (1.0), the previous segment's end (2.1) and slightly late (5.0).
  const env = energyEnvelope(signal(8, [[1.237, 2.1], [2.48, 3.3], [4.905, 6.0]]), RATE);
  const engine = words([
    ['This', 1.0, 1.5],
    ['works.', 1.5, 2.1],
    ['Then', 2.1, 2.8],
    ['this.', 2.8, 3.3],
    ['Late', 5.0, 5.4],
    ['start.', 5.4, 6.0],
    ['Nothing', 7.0, 7.5],
  ]);

  it('moves early and late anchored starts to the measured onset, within 10 ms', () => {
    const r = refineAnchoredStarts(engine, at(0, 2, 4), env);
    expect(r.words[0].start).toBeCloseTo(1.237, 1);
    expect(Math.abs(r.words[0].start - 1.237)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(r.words[2].start - 2.48)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(r.words[4].start - 4.905)).toBeLessThanOrEqual(0.01);
    expect(r.refined).toBe(3);
    expect(r.unchecked).toBe(0);
  });

  it('never touches measured words or any word end', () => {
    const r = refineAnchoredStarts(engine, at(0, 2, 4), env);
    for (const i of [1, 3, 5, 6]) expect(r.words[i]).toEqual(engine[i]);
    r.words.forEach((w, i) => expect(w.end).toBe(engine[i].end));
    expect(engine[0].start).toBe(1.0); // input not mutated
  });

  it('leaves a start with no speech in its span alone and counts it as unchecked', () => {
    const r = refineAnchoredStarts(engine, [{ index: 6, count: 1, estimated: false }], env);
    expect(r.words[6]).toEqual(engine[6]);
    expect(r).toMatchObject({ refined: 0, unchecked: 1 });
  });

  it('adjacent sentences with no pause: a start already in speech stays after the previous word', () => {
    const joined = energyEnvelope(signal(4, [[0.5, 3.5]]), RATE);
    const w = words([
      ['One', 0.5, 1.2],
      ['two.', 1.2, 1.8],
      ['Three', 1.8, 2.4],
    ]);
    const r = refineAnchoredStarts(w, [{ index: 2, count: 1, estimated: false }], joined);
    expect(r.words[2].start).toBe(1.8);
  });

  it('keeps at least 50 ms of the word and handles silence-only audio', () => {
    const late = energyEnvelope(signal(3, [[1.48, 2.5]]), RATE);
    const r = refineAnchoredStarts(words([['Hi', 1.0, 1.5]]), [{ index: 0, count: 1, estimated: false }], late);
    expect(r.words[0].start).toBeLessThanOrEqual(1.45);
    expect(speechThreshold(energyEnvelope(signal(2, []), RATE))).toBeGreaterThan(0);
    expect(refineAnchoredStarts(words([['Hi', 0.5, 1]]), [{ index: 0, count: 1, estimated: false }], energyEnvelope(signal(2, []), RATE))).toMatchObject({ refined: 0, unchecked: 1 });
  });

  it('estimated word times (no token timing): searches the whole segment and spreads its words from the onset', () => {
    // Segment 11.165–13.23 s, speech from 11.338 s. Spread evenly, "So" ends at ~11.33 s, before the speech.
    const env2 = energyEnvelope(signal(14, [[11.338, 13.0]]), RATE);
    const texts = ['So', 'we', 'asked', 'one', 'question.'];
    const spread = texts.map((text, i, all) => {
      const w = all.map((t) => t.length);
      const total = w.reduce((a, b) => a + b, 0);
      const before = w.slice(0, i).reduce((a, b) => a + b, 0);
      return { text, start: 11.165 + (2.065 * before) / total, end: 11.165 + (2.065 * (before + w[i])) / total };
    });
    const r = refineAnchoredStarts(spread, [{ index: 0, count: 5, estimated: true }], env2);
    expect(Math.abs(r.words[0].start - 11.338)).toBeLessThanOrEqual(0.01);
    expect(r.words[4].end).toBeCloseTo(13.23, 6);
    for (let i = 1; i < 5; i++) expect(r.words[i].start).toBeCloseTo(r.words[i - 1].end, 6);
    expect(r).toMatchObject({ refined: 1, unchecked: 0 });
  });
});

describe('whisper.cpp output: which starts are anchored', () => {
  const token = (text: string, from: number, to: number, t_dtw = -1) => ({ text, offsets: { from, to }, p: 0.9, t_dtw });
  const json = (dtw: boolean) =>
    JSON.stringify({
      result: { language: 'en' },
      transcription: [
        { offsets: { from: 1000, to: 2100 }, text: ' This works.', tokens: [token('[_BEG_]', 1000, 1000), token(' This', 1000, 1500, dtw ? 124 : -1), token(' works', 1500, 2050, dtw ? 160 : -1), token('.', 2050, 2100, dtw ? 205 : -1)] },
        { offsets: { from: 2100, to: 3300 }, text: ' Then this.', tokens: [token(' Then', 2100, 2800, dtw ? 249 : -1), token(' this', 2800, 3250, dtw ? 280 : -1), token('.', 3250, 3300, dtw ? 325 : -1)] },
      ],
    });

  it('token timing without DTW: each segment’s first word is anchored', () => {
    const out = parseWhisperCppJson(json(false));
    expect(out.timingSource).toBe('tokens');
    expect(out.anchoredStarts).toEqual([{ index: 0, count: 2, estimated: false }, { index: 2, count: 2, estimated: false }]);
    expect(out.words.map((w) => w.start)).toEqual([1, 1.5, 2.1, 2.8]);
  });

  it('DTW timing: nothing is anchored and fractional onsets are kept exactly', () => {
    const out = parseWhisperCppJson(json(true), { dtw: true });
    expect(out.timingSource).toBe('dtw');
    expect(out.anchoredStarts).toEqual([]);
    expect(out.words.map((w) => w.start)).toEqual([1.24, 1.6, 2.49, 2.8]);
  });

  it('segment-only output: every segment’s first word is anchored (word times are estimates)', () => {
    const out = parseWhisperCppJson(JSON.stringify({ transcription: [{ offsets: { from: 0, to: 2000 }, text: ' Hello there.' }, { offsets: { from: 2000, to: 4000 }, text: ' Bye.' }] }));
    expect(out.timingSource).toBe('interpolated');
    expect(out.anchoredStarts).toEqual([{ index: 0, count: 2, estimated: true }, { index: 2, count: 1, estimated: true }]);
  });
});

describe('readWav16', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('finds the data chunk after other chunks and reads the first channel', () => {
    const data = Buffer.alloc(8);
    [100, -100, 200, -200].forEach((v, i) => data.writeInt16LE(v, i * 2));
    const fmt = Buffer.alloc(16);
    fmt.writeUInt16LE(1, 0);
    fmt.writeUInt16LE(2, 2);
    fmt.writeUInt32LE(16000, 4);
    fmt.writeUInt32LE(64000, 8);
    fmt.writeUInt16LE(4, 12);
    fmt.writeUInt16LE(16, 14);
    const chunk = (id: string, body: Buffer) => Buffer.concat([Buffer.from(id), Buffer.from(Uint32Array.of(body.length).buffer), body]);
    const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), chunk('LIST', Buffer.from('INFOabc\0')), chunk('data', data)]);
    const file = path.join(dir, 'x.wav');
    fs.writeFileSync(file, Buffer.concat([Buffer.from('RIFF'), Buffer.from(Uint32Array.of(body.length).buffer), body]));
    const wav = readWav16(file);
    expect(wav.rate).toBe(16000);
    expect(Array.from(wav.samples)).toEqual([100, 200]);
  });
});

describe.skipIf(!ffmpegPath || process.platform === 'win32')('end to end: real FFmpeg extraction, stand-in whisper output shaped like real whisper', () => {
  let root: string;
  beforeEach(() => {
    root = tempDir();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('sentence starts land on the speech, at fractional times, and the transcript says how', async () => {
    // A video whose audio has bursts at 1.237, 2.48 and 4.905 s (the "speech").
    const media = path.join(root, 'clip.mp4');
    const on = '(between(t,1.237,2.1)+between(t,2.48,3.3)+between(t,4.905,6.0))';
    execFileSync(ffmpegPath!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x36:r=25:d=7', '-f', 'lavfi', '-i', `aevalsrc='${on}*(0.3*sin(2*PI*180*t)+0.12*sin(2*PI*720*t))':s=48000:d=7`, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', media]);
    // What whisper.cpp writes without DTW: segment starts at whole seconds / the previous end.
    const token = (text: string, from: number, to: number) => ({ text, offsets: { from, to }, p: 0.9, t_dtw: -1 });
    const output = path.join(root, 'whisper.json');
    fs.writeFileSync(output, JSON.stringify({
      result: { language: 'en' },
      transcription: [
        { offsets: { from: 1000, to: 2100 }, text: ' This works.', tokens: [token(' This', 1000, 1500), token(' works.', 1500, 2100)] },
        { offsets: { from: 2100, to: 3300 }, text: ' Then this.', tokens: [token(' Then', 2100, 2800), token(' this.', 2800, 3300)] },
        { offsets: { from: 4000, to: 6000 }, text: ' Late start.', tokens: [token(' Late', 4000, 5400), token(' start.', 5400, 6000)] },
      ],
    }));
    const userData = path.join(root, 'userData');
    fs.mkdirSync(path.join(userData, 'models'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'models', 'ggml-base.en.bin'), 'fake model');
    const service = new TranscriptionService({
      userDataPath: userData,
      getSettings: () => ({ ffmpegPath, transcription: { whisperPath: fakeWhisper } }),
      env: { PATH: '' },
      tempDir: root,
      createEngine: () => new WhisperCppEngine({ command: process.execPath, prefixArgs: [fakeWhisper, `--fake-output=${output}`] }),
    });
    const { transcript } = await service.transcribe({ mediaPath: media }, { jobId: 'j' });
    const starts = transcript.sentences.map((s) => s.start);
    expect(starts).toHaveLength(3);
    // AAC encoding and 10 ms analysis frames: within 25 ms of the true onsets.
    [1.237, 2.48, 4.905].forEach((truth, i) => expect(Math.abs(starts[i] - truth), `sentence ${i + 1}`).toBeLessThanOrEqual(0.025));
    expect(starts.some((s) => Number.isInteger(s))).toBe(false);
    // Ends and measured words are as the engine gave them.
    expect(transcript.sentences.map((s) => s.end)).toEqual([2.1, 3.3, 6]);
    expect(transcript.sentences[0].words[1]).toMatchObject({ text: 'works.', start: 1.5, end: 2.1 });
    expect(transcript.timing).toEqual({ source: 'tokens', refinedStarts: 3, uncheckedStarts: 0 });
    expect(TIMING_VERSION).toBe(2);
  });
});
