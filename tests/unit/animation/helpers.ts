import * as fs from 'fs';
import * as path from 'path';
import type { AnimationSpec } from '../../../src/shared/animation';
import type { CanvasLike, Ctx2D, PathLike, RenderEnv } from '../../../src/shared/animation/engine/context';

export const animationFixtures = path.resolve(__dirname, '../../fixtures/animation');

export function loadSpec(name: string): AnimationSpec {
  return JSON.parse(fs.readFileSync(path.join(animationFixtures, `${name}.json`), 'utf8'));
}

export interface Call {
  method: string;
  args: unknown[];
  /** Context state at the time of the call. */
  alpha: number;
  fillStyle: unknown;
  font: string;
}

/** A Canvas 2D stand-in that records draw calls. measureText uses 0.5 × fontSize per character. */
export function recordingContext(): Ctx2D & { calls: Call[]; texts: () => string[] } {
  const calls: Call[] = [];
  const stack: Record<string, unknown>[] = [];
  const state: Record<string, unknown> = {
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    lineDashOffset: 0,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    letterSpacing: '0px',
    shadowColor: 'transparent',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    filter: 'none',
  };
  const fontSize = () => Number(/(\d+(?:\.\d+)?)px/.exec(String(state.font))?.[1] ?? 10);
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args, alpha: state.globalAlpha as number, fillStyle: state.fillStyle, font: state.font as string });
  };
  const gradient = () => ({ addColorStop: () => undefined });
  const ctx = {
    calls,
    texts: () => calls.filter((c) => c.method === 'fillText').map((c) => String(c.args[0])),
    save: () => stack.push({ ...state }),
    restore: () => Object.assign(state, stack.pop() ?? {}),
    measureText: (text: string) => ({ width: text.length * fontSize() * 0.5 }),
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    createPattern: () => ({}),
    createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
  } as Record<string, unknown>;
  for (const m of [
    'translate', 'rotate', 'scale', 'setTransform', 'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo',
    'arc', 'ellipse', 'rect', 'quadraticCurveTo', 'bezierCurveTo', 'fill', 'stroke', 'clip', 'setLineDash', 'fillText', 'strokeText',
    'drawImage', 'putImageData',
  ]) {
    ctx[m] = record(m);
  }
  return new Proxy(ctx, {
    get: (target, key: string) => (key in target ? target[key] : state[key]),
    set: (_target, key: string, value) => {
      state[key] = value;
      return true;
    },
    has: (target, key: string) => key in target || key in state,
  }) as unknown as Ctx2D & { calls: Call[]; texts: () => string[] };
}

export function mockEnv(spec: Pick<AnimationSpec, 'width' | 'height' | 'fps'>, overrides: Partial<RenderEnv> = {}): RenderEnv & { canvases: number } {
  const memo = new Map<string, unknown>();
  const env = {
    width: spec.width,
    height: spec.height,
    scale: 1,
    fps: spec.fps,
    seed: 1,
    canvases: 0,
    createPath: () => ({ moveTo: () => undefined, lineTo: () => undefined, closePath: () => undefined }) as PathLike,
    pathLength: () => 100,
    createCanvas(width: number, height: number): CanvasLike {
      env.canvases++;
      const c = recordingContext();
      return { width, height, getContext: () => c };
    },
    image: () => ({ width: 100, height: 50 }),
    memo: <T>(key: string, build: () => T): T => {
      if (!memo.has(key)) memo.set(key, build());
      return memo.get(key) as T;
    },
    ...overrides,
  };
  return env;
}
