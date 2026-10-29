// Local, deterministic reading of what a sentence is about. Free (no model call); feeds the local
// planner directly and gives a model compact hints so prompts stay small.

import type { ContentKind } from './types';

export interface ExtractedNumber {
  /** Text as written, e.g. "$1.2 million", "40%". */
  raw: string;
  value: number;
  unit?: 'percent' | 'currency' | 'multiplier' | 'year' | 'duration';
  /** Up to three words after the number, e.g. "as fast", "customers" (transcript words). */
  context?: string;
}

function contextAfter(text: string, end: number): string | undefined {
  const m = /^\s*((?:[\p{L}'’-]+\s*){1,3})/u.exec(text.slice(end).split(/[,.;:!?]/)[0] ?? '');
  const ctx = m?.[1].trim().split(/\s+/).filter((w, i, all) => !(i === all.length - 1 && STOP.has(w.toLowerCase()) && all.length > 1)).join(' ');
  // Only function words ("in", "to the") say nothing on screen.
  return ctx && ctx.split(/\s+/).some((w) => !STOP.has(w.toLowerCase())) ? ctx : undefined;
}

export interface ContentAnalysis {
  /** Kinds with a 0–1 strength, strongest first. */
  kinds: { kind: ContentKind; strength: number }[];
  primary: ContentKind;
  numbers: ExtractedNumber[];
  /** Short phrase from the sentence that carries its meaning (always transcript words). */
  keyPhrase: string;
  /** Words worth emphasizing (transcript words). */
  emphasis: string[];
  /** Items for list/process content (transcript fragments). */
  items: string[];
  wordCount: number;
  /** One-line, user-facing description of the meaning. */
  meaning: string;
}

const STOP = new Set(
  'a an the and or but so of to in on at for with from by is are was were be been being it its this that these those i we you they he she our your their my me us them as if then than just very really also can will would could should do does did have has had not no yes there here what which who whom how when where why about into over more most less some any all each every one'.split(
    ' '
  )
);

const MAGNITUDE: Record<string, number> = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, billion: 1e9, bn: 1e9, b: 1e9, trillion: 1e12 };
const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twice: 2, double: 2, triple: 3, half: 0.5 };

export function extractNumbers(text: string): ExtractedNumber[] {
  const found: ExtractedNumber[] = [];
  const re = /(\$|€|£)?\s?(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?)\s?(%|percent|x\b|×|times\b|(?:thousand|million|billion|trillion|bn|k|m|b)\b)?(?:\s?(million|billion|thousand))?/gi;
  for (const m of text.matchAll(re)) {
    const [raw, currency, digits, suffix, magWord] = m;
    if (!digits) continue;
    let value = Number(digits.replace(/,(?=\d{3})/g, ''));
    if (!Number.isFinite(value)) continue;
    const s = (suffix ?? '').toLowerCase();
    let unit: ExtractedNumber['unit'];
    if (s === '%' || s === 'percent') unit = 'percent';
    else if (s === 'x' || s === '×' || s === 'times') unit = 'multiplier';
    else if (MAGNITUDE[s]) value *= MAGNITUDE[s];
    if (magWord) value *= MAGNITUDE[magWord.toLowerCase()] ?? 1;
    if (currency) unit = 'currency';
    else if (!unit && /^(19|20)\d{2}$/.test(digits)) unit = 'year';
    const ctx = contextAfter(text, (m.index ?? 0) + raw.length);
    found.push({ raw: raw.trim(), value, unit, ...(ctx ? { context: ctx } : {}) });
  }
  for (const m of text.matchAll(/\b(twice|double|triple|half)\b/gi)) {
    const ctx = contextAfter(text, (m.index ?? 0) + m[0].length);
    found.push({ raw: m[0].toLowerCase(), value: NUMBER_WORDS[m[0].toLowerCase()], unit: 'multiplier', ...(ctx ? { context: ctx } : {}) });
  }
  return found;
}

function words(text: string): string[] {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
}

const PATTERNS: { kind: ContentKind; re: RegExp; strength: number }[] = [
  { kind: 'comparison', re: /\bfrom\s+\$?\d[\d.,]*\s*\w*\s+(?:\w+\s+){0,3}to\s+\$?\d/i, strength: 0.8 },
  { kind: 'comparison', re: /\b(vs\.?|versus|compared (?:to|with)|than|instead of|unlike|whereas|on the other hand|before and after|while)\b/i, strength: 0.75 },
  { kind: 'trend', re: /\b(grew|grow(?:s|ing)?|increas\w*|decreas\w*|declin\w*|rose|rise|rising|fell|dropp\w*|doubl\w*|tripl\w*|climb\w*|surg\w*|jump\w*|since \d{4}|over the (?:last|past)|year over year|trend)\b/i, strength: 0.8 },
  { kind: 'process', re: /\b(first(?:ly)?|second(?:ly)?|then|next|after that|finally|step|steps|stage|phase|process|workflow|pipeline|how (?:to|we|it works))\b/i, strength: 0.6 },
  { kind: 'list', re: /(,\s*\w+(?:\s\w+)?,\s*(?:and|or)\s)|\b(three things|a few things|several|these are|includ(?:e|es|ing))\b/i, strength: 0.55 },
  { kind: 'quote', re: /["“”]|(\b(said|says|told me|in (?:his|her|their) words|quote)\b)/i, strength: 0.7 },
  { kind: 'question', re: /\?\s*$|^(why|how|what|who|when|where|which|is|are|do|does|can|could|would|should)\b/i, strength: 0.7 },
  { kind: 'definition', re: /\b(means|is called|is defined as|refers to|in other words|basically|is when)\b/i, strength: 0.6 },
  { kind: 'time', re: /\b(in (?:19|20)\d{2}|(?:19|20)\d{2}|years? ago|decade|century|today|tomorrow|yesterday|deadline|timeline|history)\b/i, strength: 0.5 },
  { kind: 'place', re: /\b(in (?:[A-Z][a-z]+)(?: [A-Z][a-z]+)?|city|country|worldwide|globally|across the world|office|map|region)\b/, strength: 0.45 },
  { kind: 'emotion', re: /\b(love|hate|amazing|incredible|terrified|excited|proud|frustrat\w*|heartbreak\w*|honestly|wow|unbelievable)\b/i, strength: 0.5 },
  { kind: 'call-to-action', re: /\b(subscribe|sign up|join|download|visit|click|follow|try it|get started|book a|contact us|link (?:in|below))\b/i, strength: 0.8 },
  { kind: 'claim', re: /\b(the (?:key|secret|truth|problem|answer) is|the most|the best|the only|never|always|everyone|nobody|game[- ]changer|important)\b/i, strength: 0.55 },
  { kind: 'transition', re: /^(so|now|okay|ok|alright|anyway|but first|let'?s|moving on)\b/i, strength: 0.4 },
  { kind: 'person', re: /\b(our (?:founder|ceo|team)|my (?:dad|mom|mother|father|friend|boss|client)|[A-Z][a-z]+ [A-Z][a-z]+ (?:said|told|founded))\b/, strength: 0.45 },
];

function keyPhraseOf(text: string, numbers: ExtractedNumber[]): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const quoted = /["“]([^"”]{3,})["”]/.exec(clean);
  if (quoted) return trimWords(quoted[1].replace(/[,.;:]+$/, '').trim(), 12);
  if (words(clean).length <= 12) return clean.replace(/[.!]+$/, '');
  // A clause with a number is usually the headline.
  if (numbers.length) {
    const clause = clean.split(/[,;:—–]|\band\b/).find((c) => numbers.some((n) => c.includes(n.raw)));
    if (clause) return trimWords(clause.trim(), 12);
  }
  // Otherwise the shortest substantive clause.
  const clauses = clean
    .split(/[,;:—–.!?]/)
    .map((c) => c.trim())
    .filter((c) => words(c).filter((w) => !STOP.has(w.toLowerCase())).length >= 2);
  const pick = clauses.sort((a, b) => words(a).length - words(b).length)[0] ?? clean;
  return trimWords(pick, 12);
}

function trimWords(text: string, max: number): string {
  const w = text.split(/\s+/);
  let kept = w.length > max ? w.slice(0, max) : w;
  // Don't end a phrase on a dangling function word ("…five people in").
  while (kept.length > 3 && w.length > max && STOP.has(kept[kept.length - 1].toLowerCase())) kept = kept.slice(0, -1);
  return kept.join(' ').replace(/^(and|but|so|then)\s+/i, '');
}

function itemsOf(text: string): string[] {
  const unquoted = text.replace(/["“][^"”]*["”]/g, ' ');
  const afterColon = unquoted.includes(':') ? unquoted.slice(unquoted.lastIndexOf(':') + 1) : unquoted;
  const listLike = (afterColon.match(/,/g) ?? []).length >= 1 && /\band\b|,\s*\w+\s*,/.test(afterColon);
  const sequenced = /\b(first(?:ly)?|then|next|finally|after that)\b/i.test(afterColon);
  if (!listLike && !sequenced) return [];
  const parts = afterColon
    .replace(/\b(first(?:ly)?|second(?:ly)?|third(?:ly)?|then|next|after that|finally)\b,?/gi, '|')
    .split(/[|,;]|\band\b/)
    .map((p) => trimWords(p.replace(/[.!?]$/, '').trim(), 5))
    .filter((p) => words(p).length >= 1 && words(p).some((w) => !STOP.has(w.toLowerCase())));
  return parts.length >= 2 ? parts.slice(0, 6) : [];
}

const DESCRIBE: Record<ContentKind, string> = {
  statistic: 'A figure the viewer should remember',
  money: 'A monetary amount',
  percentage: 'A proportion or rate',
  comparison: 'Two things set against each other',
  trend: 'Change over time',
  process: 'Steps in a sequence',
  list: 'Several items',
  quote: 'Someone’s words',
  question: 'A question to the viewer',
  claim: 'A strong claim or key point',
  definition: 'An explanation of a term',
  time: 'A point or span in time',
  place: 'A location',
  person: 'A person or role',
  emotion: 'An emotional beat',
  'call-to-action': 'An ask to the viewer',
  transition: 'A bridge between ideas',
  statement: 'A plain statement',
};

export function analyzeContent(text: string): ContentAnalysis {
  const numbers = extractNumbers(text);
  const scores = new Map<ContentKind, number>();
  const bump = (k: ContentKind, s: number) => scores.set(k, Math.max(scores.get(k) ?? 0, s));
  for (const p of PATTERNS) if (p.re.test(text)) bump(p.kind, p.strength);
  for (const n of numbers) {
    if (n.unit === 'percent') bump('percentage', 0.9);
    else if (n.unit === 'currency') bump('money', 0.9);
    else if (n.unit === 'year') bump('time', 0.6);
    else bump('statistic', n.unit === 'multiplier' ? 0.75 : 0.8);
  }
  if (numbers.filter((n) => n.unit !== 'year').length >= 2) bump('comparison', 0.6);
  const items = itemsOf(text);
  if (items.length >= 3) bump('list', 0.6);
  if (scores.size === 0) bump('statement', 0.3);

  const kinds = [...scores.entries()].map(([kind, strength]) => ({ kind, strength })).sort((a, b) => b.strength - a.strength || a.kind.localeCompare(b.kind));
  const all = words(text);
  const emphasis = [...new Set(all.filter((w) => !STOP.has(w.toLowerCase()) && (w.length > 6 || /\d/.test(w) || /^[A-Z]/.test(w))))].slice(0, 3);
  return {
    kinds,
    primary: kinds[0].kind,
    numbers,
    keyPhrase: keyPhraseOf(text, numbers),
    emphasis,
    items,
    wordCount: all.length,
    meaning: DESCRIBE[kinds[0].kind],
  };
}

/** Normalized transcript tokens, for checking that on-screen text comes from the transcript. */
export function transcriptTokens(text: string): Set<string> {
  return new Set(words(text).map((w) => w.toLowerCase().replace(/[’']/g, "'")));
}

/** True when every word of `candidate` appears in the transcript text (numbers may be reformatted). */
export function isFromTranscript(candidate: string, transcript: string): boolean {
  const tokens = transcriptTokens(transcript);
  const digits = new Set((transcript.match(/\d+/g) ?? []).map(String));
  return words(candidate).every((w) => {
    const t = w.toLowerCase().replace(/[’']/g, "'");
    if (tokens.has(t)) return true;
    const d = t.replace(/[^0-9]/g, '');
    return d.length > 0 && [...digits].some((x) => x.includes(d) || d.includes(x));
  });
}

/** Splits a comparison sentence into its two sides (transcript fragments), or null. */
export function comparisonSides(sentence: string): [string, string] | null {
  const m = /\b(vs\.?|versus|compared (?:to|with)|than|instead of|unlike|whereas)\b/i.exec(sentence);
  if (!m) return null;
  const parts = (t: string) => t.replace(/[.,!?;:]+$/g, '').trim().split(/\s+/).filter(Boolean);
  const left = parts(sentence.slice(0, m.index)).slice(-5).join(' ');
  const right = parts(sentence.slice(m.index + m[0].length)).slice(0, 5).join(' ');
  return left && right ? [left, right] : null;
}
