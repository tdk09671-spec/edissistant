// Handles simple editor instructions locally, without a model call: pace, size, colour, concept
// swaps and visual-mode changes. Anything it can't understand is left for the model (or the editor).

import { CONCEPTS, MODE_DEFAULT } from './concepts';
import type { ConceptParams, EditorOverrides, VisualMode } from './types';

export interface LocalEditResult {
  /** True when the whole instruction was understood. */
  handled: boolean;
  overrides: EditorOverrides;
  /** Parts of the instruction that were understood, for the UI. */
  understood: string[];
  /** Leftover text that needs a model or the editor. */
  remainder: string;
}

const MODE_PHRASES: [RegExp, VisualMode][] = [
  [/\b(?:just|only|stay on|keep (?:it )?on|no graphics?,?)\s*(?:the )?(?:speaker|talking head|face)\b|\bno graphics?\b/i, 'speaker'],
  [/\b(?:just|only|use)\s+captions?\b|\bcaptions? only\b/i, 'captions'],
  [/\bb[- ]?roll\b|\bcut ?away\b/i, 'b-roll'],
  [/\b(?:background|bg) (?:graphic|plate|texture)\b/i, 'background-graphics'],
  [/\b(?:full[- ]screen )?(?:motion )?graphic\b(?! only)/i, 'motion-graphics'],
];

const CONCEPT_ALIASES: [RegExp, string][] = [
  [/\btimeline\b/i, 'timeline-track'],
  [/\b(?:counter|count[- ]?up|big number)\b/i, 'counter-hero'],
  [/\bbar (?:chart|graph)s?\b|\bbars\b/i, 'bar-comparison'],
  [/\bline (?:chart|graph)|\btrend line\b/i, 'line-trend'],
  [/\b(?:progress|percentage) ring\b|\bdonut\b|\bring\b/i, 'progress-ring'],
  [/\bflow ?chart\b|\bprocess (?:diagram|flow)\b|\bsteps? diagram\b/i, 'process-steps'],
  [/\b(?:list|bullets?)\b/i, 'list-stack'],
  [/\bquote\b|\btype ?writer\b|\btype it on\b/i, 'type-on-quote'],
  [/\bunderline\b/i, 'underline-callout'],
  [/\blower[- ]third\b|\bname (?:tag|bar)\b/i, 'lower-third'],
  [/\bversus\b|\bside[- ]by[- ]side\b|\bsplit\b/i, 'split-versus'],
  [/\blogo\b/i, 'logo-sting'],
  [/\bkinetic|word by word\b/i, 'kinetic-headline'],
];

const PACE: [RegExp, number][] = [
  [/\b(?:much|way|a lot) (?:faster|quicker|snappier)\b/i, 1.6],
  [/\b(?:faster|quicker|snappier|speed (?:it )?up)\b/i, 1.3],
  [/\b(?:much|way|a lot) slower\b/i, 0.6],
  [/\b(?:slower|slow (?:it )?down|calmer|more relaxed)\b/i, 0.75],
];

const SCALE: [RegExp, number][] = [
  [/\b(?:much|way|a lot) (?:bigger|larger)\b/i, 1.5],
  [/\b(?:bigger|larger|bolder text|make (?:the )?text bigger)\b/i, 1.25],
  [/\b(?:much|way|a lot) smaller\b/i, 0.65],
  [/\b(?:smaller|subtler|make (?:the )?text smaller)\b/i, 0.8],
];

const TRANSITIONS: [RegExp, NonNullable<ConceptParams['transition']>][] = [
  [/\bfade\b/i, 'fade'],
  [/\bslide\b/i, 'slide'],
  [/\bwipe\b/i, 'wipe'],
  [/\b(?:scale|zoom|pop)\b/i, 'scale'],
];

/**
 * Parses an editor instruction such as "faster, use a timeline" or "just captions here".
 * Concept and mode changes are only taken from clear phrases; nothing is guessed.
 */
export function parseLocalEdit(instruction: string): LocalEditResult {
  let rest = ` ${instruction} `;
  const understood: string[] = [];
  const overrides: EditorOverrides = {};
  const params: ConceptParams = {};
  const take = (re: RegExp, label: string) => {
    const m = re.exec(rest);
    if (!m) return false;
    rest = rest.replace(m[0], ' ');
    understood.push(label);
    return true;
  };

  for (const [re, conceptId] of CONCEPT_ALIASES) {
    if (take(new RegExp(`\\b(?:use|try|make it|show|as|with|add) (?:an? |the )?${re.source}`, 'i'), `concept → ${conceptId}`) || take(re, `concept → ${conceptId}`)) {
      overrides.conceptId = conceptId;
      overrides.visualMode = CONCEPTS.find((c) => c.id === conceptId)?.visualMode;
      break;
    }
  }
  if (!overrides.conceptId) {
    for (const [re, mode] of MODE_PHRASES) {
      if (take(re, `mode → ${mode}`)) {
        overrides.visualMode = mode;
        if (mode !== 'motion-graphics') overrides.conceptId = MODE_DEFAULT[mode];
        break;
      }
    }
  }
  for (const [re, pace] of PACE) if (take(re, `pace × ${pace}`)) { params.pace = pace; break; }
  for (const [re, scale] of SCALE) if (take(re, `text size × ${scale}`)) { params.scale = scale; break; }
  for (const [re, tr] of TRANSITIONS) if (take(new RegExp(`\\b(?:use an? |with an? )?${re.source}(?: (?:in|transition))?`, 'i'), `transition → ${tr}`)) { params.transition = tr; break; }
  const color = /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/i.exec(rest);
  if (color) {
    rest = rest.replace(color[0], ' ');
    params.accent = color[0].toLowerCase();
    understood.push(`accent → ${params.accent}`);
  }
  if (Object.keys(params).length) overrides.params = params;

  // Only filler words left → fully handled. Otherwise show the editor's own words that remain.
  const meaningful = rest.replace(/\b(?:please|here|this|it|a bit|a little|more|and|then|but|make|the|use|instead|also|of|a|an|to|with|for|show|display|turn|into|as|change|switch|graphic|visual)\b/gi, ' ').replace(/[^\p{L}\p{N}#]+/gu, ' ').trim();
  const remainder = meaningful ? rest.replace(/^[\s,;.]*(?:and|then|but)?\s*(?:make it\s+)?/i, '').replace(/[\s,;.]+$/, '').replace(/\s+/g, ' ').trim() : '';
  return { handled: understood.length > 0 && !meaningful, overrides, understood, remainder };
}
