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
