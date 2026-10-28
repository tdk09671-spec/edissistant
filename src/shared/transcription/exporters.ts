import { TranscriptionError } from './errors';
import { TRANSCRIPT_SCHEMA, TRANSCRIPT_SCHEMA_VERSION, type Transcript, type TranscriptSentence, type TranscriptWord } from './types';
import { joinWords, roundTime } from './words';

// --- JSON ----------------------------------------------------------------------------------------

export function serializeTranscript(transcript: Transcript): string {
  return JSON.stringify(transcript, null, 2);
}

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validWord(w: unknown): w is TranscriptWord {
  const word = w as TranscriptWord;
  return !!word && typeof word.text === 'string' && isNum(word.start) && isNum(word.end);
}

function validSentence(s: unknown): s is TranscriptSentence {
  const sentence = s as TranscriptSentence;
  return (
    !!sentence &&
    typeof sentence.id === 'string' &&
    typeof sentence.text === 'string' &&
    isNum(sentence.start) &&
    isNum(sentence.end) &&
    Array.isArray(sentence.words) &&
    sentence.words.every(validWord)
  );
}

/** Parses and validates a transcript produced by `serializeTranscript`. */
export function parseTranscript(json: string | unknown): Transcript {
  let data: unknown = json;
  if (typeof json === 'string') {
    try {
      data = JSON.parse(json);
    } catch {
      throw new TranscriptionError('INVALID_TRANSCRIPT', 'Transcript file is not valid JSON.');
    }
  }
  const t = data as Transcript;
  if (!t || t.schema !== TRANSCRIPT_SCHEMA) throw new TranscriptionError('INVALID_TRANSCRIPT', 'Not an Edissistant transcript.');
  if (t.version !== TRANSCRIPT_SCHEMA_VERSION) {
    throw new TranscriptionError('INVALID_TRANSCRIPT', `Unsupported transcript version ${String(t.version)}.`);
  }
  if (!Array.isArray(t.sentences) || !t.sentences.every(validSentence) || !t.media || !t.engine) {
    throw new TranscriptionError('INVALID_TRANSCRIPT', 'Transcript is missing required fields.');
  }
  return t;
}

// --- SRT -----------------------------------------------------------------------------------------

export interface SrtOptions {
  /** Characters per subtitle line. Default 42 (common broadcast guideline). */
  maxCharsPerLine?: number;
  /** Lines per cue. Default 2. */
  maxLines?: number;
  /** Shortest cue duration in seconds, extended into following silence when possible. Default 0.7. */
  minDuration?: number;
}

export function formatSrtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

/** Wraps text into at most `maxLines` lines, balancing line lengths. Assumes it fits. */
export function wrapCaption(text: string, maxCharsPerLine: number, maxLines: number): string {
  if (text.length <= maxCharsPerLine || maxLines < 2 || !text.includes(' ')) return text;
  if (maxLines > 2) {
    const lines: string[] = [];
    for (const word of text.split(' ')) {
      const last = lines[lines.length - 1];
      if (last !== undefined && last.length + 1 + word.length <= maxCharsPerLine) lines[lines.length - 1] = `${last} ${word}`;
      else lines.push(word);
    }
    return lines.join('\n');
  }
  // Two-line case: choose the space that best balances both lines without exceeding the limit.
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = text.indexOf(' '); i !== -1; i = text.indexOf(' ', i + 1)) {
    const a = i;
    const b = text.length - i - 1;
    const score = Math.max(a, b) + (a > maxCharsPerLine || b > maxCharsPerLine ? 1000 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best === -1 ? text : `${text.slice(0, best)}\n${text.slice(best + 1)}`;
}

interface Cue {
  start: number;
  end: number;
  text: string;
}

/** Splits a sentence into cues that fit the line limits, cutting between words using their timing. */
function sentenceCues(sentence: TranscriptSentence, maxChars: number): Cue[] {
  const text = sentence.text.trim();
  if (!text) return [];
  if (text.length <= maxChars || sentence.words.length < 2) return [{ start: sentence.start, end: sentence.end, text }];
  const cues: Cue[] = [];
  let group: TranscriptWord[] = [];
  for (const word of sentence.words) {
    if (group.length && joinWords([...group, word]).length > maxChars) {
      cues.push({ start: group[0].start, end: group[group.length - 1].end, text: joinWords(group) });
      group = [];
    }
    group.push(word);
  }
  if (group.length) cues.push({ start: group[0].start, end: group[group.length - 1].end, text: joinWords(group) });
  // Keep the sentence's own bounds (they may have been retimed by hand).
  cues[0].start = sentence.start;
  cues[cues.length - 1].end = sentence.end;
  return cues;
}

/** Converts sentences to SubRip text. Cues never overlap and are at least `minDuration` long where silence allows. */
export function sentencesToSrt(sentences: readonly TranscriptSentence[], options: SrtOptions = {}): string {
  const maxCharsPerLine = options.maxCharsPerLine ?? 42;
  const maxLines = options.maxLines ?? 2;
  const minDuration = options.minDuration ?? 0.7;
  const cues = [...sentences].sort((a, b) => a.start - b.start).flatMap((s) => sentenceCues(s, maxCharsPerLine * maxLines));

  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    if (cues[i].end - cues[i].start < minDuration) {
      cues[i].end = cues[i].start + minDuration;
    }
    if (next && cues[i].end > next.start) cues[i].end = Math.max(cues[i].start, next.start);
  }

  return cues
    .filter((c) => c.end > c.start)
    .map((c, i) => `${i + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${wrapCaption(c.text, maxCharsPerLine, maxLines)}\n`)
    .join('\n');
}

export function transcriptToSrt(transcript: Transcript, options?: SrtOptions): string {
  return sentencesToSrt(transcript.sentences, options);
}

/** Plain text, one sentence per line. */
export function transcriptToText(transcript: Transcript): string {
  return transcript.sentences.map((s) => s.text.trim()).filter(Boolean).join('\n');
}

// --- Sequence editor -----------------------------------------------------------------------------

/** The timing/text part of a sequence-editor segment (see renderer `Segment`). */
export interface SegmentDraft {
  start: number;
  end: number;
  transcript: string;
}

/** One segment per sentence, ready to pass to the sequence editor's `createSegment`. */
export function sentencesToSegmentDrafts(sentences: readonly TranscriptSentence[]): SegmentDraft[] {
  return sentences
    .filter((s) => s.text.trim())
    .map((s) => ({ start: roundTime(s.start), end: roundTime(Math.max(s.start, s.end)), transcript: s.text.trim() }));
}
