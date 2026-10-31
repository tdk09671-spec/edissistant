import { describe, expect, it } from 'vitest';
import { frameCount, renderFrame, transitionState, validateAnimationSpec, type AnimationSpec, type CounterProps } from '../../../src/shared/animation';
import { barProgress, boxExit, chartPoints, partialPolyline } from '../../../src/shared/animation/engine/components/charts';
import { fitRect } from '../../../src/shared/animation/engine/components/media';
import { ellipsePerimeter } from '../../../src/shared/animation/engine/components/shapes';
import { counterValue, formatCounter } from '../../../src/shared/animation/engine/components/text';
import { drawBackground } from '../../../src/shared/animation/engine/backgrounds';
import { fontString, formatNumber, layoutText } from '../../../src/shared/animation/engine/text';
import { loadSpec, mockEnv, recordingContext } from './helpers';

function textSpec(layer: Record<string, unknown>, extra: Partial<AnimationSpec> = {}): AnimationSpec {
  return {
    specVersion: 1,
    id: 's',
    start: 0,
    duration: 2,
    width: 200,
    height: 100,
    fps: 10,
    exportMode: 'transparent-motion',
    background: { type: 'transparent' },
    layers: [layer as AnimationSpec['layers'][number]],
    ...extra,
  };
}

function drawAt(spec: AnimationSpec, frame: number) {
  const ctx = recordingContext();
  renderFrame(ctx, spec, frame, mockEnv(spec));
  return ctx;
}

describe('text helpers', () => {
  it('builds safe CSS font strings', () => {
    expect(fontString({ fontFamily: 'Brand Sans', fontSize: 48, fontWeight: 700 })).toBe('normal 700 48px "Brand Sans", sans-serif');
    expect(fontString({ fontFamily: 'serif', fontSize: 12, fontStyle: 'italic', fallback: 'monospace' })).toBe('italic 400 12px serif');
  });

  it('wraps at word boundaries, keeps explicit newlines and caps lines', () => {
    const ctx = recordingContext();
    ctx.font = '10px sans-serif';
    // 5 px per character in the mock.
    const block = layoutText(ctx, 'one two three four\nfive', { fontFamily: 'sans-serif', fontSize: 10 }, 50);
    expect(block.lines.map((l) => l.text)).toEqual(['one two', 'three four', 'five']);
    expect(block.lineHeight).toBe(12);
    expect(block.height).toBe(36);
    expect(layoutText(ctx, 'a b c d', { fontFamily: 'sans-serif', fontSize: 10 }, 5, 2).lines).toHaveLength(2);
    expect(layoutText(ctx, 'loud', { fontFamily: 'sans-serif', fontSize: 10, textTransform: 'uppercase' }).lines[0].text).toBe('LOUD');
  });

  it('formats numbers with separators', () => {
    expect(formatNumber(1250000, 0, ',')).toBe('1,250,000');
    expect(formatNumber(1234.5, 2, '.')).toBe('1.234,50');
    expect(formatNumber(-0.0001, 2, ',')).toBe('0.00');
    expect(formatNumber(-42, 0, '')).toBe('-42');
  });
});

describe('text component', () => {
  const layer = (reveal?: unknown) => ({
    id: 't',
    type: 'text',
    transform: { x: 100, y: 50 },
    props: { text: 'one two three', typography: { fontFamily: 'sans-serif', fontSize: 10 }, color: '#ffffff', ...(reveal ? { reveal } : {}) },
  });

  it('draws the whole text without a reveal', () => {
    expect(drawAt(textSpec(layer()), 0).texts()).toEqual(['one two three']);
  });

  it('reveals words one after another with a stagger', () => {
    const spec = textSpec(layer({ by: 'word', style: 'fade', stagger: 0.5, duration: 0.2 }));
    expect(drawAt(spec, 0).texts()).toEqual([]);
    expect(drawAt(spec, 1).texts()).toEqual(['one']);
    expect(drawAt(spec, 6).texts()).toEqual(['one', 'two']);
    expect(drawAt(spec, 11).texts()).toEqual(['one', 'two', 'three']);
  });

  it('places revealed words where they sit in the full line', () => {
    const ctx = drawAt(textSpec(layer({ by: 'word', style: 'typewriter', stagger: 0, duration: 0 })), 5);
    const xs = ctx.calls.filter((c) => c.method === 'fillText').map((c) => c.args[1]);
    // Centered line of 13 chars × 5 px = 65 px starts at -32.5; "two" follows "one " (20 px).
    expect(xs).toEqual([-32.5, -12.5, 7.5]);
  });
});

describe('counter', () => {
  const p: CounterProps = { from: 0, to: 1000, delay: 0.5, duration: 1, easing: 'linear', typography: { fontFamily: 'sans-serif', fontSize: 10 }, color: '#fff', prefix: '$', suffix: 'k', decimals: 1 };

  it('counts with delay and duration and holds the final value', () => {
    expect(counterValue(p, 0, 3)).toBe(0);
    expect(counterValue(p, 1, 3)).toBe(500);
    expect(counterValue(p, 2, 3)).toBe(1000);
    expect(formatCounter(p, 1234.56)).toBe('$1,234.6k');
  });

  it('defaults the duration to the rest of the layer', () => {
    expect(counterValue({ ...p, delay: 0, duration: undefined }, 1.5, 3)).toBe(500);
    expect(counterValue({ ...p, delay: 0, duration: undefined, easing: undefined }, 1.5, 3)).toBe(1000 * (1 - (1 - 0.5) ** 3));
  });
});

describe('charts and diagrams', () => {
  it('staggers bar growth', () => {
    const p = { data: [{ value: 1 }, { value: 2 }], width: 100, height: 100, barColor: '#fff', grow: { duration: 1, stagger: 0.5, easing: 'linear' as const } };
    expect(barProgress(p, 0, 0.5)).toBe(0.5);
    expect(barProgress(p, 1, 0.5)).toBe(0);
    expect(barProgress(p, 1, 1.5)).toBe(1);
  });

  it('maps line chart points and draws partial polylines', () => {
    const pts = chartPoints([0, 10, 5], 100, 50, 0, 10);
    expect(pts).toEqual([[-50, 25], [0, -25], [50, 0]]);
    const ctx = recordingContext();
    const reached = partialPolyline(ctx, [[0, 0], [10, 0], [20, 0]], 0.75);
    expect(reached).toBe(1);
    expect(ctx.calls.filter((c) => c.method === 'lineTo').map((c) => c.args)).toEqual([[10, 0], [15, 0]]);
  });

  it('starts diagram edges at node borders', () => {
    expect(boxExit(0, 0, 10, 5, 100, 0)).toEqual([10, 0]);
    expect(boxExit(0, 0, 10, 5, 0, -100)).toEqual([0, -5]);
  });

  it('fits images and approximates ellipse perimeters', () => {
    expect(fitRect(200, 100, 100, 100, 'contain')).toEqual([-50, -25, 100, 50]);
    expect(fitRect(200, 100, 100, 100, 'cover')).toEqual([-100, -50, 200, 100]);
    expect(fitRect(200, 100, 100, 100, 'fill')).toEqual([-50, -50, 100, 100]);
    expect(ellipsePerimeter(10, 10)).toBeCloseTo(2 * Math.PI * 10, 6);
  });
});

describe('transitions', () => {
  it('fades, slides and scales in and out', () => {
    const enter = { type: 'slide' as const, duration: 1, direction: 'up' as const, distance: 100, easing: 'linear' as const };
    expect(transitionState(enter, undefined, 0, 4)).toMatchObject({ dy: 100, alpha: 0 });
    expect(transitionState(enter, undefined, 0.5, 4)).toMatchObject({ dy: 50, alpha: 0.5 });
    expect(transitionState(enter, undefined, 1, 4)).toMatchObject({ dy: 0, alpha: 1 });
    const exit = { type: 'scale' as const, duration: 1, easing: 'linear' as const };
    expect(transitionState(undefined, exit, 3.5, 4)).toMatchObject({ scale: 0.9, alpha: 0.5 });
    expect(transitionState({ type: 'wipe', duration: 1, easing: 'linear' }, undefined, 0.25, 4).wipe).toEqual({ direction: 'right', amount: 0.25 });
    expect(transitionState({ type: 'blur', duration: 1, distance: 10, easing: 'linear' }, undefined, 0.5, 4).blur).toBe(5);
  });
});

describe('renderFrame', () => {
  it('draws every frame of every fixture without errors', () => {
    for (const name of ['showcase', 'captions', 'transparent-lower-third']) {
      const spec = loadSpec(name);
      expect(validateAnimationSpec(spec).ok).toBe(true);
      const env = mockEnv(spec);
      for (let f = 0; f < frameCount(spec.duration, spec.fps); f++) renderFrame(recordingContext(), spec, f, env);
    }
  });

  it('clears the frame first and only draws layers inside their time window', () => {
    const spec = loadSpec('transparent-lower-third');
    const before = drawAt(spec, 0);
    expect(before.calls[0].method).toBe('setTransform');
    expect(before.calls.some((c) => c.method === 'clearRect')).toBe(true);
    // "name" starts at 0.2 s (frame 5): not drawn at frame 0, drawn at frame 10.
    expect(before.texts()).not.toContain('Alex Rivera');
    expect(drawAt(spec, 10).texts()).toContain('Alex Rivera');
  });

  it('draws captions only while a cue is on screen (frame accurate)', () => {
    const spec = loadSpec('captions');
    // Cue 1 runs 0.2–1.0 s: at 25 fps frames 5–24.
    expect(drawAt(spec, 4).texts()).toEqual([]);
    // Visible on its very first frame, already partway through the entrance.
    const first = drawAt(spec, 5);
    expect(first.texts().length).toBeGreaterThan(0);
    expect(first.calls.find((c) => c.method === 'fillText')!.alpha).toBeGreaterThan(0);
    expect(drawAt(spec, 24).texts().length).toBeGreaterThan(0);
    expect(drawAt(spec, 25).texts()).toEqual([]);
    expect(drawAt(spec, 30).texts().join(' ')).toContain('BY AN EDITOR.');
  });

  it('highlights the active caption word', () => {
    const spec = loadSpec('captions');
    // Frame 11 = 0.44 s: "an" is active (0.4–0.5 s).
    const fills = drawAt(spec, 11).calls.filter((c) => c.method === 'fillText');
    const an = fills.filter((c) => c.args[0] === 'AN');
    expect(an.at(-1)?.fillStyle).toBe('#ffd166');
    expect(fills.filter((c) => c.args[0] === 'FOR').at(-1)?.fillStyle).toBe('#ffffff');
  });

  it('applies the scale factor once so previews keep the same layout', () => {
    const spec = loadSpec('transparent-lower-third');
    const ctx = recordingContext();
    renderFrame(ctx, spec, 10, mockEnv(spec, { scale: 0.5 }));
    expect(ctx.calls.find((c) => c.method === 'scale')?.args).toEqual([0.5, 0.5]);
    expect(ctx.calls.find((c) => c.method === 'clearRect')?.args).toEqual([0, 0, 320, 180]);
  });
});

describe('backgrounds', () => {
  const size = { width: 100, height: 50, fps: 25 };

  it('draws nothing for transparent and fills the frame for solid', () => {
    const ctx = recordingContext();
    drawBackground(ctx, { type: 'transparent' }, 0, mockEnv(size));
    expect(ctx.calls).toEqual([]);
    drawBackground(ctx, { type: 'solid', color: '#123456' }, 0, mockEnv(size));
    expect(ctx.calls).toEqual([expect.objectContaining({ method: 'fillRect', args: [0, 0, 100, 50], fillStyle: '#123456' })]);
  });

  it('builds the paper texture once per render and reuses it on every frame', () => {
    const env = mockEnv(size);
    for (let f = 0; f < 5; f++) drawBackground(recordingContext(), { type: 'paper' }, f, env);
    // One texture canvas + one grain tile.
    expect(env.canvases).toBe(2);
  });

  it('animates cinematic grain by frame with a fixed set of tiles', () => {
    const env = mockEnv(size);
    for (let f = 0; f < 12; f++) drawBackground(recordingContext(), { type: 'cinematic', grain: 0.5 }, f, env);
    expect(env.canvases).toBe(6);
  });
});
