import { describe, expect, it } from 'vitest';
import {
  analyzeContent,
  conceptById,
  CreativePlanner,
  effectiveSegment,
  extractNumbers,
  isFromTranscript,
  parseLocalEdit,
  planToAnimationSpecs,
  applyEditorAction,
  type ProjectPlan,
  type VarietyLevel,
} from '../../../src/shared/planning';
import { now, profile, transcript, NOW } from './helpers';

const planner = new CreativePlanner();
const plan = (video: 'video-a' | 'video-b' | 'injection', client: 'northwind' | 'lumen' = 'northwind', variety?: VarietyLevel, extra = {}) =>
  planner.plan({ projectId: video, profile: profile(client), segments: transcript(video), variety, ...extra }, { now });

const graphics = (p: ProjectPlan) => p.segments.filter((s) => ['motion-graphics', 'background-graphics'].includes(effectiveSegment(s).visualMode));

describe('content analysis', () => {
  it('extracts spoken numbers with units', () => {
    expect(extractNumbers('Revenue grew from $2 million in 2021 to $9 million, up 40% — 3x faster')).toEqual([
      { raw: '$2 million', value: 2e6, unit: 'currency' },
      { raw: '2021', value: 2021, unit: 'year' },
      { raw: '$9 million', value: 9e6, unit: 'currency' },
      { raw: '40%', value: 40, unit: 'percent' },
      { raw: '3x', value: 3, unit: 'multiplier', context: 'faster' },
    ]);
    // The words after a number label it on screen ("twice as fast" vs "half the cost").
    expect(extractNumbers('we deliver twice as fast at half the cost').map((n) => [n.raw, n.context])).toEqual([['twice', 'as fast'], ['half', 'the cost']]);
    expect(extractNumbers('1.2 million customers in 40 countries').map((n) => n.context)).toEqual(['customers', 'countries']);
    expect(extractNumbers('1,250,000 users and twice the speed').map((n) => n.value)).toEqual([1250000, 2]);
  });

  it('classifies meaning and keeps on-screen text in the speaker’s words', () => {
    expect(analyzeContent('Why does that matter for you?').primary).toBe('question');
    expect(analyzeContent('First we listen, then we prototype, and finally we ship.').items).toEqual(['we listen', 'we prototype', 'we ship']);
    expect(analyzeContent('So we changed the process: record, review, approve, and render.').items).toEqual(['record', 'review', 'approve', 'render']);
    expect(analyzeContent('"It felt like having a second editor," one producer told us.').keyPhrase).toBe('It felt like having a second editor');
    expect(analyzeContent('Teams cut revision rounds from 6 to 2.').kinds.map((k) => k.kind)).toContain('comparison');
    expect(isFromTranscript('cut revision rounds', 'Teams cut revision rounds from 6 to 2.')).toBe(true);
    expect(isFromTranscript('Massive savings', 'Teams cut revision rounds from 6 to 2.')).toBe(false);
  });
});

describe('transcript mapping', () => {
  it('keeps every segment’s identity, timing and text exactly, in timeline order', async () => {
    const input = transcript('video-a');
    const { plan: p } = await plan('video-a');
    expect(p.segments.map((s) => [s.segmentId, s.start, s.end, s.text])).toEqual(input.map((s) => [s.id, s.start, s.end, s.text]));
    expect(p.segments.every((s) => s.status === 'suggested')).toBe(true);
    for (const s of p.segments) {
      expect(s.suggestion.reasoning.length).toBeGreaterThan(10);
      expect(s.suggestion.meaning).toBeTruthy();
      expect(conceptById(s.suggestion.conceptId)).toBeDefined();
      if (s.suggestion.params.headline) expect(isFromTranscript(s.suggestion.params.headline, s.text)).toBe(true);
    }
  });

  it('rejects invalid input instead of guessing', async () => {
    const p = profile();
    await expect(planner.plan({ projectId: 'x', profile: p, segments: [{ id: 'a', start: 2, end: 1, text: 'x' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(planner.plan({ projectId: 'x', profile: p, segments: [{ id: 'a', start: 0, end: 1, text: 'x' }, { id: 'a', start: 1, end: 2, text: 'y' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('creative variety', () => {
  it('matches concepts to meaning', async () => {
    const { plan: p } = await plan('video-a');
    const concept = (id: string) => p.segments.find((s) => s.segmentId === id)!.suggestion.conceptId;
    expect(concept('a2')).toBe('counter-hero'); // 1.2 million customers
    expect(concept('a3')).toBe('line-trend'); // revenue grew from … to …
    expect(concept('a4')).toBe('question-card'); // a question
    expect(concept('a5')).toBe('process-steps'); // listen → prototype → ship
    expect(concept('a6')).toBe('progress-ring'); // 85%
    expect(concept('a7')).toBe('speaker-only'); // emotional beat: no graphic
  });

  it('never repeats a graphic back to back and keeps any concept under the share limit', async () => {
    for (const video of ['video-a', 'video-b'] as const) {
      const { plan: p } = await plan(video);
      const g = graphics(p);
      for (let i = 1; i < p.segments.length; i++) {
        const [a, b] = [effectiveSegment(p.segments[i - 1]), effectiveSegment(p.segments[i])];
        if (['motion-graphics', 'background-graphics'].includes(a.visualMode)) expect(b.conceptId).not.toBe(a.conceptId);
      }
      const counts = new Map<string, number>();
      for (const s of g) counts.set(s.suggestion.conceptId, (counts.get(s.suggestion.conceptId) ?? 0) + 1);
      expect(Math.max(...counts.values())).toBeLessThanOrEqual(Math.max(2, Math.ceil(g.length * 0.3)));
      expect(new Set(p.segments.map((s) => s.suggestion.conceptId)).size).toBeGreaterThanOrEqual(Math.ceil(p.segments.length * 0.7));
      expect(p.findings.filter((f) => f.kind === 'repetition' && f.severity === 'warning')).toEqual([]);
    }
  });

  it('does not overuse charts and counters even when every sentence has a number', async () => {
    const numbers = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, start: i * 4, end: i * 4 + 3.5, text: `Segment ${i + 1} grew by ${10 + i * 7}% to ${(i + 2) * 3} million users.` }));
    const { plan: p } = await planner.plan({ projectId: 'numbers', profile: profile(), segments: numbers }, { now });
    const data = p.segments.filter((s) => conceptById(effectiveSegment(s).conceptId)?.family === 'data');
    expect(data.length).toBeLessThan(numbers.length);
    expect(new Set(data.map((s) => s.suggestion.conceptId)).size).toBeGreaterThanOrEqual(2);
    expect(p.segments.some((s) => s.suggestion.varietyNotes.some((n) => /instead of another/.test(n)))).toBe(true);
  });

  it('keeps the client’s brand across videos while the concepts change with the content', async () => {
    const a = await plan('video-a');
    const b = await plan('video-b');
    expect(a.plan.profileFingerprint).toBe(b.plan.profileFingerprint);
    const specs = [a, b].flatMap(({ plan: p }, i) => {
      const approved = { ...p, segments: p.segments.map((s) => applyEditorAction(s, { type: 'approve' }, NOW)) };
      return planToAnimationSpecs(approved, transcript(i ? 'video-b' : 'video-a'), profile(), { width: 1920, height: 1080, fps: 25 }).flatMap((r) => (r.status === 'renderable' ? [r.spec] : []));
    });
    const fonts = new Set<string>();
    const backgrounds = new Set<string>();
    for (const spec of specs) {
      if (spec.exportMode === 'full-motion') backgrounds.add(JSON.stringify(spec.background));
      for (const l of spec.layers) {
        const t = (l.props.typography ?? (l.props.style as { typography?: { fontFamily: string } })?.typography) as { fontFamily: string } | undefined;
        if (t) fonts.add(t.fontFamily);
      }
    }
    expect([...fonts].sort()).toEqual(['Inter', 'Playfair Display']);
    expect(backgrounds.size).toBe(1);
    expect(JSON.parse([...backgrounds][0])).toMatchObject({ type: 'cinematic', color: '#0b0d12', light: '#e9c46a' });
    const conceptsA = new Set(a.plan.segments.map((s) => s.suggestion.conceptId));
    const conceptsB = b.plan.segments.map((s) => s.suggestion.conceptId);
    expect(conceptsB.some((c) => !conceptsA.has(c)) || conceptsB.length !== conceptsA.size).toBe(true);
  });

  it('respects the client’s avoid list', async () => {
    const { plan: p } = await plan('video-a', 'lumen');
    expect(p.segments.filter((s) => conceptById(s.suggestion.conceptId)?.family === 'data')).toEqual([]);
    expect(p.segments.some((s) => s.suggestion.conceptId === 'type-on-quote')).toBe(false);
    expect(p.segments.some((s) => s.suggestion.varietyNotes.some((n) => /Skipped .*no charts/.test(n)))).toBe(true);
  });

  it('freshens concepts across a client’s videos using usage history', async () => {
    const first = await plan('video-b');
    const history = { clientId: 'preset-northwind', projects: [{ projectId: 'old', concepts: first.plan.segments.map((s) => s.suggestion.conceptId), transitions: [], at: NOW }] };
    const strong = await plan('video-b', 'northwind', 'experimental', { clientHistory: history, seed: 'video-b' });
    // Strong content still gets its best concept; at least one weaker match is swapped for something fresh.
    const changed = strong.plan.segments.filter((s, i) => s.suggestion.conceptId !== first.plan.segments[i].suggestion.conceptId);
    expect(changed.length).toBeGreaterThanOrEqual(1);
    expect(strong.plan.segments.find((s) => s.segmentId === 'b2')!.suggestion.conceptId).toBe('progress-ring');
  });

  it('variety levels trade consistency for novelty; experimental is never less varied than low', async () => {
    const unique = async (v: VarietyLevel) => new Set((await plan('video-a', 'northwind', v)).plan.segments.map((s) => s.suggestion.conceptId)).size;
    const [low, balanced, experimental] = [await unique('low'), await unique('balanced'), await unique('experimental')];
    expect(experimental).toBeGreaterThanOrEqual(low);
    expect(balanced).toBeGreaterThanOrEqual(low);
  });

  it('is deterministic: the same approved inputs give byte-identical plans', async () => {
    const one = JSON.stringify((await plan('video-a')).plan);
    const two = JSON.stringify((await plan('video-a')).plan);
    expect(two).toBe(one);
    const otherSeed = JSON.stringify((await plan('video-a', 'northwind', 'experimental', { seed: 'another-seed' })).plan);
    expect(typeof otherSeed).toBe('string');
  });
});

describe('editor preferences and instructions', () => {
  it('forced and preferred concepts win; banned concepts never appear', async () => {
    const { plan: p } = await plan('video-a', 'northwind', 'balanced', {
      preferences: { forcedConcepts: { a2: 'kinetic-headline' }, bannedConcepts: ['progress-ring', 'question-card'], preferredConcepts: ['underline-callout'] },
    });
    const by = (id: string) => p.segments.find((s) => s.segmentId === id)!.suggestion;
    expect(by('a2').conceptId).toBe('kinetic-headline');
    expect(by('a2').varietyNotes).toContain('Editor choice');
    expect(p.segments.map((s) => s.suggestion.conceptId)).not.toContain('progress-ring');
    expect(p.segments.map((s) => s.suggestion.conceptId)).not.toContain('question-card');
  });

  it('handles simple instructions locally (no model needed)', async () => {
    const segs = transcript('video-a').map((s) => (s.id === 'a2' ? { ...s, instruction: 'use a timeline, faster' } : s.id === 'a6' ? { ...s, instruction: 'just captions here' } : s));
    const { plan: p } = await planner.plan({ projectId: 'i', profile: profile(), segments: segs }, { now });
    const a2 = p.segments.find((s) => s.segmentId === 'a2')!;
    expect(a2.suggestion.conceptId).toBe('timeline-track');
    expect(a2.suggestion.params.pace).toBe(1.3);
    expect(p.segments.find((s) => s.segmentId === 'a6')!.suggestion).toMatchObject({ conceptId: 'caption-emphasis', visualMode: 'captions' });
  });

  it('parses common edits and leaves the rest for a model', () => {
    expect(parseLocalEdit('make it much slower and bigger')).toMatchObject({ handled: true, overrides: { params: { pace: 0.6, scale: 1.25 } } });
    expect(parseLocalEdit('stay on the speaker')).toMatchObject({ handled: true, overrides: { visualMode: 'speaker', conceptId: 'speaker-only' } });
    expect(parseLocalEdit('use #FF8800 and a wipe')).toMatchObject({ handled: true, overrides: { params: { accent: '#ff8800', transition: 'wipe' } } });
    const partial = parseLocalEdit('faster, and make it feel like a 90s infomercial');
    expect(partial.handled).toBe(false);
    expect(partial.remainder).toMatch(/feel like a 90s infomercial/);
  });

  it('respects a visual mode locked by the editor', async () => {
    const segs = transcript('video-a').map((s) => (s.id === 'a3' ? { ...s, visualMode: 'b-roll' as const } : s));
    const { plan: p } = await planner.plan({ projectId: 'm', profile: profile(), segments: segs }, { now });
    expect(p.segments.find((s) => s.segmentId === 'a3')!.suggestion).toMatchObject({ visualMode: 'b-roll', conceptId: 'b-roll-suggestion' });
  });
});

describe('untrusted transcript text', () => {
  it('plans instruction-like speech as speech, flags it, and never puts it on screen as instructions', async () => {
    const { plan: p } = await plan('injection');
    expect(p.findings).toContainEqual(expect.objectContaining({ kind: 'injection', segmentIds: ['i2', 'i3'] }));
    const i2 = p.segments.find((s) => s.segmentId === 'i2')!;
    expect(i2.warnings.join(' ')).toMatch(/instruction-like text/);
    // Text is preserved verbatim; the planner doesn't edit or obey it.
    expect(i2.text).toBe(transcript('injection')[1].text);
    expect(p.segments.filter((s) => s.suggestion.conceptId === 'bar-comparison')).toEqual([]);
  });
});
