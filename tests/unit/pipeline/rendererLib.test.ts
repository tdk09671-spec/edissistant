import { describe, expect, it } from 'vitest';
import { adoptSourceTiming, applyUpdates, exportProblems, planningInput, timeline, transcriptRows } from '../../../src/renderer/lib/pipeline';
import { segmentUpdates } from '../../../src/shared/pipeline/convert';
import { CreativePlanner } from '../../../src/shared/planning';
import { toPlanningInputs } from '../../../src/shared/pipeline/convert';
import type { AppSettings, MediaCheck, Preset, Project, Segment, Transcript } from '../../../src/renderer/types';
import { now, profile } from '../planning/helpers';

const settings = { defaultResolution: '1920x1080', defaultFrameRate: '25', outputDirectory: '' } as AppSettings;

const preset: Preset = {
  id: 'p-1',
  name: 'Client',
  clientName: 'Client',
  type: 'podcast-trailer',
  referenceLinks: [],
  referenceFiles: [],
  creativeBrief: 'Bold.',
  fonts: 'Inter Bold',
  tracking: '',
  logoPath: '',
  brandingNotes: '',
  brandColors: ['#111216', '#E9A94B'],
  createdAt: '',
  updatedAt: '',
};

const seg = (id: string, start: number, end: number, transcript: string, extra: Partial<Segment> = {}): Segment => ({
  id,
  start,
  end,
  transcript,
  visualMode: 'speaker',
  instruction: '',
  aiSuggestion: '',
  status: 'pending',
  ...extra,
});

const project = (segments: Segment[], extra: Partial<Project> = {}): Project => ({
  id: 'proj-1',
  name: 'Trailer',
  presetId: 'p-1',
  presetName: 'Client',
  status: 'draft',
  createdAt: '',
  updatedAt: '',
  segments,
  ...extra,
});

describe('transcript → sequence rows', () => {
  it('one row per sentence with word timing; empty sentences dropped', () => {
    const transcript = {
      sentences: [
        { id: 's1', start: 0.8, end: 4.9654, text: ' This is it. ', words: [{ text: ' This', start: 0.8, end: 1.2 }, { text: ' is', start: 1.2, end: 1.5 }, { text: ' it.', start: 1.5, end: 4.9654 }] },
        { id: 's2', start: 5, end: 5.2, text: '  ', words: [] },
      ],
    } as unknown as Transcript;
    const rows = transcriptRows(transcript);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ start: 0.8, end: 4.965, transcript: 'This is it.', status: 'pending', visualMode: 'speaker', instruction: '' });
    expect(rows[0].words).toEqual([
      { text: 'This', start: 0.8, end: 1.2 },
      { text: 'is', start: 1.2, end: 1.5 },
      { text: 'it.', start: 1.5, end: 4.9654 },
    ]);
  });
});

describe('applying plan results to rows', () => {
  it('sets the plan fields and never changes transcript, timing or instructions', async () => {
    const rows = [seg('a', 1, 4, 'Revenue grew from $2 million to $9 million.', { instruction: 'keep it calm' }), seg('b', 5, 7, 'Thanks for watching.'), seg('c', 8, 9, '')];
    const p = project(rows);
    const input = planningInput(p, [preset]);
    const { plan } = await new CreativePlanner().plan({ projectId: p.id, profile: profile(), segments: toPlanningInputs(input.segments) }, { now });
    const next = applyUpdates({ ...p, segments: [...rows, { ...seg('d', 10, 11, ''), plan: segmentUpdates(plan)[0].plan, aiSuggestion: 'old' }] }, segmentUpdates(plan));
    for (const row of rows) expect(next.segments!.find((s) => s.id === row.id)).toMatchObject({ transcript: row.transcript, start: row.start, end: row.end, instruction: row.instruction });
    expect(next.segments!.find((s) => s.id === 'a')!.plan?.conceptId).toBeTruthy();
    expect(next.segments!.find((s) => s.id === 'c')!.plan).toBeUndefined();
    // A row that is no longer planned loses its stale plan.
    expect(next.segments!.find((s) => s.id === 'd')).toMatchObject({ aiSuggestion: '' });
    expect(next.segments!.find((s) => s.id === 'd')!.plan).toBeUndefined();
  });

  it('refuses to plan when the project’s preset is gone', () => {
    expect(() => planningInput(project([]), [])).toThrow(/no longer in your library/);
  });
});

describe('source timing and export checks', () => {
  it('adopts the source frame rate and size unless the editor already chose them', () => {
    const p = project([], { source: { path: '/v.mp4', name: 'v.mp4' } });
    const info = { path: '/v.mp4', duration: 35.6, width: 1920, height: 1080, frameRate: '30000/1001', fps: 29.97, videoCodec: 'h264', hasAudio: true };
    const adopted = adoptSourceTiming(p, info, settings);
    expect(adopted.exportSettings).toMatchObject({ frameRate: '29.97', resolution: '1920x1080' });
    expect(adopted.source?.duration).toBe(35.6);
    expect(timeline(adopted, settings)).toEqual({ width: 1920, height: 1080, fps: 29.97, duration: 35.6 });
    const chosen = adoptSourceTiming({ ...p, exportSettings: { ...adopted.exportSettings!, frameRate: '25' } }, info, settings);
    expect(chosen.exportSettings?.frameRate).toBe('25');
    expect(adoptSourceTiming(p, { ...info, fps: null }, settings).exportSettings).toBeUndefined();
  });

  it('reports exported files that do not match what was asked for', () => {
    const good: MediaCheck = {
      path: '/out/a.mp4',
      sizeBytes: 1000,
      duration: 35.6,
      video: { codec: 'h264', width: 1920, height: 1080, frameRate: '30000/1001', frames: 1067, pixFmt: 'yuv420p', hasAlpha: false },
      audio: { codec: 'aac', sampleRate: 48000, channels: 2, duration: 35.6 },
    };
    const expected = { width: 1920, height: 1080, fps: 29.97, duration: 35.6, alpha: false, audio: true };
    expect(exportProblems(good, expected)).toEqual([]);
    expect(exportProblems({ ...good, audio: null }, expected)).toEqual(['Has no audio, but the source does.']);
    expect(exportProblems({ ...good, video: { ...good.video!, frames: 900 } }, expected)[0]).toMatch(/900 frames, expected 1067/);
    expect(exportProblems(good, { ...expected, alpha: true })).toEqual(['Has no alpha channel.']);
    expect(exportProblems({ ...good, video: null }, expected)).toEqual(['The file has no video stream.']);
  });
});
