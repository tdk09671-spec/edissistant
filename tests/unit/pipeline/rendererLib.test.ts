import { describe, expect, it } from 'vitest';
import { adoptSourceTiming, applyUpdates, changesNotRendered, editorMessage, exportProblems, instructionPending, planningInput, timeline, timingMode, transcriptionNotice, transcriptRows } from '../../../src/renderer/lib/pipeline';
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

  // Windows validation round 2: dropped dialogue and unverified starts used to pass without a word.
  it('marks rows whose start the audio couldn’t verify and says so; missing speech is a warning', () => {
    const transcript = {
      language: 'en',
      engine: { model: 'small.en' },
      warnings: [
        'With DTW alignment, small.en returned no text for speech at 32.0–40.2 s (a known whisper.cpp problem …). This transcript was made without DTW so no dialogue is lost; …',
        '1 sentence start(s) couldn’t be verified against the audio …',
      ],
      coverage: { complete: true, gaps: [], recovered: [] },
      sentences: [
        { id: 's1', start: 0.92, end: 2, text: 'Music under this.', words: [{ text: 'Music', start: 0.92, end: 1.3, startUncertain: true }, { text: 'under', start: 1.3, end: 1.6 }, { text: 'this.', start: 1.6, end: 2 }] },
        { id: 's2', start: 3, end: 4, text: 'Clean.', words: [{ text: 'Clean.', start: 3, end: 4 }] },
      ],
    } as unknown as Transcript;
    const rows = transcriptRows(transcript);
    expect(rows.map((r) => r.startUncertain)).toEqual([true, undefined]);
    const notice = transcriptionNotice(transcript, rows, false);
    expect(notice.tone).toBe('warning');
    expect(notice.title).toBe('Transcribed 2 segments');
    expect(notice.message).toMatch(/returned no text for speech at 32\.0–40\.2 s/);
    expect(notice.message).toMatch(/start of segment 1 couldn’t be verified/);

    const gaps = transcriptionNotice({ ...transcript, warnings: ['Speech at 32.0–40.2 s has no text in the transcript: …'], coverage: { complete: false, gaps: [{ start: 32, end: 40.2 }], recovered: [] } }, rows, false);
    expect(gaps).toMatchObject({ tone: 'warning', title: 'Transcribed 2 segments, but some speech has no text' });

    const clean = transcriptionNotice({ ...transcript, warnings: [], coverage: { complete: true, gaps: [], recovered: [] } }, rows.map((r) => ({ ...r, startUncertain: undefined })), true);
    expect(clean).toMatchObject({ tone: 'success', title: 'Transcribed 2 segments' });
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
    // A graphic clip must have exactly its timeline span (Windows round 2: 146 frames instead of 145).
    expect(exportProblems({ ...good, video: { ...good.video!, frames: 146 } }, { ...expected, frames: 145 })).toEqual(['Has 146 frames, expected 145.']);
    expect(exportProblems({ ...good, video: { ...good.video!, frames: 145 } }, { ...expected, frames: 145 })).toEqual([]);
  });
});

describe('changes a render can’t have picked up (Windows round 2, bug D)', () => {
  const plan = (extra: Partial<NonNullable<Segment['plan']>> = {}): NonNullable<Segment['plan']> => ({
    conceptId: 'counter-hero',
    conceptLabel: 'Hero counter',
    mode: 'motion-graphics',
    planStatus: 'approved',
    meaning: '',
    reasoning: '',
    source: 'local',
    renderable: true,
    editorChoice: false,
    warnings: [],
    plannedInstruction: '',
    ...extra,
  });

  it('sees an edited instruction before any sync, and ignores projects saved before the field existed', () => {
    expect(instructionPending({ instruction: 'Show it as bars.' }, plan())).toBe(true);
    expect(instructionPending({ instruction: '  ' }, plan())).toBe(false);
    expect(instructionPending({ instruction: '' }, plan({ plannedInstruction: 'make it a list' }))).toBe(true);
    expect(instructionPending({ instruction: 'x' }, plan({ plannedInstruction: undefined }))).toBe(false);
  });

  it('names the rows left out instead of reporting a clean render', () => {
    const rows = [
      seg('s1', 0, 2, 'One.', { status: 'approved', plan: plan() }),
      seg('s2', 2, 4, 'Two.', { status: 'approved', instruction: 'Show it as bars.', plan: plan() }),
      seg('s3', 4, 6, 'Three.', { status: 'needs-revision', plan: plan({ stale: 'The transcript or timing changed after approval.' }) }),
      seg('s4', 6, 8, 'Four.', { instruction: 'slower', plan: plan({ planStatus: 'suggested' }) }),
    ];
    const message = changesNotRendered(project(rows))!;
    expect(message).toMatch(/instruction for segment 2 changed and hasn’t been applied/);
    expect(message).toMatch(/segment 3 changed after approval/);
    expect(message).not.toMatch(/segment 4/); // never approved: not a rendered graphic being ignored
    expect(changesNotRendered(project([rows[0]]))).toBeNull();
  });
});

describe('editor-facing messages', () => {
  it('turns the renderer’s missing-font message into an instruction in the app’s terms', () => {
    expect(editorMessage('FONT_NOT_FOUND', 'Font "Geist" is not installed. Bundle it in assets.fonts or set allowFallback.')).toBe(
      'The font “Geist” from this client’s preset is not installed on this computer. Install it, or go to Export → Allow a fallback font.'
    );
    expect(editorMessage('FONT_NOT_FOUND', 'The font file for "Brand Sans" could not be loaded (damaged or unsupported).')).toMatch(/“Brand Sans”.*could not be loaded\. Install it, or go to Export → Allow a fallback font\./);
    expect(editorMessage('FONT_NOT_FOUND', 'x')).not.toMatch(/allowFallback/);
    expect(editorMessage('MEDIA_NOT_FOUND', 'Base video not found')).toBe('Base video not found');
  });
});

// Round 3 (Task C): the transcript always says which word timing it ended up with.
describe('word timing mode after transcription', () => {
  const base = { language: 'en', engine: { model: 'small.en' }, warnings: [] as string[], coverage: { complete: true, gaps: [], recovered: [] }, sentences: [] } as unknown as Transcript;
  const withTiming = (timing: object, warnings: string[] = []) => ({ ...base, timing, warnings }) as unknown as Transcript;

  it('tells DTW, a DTW fallback, DTW unavailable and standard timing apart', () => {
    expect(timingMode(withTiming({ source: 'dtw' }), true)).toBe('dtw');
    expect(timingMode(withTiming({ source: 'tokens', dtwFallback: { reason: 'truncated', dtwEnd: 32 } }), true)).toBe('dtw-fallback');
    expect(timingMode(withTiming({ source: 'tokens' }), true)).toBe('dtw-unavailable');
    expect(timingMode(withTiming({ source: 'tokens' }), false)).toBe('standard');
  });

  it('says so in the notice; a fallback or unavailable DTW is a warning', () => {
    expect(transcriptionNotice(withTiming({ source: 'dtw' }), [], false, true)).toMatchObject({ tone: 'success', message: expect.stringContaining('Word timing: DTW alignment.') });
    const fallback = transcriptionNotice(withTiming({ source: 'tokens', dtwFallback: { reason: 'truncated', dtwEnd: 32 } }, ['With DTW alignment, small.en returned no text for speech at 32.9–34.5 s …']), [], false, true);
    expect(fallback.tone).toBe('warning');
    expect(fallback.message).toMatch(/DTW lost speech, so the transcript was made without it \(no dialogue lost\)/);
    expect(transcriptionNotice(withTiming({ source: 'tokens' }), [], false, true)).toMatchObject({ tone: 'warning', message: expect.stringContaining('isn’t available for this model') });
    expect(transcriptionNotice(withTiming({ source: 'tokens' }), [], false, false)).toMatchObject({ tone: 'success', message: expect.stringContaining('Word timing: standard.') });
  });
});

// Round 3: unverified sentence ends are marked on the row and named in the notice.
describe('unverified sentence ends', () => {
  it('rows carry the end flag and the notice points to the graphic out point', () => {
    const transcript = {
      language: 'en',
      engine: { model: 'base.en' },
      warnings: [],
      coverage: { complete: true, gaps: [], recovered: [] },
      sentences: [
        { id: 's1', start: 1, end: 2, text: 'Wait a second.', words: [{ text: 'Wait', start: 1, end: 1.4 }, { text: 'a', start: 1.4, end: 1.5 }, { text: 'second.', start: 1.5, end: 2, endUncertain: true }] },
        { id: 's2', start: 2.02, end: 3, text: 'Sure.', words: [{ text: 'Sure.', start: 2.02, end: 3 }] },
      ],
    } as unknown as Transcript;
    const rows = transcriptRows(transcript);
    expect(rows.map((r) => r.endUncertain)).toEqual([true, undefined]);
    const notice = transcriptionNotice(transcript, rows, false);
    expect(notice.tone).toBe('warning');
    expect(notice.message).toMatch(/end of segment 1 couldn’t be verified .* graphic out point/);
  });
});
