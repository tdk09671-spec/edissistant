import { frameToSeconds } from './timeline';
import type { CaptionAnimation, CaptionCue } from './types';

export interface CaptionState {
  cue: CaptionCue;
  index: number;
  /** 0–1 through the entrance animation (1 once it has finished or when there is none). */
  inProgress: number;
  /** 0–1 through the exit animation (0 until it starts). */
  outProgress: number;
  /** Index into cue.words of the word being spoken, or -1. */
  activeWord: number;
}

export const DEFAULT_CAPTION_IN = 0.15;
export const DEFAULT_CAPTION_OUT = 0.12;

/**
 * Which cue is on screen at time `t` (segment seconds). A cue is visible while start <= t < end,
 * so with frame times t = f / fps a cue covers exactly the frames whose leading edge falls inside it.
 * If cues overlap, the one that started last wins.
 *
 * `frameDuration` (1 / fps) makes the entrance progress describe the end of the frame, so a cue is
 * already partly visible on its first frame instead of appearing one frame late.
 */
export function captionAt(cues: readonly CaptionCue[], t: number, animation: CaptionAnimation = {}, frameDuration = 0): CaptionState | null {
  let index = -1;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (t >= c.start && t < c.end && (index === -1 || c.start >= cues[index].start)) index = i;
  }
  if (index === -1) return null;
  const cue = cues[index];
  const length = cue.end - cue.start;
  const inType = animation.in ?? 'fade';
  const outType = animation.out ?? 'fade';
  // Typewriter defaults to ~35 ms per character so long cues aren't typed in a flash.
  const defaultIn = inType === 'typewriter' ? cue.text.length * 0.035 : DEFAULT_CAPTION_IN;
  const inDur = inType === 'none' ? 0 : Math.min(animation.inDuration ?? defaultIn, length / 2);
  const outDur = outType === 'none' ? 0 : Math.min(animation.outDuration ?? DEFAULT_CAPTION_OUT, length / 2);
  const inProgress = inDur > 0 ? Math.min(1, (t - cue.start + frameDuration) / inDur) : 1;
  const outProgress = outDur > 0 ? Math.max(0, Math.min(1, (t - (cue.end - outDur)) / outDur)) : 0;

  let activeWord = -1;
  if (cue.words) {
    for (let i = 0; i < cue.words.length; i++) {
      if (t >= cue.words[i].start) activeWord = i;
    }
  }
  return { cue, index, inProgress, outProgress, activeWord };
}

/** Frames [first, last] (inclusive) on which a cue is visible, or null if it covers no frame. */
export function cueFrameRange(cue: CaptionCue, fps: number): [number, number] | null {
  let first = Math.max(0, Math.floor(cue.start * fps) - 1);
  while (frameToSeconds(first, fps) < cue.start) first++;
  let last = Math.ceil(cue.end * fps) + 1;
  while (last >= 0 && frameToSeconds(last, fps) >= cue.end) last--;
  return last >= first ? [first, last] : null;
}
