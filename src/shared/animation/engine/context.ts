// The subset of the Canvas 2D API the engine uses, declared structurally so shared code compiles
// without DOM types. A real CanvasRenderingContext2D satisfies it; tests use a recording mock.

export interface PathLike {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
}

export interface GradientLike {
  addColorStop(offset: number, color: string): void;
}

export interface TextMetricsLike {
  width: number;
}

/** Anything drawImage accepts: images, bitmaps, canvases. */
export type DrawableLike = object & { width: number; height: number };

export interface Ctx2D {
  canvas?: unknown;
  globalAlpha: number;
  globalCompositeOperation: string;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  lineDashOffset: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  letterSpacing?: string;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  filter?: string;
  imageSmoothingQuality?: string;

  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(radians: number): void;
  scale(x: number, y: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;

  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;

  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, start: number, end: number, ccw?: boolean): void;
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number, ccw?: boolean): void;
  rect(x: number, y: number, w: number, h: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  fill(path?: PathLike): void;
  stroke(path?: PathLike): void;
  clip(path?: PathLike): void;
  setLineDash(segments: number[]): void;

  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  strokeText(text: string, x: number, y: number, maxWidth?: number): void;
  measureText(text: string): TextMetricsLike;

  createLinearGradient(x0: number, y0: number, x1: number, y1: number): GradientLike;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): GradientLike;
  createPattern?(image: DrawableLike, repetition: string): unknown;
  drawImage(image: DrawableLike, dx: number, dy: number, dw: number, dh: number): void;
  createImageData?(width: number, height: number): { data: Uint8ClampedArray; width: number; height: number };
  putImageData?(image: { data: Uint8ClampedArray; width: number; height: number }, dx: number, dy: number): void;
}

export interface CanvasLike extends DrawableLike {
  getContext(type: '2d'): Ctx2D | null;
}

/** Host services the engine needs. Implemented by the render sandbox (Chromium) and by test mocks. */
export interface RenderEnv {
  /** Spec resolution (layout units). */
  width: number;
  height: number;
  /** Output pixels per spec pixel (1 for final, e.g. 0.5 for previews). */
  scale: number;
  fps: number;
  seed: number;
  createPath(d?: string): PathLike;
  /** Total length of an SVG path in spec pixels. */
  pathLength(d: string): number;
  createCanvas(width: number, height: number): CanvasLike;
  /** Decoded image asset by ID. */
  image(id: string): DrawableLike | undefined;
  /** Per-render memo for expensive, frame-independent work (textures, layouts). */
  memo<T>(key: string, build: () => T): T;
}

/** Timing passed to a component's draw call. */
export interface LayerTime {
  /** Seconds since the layer started. */
  t: number;
  /** Layer length in seconds. */
  duration: number;
  /** Seconds since the segment started. */
  segmentTime: number;
}
