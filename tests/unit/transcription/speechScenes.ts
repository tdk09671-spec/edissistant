// Synthetic speech scenes with ground truth that doesn't come from the code under test.
//
// Speech here is a stand-in, not words: voiced syllables (a 110–230 Hz pitch with harmonics up to
// ~3.5 kHz, shaped at a syllable rate) and optional fricative lead-ins (noise at 2.5–7 kHz). The
// truth for each sentence start is measured on the dry speech stem before anything is mixed in,
// the way the Windows validation measured TTS stems: the first 1 ms window above −45 dBFS RMS.
// Then a whisper-like word list is made the way whisper.cpp behaves without DTW: each segment
// starts where the previous one ended, and word times are spread over the segment, so after a
// pause the first word "ends" before the speech even begins.

export const RATE = 16000;

export interface Sentence {
  words: string[];
  /** Seconds of speech. */
  length: number;
  /** Quiet consonant before the first vowel: seconds, and level relative to the vowel (dB). */
  leadIn?: { seconds: number; db: number };
  /** Pitch of the voice (overlapping voices use different ones). */
  pitch?: number;
}

/** Deterministic noise. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

/** One "sentence" of voiced syllables into `out` (float), from `start` seconds. */
export function addSentence(out: Float32Array, start: number, s: Sentence, seed: number, gain = 0.25): void {
  const noise = rng(seed);
  const pitch = s.pitch ?? 120 + (seed % 7) * 15;
  const i0 = Math.round(start * RATE);
  if (s.leadIn) {
    // Fricative: noise through a crude 2.5–7 kHz band (difference of smoothed noise).
    const n = Math.round(s.leadIn.seconds * RATE);
    const level = gain * Math.pow(10, s.leadIn.db / 20);
    let lp1 = 0;
    let lp2 = 0;
    for (let k = 0; k < n && i0 + k < out.length; k++) {
      const x = noise();
      lp1 += 0.75 * (x - lp1); // ~ up to 7 kHz
      lp2 += 0.12 * (x - lp2); // ~ below 2.5 kHz
      const ramp = Math.min(1, k / (0.01 * RATE));
      out[i0 + k] += level * 2.2 * (lp1 - lp2) * ramp;
    }
  }
  const v0 = i0 + Math.round((s.leadIn?.seconds ?? 0) * RATE);
  const n = Math.round(s.length * RATE);
  const syllable = 0.18 + (seed % 5) * 0.015;
  for (let k = 0; k < n && v0 + k < out.length; k++) {
    const t = k / RATE;
    // Syllables: raised-cosine humps with short dips between them; fast attack at the very start.
    const phase = (t % syllable) / syllable;
    const env = (0.35 + 0.65 * Math.sin(Math.PI * phase) ** 2) * Math.min(1, t / 0.008) * Math.min(1, (s.length - t) / 0.03);
    const f0 = pitch * (1 + 0.04 * Math.sin(2 * Math.PI * 3 * t));
    let v = 0;
    for (let h = 1; h * f0 < 3600; h++) v += Math.sin(2 * Math.PI * h * f0 * t + h) / h;
    out[v0 + k] += gain * env * 0.6 * v;
  }
}

/** Music bed: a pad chord, a kick every 0.5 s and hats every 0.25 s. Unit-ish level. */
export function musicBed(seconds: number, seed = 3): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  const noise = rng(seed);
  let hp = 0;
  let prev = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const pad = (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t) + Math.sin(2 * Math.PI * 329.6 * t) + 0.5 * Math.sin(2 * Math.PI * 440 * t)) * (0.8 + 0.2 * Math.sin(2 * Math.PI * 0.2 * t));
    const kt = t % 0.5;
    const kick = Math.exp(-kt / 0.06) * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-kt / 0.02)) * kt) * 2.5;
    const ht = t % 0.25;
    const x = noise();
    hp = 0.9 * (hp + x - prev); // high-passed noise
    prev = x;
    const hat = Math.exp(-ht / 0.02) * hp * 0.8;
    out[i] = 0.25 * pad + kick + hat;
  }
  return out;
}

export function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

/** First time the dry stem's 1 ms RMS exceeds −45 dBFS at or after `from` seconds. */
export function measuredOnset(dry: Float32Array, from: number): number {
  const win = Math.round(0.001 * RATE);
  const threshold = Math.pow(10, -45 / 20);
  for (let i = Math.round(from * RATE); i + win <= dry.length; i += win) {
    if (rms(dry, i, i + win) > threshold) return i / RATE;
  }
  return Number.NaN;
}

export function toInt16(x: Float32Array): Int16Array {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767)));
  return out;
}

export interface Placed {
  sentence: Sentence;
  /** Seconds where the sentence's sound starts in the timeline. */
  at: number;
  /** Measured truth (dry stem). */
  truth: number;
  end: number;
}

export interface Scene {
  dry: Float32Array;
  mix: Float32Array;
  placed: Placed[];
}

/** Places sentences after the given pauses; optional music bed at `musicDb` relative to speech RMS. */
export function scene(sentences: { sentence: Sentence; pauseBefore: number; overlap?: boolean }[], options: { musicDb?: number; tail?: number; firstAt?: number } = {}): Scene {
  let t = options.firstAt ?? 0.6;
  const plan: { sentence: Sentence; at: number }[] = [];
  for (const [i, s] of sentences.entries()) {
    if (s.overlap && plan.length) {
      const prev = plan[plan.length - 1];
      t = prev.at + (prev.sentence.leadIn?.seconds ?? 0) + prev.sentence.length - s.pauseBefore; // pauseBefore = overlap length
    } else t += i === 0 ? 0 : s.pauseBefore;
    plan.push({ sentence: s.sentence, at: t });
    t += (s.sentence.leadIn?.seconds ?? 0) + s.sentence.length;
  }
  const seconds = t + (options.tail ?? 1.0);
  const dry = new Float32Array(Math.round(seconds * RATE));
  // Each sentence also goes on its own stem so overlapping truth is measured per voice.
  const placed: Placed[] = plan.map((p, i) => {
    const own = new Float32Array(dry.length);
    addSentence(own, p.at, p.sentence, 11 + i * 7);
    for (let k = 0; k < dry.length; k++) dry[k] += own[k];
    return { sentence: p.sentence, at: p.at, truth: measuredOnset(own, Math.max(0, p.at - 0.05)), end: p.at + (p.sentence.leadIn?.seconds ?? 0) + p.sentence.length };
  });
  const mix = Float32Array.from(dry);
  if (options.musicDb !== undefined) {
    const bed = musicBed(seconds);
    // Speech RMS over its own active parts; music scaled to musicDb below it.
    let speechSum = 0;
    let n = 0;
    for (const p of placed) {
      const a = Math.round(p.at * RATE);
      const b = Math.round(p.end * RATE);
      for (let k = a; k < b; k++) {
        speechSum += dry[k] * dry[k];
        n++;
      }
    }
    const speechRms = Math.sqrt(speechSum / Math.max(1, n));
    const scale = (speechRms / rms(bed)) * Math.pow(10, options.musicDb / 20);
    for (let k = 0; k < mix.length; k++) mix[k] += bed[k] * scale;
  }
  return { dry, mix, placed };
}

/**
 * Word list shaped like whisper.cpp without DTW: segments are contiguous, and the boundary between
 * two sentences sits early in the pause (0.1 s after the speech ends; the first segment starts at
 * the whole second before its speech), so each sentence after a pause "starts" most of the pause
 * early. Word times are spread over the segment by length, so the first word often "ends" before
 * the speech begins. Every segment's first word is anchored. Overlapping sentences share no pause:
 * the boundary is where the earlier one ends.
 */
export function whisperLikeWords(placed: Placed[]): { words: { text: string; start: number; end: number }[]; anchored: { index: number; count: number; estimated: boolean }[] } {
  const words: { text: string; start: number; end: number }[] = [];
  const anchored: { index: number; count: number; estimated: boolean }[] = [];
  const sorted = [...placed].sort((a, b) => a.at - b.at);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const boundaries = sorted.map((p, i) => (i === 0 ? Math.floor(p.at) : r2(Math.min(sorted[i - 1].end + 0.1, Math.max(p.at, sorted[i - 1].end)))));
  sorted.forEach((p, i) => {
    const segStart = boundaries[i];
    const segEnd = i + 1 < sorted.length ? boundaries[i + 1] : r2(p.end + 0.3);
    const total = p.sentence.words.reduce((n, w) => n + w.length, 0);
    let acc = 0;
    anchored.push({ index: words.length, count: p.sentence.words.length, estimated: false });
    for (const w of p.sentence.words) {
      const s = segStart + ((segEnd - segStart) * acc) / total;
      acc += w.length;
      words.push({ text: w, start: Math.round(s * 1000) / 1000, end: Math.round((segStart + ((segEnd - segStart) * acc) / total) * 1000) / 1000 });
    }
  });
  return { words, anchored };
}

/** Real speech stems (e.g. TTS) placed like `scene`; `stem` is 16 kHz float audio of one sentence. */
export function sceneFromStems(items: { stem: Float32Array; words: string[]; pauseBefore: number; overlap?: boolean }[], options: { musicDb?: number; tail?: number; firstAt?: number } = {}): Scene {
  // Trim each stem's leading/trailing silence so pauses are what they say; truth is still measured.
  const trimmed = items.map((it) => {
    const on = measuredOnset(it.stem, 0);
    let end = it.stem.length;
    const win = Math.round(0.001 * RATE);
    while (end - win > 0 && rms(it.stem, end - win, end) <= Math.pow(10, -45 / 20)) end -= win;
    return { ...it, stem: it.stem.slice(Math.max(0, Math.round(on * RATE) - win * 20), end) };
  });
  let t = options.firstAt ?? 0.6;
  const at: number[] = [];
  trimmed.forEach((it, i) => {
    if (i > 0) t = it.overlap ? at[i - 1] + trimmed[i - 1].stem.length / RATE - it.pauseBefore : t + it.pauseBefore;
    at.push(t);
    t = at[i] + it.stem.length / RATE;
  });
  const seconds = Math.max(...at.map((a, i) => a + trimmed[i].stem.length / RATE)) + (options.tail ?? 1.0);
  const dry = new Float32Array(Math.round(seconds * RATE));
  const placed: Placed[] = trimmed.map((it, i) => {
    const own = new Float32Array(dry.length);
    own.set(it.stem.subarray(0, Math.max(0, dry.length - Math.round(at[i] * RATE))), Math.round(at[i] * RATE));
    for (let k = 0; k < dry.length; k++) dry[k] += own[k];
    const sentence: Sentence = { words: it.words, length: it.stem.length / RATE };
    return { sentence, at: at[i], truth: measuredOnset(own, Math.max(0, at[i] - 0.05)), end: at[i] + it.stem.length / RATE };
  });
  const mix = Float32Array.from(dry);
  if (options.musicDb !== undefined) {
    const bed = musicBed(seconds);
    let sum = 0;
    let n = 0;
    for (const p of placed) for (let k = Math.round(p.at * RATE); k < Math.round(p.end * RATE); k++) {
      sum += dry[k] * dry[k];
      n++;
    }
    const scale = (Math.sqrt(sum / Math.max(1, n)) / rms(bed)) * Math.pow(10, options.musicDb / 20);
    for (let k = 0; k < mix.length; k++) mix[k] += bed[k] * scale;
  }
  return { dry, mix, placed };
}

/** Last time the stem's 1 ms RMS exceeds −45 dBFS (the measured end of a sentence's sound). */
export function measuredOffset(stem: Float32Array): number {
  const win = Math.round(0.001 * RATE);
  const threshold = Math.pow(10, -45 / 20);
  for (let i = stem.length - win; i >= 0; i -= win) if (rms(stem, i, i + win) > threshold) return (i + win) / RATE;
  return Number.NaN;
}

export interface BoundaryScene {
  mix: Float32Array;
  /** One per transcript sentence: measured truth and how whisper (simulated) timed it. */
  sentences: { id: string; words: string[]; truthStart: number; truthEnd: number; start: number; end: number }[];
}

/**
 * Sentences shaped like whisper.cpp's output in the Windows round-3 runs, with truth measured on
 * each dry stem. `parts` lets one transcript sentence hold two stems with a pause inside it ("we
 * listened … again"). Whisper's times per sentence are given as offsets from the truth:
 *   startOffset < 0: early (in the pause), > 0: late (a sentence that starts mid-segment)
 *   endOffset: how far into the following pause (or past the next onset) whisper's end runs
 */
export function boundaryScene(
  items: { parts: Sentence[]; gapInside?: number; pauseBefore: number; overlap?: boolean; startOffset: number; endOffset: number }[],
  options: { musicDb?: number; firstAt?: number; tail?: number } = {}
): BoundaryScene {
  const stems: { stem: Float32Array; at: number }[][] = [];
  let t = options.firstAt ?? 0.8;
  const lengthOf = (p: Sentence) => (p.leadIn?.seconds ?? 0) + p.length;
  const placedAt: { at: number; end: number }[] = [];
  items.forEach((it, i) => {
    const total = it.parts.reduce((n, p) => n + lengthOf(p), 0) + (it.gapInside ?? 0) * (it.parts.length - 1);
    const at = i === 0 ? t : it.overlap ? placedAt[i - 1].end - it.pauseBefore : placedAt[i - 1].end + it.pauseBefore;
    placedAt.push({ at, end: at + total });
    t = at + total;
  });
  const seconds = Math.max(...placedAt.map((p) => p.end)) + (options.tail ?? 1.2);
  const n = Math.round(seconds * RATE);
  const dry = new Float32Array(n);
  const sentences: BoundaryScene['sentences'] = items.map((it, i) => {
    const own = new Float32Array(n);
    let at = placedAt[i].at;
    it.parts.forEach((p, k) => {
      addSentence(own, at, p, 31 + i * 13 + k * 5);
      at += lengthOf(p) + (it.gapInside ?? 0);
    });
    for (let k = 0; k < n; k++) dry[k] += own[k];
    stems.push([]);
    const truthStart = measuredOnset(own, Math.max(0, placedAt[i].at - 0.05));
    const truthEnd = measuredOffset(own);
    return { id: `s${i + 1}`, words: it.parts.flatMap((p) => p.words), truthStart, truthEnd, start: 0, end: 0 };
  });
  // Whisper's times, from the truth and the offsets, kept in order and non-overlapping.
  sentences.forEach((s, i) => {
    const it = items[i];
    s.start = Math.max(0, Math.round((s.truthStart + it.startOffset) * 100) / 100);
    s.end = Math.round((s.truthEnd + it.endOffset) * 100) / 100;
  });
  for (let i = 0; i + 1 < sentences.length; i++) if (sentences[i].end > sentences[i + 1].start) sentences[i].end = sentences[i + 1].start;
  const mix = Float32Array.from(dry);
  if (options.musicDb !== undefined) {
    const bed = musicBed(seconds);
    let sum = 0;
    let cnt = 0;
    for (const p of placedAt) for (let k = Math.round(p.at * RATE); k < Math.round(p.end * RATE); k++) {
      sum += dry[k] * dry[k];
      cnt++;
    }
    const scale = (Math.sqrt(sum / Math.max(1, cnt)) / rms(bed)) * Math.pow(10, options.musicDb / 20);
    for (let k = 0; k < n; k++) mix[k] += bed[k] * scale;
  }
  return { mix, sentences };
}

/** Transcript sentences for a boundary scene: words spread evenly over whisper's times. */
export function toTranscriptSentences(scene: BoundaryScene): { id: string; start: number; end: number; text: string; words: { text: string; start: number; end: number }[] }[] {
  return scene.sentences.map((s) => {
    const total = s.words.reduce((n, w) => n + w.length, 0);
    let acc = 0;
    const words = s.words.map((w) => {
      const a = s.start + ((s.end - s.start) * acc) / total;
      acc += w.length;
      return { text: w, start: Math.round(a * 1000) / 1000, end: Math.round((s.start + ((s.end - s.start) * acc) / total) * 1000) / 1000 };
    });
    return { id: s.id, start: s.start, end: s.end, text: s.words.join(' '), words };
  });
}
