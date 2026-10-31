import { describe, expect, it } from 'vitest';
import {
  editSentenceText,
  groupWordsIntoSentences,
  makeSentence,
  mergeWithNext,
  retimeSentence,
  splitSentence,
  type TranscriptWord,
} from '../../../src/shared/transcription';

/** Words 0.3 s long with 0.1 s gaps, starting at `start`. */
function timed(text: string, start = 0, gap = 0.1, length = 0.3): TranscriptWord[] {
  let t = start;
  return text.split(' ').map((w) => {
    const word = { text: w, start: Math.round(t * 1000) / 1000, end: Math.round((t + length) * 1000) / 1000 };
    t += length + gap;
    return word;
  });
}

describe('groupWordsIntoSentences', () => {
  it('breaks after terminal punctuation and uses first/last word times', () => {
    const sentences = groupWordsIntoSentences(timed('Welcome back. Ready to cut? Yes!'));
    expect(sentences.map((s) => s.text)).toEqual(['Welcome back.', 'Ready to cut?', 'Yes!']);
    expect(sentences[0]).toMatchObject({ id: 's1', start: 0, end: 0.7 });
    expect(sentences[1]).toMatchObject({ id: 's2', start: 0.8, end: 1.9 });
    expect(sentences.every((s) => s.words.length > 0)).toBe(true);
  });

  it('does not break after common abbreviations', () => {
    const sentences = groupWordsIntoSentences(timed('Ask Dr. Smith about it.'));
    expect(sentences).toHaveLength(1);
  });

  it('breaks at a long pause even without punctuation', () => {
    const words = [...timed('first part'), ...timed('second part', 3)];
    const sentences = groupWordsIntoSentences(words, { pauseThreshold: 0.8 });
    expect(sentences.map((s) => s.text)).toEqual(['first part', 'second part']);
  });

  it('splits overlong sentences at the last comma', () => {
    const words = timed('one two three, four five six seven eight nine ten');
    const sentences = groupWordsIntoSentences(words, { maxDuration: 3 });
    expect(sentences[0].text).toBe('one two three,');
    expect(sentences.every((s) => s.end - s.start <= 3)).toBe(true);
    expect(sentences.flatMap((s) => s.words)).toHaveLength(words.length);
  });

  it('hard-splits overlong sentences without a comma by character count', () => {
    const words = timed('aaaa bbbb cccc dddd eeee ffff');
    const sentences = groupWordsIntoSentences(words, { maxChars: 10 });
    expect(sentences.map((s) => s.text)).toEqual(['aaaa bbbb', 'cccc dddd', 'eeee ffff']);
  });

  it('returns no sentences for no words', () => {
    expect(groupWordsIntoSentences([])).toEqual([]);
  });
});

describe('groupWordsIntoSentences: long sentences (regressions found on a real whisper.cpp transcript)', () => {
  // Synthetic sentence with the same shape as the real one: just over 160 characters, under 8 s, one early comma.
  // It used to end in a one-word "network." sentence.
  const real =
    "That is not your usual freelance rate, that's a senior level hire because they know that the host is the single most valuable growth channel for the entire network.";

  it('does not leave a one-word fragment at the end of a long sentence', () => {
    const words = timed(real, 5.87, 0.02, 0.24);
    const sentences = groupWordsIntoSentences(words);
    expect(sentences.map((s) => s.text)).toEqual([
      'That is not your usual freelance rate,',
      "that's a senior level hire because they know that the host is the single most valuable growth channel for the entire network.",
    ]);
  });

  it('keeps every word object and timestamp unchanged and in order', () => {
    const words = timed(`${real} ${real}`, 0, 0.02, 0.24);
    for (const options of [{}, { maxChars: 42 }, { maxChars: 30, maxDuration: 2 }]) {
      const sentences = groupWordsIntoSentences(words, options);
      expect(sentences.flatMap((s) => s.words)).toEqual(words);
      sentences.forEach((s) => expect(s).toMatchObject({ start: s.words[0].start, end: s.words[s.words.length - 1].end }));
    }
  });

  it('splits a long sentence with no comma into even parts, never a single trailing word', () => {
    const words = timed('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen');
    const sentences = groupWordsIntoSentences(words, { maxChars: 60 });
    expect(sentences.length).toBe(2);
    expect(sentences.every((s) => s.text.length <= 60 && s.words.length >= 6)).toBe(true);
  });

  it('prefers the longest pause between equally good cut points', () => {
    // After "cccc" and after "dddd" are both close to an even split of 34 characters.
    const text = 'aaaa bbbb cccc dddd eeee ffff gggg';
    expect(groupWordsIntoSentences(timed(text), { maxChars: 30 }).map((s) => s.text)).toEqual(['aaaa bbbb cccc dddd', 'eeee ffff gggg']);
    const words = timed(text);
    // A 0.5 s breath after "cccc" (still below the 0.8 s sentence-break pause).
    words.slice(3).forEach((w) => Object.assign(w, { start: w.start + 0.5, end: w.end + 0.5 }));
    expect(groupWordsIntoSentences(words, { maxChars: 30 }).map((s) => s.text)).toEqual(['aaaa bbbb cccc', 'dddd eeee ffff gggg']);
  });

  it('ignores a comma that would leave fewer than three words on one side', () => {
    const words = timed('So yes, we cut the interview down to the strongest three minutes and then graded it');
    const sentences = groupWordsIntoSentences(words, { maxChars: 50 });
    expect(sentences[0].text).not.toBe('So yes,');
    expect(sentences.every((s) => s.words.length >= 2 && s.text.length <= 50)).toBe(true);
  });
});

describe('editSentenceText', () => {
  const sentence = makeSentence('s1', [
    { text: 'We', start: 1, end: 1.2, confidence: 0.9 },
    { text: 'cut', start: 1.2, end: 1.5, confidence: 0.8 },
    { text: 'the', start: 1.5, end: 1.6, confidence: 0.9 },
    { text: 'interview.', start: 1.6, end: 2.2, confidence: 0.7 },
  ]);

  it('keeps timing and confidence for unchanged words', () => {
    const edited = editSentenceText(sentence, 'We cut the interview.');
    expect(edited.words).toEqual(sentence.words);
    expect(edited.edited).toBe(true);
  });

  it('gives a corrected word the timing of the word it replaces', () => {
    const edited = editSentenceText(sentence, 'We cut that interview.');
    expect(edited.text).toBe('We cut that interview.');
    expect(edited.words[2]).toEqual({ text: 'that', start: 1.5, end: 1.6 });
    expect(edited.words[3]).toEqual(sentence.words[3]);
  });

  it('keeps timing for words whose punctuation or case changed', () => {
    const edited = editSentenceText(sentence, 'we cut the interview!');
    expect(edited.words.map((w) => [w.start, w.end])).toEqual(sentence.words.map((w) => [w.start, w.end]));
    expect(edited.words[3].text).toBe('interview!');
    expect(edited.words[3].confidence).toBeUndefined();
  });

  it('spreads inserted words inside the replaced span', () => {
    const edited = editSentenceText(sentence, 'We cut the long interview.');
    const inserted = edited.words[3];
    expect(inserted.text).toBe('long');
    expect(inserted.start).toBe(1.6);
    expect(inserted.end).toBe(1.6);
    expect(edited.words[4]).toEqual(sentence.words[3]);
  });

  it('handles deleted words and keeps the sentence span', () => {
    const edited = editSentenceText(sentence, 'We cut interview.');
    expect(edited.words.map((w) => w.text)).toEqual(['We', 'cut', 'interview.']);
    expect([edited.start, edited.end]).toEqual([1, 2.2]);
  });

  it('interpolates when nothing matches and clears on empty text', () => {
    const rewritten = editSentenceText(sentence, 'Completely different words');
    expect(rewritten.words[0].start).toBe(1);
    expect(rewritten.words[2].end).toBe(2.2);
    expect(editSentenceText(sentence, '   ')).toMatchObject({ text: '', words: [] });
  });
});

describe('split, merge and retime', () => {
  const sentences = groupWordsIntoSentences(timed('Alpha beta gamma. Delta epsilon.'));

  it('splits a sentence before a word', () => {
    const result = splitSentence(sentences, 's1', 1, 'new');
    expect(result.map((s) => [s.id, s.text])).toEqual([
      ['s1', 'Alpha'],
      ['new', 'beta gamma.'],
      ['s2', 'Delta epsilon.'],
    ]);
    expect(result[1].start).toBe(sentences[0].words[1].start);
  });

  it('ignores splits at the edges', () => {
    expect(splitSentence(sentences, 's1', 0)).toEqual(sentences);
  });

  it('merges a sentence with the next one', () => {
    const result = mergeWithNext(sentences, 's1');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 's1', text: 'Alpha beta gamma. Delta epsilon.', start: 0, end: sentences[1].end, edited: true });
  });

  it('retimes a sentence and scales its words', () => {
    const s = sentences[1];
    const result = retimeSentence(s, 10, 10 + (s.end - s.start) * 2);
    expect(result.start).toBe(10);
    expect(result.words[0].start).toBe(10);
    expect(result.words[1].end).toBe(result.end);
    expect(result.words[0].end - result.words[0].start).toBeCloseTo((s.words[0].end - s.words[0].start) * 2, 3);
  });
});
