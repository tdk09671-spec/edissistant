import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { groupWordsIntoSentences, parseWhisperCppJson, TranscriptionError } from '../../../src/shared/transcription';

const fixtures = path.join(__dirname, '../../fixtures/transcription');
const full = fs.readFileSync(path.join(fixtures, 'whisper-full.json'), 'utf8');

describe('parseWhisperCppJson (whisper-cli -ojf)', () => {
  const parsed = parseWhisperCppJson(full);

  it('reads the detected language and word-level timing', () => {
    expect(parsed.language).toBe('en');
    expect(parsed.wordTiming).toBe('word');
    expect(parsed.end).toBe(10.5);
  });

  it('merges sub-word tokens, attaches punctuation and drops control tokens and [BLANK_AUDIO]', () => {
    expect(parsed.words.map((w) => w.text)).toEqual([
      'Welcome', 'back', 'to', 'the', 'edit.',
      'Today', "we're", 'cutting', 'the', 'interview,', 'then', "we'll", 'grade', 'it.',
      '"Cut!"',
    ]);
  });

  it('uses token offsets for word times', () => {
    const byText = Object.fromEntries(parsed.words.map((w) => [w.text, w]));
    expect(byText['Welcome']).toMatchObject({ start: 0, end: 0.42 });
    expect(byText['edit.']).toMatchObject({ start: 0.95, end: 1.45 });
    expect(byText['interview,']).toMatchObject({ start: 3.6, end: 4.12 });
    expect(byText['"Cut!"']).toMatchObject({ start: 9.05, end: 9.5 });
  });

  it('averages token probabilities and tolerates bare nan values', () => {
    const byText = Object.fromEntries(parsed.words.map((w) => [w.text, w]));
    expect(byText['interview,'].confidence).toBeCloseTo((0.88 + 0.92) / 2, 3);
    // "it" had p = nan; only the "." token's probability counts.
    expect(byText['it.'].confidence).toBeCloseTo(0.96, 3);
  });

  it('groups into editor sentences', () => {
    const sentences = groupWordsIntoSentences(parsed.words);
    expect(sentences.map((s) => s.text)).toEqual(['Welcome back to the edit.', "Today we're cutting the interview, then we'll grade it.", '"Cut!"']);
    expect(sentences[1]).toMatchObject({ start: 2.6, end: 5.55 });
  });

  it('uses DTW times when asked and every word has them', () => {
    const dtw = parseWhisperCppJson(full, { dtw: true });
    const first = dtw.words.slice(0, 5);
    expect(first.map((w) => w.start)).toEqual([0.02, 0.44, 0.72, 0.84, 0.97]);
    // Each word ends where the next begins; the last ends at the segment end.
    expect(first[0].end).toBe(0.44);
    expect(first[4].end).toBe(1.8);
  });

  it('falls back to interpolated words when segments have no tokens', () => {
    const raw = fs.readFileSync(path.join(fixtures, 'whisper-segments-only.json'), 'utf8');
    const result = parseWhisperCppJson(raw);
    expect(result.language).toBe('de');
    expect(result.wordTiming).toBe('interpolated');
    expect(result.words.map((w) => w.text)).toEqual(['Guten', 'Morgen', 'zusammen.', 'Wir', 'fangen', 'an.']);
    expect(result.words[0].start).toBe(0);
    expect(result.words[2].end).toBe(2);
    expect(result.words[3].start).toBe(2.5);
  });

  it('rejects unreadable output', () => {
    expect(() => parseWhisperCppJson('{ truncated')).toThrow(TranscriptionError);
    expect(() => parseWhisperCppJson('{}')).toThrow(/no transcription/);
  });

  it('handles CJK tokens without spaces as separate words', () => {
    const raw = JSON.stringify({
      result: { language: 'ja' },
      transcription: [
        {
          offsets: { from: 0, to: 1000 },
          text: '今日は。',
          tokens: [
            { text: '今日', offsets: { from: 0, to: 400 }, p: 0.9 },
            { text: 'は', offsets: { from: 400, to: 600 }, p: 0.9 },
            { text: '。', offsets: { from: 600, to: 700 }, p: 0.9 },
          ],
        },
      ],
    });
    const result = parseWhisperCppJson(raw);
    expect(result.words.map((w) => w.text)).toEqual(['今日', 'は。']);
    expect(groupWordsIntoSentences(result.words)[0].text).toBe('今日は。');
  });
});
