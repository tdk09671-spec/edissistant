// Transcripts and reference material are untrusted: a speaker (or a reference page) can say
// "ignore your instructions". Such text is always passed to a model as escaped data inside tags, is
// flagged for the editor, and can never change what the planner is allowed to do.

const INJECTION_PATTERNS: RegExp[] = [
  /\bignore (?:all |any |the )?(?:previous|prior|above|earlier|your) (?:instructions|rules|prompts?)\b/i,
  /\bdisregard (?:all |any |the )?(?:previous|prior|above|your) (?:instructions|rules)\b/i,
  /\b(?:new|updated) (?:system )?instructions?:/i,
  /\byou are now\b|\bact as (?:an? )?(?:system|developer|admin)\b/i,
  /\b(?:system|developer) (?:prompt|message|mode)\b/i,
  /\breveal (?:your|the) (?:prompt|instructions|api key|key)\b/i,
  /\b(?:api[_ -]?key|secret key|password)\b/i,
  /<\/?\s*(?:system|instructions?|untrusted|transcript_segment|reference)\b/i,
  /\b(?:execute|run|eval) (?:this |the following )?(?:code|javascript|script|command)\b/i,
];

/** The first instruction-like fragment in `text`, or null. */
export function findInjection(text: string): string | null {
  for (const re of INJECTION_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0].slice(0, 60);
  }
  return null;
}

/** Escapes text so it can't open or close tags in a prompt. */
export function escapeForPrompt(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Wraps untrusted text in a tag with escaped content and a safe attribute value. */
export function untrusted(tag: 'transcript_segment' | 'context' | 'reference_note', text: string, attrs: Record<string, string> = {}): string {
  const a = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${v.replace(/[^A-Za-z0-9_.:-]/g, '_')}"`)
    .join('');
  return `<${tag}${a}>${escapeForPrompt(text)}</${tag}>`;
}
