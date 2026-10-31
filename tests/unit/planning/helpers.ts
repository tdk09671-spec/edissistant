import * as fs from 'fs';
import * as path from 'path';
import { buildStyleProfile, type PlanningSegmentInput, type PresetLike, type StyleProfile } from '../../../src/shared/planning';

export const fixtures = path.resolve(__dirname, '../../fixtures/planning');
export const NOW = '2026-10-29T12:00:00.000Z';
export const now = () => NOW;

export function preset(name: 'northwind' | 'lumen'): PresetLike {
  return JSON.parse(fs.readFileSync(path.join(fixtures, 'presets.json'), 'utf8'))[name];
}

export function profile(name: 'northwind' | 'lumen' = 'northwind'): StyleProfile {
  return buildStyleProfile({ preset: preset(name) }, NOW);
}

export function transcript(name: 'video-a' | 'video-b' | 'injection'): PlanningSegmentInput[] {
  return JSON.parse(fs.readFileSync(path.join(fixtures, `${name}.json`), 'utf8'));
}
