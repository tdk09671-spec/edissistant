// Parser for whisper.cpp `whisper-cli --output-json-full` (-ojf) files.
// Format reference: examples/cli/cli.cpp `output_json` in ggml-org/whisper.cpp.

import { TranscriptionError } from './errors';
import type { TranscriptWord, WordTiming } from './types';
import { hasWordCharacter, interpolateWords, isNoSpaceScript, roundTime, tokenizeText } from './words';

interface RawOffsets {
  from?: number;
  to?: number;
}

interface RawToken {
  text?: string;
  offsets?: RawOffsets;
  p?: number | null;
  t_dtw?: number | null;
}

interface RawSegment {
  offsets?: RawOffsets;
  text?: string;
  tokens?: RawToken[];
}

interface RawOutput {
  result?: { language?: string };
  params?: { language?: string };
  transcription?: RawSegment[];
}

export interface ParsedWhisperOutput {
  language: string;
  words: TranscriptWord[];
  wordTiming: WordTiming;
  /** End of the last segment, seconds. */
  end: number;
  /** Where word times came from: DTW alignment, whisper token times, or spread evenly over segments. */
  timingSource: 'dtw' | 'tokens' | 'interpolated';
  /**
   * Words whose start is a whisper segment boundary rather than a measured word onset. Without DTW,
   * whisper.cpp pins a segment's first token to the segment start, which it usually places where
   * the previous segment ended (before the pause), so these starts are often early.
   */
  anchoredStarts: AnchoredStart[];
}

export interface AnchoredStart {
  /** Index of the segment's first word in `words`. */
  index: number;
  /** Number of words in that segment. */
  count: number;
  /** The segment's word times are estimates spread over the segment (no token timing). */
  estimated: boolean;
}

export interface ParseWhisperOptions {
  /** Use DTW token times (`t_dtw`) when present. */
  dtw?: boolean;
}

// Control tokens such as [_BEG_], [_TT_150], [_SOT_], <|endoftext|>.
const SPECIAL_TOKEN = /^\s*(\[_[A-Z]+_?\d*\]|<\|[^|]*\|>)\s*$/;
// Non-speech annotations the model emits for silence/music: [BLANK_AUDIO], (music), [Applause] …
const ANNOTATION = /^\s*[[(][^\])]*[\])]\s*$/;
// Space-led tokens that belong to the following word: opening quotes/brackets and prefix symbols
// such as currency (" $" + "230" → "$230").
const OPENING_PUNCTUATION = /^\s*["'“‘«(\[¿¡$£€¥₹#@]+$/;

/** whisper.cpp writes non-finite floats as bare nan/inf, which isn't JSON. */
function sanitizeJson(raw: string): string {
  return raw.replace(/:\s*-?(?:nan(?:\([^)]*\))?|inf(?:inity)?)(?=\s*[,}\n])/gi, ': null');
}

export function parseWhisperCppJson(raw: string, options: ParseWhisperOptions = {}): ParsedWhisperOutput {
  let data: RawOutput;
  try {
    data = JSON.parse(sanitizeJson(raw));
  } catch {
    try {
      // Raw control characters inside strings are the other thing whisper.cpp doesn't escape.
      data = JSON.parse(sanitizeJson(raw).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' '));
    } catch {
      throw new TranscriptionError('TRANSCRIPTION_FAILED', 'The transcription engine produced unreadable output.');
    }
  }
  if (!data || !Array.isArray(data.transcription)) {
    throw new TranscriptionError('TRANSCRIPTION_FAILED', 'The transcription engine output has no transcription.');
  }

  const words: TranscriptWord[] = [];
  const anchoredStarts: AnchoredStart[] = [];
  let anyTokenTiming = false;
  let allTokenTiming = true;
  let allDtw = true;
  let end = 0;

  for (const segment of data.transcription) {
    const segStart = (segment.offsets?.from ?? 0) / 1000;
    const segEnd = Math.max(segStart, (segment.offsets?.to ?? 0) / 1000);
    end = Math.max(end, segEnd);
    const text = (segment.text ?? '').trim();
    if (!text || ANNOTATION.test(text)) continue;

    const fromTokens = wordsFromTokens(segment.tokens ?? [], segStart, segEnd, options.dtw === true);
    const first = words.length;
    if (fromTokens) {
      anyTokenTiming = true;
      if (!fromTokens.usedDtw) allDtw = false;
      words.push(...fromTokens.words);
      if (!fromTokens.usedDtw && fromTokens.words.length && Math.abs(fromTokens.words[0].start - roundTime(segStart)) < 0.0015) {
        anchoredStarts.push({ index: first, count: fromTokens.words.length, estimated: false });
      }
    } else {
      allTokenTiming = false;
      allDtw = false;
      words.push(...interpolateWords(tokenizeText(text), segStart, segEnd));
      if (words.length > first) anchoredStarts.push({ index: first, count: words.length - first, estimated: true });
    }
  }

  const language = data.result?.language || data.params?.language || 'unknown';
  const timed = anyTokenTiming && allTokenTiming;
  return {
    language,
    words,
    wordTiming: timed ? 'word' : 'interpolated',
    end: roundTime(end),
    timingSource: !timed ? 'interpolated' : allDtw && words.length > 0 ? 'dtw' : 'tokens',
    anchoredStarts,
  };
}

interface WordBuilder {
  text: string;
  start: number;
  end: number;
  dtw: number | null;
  probabilities: number[];
}

/** Assembles sub-word tokens into words. Returns null when the tokens carry no timing. */
function wordsFromTokens(tokens: RawToken[], segStart: number, segEnd: number, useDtw: boolean): { words: TranscriptWord[]; usedDtw: boolean } | null {
  const timed = tokens.filter(
    (t) => typeof t.text === 'string' && !SPECIAL_TOKEN.test(t.text) && typeof t.offsets?.from === 'number' && typeof t.offsets?.to === 'number'
  );
  if (timed.length === 0) return null;

  const built: WordBuilder[] = [];
  let prefix = '';
  for (const token of timed) {
    const text = token.text as string;
    const start = (token.offsets!.from as number) / 1000;
    const end = (token.offsets!.to as number) / 1000;
    const p = typeof token.p === 'number' && Number.isFinite(token.p) ? token.p : null;
    const dtw = typeof token.t_dtw === 'number' && token.t_dtw >= 0 ? token.t_dtw / 100 : null;
    const current = built[built.length - 1];
    // A pending prefix means the next token starts a new word even without a leading space.
    const startsWord = /^\s/.test(text) || !current || prefix !== '' || isNoSpaceScript(text);

    if (startsWord && !hasWordCharacter(text)) {
      // Punctuation token: an opening quote/bracket or prefix symbol belongs to the next word, anything else to the previous one.
      if (OPENING_PUNCTUATION.test(text) || !current) {
        prefix += text.trim();
      } else {
        current.text += text.trim();
        current.end = Math.max(current.end, end);
      }
      continue;
    }
    if (startsWord) {
      built.push({ text: prefix + text.trim(), start, end, dtw, probabilities: p === null ? [] : [p] });
      prefix = '';
    } else {
      current.text += text;
      current.end = Math.max(current.end, end);
      if (p !== null) current.probabilities.push(p);
    }
  }

  const words = built.filter((w) => !ANNOTATION.test(w.text) && hasWordCharacter(w.text));
  const dtwUsable = useDtw && words.length > 0 && words.every((w) => w.dtw !== null);

  const timedWords = words.map((w, i) => {
    let start = w.start;
    let end = w.end;
    if (dtwUsable) {
      // DTW times mark where each token begins; a word ends where the next one begins.
      start = w.dtw as number;
      end = i < words.length - 1 ? (words[i + 1].dtw as number) : Math.max(segEnd, start);
    }
    start = Math.min(Math.max(start, segStart), segEnd);
    end = Math.min(Math.max(end, start), segEnd);
    const word: TranscriptWord = { text: w.text, start: roundTime(start), end: roundTime(end) };
    if (w.probabilities.length) {
      word.confidence = Math.round((w.probabilities.reduce((a, b) => a + b, 0) / w.probabilities.length) * 1000) / 1000;
    }
    return word;
  });
  return { words: timedWords, usedDtw: dtwUsable };
}
