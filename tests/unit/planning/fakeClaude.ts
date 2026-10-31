import type { ModelCall, ModelReply, ModelTransport } from '../../../src/shared/planning';

// A stand-in for the Anthropic transport: answers like the model would, or fails the way the API
// does. No test ever calls the real API.

export const FITTING: Record<string, string> = {
  a1: 'kinetic-headline',
  a2: 'counter-hero',
  a3: 'line-trend',
  a4: 'question-card',
  a5: 'process-steps',
  a6: 'progress-ring',
  a7: 'speaker-only',
  a8: 'stat-split',
  a9: 'caption-emphasis',
  a10: 'kinetic-headline',
};
export const ids = (user: string) => [...user.matchAll(/<transcript_segment id="([^"]+)"/g)].map((m) => m[1]);
export const usage = { inputTokens: 3000, outputTokens: 1200, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/** Answers every segment it was sent with a valid candidate, or runs `fail` instead. */
export function fakeTransport(fail?: (call: ModelCall, n: number) => ModelReply | never) {
  const calls: ModelCall[] = [];
  const t: ModelTransport & { calls: ModelCall[] } = {
    calls,
    async complete(call) {
      calls.push(call);
      if (fail) return fail(call, calls.length);
      // Varied concepts that fit each line, as a real answer would (the planner penalises repeats).
      const segments = ids(call.user).map((segmentId) => ({ segmentId, meaning: 'a point', candidates: [{ conceptId: FITTING[segmentId] ?? 'kinetic-headline', fit: 0.95, reasoning: 'Fits what is said.' }] }));
      return { text: JSON.stringify({ segments }), stopReason: 'end_turn', usage, model: call.model };
    },
  };
  return t;
}

