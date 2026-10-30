import type { TranscriptWord } from './types';

// Scripts written without spaces between words (CJK, kana, hangul syllables, Thai).
const NO_SPACE_SCRIPT = /[฀-๿぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/;

export function isNoSpaceScript(text: string): boolean {
  return NO_SPACE_SCRIPT.test(text);
}

/** True when the text has a letter or digit, i.e. it's a word rather than stray punctuation. */
export function hasWordCharacter(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

export function roundTime(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/** Joins words with spaces, except between words of scripts that don't use them. */
export function joinWords(words: readonly { text: string }[]): string {
  let out = '';
  for (const word of words) {
    const text = word.text.trim();
    if (!text) continue;
    const glue = out && !(isNoSpaceScript(out.slice(-1)) && isNoSpaceScript(text[0])) ? ' ' : '';
    out += glue + text;
  }
  return out;
}

/** Splits text into words: on whitespace, and per character for scripts that don't use spaces. */
export function tokenizeText(text: string): string[] {
  const words: string[] = [];
  for (const chunk of text.trim().split(/\s+/)) {
    if (!chunk) continue;
    if (!isNoSpaceScript(chunk)) {
      words.push(chunk);
      continue;
    }
    // Keep punctuation attached to the preceding character.
    for (const char of Array.from(chunk)) {
      if (words.length && !hasWordCharacter(char)) {
        words[words.length - 1] += char;
      } else {
        words.push(char);
      }
    }
  }
  return words;
}

/**
 * Spreads words evenly (by character count) across a time span. Used when the engine gave no
 * per-word timing, and for words an editor typed in.
 */
export function interpolateWords(texts: string[], start: number, end: number): TranscriptWord[] {
  const span = Math.max(0, end - start);
  const weights = texts.map((t) => Math.max(1, Array.from(t).length));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let cursor = start;
  return texts.map((text, i) => {
    const wordStart = cursor;
    cursor = i === texts.length - 1 ? end : cursor + (span * weights[i]) / total;
    return { text, start: roundTime(wordStart), end: roundTime(cursor) };
  });
}

/**
 * Makes engine words safe to use: trims text, drops empties, sorts by start, clamps to
 * [0, duration] and removes overlaps so each word ends no later than the next one starts.
 */
export function normalizeWords(words: readonly TranscriptWord[], duration = 0): TranscriptWord[] {
  const limit = duration > 0 ? duration : Number.POSITIVE_INFINITY;
  const cleaned = words
    .map((w) => ({ ...w, text: w.text.trim() }))
    .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end))
    .map((w) => {
      const start = Math.min(Math.max(0, w.start), limit);
      return { ...w, start, end: Math.min(Math.max(start, w.end), limit) };
    })
    .sort((a, b) => a.start - b.start);

  for (let i = 0; i < cleaned.length - 1; i++) {
    if (cleaned[i].end > cleaned[i + 1].start) cleaned[i].end = Math.max(cleaned[i].start, cleaned[i + 1].start);
  }
  return cleaned.map((w) => ({ ...w, start: roundTime(w.start), end: roundTime(w.end) }));
}
