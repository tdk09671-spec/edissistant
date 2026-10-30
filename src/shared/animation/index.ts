// Public, environment-neutral API of the animation engine (safe to import from any process).
export * from './types';
export * from './timeline';
export * from './easing';
export * from './color';
export * from './keyframes';
export * from './random';
export * from './captions';
export * from './formats';
export * from './sequence';
export { Checker, type SpecIssue } from './checker';
export { validateAnimationSpec, validateSequence, LIMITS, FONT_EXTENSIONS, IMAGE_EXTENSIONS, type ValidationResult } from './validate';
export type { Ctx2D, RenderEnv, CanvasLike, DrawableLike, PathLike, LayerTime } from './engine/context';
export type { ComponentDefinition } from './engine/component';
export { COMPONENTS, LAYER_TYPES, componentFor } from './engine/registry';
export { renderFrame, drawLayers, transitionState } from './engine/render';
export * from './api';
export * from './errors';
