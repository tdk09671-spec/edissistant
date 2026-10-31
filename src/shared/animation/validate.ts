import { Checker, GENERIC_FONTS, join, type Obj, type SpecIssue } from './checker';
import type { ValidationContext } from './engine/component';
import { componentFor, LAYER_TYPES } from './engine/registry';
import { fpsRational, isSupportedFps } from './timeline';
import { ANIMATION_SPEC_VERSION, type AnimationSpec, type ExportMode, type SequenceSpec, type Typography } from './types';

export const LIMITS = {
  maxDuration: 600,
  minDimension: 16,
  maxDimension: 7680,
  /** 4096 × 2304: covers UHD (3840×2160) and DCI 4K (4096×2160). */
  maxPixels: 4096 * 2304,
  maxLayers: 200,
  maxSegments: 500,
  maxFonts: 32,
  maxImages: 64,
} as const;

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** Absolute Windows (C:\, \\server\) or POSIX path. */
const ABSOLUTE_PATH = /^([A-Za-z]:[\\/]|\\\\[^\\]|\/)/;
export const FONT_EXTENSIONS = ['.ttf', '.otf', '.woff', '.woff2'];
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

export type ValidationResult =
  | {
      ok: true;
      spec: AnimationSpec;
      warnings: SpecIssue[];
      /** Every typography used, for font preloading and availability checks. */
      typographies: Typography[];
      /** Font families that are neither generic nor bundled as assets, i.e. must be installed on the system. */
      systemFonts: string[];
    }
  | { ok: false; issues: SpecIssue[]; warnings: SpecIssue[] };

const SPEC_KEYS = ['specVersion', 'id', 'start', 'duration', 'end', 'width', 'height', 'fps', 'exportMode', 'background', 'camera', 'seed', 'assets', 'layers'];
const LAYER_KEYS = ['id', 'type', 'start', 'end', 'transform', 'opacity', 'enter', 'exit', 'mask', 'blendMode', 'props'];
const MODES: readonly ExportMode[] = ['full-motion', 'transparent-motion', 'transparent-captions'];

function extensionOf(p: string): string {
  const m = /\.[A-Za-z0-9]+$/.exec(p);
  return m ? m[0].toLowerCase() : '';
}

function checkTransform(c: Checker, o: Obj, key: string, path: string): void {
  if (o[key] === undefined) return;
  const p = join(path, key);
  const t = c.object(o[key], p);
  if (!t) return;
  c.keys(t, p, ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation']);
  for (const k of ['x', 'y']) c.animNumber(t, k, p, { min: -100000, max: 100000 });
  for (const k of ['scale', 'scaleX', 'scaleY']) c.animNumber(t, k, p, { min: -100, max: 100 });
  c.animNumber(t, 'rotation', p, { min: -36000, max: 36000 });
}

function checkTransition(c: Checker, o: Obj, key: string, path: string, layerDuration: number | undefined): void {
  if (o[key] === undefined) return;
  const p = join(path, key);
  const t = c.object(o[key], p);
  if (!t) return;
  c.keys(t, p, ['type', 'duration', 'easing', 'direction', 'distance']);
  c.oneOf(t, 'type', p, ['fade', 'slide', 'scale', 'wipe', 'blur'] as const, true);
  const d = c.number(t, 'duration', p, { required: true, min: 0, max: 600 });
  if (d !== undefined && layerDuration !== undefined && d > layerDuration + 1e-9) c.fail(join(p, 'duration'), 'is longer than the layer');
  if (t.easing !== undefined) c.easing(t.easing, join(p, 'easing'));
  c.oneOf(t, 'direction', p, ['left', 'right', 'up', 'down'] as const);
  c.number(t, 'distance', p, { min: 0, max: 10000 });
}

function checkMask(c: Checker, o: Obj, path: string): void {
  if (o.mask === undefined) return;
  const p = join(path, 'mask');
  const m = c.object(o.mask, p);
  if (!m) return;
  const type = c.oneOf(m, 'type', p, ['wipe', 'rect'] as const, true);
  if (type === 'wipe') {
    c.keys(m, p, ['type', 'direction', 'progress']);
    c.oneOf(m, 'direction', p, ['left', 'right', 'up', 'down'] as const, true);
    c.animNumber(m, 'progress', p, { required: true, min: 0, max: 1 });
  } else if (type === 'rect') {
    c.keys(m, p, ['type', 'x', 'y', 'width', 'height']);
    for (const k of ['x', 'y', 'width', 'height']) c.animNumber(m, k, p, { required: true, min: -100000, max: 100000 });
  }
}

function checkBackground(c: Checker, value: unknown, imageIds: ReadonlySet<string>): string | undefined {
  const p = 'background';
  const bg = value === undefined ? (c.fail(p, 'is required'), null) : c.object(value, p);
  if (!bg) return undefined;
  const type = c.oneOf(bg, 'type', p, ['transparent', 'solid', 'gradient', 'paper', 'cinematic', 'image'] as const, true);
  switch (type) {
    case 'transparent':
      c.keys(bg, p, ['type']);
      break;
    case 'solid':
      c.keys(bg, p, ['type', 'color']);
      c.color(bg, 'color', p, true);
      break;
    case 'gradient': {
      c.keys(bg, p, ['type', 'kind', 'stops', 'angle']);
      c.oneOf(bg, 'kind', p, ['linear', 'radial'] as const, true);
      c.number(bg, 'angle', p, { min: -3600, max: 3600 });
      const stops = c.array(bg, 'stops', p, { required: true, min: 2, max: 32 });
      stops?.forEach((s, i) => {
        const sp = join(join(p, 'stops'), i);
        const o = c.object(s, sp);
        if (!o) return;
        c.keys(o, sp, ['offset', 'color']);
        c.number(o, 'offset', sp, { required: true, min: 0, max: 1 });
        c.color(o, 'color', sp, true);
      });
      break;
    }
    case 'paper':
      c.keys(bg, p, ['type', 'color', 'grain', 'fibers']);
      c.color(bg, 'color', p);
      c.number(bg, 'grain', p, { min: 0, max: 1 });
      c.number(bg, 'fibers', p, { min: 0, max: 1 });
      break;
    case 'cinematic':
      c.keys(bg, p, ['type', 'color', 'vignette', 'grain', 'light']);
      c.color(bg, 'color', p);
      c.number(bg, 'vignette', p, { min: 0, max: 1 });
      c.number(bg, 'grain', p, { min: 0, max: 1 });
      c.color(bg, 'light', p);
      break;
    case 'image': {
      c.keys(bg, p, ['type', 'asset', 'fit']);
      const asset = c.string(bg, 'asset', p, { required: true, maxLength: 128 });
      if (asset && !imageIds.has(asset)) c.fail(join(p, 'asset'), `unknown image asset "${asset}"`);
      c.oneOf(bg, 'fit', p, ['cover', 'contain'] as const);
      break;
    }
  }
  return type;
}

function checkAssets(c: Checker, value: unknown): { imageIds: Set<string>; fontFamilies: Set<string> } {
  const imageIds = new Set<string>();
  const fontFamilies = new Set<string>();
  if (value === undefined) return { imageIds, fontFamilies };
  const a = c.object(value, 'assets');
  if (!a) return { imageIds, fontFamilies };
  c.keys(a, 'assets', ['fonts', 'images']);
  c.array(a, 'fonts', 'assets', { max: LIMITS.maxFonts })?.forEach((f, i) => {
    const p = join('assets.fonts', i);
    const o = c.object(f, p);
    if (!o) return;
    c.keys(o, p, ['family', 'path', 'weight', 'style']);
    const family = c.string(o, 'family', p, { required: true, maxLength: 64 });
    const file = c.string(o, 'path', p, { required: true, maxLength: 1024, pattern: ABSOLUTE_PATH, patternMessage: 'must be an absolute path' });
    if (file && !FONT_EXTENSIONS.includes(extensionOf(file))) c.fail(join(p, 'path'), `must be a ${FONT_EXTENSIONS.join('/')} file`);
    c.number(o, 'weight', p, { integer: true, min: 1, max: 1000 });
    c.oneOf(o, 'style', p, ['normal', 'italic'] as const);
    if (family) fontFamilies.add(family);
  });
  c.array(a, 'images', 'assets', { max: LIMITS.maxImages })?.forEach((img, i) => {
    const p = join('assets.images', i);
    const o = c.object(img, p);
    if (!o) return;
    c.keys(o, p, ['id', 'path']);
    const id = c.string(o, 'id', p, { required: true, maxLength: 128, pattern: ID_PATTERN });
    const file = c.string(o, 'path', p, { required: true, maxLength: 1024, pattern: ABSOLUTE_PATH, patternMessage: 'must be an absolute path' });
    if (file && !IMAGE_EXTENSIONS.includes(extensionOf(file))) c.fail(join(p, 'path'), `must be a ${IMAGE_EXTENSIONS.join('/')} file`);
    if (id && imageIds.has(id)) c.fail(join(p, 'id'), `duplicate image id "${id}"`);
    if (id) imageIds.add(id);
  });
  return { imageIds, fontFamilies };
}

/** Validates an untrusted spec. Nothing renders unless this returns ok. */
export function validateAnimationSpec(input: unknown): ValidationResult {
  const c = new Checker();
  const spec = c.object(input, '');
  if (!spec) return { ok: false, issues: c.issues, warnings: c.warnings };
  c.keys(spec, '', SPEC_KEYS);
  if (spec.specVersion !== ANIMATION_SPEC_VERSION) c.fail('specVersion', `must be ${ANIMATION_SPEC_VERSION}`);
  c.string(spec, 'id', '', { required: true, maxLength: 128, pattern: ID_PATTERN, patternMessage: 'may only contain letters, digits and _ . : -' });
  const start = c.number(spec, 'start', '', { required: true, min: 0, max: 86400 });
  const duration = c.number(spec, 'duration', '', { required: true, min: 0, max: LIMITS.maxDuration });
  if (duration === 0) c.fail('duration', 'must be greater than 0');
  const end = c.number(spec, 'end', '', { min: 0 });
  const width = c.number(spec, 'width', '', { required: true, integer: true, min: LIMITS.minDimension, max: LIMITS.maxDimension });
  const height = c.number(spec, 'height', '', { required: true, integer: true, min: LIMITS.minDimension, max: LIMITS.maxDimension });
  // 4:2:0/4:2:2 codecs need even dimensions.
  if (width !== undefined && width % 2 !== 0) c.fail('width', 'must be even');
  if (height !== undefined && height % 2 !== 0) c.fail('height', 'must be even');
  if (width && height && width * height > LIMITS.maxPixels) c.fail('width', `resolution is above the ${LIMITS.maxPixels.toLocaleString('en-US')} pixel limit`);
  const fps = c.number(spec, 'fps', '', { required: true });
  if (fps !== undefined && !isSupportedFps(fps)) c.fail('fps', 'must be an integer 1–120 or an NTSC rate (23.976, 29.97, 59.94)');
  if (fps !== undefined && duration !== undefined && isSupportedFps(fps) && duration > 0) {
    const r = fpsRational(fps);
    if ((duration * r.num) / r.den < 1 - 1e-9) c.fail('duration', 'is shorter than one frame');
  }
  if (end !== undefined && start !== undefined && duration !== undefined && Math.abs(end - (start + duration)) > 1e-6) {
    c.fail('end', 'must equal start + duration');
  }
  const mode = c.oneOf(spec, 'exportMode', '', MODES, true);
  c.number(spec, 'seed', '', { integer: true, min: 0, max: 2 ** 31 - 1 });
  checkTransform(c, spec, 'camera', '');

  const { imageIds, fontFamilies } = checkAssets(c, spec.assets);
  const bgType = checkBackground(c, spec.background, imageIds);
  if (mode && bgType) {
    if (mode !== 'full-motion' && bgType !== 'transparent') {
      c.fail('background', 'transparent exports must use {"type": "transparent"}; a solid or black background is not transparency');
    }
    if (mode === 'full-motion' && bgType === 'transparent') {
      c.fail('background', 'full-motion exports need a background; use a transparent export mode for alpha');
    }
  }

  const ids = new Set<string>();
  let captionLayers = 0;
  const segmentDuration = duration ?? 0;
  const context: ValidationContext = {
    imageIds,
    segmentDuration,
    depth: 0,
    validateLayers: (value, path, depth, parentDuration) => validateLayers(value, path, depth, parentDuration),
  };

  const validateLayers = (value: unknown, path: string, depth: number, parentDuration: number) => {
    if (!Array.isArray(value)) {
      c.fail(path, 'must be an array');
      return;
    }
    if (value.length > LIMITS.maxLayers) c.fail(path, `must have at most ${LIMITS.maxLayers} layers`);
    value.forEach((item, i) => {
      const lp = join(path, i);
      const layer = c.object(item, lp);
      if (!layer) return;
      c.keys(layer, lp, LAYER_KEYS);
      const id = c.string(layer, 'id', lp, { required: true, maxLength: 128, pattern: ID_PATTERN });
      if (id && ids.has(id)) c.fail(join(lp, 'id'), `duplicate layer id "${id}"`);
      if (id) ids.add(id);
      const type = c.oneOf(layer, 'type', lp, LAYER_TYPES, true);
      const ls = c.number(layer, 'start', lp, { min: 0, max: parentDuration }) ?? 0;
      const le = c.number(layer, 'end', lp, { min: 0, max: parentDuration + 1e-6 }) ?? parentDuration;
      if (le <= ls) c.fail(join(lp, 'end'), 'must be after start');
      checkTransform(c, layer, 'transform', lp);
      c.animNumber(layer, 'opacity', lp, { min: 0, max: 1 });
      checkTransition(c, layer, 'enter', lp, le - ls);
      checkTransition(c, layer, 'exit', lp, le - ls);
      checkMask(c, layer, lp);
      c.oneOf(layer, 'blendMode', lp, ['normal', 'multiply', 'screen', 'overlay', 'add'] as const);
      if (type === 'captions') captionLayers++;
      const component = type ? componentFor(type) : undefined;
      const pp = join(lp, 'props');
      const props = layer.props === undefined ? (c.fail(pp, 'is required'), null) : c.object(layer.props, pp);
      if (component && props) component.validate(props, c, pp, { ...context, depth });
    });
  };

  if (spec.layers === undefined) c.fail('layers', 'is required');
  else validateLayers(spec.layers, 'layers', 0, segmentDuration);
  if (mode === 'transparent-captions' && captionLayers === 0) c.fail('layers', 'transparent-captions needs at least one captions layer');

  if (c.issues.length > 0) return { ok: false, issues: c.issues, warnings: c.warnings };

  const systemFonts = [...new Set(c.typographies.map((t) => t.fontFamily))].filter(
    (f) => !(GENERIC_FONTS as readonly string[]).includes(f) && !fontFamilies.has(f)
  );
  return { ok: true, spec: spec as unknown as AnimationSpec, warnings: c.warnings, typographies: c.typographies, systemFonts };
}

export type SequenceValidationResult = { ok: true; sequence: SequenceSpec } | { ok: false; issues: SpecIssue[] };

/** Validates a sequence: its own fields plus every segment, which must match its size and frame rate. */
export function validateSequence(input: unknown): SequenceValidationResult {
  const c = new Checker();
  const seq = c.object(input, '');
  if (!seq) return { ok: false, issues: c.issues };
  c.keys(seq, '', ['id', 'width', 'height', 'fps', 'duration', 'segments']);
  c.string(seq, 'id', '', { required: true, maxLength: 128, pattern: ID_PATTERN });
  const width = c.number(seq, 'width', '', { required: true, integer: true, min: LIMITS.minDimension, max: LIMITS.maxDimension });
  const height = c.number(seq, 'height', '', { required: true, integer: true, min: LIMITS.minDimension, max: LIMITS.maxDimension });
  if (width !== undefined && width % 2 !== 0) c.fail('width', 'must be even');
  if (height !== undefined && height % 2 !== 0) c.fail('height', 'must be even');
  const fps = c.number(seq, 'fps', '', { required: true });
  if (fps !== undefined && !isSupportedFps(fps)) c.fail('fps', 'is not a supported frame rate');
  const duration = c.number(seq, 'duration', '', { required: true, min: 0, max: 86400 });
  const segments = c.array(seq, 'segments', '', { required: true, max: LIMITS.maxSegments });
  const ids = new Set<string>();
  segments?.forEach((s, i) => {
    const p = join('segments', i);
    const result = validateAnimationSpec(s);
    if (!result.ok) {
      for (const issue of result.issues) c.fail(issue.path === '(root)' ? p : `${p}.${issue.path}`, issue.message);
      return;
    }
    const spec = result.spec;
    if (ids.has(spec.id)) c.fail(join(p, 'id'), `duplicate segment id "${spec.id}"`);
    ids.add(spec.id);
    if (spec.width !== width || spec.height !== height) c.fail(p, 'segment resolution must match the sequence');
    if (fps !== undefined && fpsRational(spec.fps).num * fpsRational(fps).den !== fpsRational(fps).num * fpsRational(spec.fps).den) {
      c.fail(join(p, 'fps'), 'segment frame rate must match the sequence');
    }
    if (duration !== undefined && spec.start + spec.duration > duration + 1e-6) c.fail(p, 'segment ends after the sequence');
  });
  return c.issues.length ? { ok: false, issues: c.issues } : { ok: true, sequence: seq as unknown as SequenceSpec };
}
