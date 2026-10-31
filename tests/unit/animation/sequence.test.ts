import { describe, expect, it } from 'vitest';
import { diffSequences, renderIdentity, replaceSegment, segmentContent, stableStringify, type AnimationSpec, type SequenceSpec } from '../../../src/shared/animation';
import { loadSpec } from './helpers';

const spec = (id: string, start: number, color = '#ffffff'): AnimationSpec => ({
  ...loadSpec('transparent-lower-third'),
  id,
  start,
  layers: loadSpec('transparent-lower-third').layers.map((l) => (l.id === 'name' ? { ...l, props: { ...l.props, color } } : l)) as AnimationSpec['layers'],
});

const sequence = (segments: AnimationSpec[]): SequenceSpec => ({ id: 'p', width: 640, height: 360, fps: 25, duration: 30, segments });

describe('render identity', () => {
  it('ignores key order, segment ID and timeline position', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe('{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}');
    const a = renderIdentity(spec('a', 0), { format: 'prores-4444', scale: 1 }, {});
    expect(renderIdentity(spec('b', 9), { format: 'prores-4444', scale: 1 }, {})).toBe(a);
    expect(segmentContent(spec('a', 0))).not.toHaveProperty('id');
    expect(segmentContent(spec('a', 0))).not.toHaveProperty('start');
  });

  it('changes with visuals, format, scale and asset content', () => {
    const a = renderIdentity(spec('a', 0), { format: 'prores-4444', scale: 1 }, {});
    expect(renderIdentity(spec('a', 0, '#ff0000'), { format: 'prores-4444', scale: 1 }, {})).not.toBe(a);
    expect(renderIdentity(spec('a', 0), { format: 'qtrle', scale: 1 }, {})).not.toBe(a);
    expect(renderIdentity(spec('a', 0), { format: 'prores-4444', scale: 0.5 }, {})).not.toBe(a);
    expect(renderIdentity(spec('a', 0), { format: 'prores-4444', scale: 1 }, { 'font:Brand': 'abc' })).not.toBe(a);
  });
});

describe('diffSequences', () => {
  it('classifies added, removed, changed, moved and unchanged segments', () => {
    const before = sequence([spec('intro', 0), spec('stats', 5), spec('outro', 20), spec('gone', 25)]);
    const after = sequence([spec('intro', 0), spec('stats', 5, '#ff0000'), spec('outro', 22), spec('new', 26)]);
    expect(diffSequences(before, after)).toEqual({ added: ['new'], removed: ['gone'], changed: ['stats'], moved: ['outro'], unchanged: ['intro'] });
    expect(diffSequences(null, after).added).toEqual(['intro', 'stats', 'outro', 'new']);
  });

  it('re-renders a moved segment when the move changes its frame count, and reuses it otherwise', () => {
    // 25 fps, 1.3 s long. From 0.00: frames 0–32 (33). From 0.04: frames 1–33 (33, same length).
    // From 0.02: the start rounds up to frame 1 (0.5) but the end is exactly frame 33: frames 1–32 (32).
    const at = (start: number) => ({ ...spec('s', start), duration: 1.3 });
    expect(diffSequences(sequence([at(0)]), sequence([at(0.04)])).moved).toEqual(['s']);
    expect(diffSequences(sequence([at(0)]), sequence([at(0.02)])).changed).toEqual(['s']);
    const id = (s: AnimationSpec) => renderIdentity(s, { format: 'prores-4444', scale: 1 }, {});
    expect(id(at(0))).toBe(id(at(0.04)));
    expect(id(at(0))).not.toBe(id(at(0.02)));
  });

  it('replaces one segment and leaves the others untouched', () => {
    const before = sequence([spec('a', 0), spec('b', 5)]);
    const next = replaceSegment(before, spec('b', 5, '#00ff00'));
    expect(next.segments[0]).toBe(before.segments[0]);
    expect(diffSequences(before, next).changed).toEqual(['b']);
    expect(() => replaceSegment(before, spec('zzz', 0))).toThrow(/Unknown segment/);
  });
});
