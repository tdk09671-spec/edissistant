import { describe, expect, it } from 'vitest';
import { validateAnimationSpec, validateSequence, type AnimationSpec } from '../../../src/shared/animation';
import { loadSpec } from './helpers';

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    specVersion: 1,
    id: 'seg-1',
    start: 2,
    duration: 3,
    width: 1920,
    height: 1080,
    fps: 25,
    exportMode: 'full-motion',
    background: { type: 'solid', color: '#101010' },
    layers: [{ id: 'title', type: 'text', props: { text: 'Hi', typography: { fontFamily: 'sans-serif', fontSize: 64 }, color: '#fff' } }],
    ...overrides,
  };
}

function issues(input: unknown): string[] {
  const r = validateAnimationSpec(input);
  return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
}

function expectIssue(input: unknown, pattern: RegExp) {
  const list = issues(input);
  expect(list.some((i) => pattern.test(i)), `expected ${pattern} in:\n${list.join('\n')}`).toBe(true);
}

describe('validateAnimationSpec', () => {
  it('accepts the fixtures that exercise every component and the caption mode', () => {
    for (const name of ['showcase', 'captions', 'transparent-lower-third']) {
      const r = validateAnimationSpec(loadSpec(name));
      expect(r.ok ? [] : r.issues).toEqual([]);
    }
  });

  it('reports system fonts that must be installed (not generic, not bundled)', () => {
    const r = validateAnimationSpec(
      base({
        assets: { fonts: [{ family: 'Brand Sans', path: '/fonts/brand.ttf' }] },
        layers: [
          { id: 'a', type: 'text', props: { text: 'a', typography: { fontFamily: 'Brand Sans', fontSize: 10 }, color: '#fff' } },
          { id: 'b', type: 'text', props: { text: 'b', typography: { fontFamily: 'Inter', fontSize: 10 }, color: '#fff' } },
          { id: 'c', type: 'text', props: { text: 'c', typography: { fontFamily: 'serif', fontSize: 10 }, color: '#fff' } },
        ],
      })
    );
    expect(r.ok && r.systemFonts).toEqual(['Inter']);
  });

  it('rejects non-objects and wrong versions', () => {
    expect(issues(null)).toEqual(['(root): must be an object']);
    expectIssue(base({ specVersion: 2 }), /^specVersion: must be 1/);
  });

  it('rejects unknown properties at every level (typos and unsupported features)', () => {
    expectIssue(base({ colour: 'red' }), /^colour: unknown property/);
    expectIssue(base({ layers: [{ id: 'x', type: 'text', script: 'alert(1)', props: {} }] }), /layers\[0\]\.script: unknown property/);
    expectIssue(
      base({ layers: [{ id: 'x', type: 'text', props: { text: 'a', typography: { fontFamily: 'sans-serif', fontSize: 10, kerning: 1 }, color: '#fff' } }] }),
      /typography\.kerning: unknown property/
    );
  });

  it('checks timing: duration, end, fps and frame coverage', () => {
    expectIssue(base({ duration: 0 }), /^duration: must be greater than 0/);
    expectIssue(base({ duration: 601 }), /^duration: must be ≤ 600/);
    expectIssue(base({ end: 4 }), /^end: must equal start \+ duration/);
    expect(issues(base({ end: 5 }))).toEqual([]);
    expectIssue(base({ fps: 27.5 }), /^fps:/);
    expect(issues(base({ fps: 29.97 }))).toEqual([]);
    expect(issues(base({ fps: 23.976 }))).toEqual([]);
    expectIssue(base({ fps: 25, duration: 0.01 }), /shorter than one frame/);
  });

  it('checks resolution limits and even dimensions', () => {
    expectIssue(base({ width: 1921 }), /^width: must be even/);
    expectIssue(base({ width: 8 }), /^width: must be ≥ 16/);
    expectIssue(base({ width: 7680, height: 4320 }), /pixel limit/);
    expect(issues(base({ width: 3840, height: 2160 }))).toEqual([]);
  });

  it('refuses to treat a solid or black background as transparency', () => {
    expectIssue(base({ exportMode: 'transparent-motion', background: { type: 'solid', color: '#000000' } }), /a solid or black background is not transparency/);
    expectIssue(base({ background: { type: 'transparent' } }), /full-motion exports need a background/);
    expect(issues(base({ exportMode: 'transparent-motion', background: { type: 'transparent' } }))).toEqual([]);
  });

  it('requires a captions layer for transparent-captions', () => {
    expectIssue(base({ exportMode: 'transparent-captions', background: { type: 'transparent' } }), /needs at least one captions layer/);
  });

  it('checks layers: ids, types, timing and transitions', () => {
    const t = (extra: Record<string, unknown>) => ({ id: 'x', type: 'text', props: { text: 'a', typography: { fontFamily: 'sans-serif', fontSize: 10 }, color: '#fff' }, ...extra });
    expectIssue(base({ layers: [t({}), t({})] }), /duplicate layer id "x"/);
    expectIssue(base({ layers: [t({ type: 'eval' })] }), /type: must be one of/);
    expectIssue(base({ layers: [t({ start: 2, end: 1 })] }), /end: must be after start/);
    expectIssue(base({ layers: [t({ start: 5 })] }), /start: must be ≤ 3/);
    expectIssue(base({ layers: [t({ enter: { type: 'fade', duration: 4 } })] }), /enter\.duration: is longer than the layer/);
    expectIssue(base({ layers: [t({ opacity: 2 })] }), /opacity: must be ≤ 1/);
    expectIssue(base({ layers: [t({ props: undefined })] }), /props: is required/);
  });

  it('checks keyframes and easings', () => {
    const layer = (opacity: unknown) => ({ id: 'x', type: 'text', opacity, props: { text: 'a', typography: { fontFamily: 'sans-serif', fontSize: 10 }, color: '#fff' } });
    expectIssue(base({ layers: [layer({ keyframes: [] })] }), /keyframes: needs at least 1/);
    expectIssue(base({ layers: [layer({ keyframes: [{ t: 0, value: 0, easing: 'wobble' }] })] }), /easing: unknown easing/);
    expectIssue(base({ layers: [layer({ keyframes: [{ t: 0, value: 0, easing: { cubicBezier: [2, 0, 0, 1] } }] })] }), /x1 and x2 must be between 0 and 1/);
    expect(issues(base({ layers: [layer({ keyframes: [{ t: 0, value: 0, easing: { cubicBezier: [0.2, 0, 0, 1] } }, { t: 1, value: 1, easing: { steps: 4 } }] })] }))).toEqual([]);
  });

  it('blocks injection through fonts, colors and SVG paths', () => {
    const text = (family: string) => ({ id: 'x', type: 'text', props: { text: 'a', typography: { fontFamily: family, fontSize: 10 }, color: '#fff' } });
    expectIssue(base({ layers: [text('Arial", serif; x')] }), /fontFamily: may only contain/);
    expectIssue(base({ layers: [{ id: 'x', type: 'shape', props: { shape: 'rect', width: 10, height: 10, fill: 'url(javascript:alert(1))' } }] }), /fill: must be a color/);
    expectIssue(base({ layers: [{ id: 'x', type: 'path', props: { d: 'M0 0 L10 10 <script>', stroke: { color: '#fff', width: 1 } } }] }), /d: must be SVG path data/);
  });

  it('checks assets: absolute paths, extensions and references', () => {
    expectIssue(base({ assets: { fonts: [{ family: 'X', path: 'fonts/x.ttf' }] } }), /assets\.fonts\[0\]\.path: must be an absolute path/);
    expectIssue(base({ assets: { fonts: [{ family: 'X', path: 'C:\\Fonts\\x.exe' }] } }), /must be a \.ttf/);
    expect(issues(base({ assets: { fonts: [{ family: 'X', path: 'C:\\Fonts\\x.otf' }], images: [{ id: 'logo', path: '\\\\nas\\brand\\logo.png' }] } }))).toEqual([]);
    expectIssue(base({ layers: [{ id: 'i', type: 'image', props: { asset: 'logo', width: 10, height: 10 } }] }), /unknown image asset "logo"/);
    expectIssue(base({ background: { type: 'image', asset: 'plate' } }), /background\.asset: unknown image asset/);
  });

  it('validates component props (charts, diagrams, captions)', () => {
    expectIssue(base({ layers: [{ id: 'b', type: 'barChart', props: { data: [], width: 10, height: 10, barColor: '#fff' } }] }), /data: needs at least 1/);
    expectIssue(
      base({
        layers: [
          {
            id: 'd',
            type: 'diagram',
            props: {
              nodes: [{ id: 'a', label: 'A', x: 0, y: 0, width: 10, height: 10 }],
              edges: [{ from: 'a', to: 'missing' }],
              nodeStyle: { fill: '#000', typography: { fontFamily: 'sans-serif', fontSize: 10 }, textColor: '#fff' },
              edgeStyle: { color: '#fff', width: 1 },
            },
          },
        ],
      }),
      /edges\[0\]\.to: unknown node "missing"/
    );
    const captions = (cues: unknown[]) =>
      base({
        exportMode: 'transparent-captions',
        background: { type: 'transparent' },
        layers: [{ id: 'c', type: 'captions', props: { cues, style: { typography: { fontFamily: 'sans-serif', fontSize: 30 }, color: '#fff' } } }],
      });
    expectIssue(captions([{ start: 1, end: 0.5, text: 'x' }]), /end: must be after start/);
    expectIssue(captions([{ start: 1, end: 2, text: 'x' }, { start: 0.5, end: 0.8, text: 'y' }]), /cues must be sorted/);
    expectIssue(captions([{ start: 0, end: 4, text: 'x' }]), /end: must be ≤ 3/);
    expectIssue(captions([{ start: 0, end: 1, text: 'a b', words: [{ text: 'a b', start: 0, end: 1 }] }]), /must be a single word/);
    expectIssue(captions([{ start: 0, end: 1, text: 'a', words: [{ text: 'a', start: 1.5, end: 2 }] }]), /must fall inside the cue/);
  });

  it('limits group nesting depth', () => {
    let layer: Record<string, unknown> = { id: 'leaf', type: 'shape', props: { shape: 'rect', width: 1, height: 1, fill: '#fff' } };
    for (let i = 0; i < 5; i++) layer = { id: `g${i}`, type: 'group', props: { layers: [layer] } };
    expectIssue(base({ layers: [layer] }), /nested at most/);
  });
});

describe('validateSequence', () => {
  const seg = (id: string, start: number, extra: Partial<AnimationSpec> = {}) => base({ id, start, duration: 2, ...extra });

  it('accepts matching segments', () => {
    expect(validateSequence({ id: 'p', width: 1920, height: 1080, fps: 25, duration: 10, segments: [seg('a', 0), seg('b', 4)] }).ok).toBe(true);
  });

  it('rejects mismatched resolution, frame rate, duplicates and overruns', () => {
    const r = validateSequence({
      id: 'p',
      width: 1920,
      height: 1080,
      fps: 25,
      duration: 5,
      segments: [seg('a', 0), seg('a', 1), seg('b', 0, { width: 1280, height: 720 }), seg('c', 0, { fps: 30 }), seg('d', 4)],
    });
    expect(r.ok).toBe(false);
    const messages = r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        'segments[1].id: duplicate segment id "a"',
        'segments[2]: segment resolution must match the sequence',
        'segments[3].fps: segment frame rate must match the sequence',
        'segments[4]: segment ends after the sequence',
      ])
    );
  });

  it('prefixes segment issues with their index', () => {
    const r = validateSequence({ id: 'p', width: 1920, height: 1080, fps: 25, duration: 5, segments: [seg('a', 0, { width: 3 })] });
    expect(r.ok ? [] : r.issues.map((i) => i.path)).toContain('segments[0].width');
  });
});
