// Speech onsets from the extracted audio, for word starts the engine didn't measure.
//
// Without DTW, whisper.cpp pins the first token of each segment to the segment's start timestamp,
// which the model usually puts where the previous segment ended: before the pause, not at the
// first word. Those sentence starts can be most of a second early (graphics then appear before the
// speech). For exactly those words (see ParsedWhisperOutput.anchoredStarts), this moves the start to
// where speech energy actually begins in the 16 kHz WAV the engine read. It never shifts measured
// word times, never moves a start past its own word or before the previous one, and leaves a start
// alone (counted as unchecked) when the audio shows no clear onset.

import * as fs from 'fs';
import { roundTime, type TranscriptWord } from '../../shared/transcription';

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

/** RMS level (0–1) of each 10 ms frame. */
export function energyEnvelope(samples: Int16Array, rate: number, frameSeconds = FRAME_SECONDS): Float32Array {
  const size = Math.max(1, Math.round(rate * frameSeconds));
  const frames = Math.ceil(samples.length / size);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const end = Math.min(samples.length, (f + 1) * size);
    for (let i = f * size; i < end; i++) sum += samples[i] * samples[i];
    env[f] = Math.sqrt(sum / Math.max(1, end - f * size)) / 32768;
  }
  return env;
}

/** Level above which a frame counts as speech: well above the noise floor, a share of the peaks. */
export function speechThreshold(env: Float32Array): number {
  if (env.length === 0) return 1;
  const sorted = Float32Array.from(env).sort();
  const noise = sorted[Math.floor(sorted.length * 0.1)];
  const peak = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
  return Math.max(noise * 4, noise + (peak - noise) * 0.06, 0.003);
}

export interface OnsetResult {
  words: TranscriptWord[];
  /** Anchored starts moved to the measured onset. */
  refined: number;
  /** Anchored starts with no clear onset in the audio, left as the engine gave them. */
  unchecked: number;
}

/**
 * Moves each anchored word start to the speech onset inside that word's span. A start that is
 * already in speech is walked back to where that speech began, but not before the previous word.
 * Measured word times (and every word end) are kept.
 */
export function refineAnchoredStarts(words: readonly TranscriptWord[], anchored: readonly number[], env: Float32Array, frameSeconds = FRAME_SECONDS): OnsetResult {
  const out = words.map((w) => ({ ...w }));
  if (!anchored.length || env.length === 0) return { words: out, refined: 0, unchecked: anchored.length };
  const thr = speechThreshold(env);
  const speech = (f: number) => f >= 0 && f < env.length && env[f] >= thr && (env[f + 1] ?? 0) >= thr;
  const frameOf = (t: number) => Math.floor(t / frameSeconds + 1e-6);
  let refined = 0;
  let unchecked = 0;

  for (const i of anchored) {
    const w = out[i];
    if (!w) continue;
    const prevEnd = i > 0 ? out[i - 1].end : 0;
    const latest = w.end - 0.05; // keep at least 50 ms of the word
    let onset: number | null = null;
    if (speech(frameOf(w.start))) {
      // Already in speech: find where it began, at most 0.5 s back and not before the previous word.
      let f = frameOf(w.start);
      const floor = Math.max(frameOf(prevEnd), frameOf(w.start - 0.5));
      while (f - 1 >= floor && env[f - 1] >= thr) f--;
      onset = f * frameSeconds;
    } else {
      for (let f = frameOf(w.start); f * frameSeconds <= latest; f++) {
        if (speech(f)) {
          onset = f * frameSeconds;
          break;
        }
      }
    }
    if (onset === null) {
      unchecked++;
      continue;
    }
    const start = roundTime(Math.min(Math.max(onset, prevEnd), Math.max(w.start, latest)));
    if (Math.abs(start - w.start) >= 0.005) {
      w.start = start;
      refined++;
    }
  }
  return { words: out, refined, unchecked };
}
