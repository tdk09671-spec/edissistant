// Where concept candidates come from. The local provider is free and deterministic; the model
// provider (modelProvider.ts) asks Claude. Either way the variety engine makes the final choice and
// the editor approves it.

import { analyzeContent, type ContentAnalysis } from './content';
import { CONCEPTS, conceptFit } from './concepts';
import type { ConceptCandidate, StyleProfile, VarietyLevel, VisualMode } from './types';

export interface ConceptRequestSegment {
  segmentId: string;
  start: number;
  end: number;
  text: string;
  speaker?: string;
  instruction?: string;
  visualMode?: VisualMode;
  analysis: ContentAnalysis;
  /** Neighbouring sentences, for context only (shortened). */
  before?: string;
  after?: string;
  rejectedConcepts: string[];
}

export interface ConceptRequest {
  projectId: string;
  profile: StyleProfile;
  segments: ConceptRequestSegment[];
  /** Concepts already used in this project (ids only, for variety). */
  usedConcepts: string[];
  variety: VarietyLevel;
}

export interface ConceptResponse {
  /** Candidates per segment ID. Segments may be missing (the planner falls back to local). */
  candidates: Record<string, ConceptCandidate[]>;
  warnings: string[];
}

export interface PlanningProvider {
  readonly name: string;
  suggest(request: ConceptRequest, options?: { signal?: AbortSignal }): Promise<ConceptResponse>;
}

const REASON: Record<string, (a: ContentAnalysis) => string> = {
  'counter-hero': (a) => `"${a.numbers[0]?.raw ?? 'The figure'}" is the point — counting it up makes it land.`,
  'bar-comparison': () => 'Two or more values are compared; bars make the difference visible at a glance.',
  'line-trend': () => 'The sentence describes change over time, which reads best as a line drawing on.',
  'progress-ring': (a) => `A share (${a.numbers.find((n) => n.unit === 'percent')?.raw ?? 'a percentage'}) reads instantly as a filling ring.`,
  'stat-split': () => 'Two figures side by side let the viewer compare them directly.',
  'process-steps': () => 'The speaker walks through steps; a flow shows the order.',
  'timeline-track': () => 'Points in time are mentioned; a timeline places them.',
  'list-stack': () => 'Several items are listed; stacking them keeps each readable.',
  'split-versus': () => 'Two sides are contrasted; a split frame shows the tension.',
  'kinetic-headline': () => 'A strong statement benefits from the words building on screen.',
  'type-on-quote': () => 'Someone’s words are quoted; typing them on gives them weight.',
  'mask-reveal-title': () => 'A title-like line works as a clean chapter reveal.',
  'question-card': () => 'A direct question; holding it on screen invites the viewer to think.',
  'underline-callout': () => 'One phrase carries the meaning; underlining it focuses attention.',
  'icon-draw': () => 'An ask to the viewer; a simple drawn icon supports it without clutter.',
  'lower-third': () => 'A person is introduced; a lower third names them.',
  'logo-sting': () => 'A call to action is a natural place for the brand mark.',
  'caption-emphasis': () => 'A spoken beat without a natural graphic; styled captions keep it engaging.',
  'ambient-texture': () => 'A bridge between ideas; a quiet branded plate resets attention.',
  'speaker-only': () => 'Nothing to visualise here — the speaker’s delivery is the story.',
  'b-roll-suggestion': () => 'Something concrete is described; footage of it would help.',
  'map-route': () => 'A location is mentioned; a map would orient the viewer.',
};

/** Deterministic candidates from local content analysis. Free and works offline. */
export class LocalConceptProvider implements PlanningProvider {
  readonly name = 'local';

  async suggest(request: ConceptRequest): Promise<ConceptResponse> {
    const candidates: Record<string, ConceptCandidate[]> = {};
    for (const s of request.segments) candidates[s.segmentId] = localCandidates(s.analysis);
    return { candidates, warnings: [] };
  }
}

export function localCandidates(analysis: ContentAnalysis): ConceptCandidate[] {
  return CONCEPTS.map((concept) => ({
    conceptId: concept.id,
    fit: Math.round(conceptFit(concept, analysis.kinds) * 1000) / 1000,
    reasoning: REASON[concept.id]?.(analysis) ?? concept.description,
    meaning: analysis.meaning,
    source: 'local' as const,
  }))
    .filter((c) => c.fit > 0)
    .sort((a, b) => b.fit - a.fit || a.conceptId.localeCompare(b.conceptId));
}

export function requestSegment(
  s: { id: string; start: number; end: number; text: string; speaker?: string; instruction?: string; visualMode?: VisualMode },
  neighbours: { before?: string; after?: string },
  rejectedConcepts: string[]
): ConceptRequestSegment {
  const cut = (t?: string) => (t && t.length > 160 ? `${t.slice(0, 157)}…` : t);
  return {
    segmentId: s.id,
    start: s.start,
    end: s.end,
    text: s.text,
    speaker: s.speaker,
    instruction: s.instruction,
    visualMode: s.visualMode,
    analysis: analyzeContent(s.text),
    before: cut(neighbours.before),
    after: cut(neighbours.after),
    rejectedConcepts,
  };
}
