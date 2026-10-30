import { describe, expect, it } from 'vitest';
import {
  adaptSegment,
  applyEditorAction,
  buildStyleProfile,
  captionCues,
  CONCEPTS,
  CreativePlanner,
  PR2_COMPONENTS,
  PR2_ID,
  planToAnimationSpecs,
  toSequenceSpec,
  type EffectiveSegment,
  type LayerCompat,
  type ProjectPlan,
} from '../../../src/shared/planning';
import { NOW, now, preset, profile, transcript } from './helpers';

const settings = { width: 1920, height: 1080, fps: 25 };

const eff = (conceptId: string, text: string, extra: Partial<EffectiveSegment> = {}): EffectiveSegment => {
  const concept = CONCEPTS.find((c) => c.id === conceptId)!;
  return { segmentId: `seg-${conceptId}`, start: 10, end: 14, text, conceptId, visualMode: concept.visualMode, params: {}, transition: 'fade', status: 'approved', ...extra };
};

async function approvedPlan(video: 'video-a' | 'video-b' = 'video-a'): Promise<ProjectPlan> {
  const { plan } = await new CreativePlanner().plan({ projectId: video, profile: profile(), segments: transcript(video) }, { now });
  return { ...plan, segments: plan.segments.map((s) => applyEditorAction(s, { type: 'approve' }, NOW)) };
}

/** Structural checks matching PR #2's validator rules the adapter is responsible for. */
function checkSpec(spec: NonNullable<Extract<ReturnType<typeof adaptSegment>, { status: 'renderable' }>['spec']>) {
  expect(spec.specVersion).toBe(1);
  expect(PR2_ID.test(spec.id)).toBe(true);
  expect(spec.width % 2 + spec.height % 2).toBe(0);
  expect(spec.duration).toBeGreaterThan(0);
  if (spec.exportMode === 'full-motion') expect(spec.background.type).not.toBe('transparent');
  else expect(spec.background).toEqual({ type: 'transparent' });
  const ids = new Set<string>();
  const walk = (layers: LayerCompat[]) => {
    for (const l of layers) {
      expect(PR2_COMPONENTS).toContain(l.type);
      expect(ids.has(l.id)).toBe(false);
      ids.add(l.id);
      const start = l.start ?? 0;
      const end = l.end ?? spec.duration;
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      for (const tr of [l.enter, l.exit]) if (tr) expect(tr.duration).toBeLessThanOrEqual(end - start + 1e-9);
      expect(JSON.stringify(l)).not.toMatch(/undefined|NaN|Infinity/);
    }
  };
  walk(spec.layers);
}

describe('animation spec adapter', () => {
  it('turns every approved, renderable plan segment into a PR #2-shaped spec at its timeline position', async () => {
    const plan = await approvedPlan();
    const results = planToAnimationSpecs(plan, transcript('video-a'), profile(), settings);
    const renderable = results.filter((r) => r.status === 'renderable');
    expect(renderable.length).toBeGreaterThanOrEqual(6);
    for (const r of renderable) {
      if (r.status !== 'renderable') continue;
      checkSpec(r.spec);
      const seg = plan.segments.find((s) => s.segmentId === r.segmentId)!;
      expect(r.spec.start).toBe(seg.start);
      expect(r.spec.duration).toBeCloseTo(seg.end - seg.start, 3);
    }
    expect(results.find((r) => r.segmentId === 'a7')).toMatchObject({ status: 'no-graphic' }); // stays on the speaker
  });

  it('uses only brand styling from the profile', () => {
    const r = adaptSegment(eff('kinetic-headline', 'The key is that every decision starts with the editor.', { params: { headline: 'every decision starts with the editor' } }), profile(), settings);
    expect(r.status).toBe('renderable');
    if (r.status !== 'renderable') return;
    expect(r.spec.background).toEqual({ type: 'cinematic', color: '#0b0d12', light: '#e9c46a', vignette: 0.6, grain: 0.5 });
    expect(r.spec.layers[0].props).toMatchObject({
      text: 'every decision starts with the editor',
      typography: { fontFamily: 'Playfair Display', fallback: 'serif', allowFallback: false, fontWeight: 700, letterSpacing: 3.2 },
      color: '#f5f5f2',
    });
    expect(r.warnings.join(' ')).toMatch(/Playfair Display" must be installed/);
  });

  it('bundles font files and logos from the profile as PR #2 assets', () => {
    const p = buildStyleProfile({ preset: preset('northwind'), fontFiles: { 'Playfair Display': '/fonts/Playfair-Bold.ttf' } }, NOW);
    const r = adaptSegment(eff('logo-sting', 'Visit northwind.studio and book a demo today.', { params: { headline: 'book a demo today' } }), p, settings);
    expect(r).toMatchObject({ status: 'renderable', spec: { assets: { fonts: [{ family: 'Playfair Display', path: '/fonts/Playfair-Bold.ttf', weight: 700 }], images: [{ id: 'logo', path: '/brand/northwind/logo.png' }] } } });
  });

  it('uses transparent output over footage and for captions', () => {
    const overFootage = buildStyleProfile({ preset: preset('northwind'), overrides: { background: 'over-footage' } }, NOW);
    const r = adaptSegment(eff('underline-callout', 'This matters.', { params: { headline: 'This matters' } }), overFootage, settings);
    expect(r).toMatchObject({ status: 'renderable', spec: { exportMode: 'transparent-motion', background: { type: 'transparent' } } });
    const words = [
      { text: 'Honestly,', start: 10.0, end: 10.4 },
      { text: 'I', start: 10.5, end: 10.6 },
      { text: 'was', start: 10.6, end: 10.8 },
      { text: 'terrified', start: 10.8, end: 11.5 },
    ];
    const c = adaptSegment(eff('caption-emphasis', 'Honestly, I was terrified', { words }), profile(), settings);
    expect(c).toMatchObject({ status: 'renderable', spec: { exportMode: 'transparent-captions', background: { type: 'transparent' } } });
    if (c.status === 'renderable') {
      const cues = c.spec.layers[0].props.cues as { start: number; end: number; words: { start: number }[] }[];
      expect(cues[0]).toMatchObject({ start: 0, text: 'Honestly, I was terrified' });
      expect(cues[0].words.map((w) => w.start)).toEqual([0, 0.5, 0.6, 0.8]);
    }
  });

  it('splits captions into short, non-overlapping cues relative to the segment', () => {
    const cues = captionCues(eff('caption-emphasis', 'one two three four five six seven eight nine ten'), 4);
    expect(cues.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end);
    expect(cues.at(-1)!.end).toBeLessThanOrEqual(4);
  });

  it('flags what PR #2 cannot render instead of pretending', () => {
    expect(adaptSegment(eff('map-route', 'Our office in Lisbon.'), profile(), settings)).toMatchObject({ status: 'unsupported', reason: expect.stringMatching(/no map component/) });
    expect(adaptSegment(eff('b-roll-suggestion', 'A garage.'), profile(), settings)).toMatchObject({ status: 'unsupported' });
    expect(adaptSegment(eff('speaker-only', 'Hi.'), profile(), settings)).toMatchObject({ status: 'no-graphic' });
    expect(adaptSegment(eff('counter-hero', 'No numbers here.'), profile(), settings)).toMatchObject({ status: 'missing-data' });
    expect(adaptSegment(eff('bar-comparison', 'Only 40%.', { params: { values: [{ value: 40, unit: 'percent' }] } }), profile(), settings)).toMatchObject({ status: 'missing-data' });
    expect(adaptSegment(eff('lower-third', 'I run the studio.'), profile(), settings)).toMatchObject({ status: 'missing-data' });
    expect(adaptSegment(eff('logo-sting', 'Visit us.'), buildStyleProfile({ preset: { ...preset('lumen') } }, NOW), settings)).toMatchObject({ status: 'missing-assets' });
  });

  it('renders only approved, up-to-date segments unless asked for a rough preview', async () => {
    const { plan } = await new CreativePlanner().plan({ projectId: 'p', profile: profile(), segments: transcript('video-a') }, { now });
    expect(planToAnimationSpecs(plan, transcript('video-a'), profile(), settings).every((r) => r.status === 'not-approved')).toBe(true);
    const preview = planToAnimationSpecs(plan, transcript('video-a'), profile(), settings, { includeUnapproved: true });
    expect(preview.some((r) => r.status === 'renderable')).toBe(true);
    const stale = { ...plan, segments: plan.segments.map((s) => ({ ...applyEditorAction(s, { type: 'approve' }, NOW), stale: { reason: 'changed', since: NOW, inputHash: 'x' } })) };
    expect(planToAnimationSpecs(stale, [], profile(), settings).every((r) => r.status === 'not-approved' && /changed after approval/.test(r.reason))).toBe(true);
  });

  it('applies editor overrides (concept, pace, accent) when building the spec', () => {
    const r = adaptSegment(eff('kinetic-headline', 'Fast words here.', { params: { headline: 'Fast words here', pace: 2, accent: '#ff0055' } }), profile(), settings);
    if (r.status !== 'renderable') throw new Error(r.status);
    const reveal = r.spec.layers[0].props.reveal as { stagger: number; duration: number };
    const slow = adaptSegment(eff('kinetic-headline', 'Fast words here.', { params: { headline: 'Fast words here', pace: 0.5 } }), profile(), settings);
    if (slow.status !== 'renderable') throw new Error(slow.status);
    expect(reveal.duration).toBeLessThan((slow.spec.layers[0].props.reveal as { duration: number }).duration);
  });

  it('builds a PR #2 SequenceSpec covering the timeline', async () => {
    const plan = await approvedPlan();
    const seq = toSequenceSpec('video-a', planToAnimationSpecs(plan, transcript('video-a'), profile(), settings), settings);
    expect(seq).toMatchObject({ id: 'video-a', width: 1920, height: 1080, fps: 25 });
    expect(seq.duration).toBeGreaterThanOrEqual(Math.max(...seq.segments.map((s) => s.start + s.duration)));
    expect(new Set(seq.segments.map((s) => s.id)).size).toBe(seq.segments.length);
  });

  it('sanitises segment ids for PR #2', () => {
    const r = adaptSegment({ ...eff('kinetic-headline', 'Hi there.', { params: { headline: 'Hi there' } }), segmentId: '{weird id}/1' }, profile(), settings);
    expect(r.status === 'renderable' && PR2_ID.test(r.spec.id)).toBe(true);
  });
});
