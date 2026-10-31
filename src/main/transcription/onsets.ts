// Speech onsets from the extracted audio, for word starts the engine didn't measure, and a check
// that the transcript has text wherever the audio has speech.
//
// Without DTW, whisper.cpp pins the first token of each segment to the segment's start timestamp,
// which the model usually puts where the previous segment ended: before the pause, not at the first
// word. Those sentence starts can be most of a second early (2 s after a long pause), so graphics
// appear before the speech. For exactly those words (see ParsedWhisperOutput.anchoredStarts), this
// moves the start to where speech begins in the 16 kHz WAV the engine read.
//
// Evidence is the speech band (300–3400 Hz), measured against the local background, not overall
// volume: a music bed or steady noise is background, so speech starting over it is still found, and
// the bed alone never counts as "already speaking" (Windows validation round 2: with music from
// t = 0, the first sentence stayed 0.92 s early and wasn't even counted as unchecked). An onset
// must also persist like speech does (a kick drum or a lip smack doesn't). Quiet lead-in consonants
// (f, s, sh, th, h) are found in a separate 2.5–7 kHz band. Every anchored start ends up in exactly
// one of four states, and the uncertain ones are flagged on the word:
//   moved      a clear onset, and the start was moved to it
//   confirmed  a clear onset where the engine already had the start
//   uncertain  weak or ambiguous evidence (music, overlap, continuous speech): best guess, flagged
//   unchecked  no onset found: left as the engine gave it, flagged
// Measured word times are never shifted, and no start moves before the previous word.

import * as fs from 'fs';
import { interpolateWords, roundTime, type AnchoredStart, type TranscriptWord } from '../../shared/transcription';

export const FRAME_SECONDS = 0.01;

/** 16-bit PCM WAV → samples of the first channel. Finds the "data" chunk past any other chunks. */
export function readWav16(file: string): { samples: Int16Array; rate: number } {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let pos = 12;
  let rate = 0;
  let channels = 1;
  let bits = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (bits !== 16 || !rate) throw new Error('Expected 16-bit PCM');
      const end = Math.min(buf.length, body + size);
      const frames = Math.floor((end - body) / (2 * channels));
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) samples[i] = buf.readInt16LE(body + i * 2 * channels);
      return { samples, rate };
    }
    pos = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

/** Mono 16-bit PCM WAV bytes (for transcribing part of the audio again). */
export function wavBytes(samples: Int16Array, rate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(samples[i], i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** RMS level (0–1) of each 10 ms frame. */
export function energyEnvelope(samples: ArrayLike<number>, rate: number, frameSeconds = FRAME_SECONDS, scale = 32768): Float32Array {
  const size = Math.max(1, Math.round(rate * frameSeconds));
  const frames = Math.ceil(samples.length / size);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const end = Math.min(samples.length, (f + 1) * size);
    for (let i = f * size; i < end; i++) sum += samples[i] * samples[i];
    env[f] = Math.sqrt(sum / Math.max(1, end - f * size)) / scale;
  }
  return env;
}

function levels(env: Float32Array): { noise: number; peak: number } {
  const sorted = Float32Array.from(env).sort();
  return { noise: sorted[Math.floor(sorted.length * 0.1)], peak: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] };
}

/** Full-band level above which a frame is loud (kept for callers that only have the envelope). */
export function speechThreshold(env: Float32Array): number {
  if (env.length === 0) return 1;
  const { noise, peak } = levels(env);
  return Math.max(noise * 4, noise + (peak - noise) * 0.06, 0.003);
}

/** Second-order section (RBJ cookbook), applied in place. */
function biquad(x: Float32Array, kind: 'lowpass' | 'highpass', f0: number, rate: number): void {
  const w0 = (2 * Math.PI * Math.min(f0, rate * 0.45)) / rate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (kind === 'lowpass' ? (1 - cos) / 2 : (1 + cos) / 2) / a0;
  const b1 = (kind === 'lowpass' ? 1 - cos : -(1 + cos)) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

/** 4th-order band-pass (two high-pass and two low-pass sections). */
function bandPass(samples: Int16Array, low: number, high: number, rate: number): Float32Array {
  const x = Float32Array.from(samples);
  biquad(x, 'highpass', low, rate);
  biquad(x, 'highpass', low, rate);
  biquad(x, 'lowpass', high, rate);
  biquad(x, 'lowpass', high, rate);
  return x;
}

/** Lowest mean of `width` consecutive values in [from, to). */
function quietest(values: ArrayLike<number>, from: number, to: number, width: number): number {
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(values.length, Math.ceil(to));
  if (b - a < width) return percentile(values, a, b, 0.2);
  let sum = 0;
  for (let k = a; k < a + width; k++) sum += values[k];
  let best = sum;
  for (let k = a + width; k < b; k++) {
    sum += values[k] - values[k - width];
    best = Math.min(best, sum);
  }
  return best / width;
}

function percentile(values: ArrayLike<number>, from: number, to: number, p: number): number {
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(values.length, Math.ceil(to));
  if (b <= a) return 0;
  const slice = Float32Array.prototype.slice.call(values, a, b) as Float32Array;
  slice.sort();
  return slice[Math.min(slice.length - 1, Math.floor(slice.length * p))];
}

export interface SpeechAnalysis {
  frameSeconds: number;
  /** Speech band (300–3400 Hz) RMS per frame, 0–1. */
  band: Float32Array;
  /** Fricative band (2.5–7 kHz) RMS per frame: quiet consonants. */
  fric: Float32Array;
  /** Whole-file floors (10th percentile) of each band. */
  bandFloor: number;
  fricFloor: number;
}

export function analyzeSpeech(samples: Int16Array, rate: number, frameSeconds = FRAME_SECONDS): SpeechAnalysis {
  const band = energyEnvelope(bandPass(samples, 300, 3400, rate), rate, frameSeconds);
  const fric = energyEnvelope(bandPass(samples, 2500, 7000, rate), rate, frameSeconds);
  return { frameSeconds, band, fric, bandFloor: percentile(band, 0, band.length, 0.1), fricFloor: percentile(fric, 0, fric.length, 0.1) };
}

// Tuning. An onset is a rise of the speech band to RISE × the local background that persists like
// speech: active in at least PERSIST of the next PERSIST_WINDOW frames, and in the first 3. Its
// evidence is strong when the band peaks at STRONG × background within 300 ms. Silence is never
// quieter than ABS_FLOOR for this purpose (dithered digital silence).
const RISE = 2.0; // +6 dB
const SOFT = 1.4; // +3 dB: lead-in consonant in the speech band
const FRIC_RISE = 2.5; // +8 dB: lead-in consonant in the fricative band
const STRONG = 3.2; // +10 dB
// Over a real background (a music bed, room noise above ABS_FLOOR × 4), quiet lead-in consonants
// drown and drum hits sit next to the speech, so an onset is only as good as about ±0.1 s unless
// the speech is CLEAR × the background. Such starts are moved but flagged.
const CLEAR = 20; // +26 dB
const PERSIST_WINDOW = 40; // 400 ms
const PERSIST = 15; // 150 ms of it
const MAX_SEARCH = 3.0; // seconds after the engine's start
const LEAD_IN = 0.25; // seconds of consonant before the vowel
const ABS_FLOOR = 0.0005;
const BG_WINDOW = 10; // 100 ms

export type StartCheck = 'moved' | 'confirmed' | 'uncertain' | 'unchecked';

export interface OnsetResult {
  words: TranscriptWord[];
  /** Anchored starts moved to a clear onset in the audio. */
  refined: number;
  /** Anchored starts with no onset in the audio, left as the engine gave them (flagged). */
  unchecked: number;
  /** Anchored starts the audio confirmed where the engine put them. */
  confirmed: number;
  /** Anchored starts with weak or ambiguous evidence: best guess, flagged. */
  uncertain: number;
  /** One entry per anchored start, in order. */
  checks: { index: number; result: StartCheck; reason?: string }[];
}

interface Detection {
  /** Frame of the onset, or null when none was found. */
  frame: number | null;
  strong: boolean;
  reason?: string;
}

/** Finds the speech onset for one anchored start between `floorFrame` (the previous word) and `limitFrame`. */
function detectOnset(a: SpeechAnalysis, startFrame: number, floorFrame: number, limitFrame: number): Detection {
  const { band, fric } = a;
  // The background is the quietest 100 ms of this stretch, from 1 s before the engine's start: the
  // pause before the sentence (even a short one), or the level of a music bed averaged over its
  // beats (a percentile would land in the gaps between drum hits and set the bar too low).
  const from = Math.max(0, startFrame - Math.round(1 / a.frameSeconds));
  const bg = Math.max(quietest(band, from, limitFrame + 1, BG_WINDOW), a.bandFloor, ABS_FLOOR);
  const fricBg = Math.max(quietest(fric, from, limitFrame + 1, BG_WINDOW), a.fricFloor, ABS_FLOOR);
  const on = bg * RISE;
  const active = (f: number) => f >= 0 && f < band.length && band[f] >= on;
  const persists = (f: number) => {
    if (!(active(f) && active(f + 1) && active(f + 2))) return false;
    let n = 0;
    for (let k = f; k < Math.min(band.length, f + PERSIST_WINDOW); k++) if (active(k)) n++;
    return n >= PERSIST;
  };
  const evidence = (f: number): { strong: boolean; reason?: string } => {
    let peak = 0;
    for (let k = f; k < Math.min(band.length, f + 30); k++) peak = Math.max(peak, band[k]);
    const ratio = peak / bg;
    if (ratio < STRONG) return { strong: false, reason: 'speech barely rises above the background (music or noise)' };
    if (bg > ABS_FLOOR * 4 && ratio < CLEAR) return { strong: false, reason: 'music or noise under the speech: the start is accurate to about ±0.1 s' };
    return { strong: true };
  };
  const leadIn = (f: number, lowest: number) => {
    // Back over a quiet consonant before the louder vowel; one quieter frame inside it doesn't end it.
    const soft = (k: number) => band[k] >= bg * SOFT || fric[k] >= fricBg * FRIC_RISE;
    const stop = Math.max(lowest, f - Math.round(LEAD_IN / a.frameSeconds));
    while (f - 1 >= stop && (soft(f - 1) || (f - 2 >= stop && soft(f - 2)))) f--;
    return f;
  };

  if (active(startFrame) && persists(startFrame)) {
    // Already in speech where the engine starts: find where that speech began, back to the
    // previous word at most. Reaching it while still in speech means the sentences run together
    // or voices overlap; the true start can't be told apart.
    let f = startFrame;
    const stop = Math.max(floorFrame, startFrame - Math.round(0.5 / a.frameSeconds));
    while (f - 1 >= stop && band[f - 1] >= bg * SOFT) f--;
    const quietBefore = f - 1 >= Math.max(0, floorFrame) && band[f - 1] < bg * SOFT;
    if (!quietBefore) {
      return { frame: null, strong: false, reason: 'speech continues from the previous word (no pause, or overlapping voices)' };
    }
    return { frame: f, ...evidence(f) };
  }
  for (let f = startFrame; f <= limitFrame; f++) {
    if (!persists(f)) continue;
    const onset = leadIn(f, startFrame);
    // An onset rises out of something quieter. Speech running straight into it (a voice that
    // started under the previous one) gives no start to measure, only the engine's guess.
    const quiet = (k: number) => k >= 0 && band[k] < bg * SOFT && fric[k] < fricBg * FRIC_RISE;
    if (!quiet(onset - 1) && !quiet(onset - 2) && !quiet(onset - 3)) {
      return { frame: null, strong: false, reason: 'speech continues from the previous word (no pause, or overlapping voices)' };
    }
    return { frame: onset, ...evidence(f) };
  }
  return { frame: null, strong: false, reason: 'no clear speech onset in the audio' };
}

/**
 * Moves each anchored segment start to the speech onset in the audio (see the header). The search
 * runs from the engine's start up to 3 s into the segment, not just to the first token's end:
 * whisper's own first-token end is often before the real onset. When the onset lands past the
 * first word's end, the words up to the first one that still fits are spread again from the onset.
 */
export function refineAnchoredStarts(words: readonly TranscriptWord[], anchored: readonly AnchoredStart[], analysis: SpeechAnalysis): OnsetResult {
  const out = words.map((w) => ({ ...w }));
  const result: OnsetResult = { words: out, refined: 0, unchecked: 0, confirmed: 0, uncertain: 0, checks: [] };
  const fs = analysis.frameSeconds;
  const frameOf = (t: number) => Math.floor(t / fs + 1e-6);
  const flag = (index: number, check: StartCheck, reason?: string) => {
    result.checks.push({ index, result: check, ...(reason ? { reason } : {}) });
    if (check === 'uncertain' || check === 'unchecked') out[index].startUncertain = true;
    result[check === 'moved' ? 'refined' : check]++;
  };

  for (const a of anchored) {
    const w = out[a.index];
    if (!w) continue;
    const lastIndex = Math.min(out.length, a.index + Math.max(1, a.count)) - 1;
    const segEnd = out[lastIndex].end;
    const prevEnd = a.index > 0 ? out[a.index - 1].end : 0;
    if (analysis.band.length === 0) {
      flag(a.index, 'unchecked', 'no audio');
      continue;
    }
    // Keep at least 50 ms of the segment.
    const latest = Math.min(segEnd - 0.05, w.start + MAX_SEARCH);
    const found = latest > w.start ? detectOnset(analysis, frameOf(w.start), frameOf(prevEnd), frameOf(latest)) : { frame: null, strong: false, reason: 'segment too short to check' };
    if (found.frame === null) {
      flag(a.index, found.reason?.startsWith('speech continues') ? 'uncertain' : 'unchecked', found.reason);
      continue;
    }
    const start = roundTime(Math.min(Math.max(found.frame * fs, prevEnd), latest));
    if (Math.abs(start - w.start) < 0.005) {
      flag(a.index, found.strong ? 'confirmed' : 'uncertain', found.reason);
      continue;
    }
    // Words that would end before the new start are spread again from it, up to the first word
    // that still fits (or the whole segment when its word times were estimates anyway).
    let k = a.index;
    if (a.estimated) k = lastIndex;
    else while (k < lastIndex && out[k].end < start + 0.05 * (k - a.index + 1)) k++;
    if (k > a.index) {
      const spread = interpolateWords(out.slice(a.index, k + 1).map((x) => x.text), start, out[k].end);
      spread.forEach((x, j) => Object.assign(out[a.index + j], { start: x.start, end: x.end }));
    } else {
      w.start = start;
      if (w.end < start) w.end = start;
    }
    flag(a.index, found.strong ? 'moved' : 'uncertain', found.reason);
  }
  return result;
}

/**
 * Spans where the audio has speech but no word covers it: a sign the engine dropped dialogue
 * (whisper.cpp small.en with flash attention off stops early, Windows validation round 2). Speech
 * here is the speech band at least +8 dB over the file's floor, in runs with at least `minSpeech`
 * seconds of it; a word covers its own span plus `pad` on each side. A music bed sits at the floor
 * and isn't counted.
 */
export function untranscribedSpeech(analysis: SpeechAnalysis, words: readonly Pick<TranscriptWord, 'start' | 'end'>[], options: { pad?: number; minSpeech?: number } = {}): { start: number; end: number }[] {
  const { band, frameSeconds: fs } = analysis;
  const pad = options.pad ?? 0.5;
  const minSpeech = options.minSpeech ?? 1.0;
  const threshold = Math.max(analysis.bandFloor * 2.5, ABS_FLOOR * 4);
  const covered = new Uint8Array(band.length);
  for (const w of words) {
    const a = Math.max(0, Math.floor((w.start - pad) / fs));
    const b = Math.min(band.length, Math.ceil((w.end + pad) / fs));
    covered.fill(1, a, b);
  }
  const gaps: { start: number; end: number; speech: number }[] = [];
  let open: { start: number; end: number; speech: number } | null = null;
  const maxQuiet = Math.round(0.6 / fs); // a pause shorter than this joins two runs
  let quiet = 0;
  for (let f = 0; f < band.length; f++) {
    const speech = band[f] >= threshold && !covered[f];
    if (speech) {
      if (!open) open = { start: f, end: f + 1, speech: 0 };
      open.end = f + 1;
      open.speech++;
      quiet = 0;
    } else if (open && ++quiet > maxQuiet) {
      gaps.push(open);
      open = null;
      quiet = 0;
    }
  }
  if (open) gaps.push(open);
  return gaps.filter((g) => g.speech * fs >= minSpeech).map((g) => ({ start: roundTime(g.start * fs), end: roundTime(g.end * fs) }));
}
