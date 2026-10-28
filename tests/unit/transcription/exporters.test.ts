import { describe, expect, it } from 'vitest';
import { parseCaptions } from '../../../src/renderer/lib/captions';
import {
  formatSrtTime,
  makeSentence,
  parseTranscript,
  sentencesToSegmentDrafts,
  sentencesToSrt,
  serializeTranscript,
  TRANSCRIPT_SCHEMA,
  TRANSCRIPT_SCHEMA_VERSION,
  TranscriptionError,
  transcriptToText,
  wrapCaption,
  type Transcript,
  type TranscriptWord,
} from '../../../src/shared/transcription';

function words(text: string, start: number, step = 0.5): TranscriptWord[] {
  return text.split(' ').map((w, i) => ({ text: w, start: start + i * step, end: start + i * step + step * 0.8 }));
}

function transcript(sentences = [makeSentence('s1', words('Hello there.', 0)), makeSentence('s2', words('General Kenobi.', 2))]): Transcript {
  return {
    schema: TRANSCRIPT_SCHEMA,
    version: TRANSCRIPT_SCHEMA_VERSION,
    id: 'abc',
    language: 'en',
    duration: 4,
    media: { path: '/m/a.mp4', name: 'a.mp4', size: 1, modifiedAt: '2026-01-01T00:00:00.000Z', fingerprint: 'f' },
    engine: { name: 'whisper.cpp', model: 'base.en', device: 'cpu', cpuFallback: false, threads: 4 },
    wordTiming: 'word',
    sentences,
    createdAt: '2026-01-01T00:00:00.000Z',
    warnings: [],
  };
}

describe('formatSrtTime', () => {
  it('formats hours, minutes, seconds and milliseconds', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000');
    expect(formatSrtTime(3723.4567)).toBe('01:02:03,457');
    expect(formatSrtTime(-1)).toBe('00:00:00,000');
  });
});

describe('wrapCaption', () => {
  it('leaves short text alone and balances two lines', () => {
    expect(wrapCaption('Short line', 42, 2)).toBe('Short line');
    const wrapped = wrapCaption('This caption is definitely longer than forty-two characters', 42, 2);
    const lines = wrapped.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.length <= 42)).toBe(true);
    expect(Math.abs(lines[0].length - lines[1].length)).toBeLessThan(12);
  });
});

describe('sentencesToSrt', () => {
  it('writes numbered cues that round-trip through the existing caption parser', () => {
    const srt = sentencesToSrt(transcript().sentences);
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:00,900\nHello there.\n\n2\n00:00:02,000 --> 00:00:02,900\nGeneral Kenobi.\n');
    expect(parseCaptions(srt)).toEqual([
      { start: 0, end: 0.9, text: 'Hello there.' },
      { start: 2, end: 2.9, text: 'General Kenobi.' },
    ]);
  });

  it('splits sentences that exceed two lines at word boundaries using word timing', () => {
    const long = 'This is a very long sentence that keeps going well past the length that fits on two subtitle lines comfortably.';
    const sentence = makeSentence('s1', words(long, 10, 0.3));
    const cues = parseCaptions(sentencesToSrt([sentence], { maxCharsPerLine: 30, maxLines: 2 }));
    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0].start).toBe(10);
    expect(cues[cues.length - 1].end).toBeCloseTo(sentence.end, 3);
    for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end);
    expect(cues.map((c) => c.text).join(' ')).toBe(long);
  });

  it('extends very short cues without overlapping the next one', () => {
    const a = makeSentence('a', [{ text: 'Hi.', start: 1, end: 1.1 }]);
    const b = makeSentence('b', [{ text: 'Yo.', start: 1.4, end: 2 }]);
    const c = makeSentence('c', [{ text: 'Ok.', start: 5, end: 5.1 }]);
    const cues = parseCaptions(sentencesToSrt([a, b, c], { minDuration: 0.7 }));
    expect(cues[0]).toMatchObject({ start: 1, end: 1.4 });
    expect(cues[2]).toMatchObject({ start: 5, end: 5.7 });
  });

  it('skips empty sentences', () => {
    expect(sentencesToSrt([makeSentence('x', [])])).toBe('');
  });
});

describe('transcript JSON', () => {
  it('round-trips', () => {
    const t = transcript();
    expect(parseTranscript(serializeTranscript(t))).toEqual(t);
  });

  it('rejects invalid documents with INVALID_TRANSCRIPT', () => {
    const cases = ['not json', '{}', JSON.stringify({ ...transcript(), version: 99 }), JSON.stringify({ ...transcript(), sentences: [{ id: 1 }] })];
    for (const raw of cases) {
      try {
        parseTranscript(raw);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(TranscriptionError);
        expect((error as TranscriptionError).code).toBe('INVALID_TRANSCRIPT');
      }
    }
  });
});

describe('plain text and segment drafts', () => {
  it('produces one line / one segment per sentence', () => {
    const t = transcript();
    expect(transcriptToText(t)).toBe('Hello there.\nGeneral Kenobi.');
    expect(sentencesToSegmentDrafts(t.sentences)).toEqual([
      { start: 0, end: 0.9, transcript: 'Hello there.' },
      { start: 2, end: 2.9, transcript: 'General Kenobi.' },
    ]);
  });
});
