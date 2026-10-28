import type { SentenceGroupingOptions, TranscriptSentence, TranscriptWord } from './types';
import { interpolateWords, joinWords, roundTime, tokenizeText } from './words';

export const DEFAULT_GROUPING: Required<SentenceGroupingOptions> = {
  pauseThreshold: 0.8,
  maxDuration: 8,
  maxChars: 160,
};

const SENTENCE_END = /[.!?…。！？‼⁇⁈⁉]["'”’»)\]]*$/;
const CLAUSE_END = /[,;:，、；：—–]["'”’»)\]]*$/;
// Words ending in "." that usually don't end a sentence.
const ABBREVIATIONS = new Set(['mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'st.', 'jr.', 'sr.', 'vs.', 'e.g.', 'i.e.', 'approx.', 'no.']);

export function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text) && !ABBREVIATIONS.has(text.toLowerCase());
}

export function endsClause(text: string): boolean {
  return CLAUSE_END.test(text);
}

export function makeSentence(id: string, words: TranscriptWord[], extra: Partial<TranscriptSentence> = {}): TranscriptSentence {
  return {
    id,
    start: words.length ? words[0].start : 0,
    end: words.length ? words[words.length - 1].end : 0,
    text: joinWords(words),
    words,
    ...extra,
  };
}

/**
 * Groups timed words into sentences. A new sentence starts after terminal punctuation, at a
 * pause of at least `pauseThreshold`, or when the current one would exceed `maxDuration` /
 * `maxChars` (split at the last comma when there is one, so captions break at natural points).
 */
export function groupWordsIntoSentences(words: readonly TranscriptWord[], options: SentenceGroupingOptions = {}): TranscriptSentence[] {
  const opts = { ...DEFAULT_GROUPING, ...options };
  const groups: TranscriptWord[][] = [];
  let current: TranscriptWord[] = [];

  const overflows = (group: TranscriptWord[], next: TranscriptWord) =>
    group.length > 0 &&
    (next.end - group[0].start > opts.maxDuration || joinWords(group).length + 1 + next.text.length > opts.maxChars);

  for (const word of words) {
    const prev = current[current.length - 1];
    if (prev && word.start - prev.end >= opts.pauseThreshold) {
      groups.push(current);
      current = [];
    }
    while (overflows(current, word)) {
      // Split at the last clause boundary, but not one so early that it leaves a tiny fragment.
      let cut = -1;
      for (let k = current.length - 1; k >= Math.floor(current.length / 3); k--) {
        if (endsClause(current[k].text)) {
          cut = k;
          break;
        }
      }
      if (cut === -1) {
        groups.push(current);
        current = [];
      } else {
        groups.push(current.slice(0, cut + 1));
        current = current.slice(cut + 1);
      }
    }
    current.push(word);
    if (endsSentence(word.text)) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);

  return groups.map((group, i) => makeSentence(`s${i + 1}`, group));
}

export function flattenWords(sentences: readonly TranscriptSentence[]): TranscriptWord[] {
  return sentences.flatMap((s) => s.words);
}

// --- Editing -------------------------------------------------------------------------------------

function normalizeToken(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
}

/** Longest common subsequence of two token lists; returns matched index pairs in order. */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] && a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] && a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * Replaces a sentence's text while keeping word timing wherever possible: unchanged words keep
 * their engine timestamps; inserted or rewritten words are spread across the time of the words
 * they replace (or the gap they sit in). The sentence's start and end don't move.
 */
export function editSentenceText(sentence: TranscriptSentence, text: string): TranscriptSentence {
  const tokens = tokenizeText(text);
  const old = sentence.words;
  if (tokens.length === 0) return { ...sentence, text: '', words: [], edited: true };
  if (old.length === 0) return { ...sentence, text: joinWords(tokens.map((t) => ({ text: t }))), words: interpolateWords(tokens, sentence.start, sentence.end), edited: true };

  const pairs = lcsPairs(old.map((w) => normalizeToken(w.text)), tokens.map(normalizeToken));
  const words: TranscriptWord[] = [];
  // Sentinels: anchor "before the first word" and "after the last word".
  const anchors: Array<[number, number]> = [[-1, -1], ...pairs, [old.length, tokens.length]];

  for (let k = 0; k < anchors.length - 1; k++) {
    const [oldA, newA] = anchors[k];
    const [oldB, newB] = anchors[k + 1];
    if (newA >= 0) {
      const match = old[oldA];
      const same = match.text === tokens[newA];
      words.push(same ? { ...match } : { text: tokens[newA], start: match.start, end: match.end });
    }
    const inserted = tokens.slice(newA + 1, newB);
    if (inserted.length) {
      const replaced = old.slice(oldA + 1, oldB);
      const spanStart = replaced.length ? replaced[0].start : oldA >= 0 ? old[oldA].end : sentence.start;
      const spanEnd = replaced.length ? replaced[replaced.length - 1].end : oldB < old.length ? old[oldB].start : sentence.end;
      words.push(...interpolateWords(inserted, spanStart, Math.max(spanStart, spanEnd)));
    }
  }
  return { ...sentence, text: joinWords(words), words, edited: true };
}

/** Splits a sentence before the word at `wordIndex`. The second half gets `newId`. */
export function splitSentence(sentences: readonly TranscriptSentence[], id: string, wordIndex: number, newId = `${id}b`): TranscriptSentence[] {
  return sentences.flatMap((s) => {
    if (s.id !== id) return [s];
    if (wordIndex <= 0 || wordIndex >= s.words.length) return [s];
    const edited = s.edited ? { edited: true } : {};
    return [makeSentence(s.id, s.words.slice(0, wordIndex), edited), makeSentence(newId, s.words.slice(wordIndex), edited)];
  });
}

/** Merges a sentence with the one that follows it. */
export function mergeWithNext(sentences: readonly TranscriptSentence[], id: string): TranscriptSentence[] {
  const index = sentences.findIndex((s) => s.id === id);
  if (index === -1 || index === sentences.length - 1) return [...sentences];
  const a = sentences[index];
  const b = sentences[index + 1];
  const merged = makeSentence(a.id, [...a.words, ...b.words], { edited: true });
  merged.start = Math.min(a.start, b.start);
  merged.end = Math.max(a.end, b.end);
  return [...sentences.slice(0, index), merged, ...sentences.slice(index + 2)];
}

/** Moves a sentence to a new time span, scaling its words proportionally. */
export function retimeSentence(sentence: TranscriptSentence, start: number, end: number): TranscriptSentence {
  const newStart = Math.max(0, start);
  const newEnd = Math.max(newStart, end);
  const oldSpan = sentence.end - sentence.start;
  const map = (t: number) =>
    roundTime(oldSpan > 0 ? newStart + ((t - sentence.start) / oldSpan) * (newEnd - newStart) : newStart);
  const words =
    oldSpan > 0
      ? sentence.words.map((w) => ({ ...w, start: map(w.start), end: map(w.end) }))
      : interpolateWords(sentence.words.map((w) => w.text), newStart, newEnd);
  return { ...sentence, start: roundTime(newStart), end: roundTime(newEnd), words, edited: true };
}
