// Animation specification: the contract between the (future) planning engine and the renderer.
// Pure data. No code is ever accepted from a spec: every visual is drawn by a trusted component
// registered in engine/registry.ts. Nothing here may depend on Node or the DOM.

export const ANIMATION_SPEC_VERSION = 1;

/** Same identifiers as the project's ExportFormat (renderer types). */
export type ExportMode = 'full-motion' | 'transparent-motion' | 'transparent-captions';

export type ExportFormatId = 'prores-4444' | 'prores-422hq' | 'qtrle' | 'png-mov' | 'vp9-webm' | 'h264-mp4';

// --- Timing ----------------------------------------------------------------------------------------

export type EasingName =
  | 'linear'
  | 'easeInQuad'
  | 'easeOutQuad'
  | 'easeInOutQuad'
  | 'easeInCubic'
  | 'easeOutCubic'
  | 'easeInOutCubic'
  | 'easeInQuart'
  | 'easeOutQuart'
  | 'easeInOutQuart'
  | 'easeInExpo'
  | 'easeOutExpo'
  | 'easeInOutExpo'
  | 'easeInBack'
  | 'easeOutBack'
  | 'easeInOutBack'
  | 'easeOutElastic'
  | 'easeOutBounce';

export type Easing = EasingName | { cubicBezier: [number, number, number, number] } | { steps: number };

export interface Keyframe<T> {
  /** Seconds from the start of the layer. */
  t: number;
  value: T;
  /** Easing from this keyframe to the next. Default 'easeInOutCubic'. */
  easing?: Easing;
}

/** A constant, or keyframes interpolated over the layer's local time. */
export type Animatable<T> = T | { keyframes: Keyframe<T>[] };

/** CSS-style color: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(), or 'transparent'. */
export type Color = string;

// --- Styling ---------------------------------------------------------------------------------------

export type GenericFontFamily = 'sans-serif' | 'serif' | 'monospace';

export interface Typography {
  fontFamily: string;
  /** Used only if `allowFallback` is true or fontFamily is generic. */
  fallback?: GenericFontFamily;
  /** When false (default), a font that isn't installed or bundled fails the render. */
  allowFallback?: boolean;
  fontWeight?: number;
  fontStyle?: 'normal' | 'italic';
  /** Pixels at the spec's resolution. */
  fontSize: number;
  /** Pixels between characters. */
  letterSpacing?: number;
  /** Multiple of fontSize. Default 1.2. */
  lineHeight?: number;
  textTransform?: 'none' | 'uppercase' | 'lowercase';
}

export interface Shadow {
  color: Color;
  blur: number;
  offsetX?: number;
  offsetY?: number;
}

export interface Glow {
  color: Color;
  blur: number;
  /** Number of stacked glow passes, 1–4. Default 2. */
  strength?: number;
}

export interface Stroke {
  color: Color;
  width: number;
}

export interface Transform {
  x?: Animatable<number>;
  y?: Animatable<number>;
  scale?: Animatable<number>;
  scaleX?: Animatable<number>;
  scaleY?: Animatable<number>;
  /** Degrees, clockwise. */
  rotation?: Animatable<number>;
}

export type Direction = 'left' | 'right' | 'up' | 'down';

export interface Transition {
  type: 'fade' | 'slide' | 'scale' | 'wipe' | 'blur';
  /** Seconds. */
  duration: number;
  easing?: Easing;
  /** For slide/wipe: the direction of motion. */
  direction?: Direction;
  /** For slide: pixels travelled. Default 60. For blur: max blur radius. Default 12. */
  distance?: number;
}

export type Mask =
  | { type: 'wipe'; direction: Direction; progress: Animatable<number> }
  | { type: 'rect'; x: Animatable<number>; y: Animatable<number>; width: Animatable<number>; height: Animatable<number> };

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'add';

// --- Backgrounds -----------------------------------------------------------------------------------

export interface GradientStop {
  offset: number;
  color: Color;
}

export type Background =
  | { type: 'transparent' }
  | { type: 'solid'; color: Color }
  | { type: 'gradient'; kind: 'linear' | 'radial'; stops: GradientStop[]; angle?: number }
  /** Procedural paper: deterministic from the spec seed. */
  | { type: 'paper'; color?: Color; grain?: number; fibers?: number }
  /** Dark cinematic base with optional vignette, animated film grain and a soft light. */
  | { type: 'cinematic'; color?: Color; vignette?: number; grain?: number; light?: Color }
  | { type: 'image'; asset: string; fit?: 'cover' | 'contain' };

// --- Components ------------------------------------------------------------------------------------

interface LayerBase {
  /** Stable within the segment. */
  id: string;
  /** Seconds from segment start. Default 0. */
  start?: number;
  /** Seconds from segment start. Default: segment duration. */
  end?: number;
  transform?: Transform;
  opacity?: Animatable<number>;
  enter?: Transition;
  exit?: Transition;
  mask?: Mask;
  blendMode?: BlendMode;
}

export type TextAlign = 'left' | 'center' | 'right';

export interface TextReveal {
  by: 'char' | 'word' | 'line';
  style: 'fade' | 'rise' | 'scale' | 'mask' | 'typewriter';
  /** Seconds between units. */
  stagger: number;
  /** Seconds each unit takes. */
  duration: number;
  easing?: Easing;
}

export interface TextProps {
  text: string;
  typography: Typography;
  color: Animatable<Color>;
  align?: TextAlign;
  /** Where the origin sits vertically relative to the text block. Default 'middle'. */
  verticalAlign?: 'top' | 'middle' | 'bottom';
  /** Wrap width in pixels. */
  maxWidth?: number;
  stroke?: Stroke;
  shadow?: Shadow;
  glow?: Glow;
  reveal?: TextReveal;
}

export interface ShapeProps {
  shape: 'rect' | 'ellipse' | 'line';
  width: Animatable<number>;
  height: Animatable<number>;
  radius?: number;
  fill?: Animatable<Color>;
  stroke?: Stroke;
  /** 'center' (default) or 'top-left' relative to the origin. */
  anchor?: 'center' | 'top-left';
  /** Draws the outline on from 0 to 1. */
  drawOn?: Animatable<number>;
  shadow?: Shadow;
}

export interface PathProps {
  /** SVG path data (M, L, H, V, C, S, Q, T, A, Z commands only). */
  d: string;
  fill?: Animatable<Color>;
  stroke?: Stroke;
  /** Fraction of the stroke drawn, 0–1. Default 1. */
  trim?: Animatable<number>;
  lineCap?: 'butt' | 'round' | 'square';
}

export interface CounterProps {
  from: number;
  to: number;
  /** Seconds after layer start the count begins. Default 0. */
  delay?: number;
  /** Seconds the count takes. Default: until the layer ends. */
  duration?: number;
  easing?: Easing;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  thousandsSeparator?: ',' | '.' | ' ' | '';
  typography: Typography;
  color: Animatable<Color>;
  align?: TextAlign;
  shadow?: Shadow;
  glow?: Glow;
}

export interface ChartLabelStyle {
  typography: Typography;
  color: Color;
}

export interface BarChartProps {
  data: { label?: string; value: number; color?: Color }[];
  width: number;
  height: number;
  /** Axis maximum. Default: largest value. */
  max?: number;
  orientation?: 'vertical' | 'horizontal';
  barColor: Color;
  /** Fraction of each slot left empty, 0–0.9. Default 0.3. */
  gap?: number;
  radius?: number;
  grow?: { duration: number; stagger?: number; easing?: Easing; delay?: number };
  labels?: ChartLabelStyle;
  values?: ChartLabelStyle & { decimals?: number; suffix?: string; prefix?: string };
  axisColor?: Color;
}

export interface LineChartProps {
  series: { points: number[]; color: Color; width?: number }[];
  width: number;
  height: number;
  min?: number;
  max?: number;
  draw?: { duration: number; easing?: Easing; delay?: number };
  dots?: { radius: number };
  axisColor?: Color;
  gridLines?: number;
  gridColor?: Color;
  labels?: ChartLabelStyle & { text: string[] };
}

export interface ProgressProps {
  style: 'bar' | 'ring';
  /** 0–1. */
  value: Animatable<number>;
  width?: number;
  height?: number;
  radius?: number;
  thickness?: number;
  trackColor: Color;
  fillColor: Color;
  rounded?: boolean;
  label?: ChartLabelStyle;
}

export interface HighlightProps {
  style: 'box' | 'underline' | 'marker' | 'circle';
  width: number;
  height: number;
  color: Color;
  strokeWidth?: number;
  radius?: number;
  /** 0–1 draw-on. Default 1. */
  progress?: Animatable<number>;
}

export interface DiagramProps {
  nodes: { id: string; label: string; x: number; y: number; width: number; height: number; fill?: Color }[];
  edges: { from: string; to: string }[];
  nodeStyle: { fill: Color; stroke?: Stroke; radius?: number; typography: Typography; textColor: Color };
  edgeStyle: { color: Color; width: number; arrow?: boolean };
  /** Nodes then edges appear in order. */
  reveal?: { stagger: number; duration: number; easing?: Easing };
}

export interface ImageProps {
  asset: string;
  width: number;
  height: number;
  fit?: 'cover' | 'contain' | 'fill';
}

export interface CaptionWord {
  text: string;
  /** Seconds from segment start. */
  start: number;
  end: number;
}

export interface CaptionCue {
  /** Seconds from segment start. Visible while start <= t < end. */
  start: number;
  end: number;
  text: string;
  /** Optional word timing for karaoke-style highlighting. */
  words?: CaptionWord[];
}

export interface CaptionStyle {
  typography: Typography;
  color: Color;
  /** Color of the active word when `animation.highlightWords` is on. */
  highlightColor?: Color;
  /** Anchor point in normalized frame coordinates (0–1). Default x 0.5, y 0.85. */
  position?: { x: number; y: number };
  align?: TextAlign;
  /** Wrap width as a fraction of the frame width. Default 0.8. */
  maxWidth?: number;
  maxLines?: number;
  stroke?: Stroke;
  shadow?: Shadow;
  glow?: Glow;
  box?: { color: Color; padding: number; radius?: number };
}

export interface CaptionAnimation {
  in?: 'none' | 'fade' | 'pop' | 'slide-up' | 'typewriter';
  out?: 'none' | 'fade' | 'slide-down';
  /** Seconds. Default 0.15. Clamped to half the cue length. */
  inDuration?: number;
  outDuration?: number;
  highlightWords?: boolean;
}

export interface CaptionsProps {
  cues: CaptionCue[];
  style: CaptionStyle;
  animation?: CaptionAnimation;
}

export type TextLayer = LayerBase & { type: 'text'; props: TextProps };
export type ShapeLayer = LayerBase & { type: 'shape'; props: ShapeProps };
export type PathLayer = LayerBase & { type: 'path'; props: PathProps };
export type CounterLayer = LayerBase & { type: 'counter'; props: CounterProps };
export type BarChartLayer = LayerBase & { type: 'barChart'; props: BarChartProps };
export type LineChartLayer = LayerBase & { type: 'lineChart'; props: LineChartProps };
export type ProgressLayer = LayerBase & { type: 'progress'; props: ProgressProps };
export type HighlightLayer = LayerBase & { type: 'highlight'; props: HighlightProps };
export type DiagramLayer = LayerBase & { type: 'diagram'; props: DiagramProps };
export type ImageLayer = LayerBase & { type: 'image'; props: ImageProps };
export type CaptionsLayer = LayerBase & { type: 'captions'; props: CaptionsProps };
export type GroupLayer = LayerBase & { type: 'group'; props: { layers: Layer[] } };

export type Layer =
  | TextLayer
  | ShapeLayer
  | PathLayer
  | CounterLayer
  | BarChartLayer
  | LineChartLayer
  | ProgressLayer
  | HighlightLayer
  | DiagramLayer
  | ImageLayer
  | CaptionsLayer
  | GroupLayer;

export type LayerType = Layer['type'];

// --- Assets & spec ---------------------------------------------------------------------------------

export interface FontAsset {
  family: string;
  /** Absolute path to .ttf/.otf/.woff/.woff2. Read by the main process; the sandbox only sees bytes. */
  path: string;
  weight?: number;
  style?: 'normal' | 'italic';
}

export interface ImageAsset {
  id: string;
  /** Absolute path to .png/.jpg/.jpeg/.webp. */
  path: string;
}

export interface AnimationSpec {
  specVersion: typeof ANIMATION_SPEC_VERSION;
  /** Stable segment ID (matches the project's segment). */
  id: string;
  /** Seconds on the project timeline. Moving a segment never forces a re-render. */
  start: number;
  /** Seconds. */
  duration: number;
  /** Optional; must equal start + duration when given. */
  end?: number;
  width: number;
  height: number;
  /** 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, or any integer 1–120. */
  fps: number;
  exportMode: ExportMode;
  background: Background;
  /** Applied to every layer, around the frame center. */
  camera?: Transform;
  /** Seed for procedural textures and grain. Default 1. */
  seed?: number;
  assets?: { fonts?: FontAsset[]; images?: ImageAsset[] };
  layers: Layer[];
}

/** An ordered set of segments placed on one timeline (one project). */
export interface SequenceSpec {
  id: string;
  width: number;
  height: number;
  fps: number;
  /** Seconds. */
  duration: number;
  segments: AnimationSpec[];
}
