import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlanningStore } from '../../../src/main/planning/stores';
import { buildStyleProfile, contrastRatio, parseFonts, parseStyleProfile, parseTracking, PlanningError, type ReferenceAnalysis } from '../../../src/shared/planning';
import { NOW, preset, profile } from './helpers';

const darkReference: ReferenceAnalysis = {
  id: 'ref-dark',
  kind: 'reference-video',
  location: '/refs/dark.mp4',
  fingerprint: 'f1',
  durationSeconds: 60,
  width: 1920,
  height: 1080,
  fps: 25,
  cuts: [],
  cutsPerMinute: 30,
  averageShotSeconds: 2,
  frames: [],
  dominantColors: ['#0b0f1a', '#d4a017'],
  meanLuminance: 0.12,
  contrast: 0.2,
  meanSaturation: 0.3,
  analyzedAt: NOW,
};

describe('style profile', () => {
  it('reads explicit preset choices with high confidence and provenance', () => {
    const p = profile('northwind');
    expect(p.typography.value.headline).toMatchObject({ family: 'Playfair Display', weight: 700, fallback: 'serif' });
    expect(p.typography.value.body).toMatchObject({ family: 'Inter', weight: 500, fallback: 'sans-serif' });
    expect(p.typography.value.headline.letterSpacing).toBe(3.2); // +50 tracking ≈ 3.2 px at 64 px
    expect(p.typography.confidence).toBeGreaterThan(0.9);
    expect(p.palette.value.accents.slice(0, 2)).toEqual(['#e9c46a', '#f4a261']);
    expect(p.background.value).toBe('cinematic');
    expect(p.motion.value.energy).toBe('calm');
    expect(p.graphicElements.value).toEqual(['charts', 'grain', 'underline']);
    expect(p.avoid).toContainEqual({ kind: 'effect', value: 'overshoot', reason: 'Brief: no bouncy motion' });
    expect(p.logos).toEqual(['/brand/northwind/logo.png']);
    expect(p.provenance[0]).toEqual({ kind: 'preset', sourceId: 'preset-northwind' });
  });

  it('turns "no charts" into an avoid rule, not a chart preference', () => {
    const p = profile('lumen');
    expect(p.avoid).toContainEqual(expect.objectContaining({ kind: 'family', value: 'data' }));
    expect(p.avoid).toContainEqual(expect.objectContaining({ kind: 'effect', value: 'typewriter' }));
    expect(p.graphicElements.value).not.toContain('charts');
    expect(p.background.value).toBe('paper');
    expect(p.motion.value.energy).toBe('energetic');
  });

  it('states what is uncertain', () => {
    const p = buildStyleProfile({ preset: { ...preset('lumen'), fonts: '', brandColors: [], creativeBrief: '' } }, NOW);
    expect(p.typography.confidence).toBeLessThan(0.3);
    expect(p.palette.uncertainty).toMatch(/inferred/);
    expect(p.uncertainties.join(' ')).toMatch(/No reference videos analysed/);
    expect(p.confidence).toBeLessThan(0.4);
    expect(profile('northwind').uncertainties.join(' ')).toMatch(/Playfair Display" must be installed/);
  });

  it('uses reference analysis as evidence, with provenance', () => {
    const p = buildStyleProfile({ preset: { ...preset('lumen'), creativeBrief: '', brandColors: [] }, references: [darkReference] }, NOW);
    expect(p.background.value).toBe('cinematic');
    expect(p.background.sources[0]).toMatchObject({ kind: 'reference-video', sourceId: 'ref-dark' });
    expect(p.motion.value).toMatchObject({ energy: 'energetic', averageShotSeconds: 2 });
    expect(p.palette.value.accents).toContain('#d4a017');
    expect(p.provenance).toContainEqual(expect.objectContaining({ kind: 'reference-video', location: '/refs/dark.mp4' }));
  });

  it('is deterministic; the revision only moves when the style changes', () => {
    const a = buildStyleProfile({ preset: preset('northwind') }, NOW);
    const b = buildStyleProfile({ preset: preset('northwind') }, '2027-01-01T00:00:00.000Z', a);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.revision).toBe(1);
    expect(b.updatedAt).toBe(NOW);
    const c = buildStyleProfile({ preset: { ...preset('northwind'), brandColors: ['#ff0000'] } }, '2027-01-01T00:00:00.000Z', a);
    expect(c.fingerprint).not.toBe(a.fingerprint);
    expect(c.revision).toBe(2);
    expect(c.createdAt).toBe(NOW);
  });

  it('parses fonts and tracking forms editors type', () => {
    expect(parseFonts('Inter Bold, Playfair Display 600; Space Mono')).toEqual([
      { family: 'Inter', weight: 700 },
      { family: 'Playfair Display', weight: 600 },
      { family: 'Space Mono', weight: 400 },
    ]);
    expect(parseFonts('"Brand; Sans", Evil<script>')).toEqual([{ family: 'Brand', weight: 400 }, { family: 'Sans', weight: 400 }, { family: 'Evilscript', weight: 400 }]);
    expect(parseTracking('+50')).toBe(3.2);
    expect(parseTracking('2')).toBe(2);
    expect(parseTracking('tight')).toBe(-1);
    expect(parseTracking('')).toBeNull();
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });

  it('rejects invalid stored profiles', () => {
    expect(() => parseStyleProfile({ schema: 'other' })).toThrow(PlanningError);
    expect(() => parseStyleProfile({ ...profile(), version: 9 })).toThrow(/version/);
    expect(() => parseStyleProfile({ ...profile(), palette: { value: { background: 'red', accents: [] } } })).toThrow(/missing/);
    expect(parseStyleProfile(JSON.parse(JSON.stringify(profile())))).toEqual(profile());
  });
});

describe('PlanningStore profiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'planning-store-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('saves, reloads and keeps a bounded revision history', () => {
    const store = new PlanningStore(dir, 2);
    let p = profile('northwind');
    store.saveProfile(p);
    expect(store.loadProfile(p.id)).toEqual(p);
    for (const color of ['#111111', '#222222', '#333333']) {
      p = buildStyleProfile({ preset: { ...preset('northwind'), brandColors: [color] } }, NOW, p);
      store.saveProfile(p);
    }
    expect(store.loadProfile(p.id)?.revision).toBe(4);
    expect(store.profileRevisions(p.id)).toEqual([2, 3]);
    expect(store.listProfiles()).toEqual(['preset-northwind']);
  });

  it('ignores corrupt files and refuses unsafe ids', () => {
    const store = new PlanningStore(dir);
    fs.mkdirSync(path.join(dir, 'style-profiles'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'style-profiles', 'broken.json'), '{nope');
    expect(store.loadProfile('broken')).toBeNull();
    expect(() => store.loadProfile('../secrets')).toThrow(/Invalid id/);
  });
});
