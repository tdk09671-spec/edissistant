import type { LayerType } from '../types';
import type { ComponentDefinition } from './component';
import { barChartComponent, diagramComponent, lineChartComponent } from './components/charts';
import { captionsComponent, groupComponent, imageComponent } from './components/media';
import { highlightComponent, pathComponent, progressComponent, shapeComponent } from './components/shapes';
import { counterComponent, textComponent } from './components/text';

/**
 * Trusted components by layer type. Adding a visual concept means adding a reviewed definition here
 * (and its props type in types.ts); specs can only reference registered types.
 */
export const COMPONENTS: Record<LayerType, ComponentDefinition<never>> = {
  text: textComponent,
  shape: shapeComponent,
  path: pathComponent,
  counter: counterComponent,
  barChart: barChartComponent,
  lineChart: lineChartComponent,
  progress: progressComponent,
  highlight: highlightComponent,
  diagram: diagramComponent,
  image: imageComponent,
  captions: captionsComponent,
  group: groupComponent,
} as Record<LayerType, ComponentDefinition<never>>;

export const LAYER_TYPES = Object.keys(COMPONENTS) as LayerType[];

export function componentFor(type: string): ComponentDefinition<unknown> | undefined {
  return (COMPONENTS as Record<string, ComponentDefinition<unknown>>)[type];
}
