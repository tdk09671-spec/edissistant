import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parseCaptions, segmentsToCsv, segmentsToSrt } from '../../src/renderer/lib/captions';
import { createSegment } from '../../src/renderer/lib/project';

describe('parseCaptions', () => {
  it('parses the SRT fixture', () => {
    const cues = parseCaptions(readFileSync(join(__dirname, '../fixtures/sample.srt'), 'utf-8'));
    expect(cues).toEqual([
      { start: 0, end: 1.5, text: 'First cue' },
      { start: 1.5, end: 3, text: 'Second cue' },
    ]);
  });
  it('parses WebVTT with CRLF, BOM, cue settings and tags', () => {
    const vtt = '﻿WEBVTT\r\n\r\n00:01.000 --> 00:02.500 align:start\r\n<b>Hello</b> there\r\n';
    expect(parseCaptions(vtt)).toEqual([{ start: 1, end: 2.5, text: 'Hello there' }]);
  });
  it('splits plain transcripts into sequential placeholder cues', () => {
    expect(parseCaptions('Line one\nLine two')).toEqual([
      { start: 0, end: 5, text: 'Line one' },
      { start: 5, end: 10, text: 'Line two' },
    ]);
  });
  it('returns nothing for an empty WebVTT file', () => {
    expect(parseCaptions('WEBVTT\n')).toEqual([]);
  });
});

describe('export formats', () => {
  const segments = [
    createSegment(0, 1.5, { transcript: 'Hello, "world"', instruction: 'Cut on beat' }),
    createSegment(1.5, 3, { transcript: '' }),
  ];
  it('writes SRT for segments with a transcript only', () => {
    expect(segmentsToSrt(segments)).toBe('1\n00:00:00,000 --> 00:00:01,500\nHello, "world"\n');
  });
  it('writes CSV with escaped cells', () => {
    const lines = segmentsToCsv(segments).split('\n');
    expect(lines[0]).toBe('#,Start (s),End (s),Transcript,Visual mode,Editor instruction,AI suggestion,Status');
    expect(lines[1]).toBe('1,0.000,1.500,"Hello, ""world""",speaker,Cut on beat,,pending');
    expect(lines).toHaveLength(3);
  });
});
