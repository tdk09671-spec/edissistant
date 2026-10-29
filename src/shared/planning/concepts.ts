// Library of reusable visual storytelling concepts. A concept is a creative idea ("count the number
// up", "draw the steps as a flow"), not a look: every concept is styled by the client's profile.
// `components` names the PR #2 component types it is built from; null means PR #2 can't render it.

import type { ContentKind, VisualConcept } from './types';

const c = (concept: VisualConcept): VisualConcept => concept;

export const CONCEPTS: readonly VisualConcept[] = [
  // Typography
  c({ id: 'kinetic-headline', label: 'Kinetic headline', family: 'typography', visualMode: 'motion-graphics', energy: 'moderate', density: 'minimal',
    suits: { claim: 0.8, statement: 0.5, emotion: 0.6, 'call-to-action': 0.5, transition: 0.35, statistic: 0.55, percentage: 0.55, money: 0.5 }, components: ['text'], effects: ['word-reveal'],
    description: 'Key phrase builds word by word, full frame.' }),
  c({ id: 'type-on-quote', label: 'Typed quote', family: 'typography', visualMode: 'motion-graphics', energy: 'calm', density: 'minimal',
    suits: { quote: 0.95, definition: 0.5, emotion: 0.4 }, components: ['text'], effects: ['typewriter'],
    description: 'The words type on like a pulled quote.' }),
  c({ id: 'mask-reveal-title', label: 'Masked title reveal', family: 'typography', visualMode: 'motion-graphics', energy: 'moderate', density: 'minimal',
    suits: { claim: 0.65, time: 0.45, transition: 0.55, statement: 0.4, statistic: 0.5, money: 0.5 }, components: ['text'], effects: ['mask'],
    description: 'A title rises out of a hidden slot, line by line.' }),
  c({ id: 'question-card', label: 'Question card', family: 'typography', visualMode: 'motion-graphics', energy: 'moderate', density: 'minimal',
    suits: { question: 0.95 }, components: ['text', 'highlight'], effects: [],
    description: 'The question pops in with an underline, holding for the answer.' }),
  // Data
  c({ id: 'counter-hero', label: 'Hero number count-up', family: 'data', visualMode: 'motion-graphics', energy: 'energetic', density: 'minimal',
    suits: { statistic: 0.9, money: 0.95, percentage: 0.7 }, components: ['counter', 'text'], effects: ['counter'],
    description: 'The number counts up large with a short label.' }),
  c({ id: 'bar-comparison', label: 'Bar comparison', family: 'data', visualMode: 'motion-graphics', energy: 'moderate', density: 'balanced',
    suits: { comparison: 0.85, statistic: 0.45, percentage: 0.45, money: 0.4 }, components: ['barChart'], effects: ['chart'],
    description: 'Bars grow to compare values.' }),
  c({ id: 'line-trend', label: 'Trend line', family: 'data', visualMode: 'motion-graphics', energy: 'moderate', density: 'balanced',
    suits: { trend: 0.95, time: 0.35 }, components: ['lineChart', 'text'], effects: ['chart'],
    description: 'A line draws on to show change over time.' }),
  c({ id: 'progress-ring', label: 'Progress ring', family: 'data', visualMode: 'motion-graphics', energy: 'moderate', density: 'minimal',
    suits: { percentage: 0.95 }, components: ['progress', 'text'], effects: ['chart'],
    description: 'A ring fills to the percentage.' }),
  c({ id: 'stat-split', label: 'Side-by-side stats', family: 'data', visualMode: 'motion-graphics', energy: 'moderate', density: 'balanced',
    suits: { comparison: 0.8, money: 0.5, statistic: 0.5 }, components: ['counter', 'shape'], effects: ['counter'],
    description: 'Two figures count up side by side, split by a rule.' }),
  // Diagrams
  c({ id: 'process-steps', label: 'Process flow', family: 'diagram', visualMode: 'motion-graphics', energy: 'calm', density: 'balanced',
    suits: { process: 0.95, list: 0.5 }, components: ['diagram'], effects: ['diagram'],
    description: 'Steps appear as connected boxes with arrows.' }),
  c({ id: 'timeline-track', label: 'Timeline track', family: 'diagram', visualMode: 'motion-graphics', energy: 'calm', density: 'balanced',
    suits: { time: 0.85, process: 0.6, trend: 0.4 }, components: ['shape', 'text'], effects: ['draw-on'],
    description: 'A rule draws across and milestones appear along it.' }),
  c({ id: 'list-stack', label: 'Stacked list', family: 'diagram', visualMode: 'motion-graphics', energy: 'moderate', density: 'balanced',
    suits: { list: 0.9, process: 0.55 }, components: ['text'], effects: ['slide'],
    description: 'Items slide in one under another.' }),
  c({ id: 'split-versus', label: 'Versus split', family: 'diagram', visualMode: 'motion-graphics', energy: 'moderate', density: 'balanced',
    suits: { comparison: 0.75 }, components: ['text', 'shape'], effects: ['wipe'],
    description: 'The two sides of the comparison face each other across a divider.' }),
  // Emphasis
  c({ id: 'underline-callout', label: 'Underline callout', family: 'emphasis', visualMode: 'motion-graphics', energy: 'calm', density: 'minimal',
    suits: { claim: 0.6, definition: 0.75, emotion: 0.35, statement: 0.45, percentage: 0.5, comparison: 0.5 }, components: ['text', 'highlight'], effects: ['draw-on'],
    description: 'The key phrase with a hand-drawn underline.' }),
  c({ id: 'icon-draw', label: 'Icon draw-on', family: 'emphasis', visualMode: 'motion-graphics', energy: 'calm', density: 'minimal',
    suits: { 'call-to-action': 0.75, claim: 0.35 }, components: ['path', 'text'], effects: ['draw-on'],
    description: 'A simple check or arrow draws on beside the phrase.' }),
  c({ id: 'lower-third', label: 'Name lower third', family: 'identity', visualMode: 'motion-graphics', energy: 'calm', density: 'minimal',
    suits: { person: 0.9 }, components: ['shape', 'text'], effects: ['wipe'],
    description: 'Speaker name on a bar over the footage.' }),
  c({ id: 'logo-sting', label: 'Logo sting', family: 'identity', visualMode: 'motion-graphics', energy: 'moderate', density: 'minimal',
    suits: { 'call-to-action': 0.55 }, components: ['image', 'text'], effects: ['scale'],
    description: 'The client logo resolves with the call to action.' }),
  // Captions & texture
  c({ id: 'caption-emphasis', label: 'Emphasis captions', family: 'caption', visualMode: 'captions', energy: 'moderate', density: 'minimal',
    suits: { emotion: 0.5, quote: 0.45, statement: 0.4, claim: 0.35, transition: 0.3, question: 0.3 }, components: ['captions'], effects: ['word-highlight'],
    description: 'Styled captions with the spoken word highlighted.' }),
  c({ id: 'ambient-texture', label: 'Ambient background plate', family: 'texture', visualMode: 'background-graphics', energy: 'calm', density: 'minimal',
    suits: { transition: 0.6, statement: 0.3, time: 0.3 }, components: ['text'], effects: ['texture'],
    description: 'A brand texture plate with a quiet title, for bridges between ideas.' }),
  // Not graphics
  c({ id: 'speaker-only', label: 'Stay on speaker', family: 'speaker', visualMode: 'speaker', energy: 'calm', density: 'minimal',
    suits: { emotion: 0.6, statement: 0.4, person: 0.45, quote: 0.3 }, components: [], effects: [],
    description: 'No graphic: let the speaker carry the moment.' }),
  c({ id: 'b-roll-suggestion', label: 'B-roll cutaway', family: 'footage', visualMode: 'b-roll', energy: 'moderate', density: 'minimal',
    suits: { place: 0.7, person: 0.3, statement: 0.3, time: 0.25 }, components: null, unsupportedReason: 'Needs footage chosen by the editor; not a rendered graphic.', effects: [],
    description: 'Cut to supporting footage of what is being described.' }),
  c({ id: 'map-route', label: 'Map callout', family: 'diagram', visualMode: 'motion-graphics', energy: 'moderate', density: 'balanced',
    suits: { place: 0.85 }, components: null, unsupportedReason: 'PR #2 has no map component; would need a map image asset or a new component.', effects: [],
    description: 'Locate the place on a map.' }),
];

const BY_ID = new Map(CONCEPTS.map((x) => [x.id, x]));

export function conceptById(id: string): VisualConcept | undefined {
  return BY_ID.get(id);
}

export const CONCEPT_IDS = CONCEPTS.map((x) => x.id);

/** Default concept per visual mode, used when the editor locks a mode and nothing else fits. */
export const MODE_DEFAULT: Record<VisualConcept['visualMode'], string> = {
  speaker: 'speaker-only',
  'b-roll': 'b-roll-suggestion',
  captions: 'caption-emphasis',
  'background-graphics': 'ambient-texture',
  'motion-graphics': 'kinetic-headline',
};

/** 0–1 fit of a concept to analysed content (strength-weighted best match). */
export function conceptFit(concept: VisualConcept, kinds: { kind: ContentKind; strength: number }[]): number {
  let best = 0;
  let sum = 0;
  for (const { kind, strength } of kinds) {
    const s = (concept.suits[kind] ?? 0) * strength;
    best = Math.max(best, s);
    sum += s;
  }
  // Mostly the best match, with a little credit for fitting several aspects.
  return Math.min(1, best + 0.15 * (sum - best));
}
