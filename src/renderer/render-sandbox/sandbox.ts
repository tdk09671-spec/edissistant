// Runs inside the hidden render sandbox window (sandboxed Chromium, no Node, no network).
// Receives a spec plus font/image bytes, draws frames with the trusted engine and returns RGBA.

import { renderFrame } from '../../shared/animation/engine/render';
import type { CanvasLike, Ctx2D, DrawableLike, PathLike, RenderEnv } from '../../shared/animation/engine/context';
import { RenderError, toRenderErrorInfo } from '../../shared/animation/errors';
import type { SandboxCommand, SandboxMessage } from '../../shared/animation/sandboxProtocol';
import type { AnimationSpec } from '../../shared/animation/types';
import { validateAnimationSpec } from '../../shared/animation/validate';

interface RenderHost {
  send(message: SandboxMessage): void;
  onCommand(callback: (command: SandboxCommand) => void): void;
}

declare global {
  interface Window {
    renderHost?: RenderHost;
  }
}

interface Job {
  jobId: string;
  spec: AnimationSpec;
  width: number;
  height: number;
  ctx: CanvasRenderingContext2D;
  env: RenderEnv;
}

let job: Job | null = null;
const SVG_NS = 'http://www.w3.org/2000/svg';

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Text-width probe: a family is installed if text measures differently than with each generic fallback alone. */
export function fontInstalled(family: string, weight = 400, style = 'normal'): boolean {
  const ctx = makeCanvas(8, 8).getContext('2d')!;
  const sample = 'mmmmmmmmmmlli1WQ@#$%&gjpqy';
  return (['monospace', 'serif', 'sans-serif'] as const).some((generic) => {
    ctx.font = `${style} ${weight} 72px ${generic}`;
    const base = ctx.measureText(sample).width;
    ctx.font = `${style} ${weight} 72px "${family}", ${generic}`;
    return Math.abs(ctx.measureText(sample).width - base) > 0.01;
  });
}

async function init(command: Extract<SandboxCommand, { type: 'init' }>): Promise<string[]> {
  // Defense in depth: never trust that the main process validated it.
  const checked = validateAnimationSpec(command.spec);
  if (!checked.ok) throw new RenderError('INVALID_SPEC', 'The sandbox rejected the spec.', { issues: checked.issues });
  const warnings: string[] = [];

  for (const font of command.fonts) {
    try {
      const face = new FontFace(font.family, font.data as Uint8Array<ArrayBuffer>, { weight: String(font.weight ?? 400), style: font.style ?? 'normal' });
      document.fonts.add(await face.load());
    } catch {
      throw new RenderError('FONT_NOT_FOUND', `The font file for "${font.family}" could not be loaded (damaged or unsupported).`);
    }
  }
  await document.fonts.ready;

  const missing = new Map<string, boolean>();
  for (const t of checked.typographies) {
    if (['sans-serif', 'serif', 'monospace'].includes(t.fontFamily)) continue;
    const bundled = command.fonts.some((f) => f.family === t.fontFamily);
    if (bundled || fontInstalled(t.fontFamily, t.fontWeight ?? 400, t.fontStyle ?? 'normal')) continue;
    missing.set(t.fontFamily, (missing.get(t.fontFamily) ?? true) && t.allowFallback === true);
  }
  for (const [family, fallbackAllowed] of missing) {
    if (!fallbackAllowed) {
      throw new RenderError('FONT_NOT_FOUND', `Font "${family}" is not installed. Bundle it in assets.fonts or set allowFallback.`);
    }
    warnings.push(`Font "${family}" is not installed; its fallback was used.`);
  }

  const images = new Map<string, ImageBitmap>();
  for (const img of command.images) {
    try {
      images.set(img.id, await createImageBitmap(new Blob([img.data as BlobPart], { type: img.mime })));
    } catch {
      throw new RenderError('MEDIA_NOT_FOUND', `Image "${img.id}" could not be decoded.`);
    }
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  document.body.appendChild(svg);
  const memo = new Map<string, unknown>();
  const env: RenderEnv = {
    width: checked.spec.width,
    height: checked.spec.height,
    scale: command.scale,
    fps: checked.spec.fps,
    seed: checked.spec.seed ?? 1,
    createPath: (d) => new Path2D(d) as unknown as PathLike,
    pathLength: (d) => {
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', d);
      svg.appendChild(el);
      const length = el.getTotalLength();
      el.remove();
      return length;
    },
    createCanvas: (w, h) => makeCanvas(w, h) as unknown as CanvasLike,
    image: (id) => images.get(id) as DrawableLike | undefined,
    memo: <T>(key: string, build: () => T): T => {
      if (!memo.has(key)) memo.set(key, build());
      return memo.get(key) as T;
    },
  };

  // willReadFrequently keeps the canvas in CPU memory: fast readback and the same pixels on any GPU.
  const ctx = makeCanvas(command.width, command.height).getContext('2d', { alpha: true, willReadFrequently: true, colorSpace: 'srgb' });
  if (!ctx) throw new RenderError('SANDBOX_FAILED', 'Canvas 2D is not available.');
  job = { jobId: command.jobId, spec: checked.spec, width: command.width, height: command.height, ctx, env };
  return warnings;
}

const host = window.renderHost;
if (host) {
  host.onCommand(async (command) => {
    if (command.type === 'init') {
      try {
        host.send({ type: 'init-result', jobId: command.jobId, ok: true, warnings: await init(command) });
      } catch (error) {
        host.send({ type: 'init-result', jobId: command.jobId, ok: false, error: toRenderErrorInfo(error) });
      }
    } else if (command.type === 'frame' && job && command.jobId === job.jobId) {
      try {
        renderFrame(job.ctx as unknown as Ctx2D, job.spec, command.index, job.env);
        const data = job.ctx.getImageData(0, 0, job.width, job.height, { colorSpace: 'srgb' }).data;
        host.send({ type: 'frame', jobId: job.jobId, index: command.index, data });
      } catch (error) {
        host.send({ type: 'frame-error', jobId: job.jobId, index: command.index, message: error instanceof Error ? error.message : String(error) });
      }
    }
  });
  host.send({ type: 'ready' });
}
