import type { AnimationSpec } from '../../shared/animation/types';
import type { LoadedAssets } from './assets';

export interface FrameJob {
  spec: AnimationSpec;
  /** Output size in pixels (spec size × scale, rounded to even). */
  width: number;
  height: number;
  scale: number;
  assets: LoadedAssets;
  /** Font families that must be installed on the system (validated as not bundled). */
  systemFonts: string[];
}

/**
 * Produces straight (non-premultiplied) RGBA frames. The production source draws with the trusted
 * engine inside a sandboxed Chromium renderer; tests use synthetic sources. Swapping this out (e.g.
 * for a GPU or native renderer) doesn't touch encoding, caching or composition.
 */
export interface FrameSource {
  /** Loads fonts and images and checks font availability. Returns warnings. */
  open(signal?: AbortSignal): Promise<{ warnings: string[] }>;
  /** RGBA bytes for frame `index`: width × height × 4. */
  frame(index: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export type FrameSourceFactory = (job: FrameJob) => FrameSource;
