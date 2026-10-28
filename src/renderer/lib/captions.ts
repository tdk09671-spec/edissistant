import type { Segment } from '../types';

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

function parseCueTime(value: string): number {
  const match = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(value.trim());
  if (!match) return NaN;
  const [, h = '0', m, s, ms] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
}

/** Parses SRT or WebVTT text into cues. Plain text is split into paragraphs without timing. */
export function parseCaptions(raw: string): CaptionCue[] {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const cues: CaptionCue[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const timingIndex = lines.findIndex((l) => l.includes('-->'));
    if (timingIndex === -1) continue;
    const [startRaw, endRaw] = lines[timingIndex].split('-->');
    const start = parseCueTime(startRaw);
    const end = parseCueTime(endRaw.trim().split(/\s+/)[0]);
    const body = lines
      .slice(timingIndex + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (!Number.isNaN(start) && !Number.isNaN(end) && body) cues.push({ start, end, text: body });
  }

  if (cues.length === 0 && !text.trimStart().startsWith('WEBVTT')) {
    // Plain transcript: one cue per paragraph, untimed (zero-length, sequential placeholders)
    return text
      .split(/\n{2,}|\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p, i) => ({ start: i * 5, end: i * 5 + 5, text: p }));
  }
  return cues;
}

function srtTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

export function segmentsToSrt(segments: Segment[]): string {
  return segments
    .filter((s) => s.transcript.trim())
    .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.transcript.trim()}\n`)
    .join('\n');
}

function csvCell(value: string | number): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function segmentsToCsv(segments: Segment[]): string {
  const header = ['#', 'Start (s)', 'End (s)', 'Transcript', 'Visual mode', 'Editor instruction', 'AI suggestion', 'Status'];
  const rows = segments.map((s, i) => [i + 1, s.start.toFixed(3), s.end.toFixed(3), s.transcript, s.visualMode, s.instruction, s.aiSuggestion, s.status]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}
