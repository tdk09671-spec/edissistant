import type { Checker, Obj } from '../checker';
import type { Layer, LayerType } from '../types';
import type { Ctx2D, LayerTime, RenderEnv } from './context';

export interface ValidationContext {
  imageIds: ReadonlySet<string>;
  segmentDuration: number;
  /** Nesting depth of the layer being validated (0 = top level). */
  depth: number;
  /** Validates a nested layer list (used by groups). */
  validateLayers(value: unknown, path: string, depth: number, duration: number): void;
}

export interface DrawHelpers {
  /** Draws child layers with times relative to the current layer (used by groups). */
  drawLayers(layers: readonly Layer[], t: number, duration: number, segmentTime: number): void;
}

/**
 * A trusted, reviewed drawing component. New visual concepts are added by registering a new
 * definition (an "approved extension"), never by executing code from a spec.
 */
export interface ComponentDefinition<P = unknown> {
  type: LayerType;
  validate(props: Obj, c: Checker, path: string, context: ValidationContext): void;
  /** Draws in layer-local spec pixels; the origin is the layer's transform position. */
  draw(ctx: Ctx2D, props: P, time: LayerTime, env: RenderEnv, helpers: DrawHelpers): void;
}

export function defineComponent<P>(definition: ComponentDefinition<P>): ComponentDefinition<P> {
  return definition;
}
