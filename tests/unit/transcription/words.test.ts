import { describe, expect, it } from 'vitest';
import { interpolateWords, joinWords, normalizeWords, tokenizeText } from '../../../src/shared/transcription';

describe('joinWords', () => {
  it('joins with spaces and skips empty words', () => {
    expect(joinWords([{ text: 'Hello' }, { text: ' ' }, { text: 'world.' }])).toBe('Hello world.');
  });

  it('does not put spaces between CJK words', () => {
    expect(joinWords([{ text: '今日' }, { text: 'は' }, { text: '晴れ。' }])).toBe('今日は晴れ。');
    expect(joinWords([{ text: 'OK' }, { text: '今日' }])).toBe('OK 今日');
  });
});

describe('tokenizeText', () => {
  it('splits on whitespace, keeping punctuation on words', () => {
    expect(tokenizeText('  Hello,  world!\n Again ')).toEqual(['Hello,', 'world!', 'Again']);
  });

  it('splits CJK per character and keeps punctuation attached', () => {
    expect(tokenizeText('你好。')).toEqual(['你', '好。']);
  });
});

describe('interpolateWords', () => {
  it('spreads words by length across the span and ends exactly at the end', () => {
    const words = interpolateWords(['a', 'bbb'], 1, 5);
    expect(words).toEqual([
      { text: 'a', start: 1, end: 2 },
      { text: 'bbb', start: 2, end: 5 },
    ]);
  });
});

describe('normalizeWords', () => {
  it('sorts, trims, drops empties, clamps to duration and removes overlaps', () => {
    const words = normalizeWords(
      [
        { text: ' second ', start: 1.0, end: 2.5 },
        { text: 'first', start: 0.2, end: 1.2 },
        { text: '', start: 3, end: 4 },
        { text: 'late', start: 2.4, end: 9 },
        { text: 'bad', start: Number.NaN, end: 1 },
      ],
      3
    );
    expect(words).toEqual([
      { text: 'first', start: 0.2, end: 1.0 },
      { text: 'second', start: 1.0, end: 2.4 },
      { text: 'late', start: 2.4, end: 3 },
    ]);
  });

  it('never produces negative or reversed times', () => {
    const [w] = normalizeWords([{ text: 'x', start: -1, end: -2 }]);
    expect(w.start).toBe(0);
    expect(w.end).toBe(0);
  });
});
