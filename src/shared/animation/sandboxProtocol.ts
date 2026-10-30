// Messages between the main process and the render sandbox (a sandboxed, hidden Chromium page that
// only runs the trusted engine). Data only: specs, font/image bytes and frame indices go in; RGBA
// frames come out.
import type { RenderErrorInfo } from './errors';
import type { AnimationSpec } from './types';

export interface SandboxFont {
  family: string;
  weight?: number;
  style?: 'normal' | 'italic';
  data: Uint8Array;
}

export interface SandboxImage {
  id: string;
  mime: string;
  data: Uint8Array;
}

export type SandboxCommand =
  | {
      type: 'init';
      jobId: string;
      spec: AnimationSpec;
      width: number;
      height: number;
      scale: number;
      fonts: SandboxFont[];
      images: SandboxImage[];
    }
  | { type: 'frame'; jobId: string; index: number };

export type SandboxMessage =
  | { type: 'ready' }
  | { type: 'init-result'; jobId: string; ok: true; warnings: string[] }
  | { type: 'init-result'; jobId: string; ok: false; error: RenderErrorInfo }
  | { type: 'frame'; jobId: string; index: number; data: Uint8Array | Uint8ClampedArray }
  | { type: 'frame-error'; jobId: string; index: number; message: string };

export const SANDBOX_COMMAND_CHANNEL = 'render-sandbox:command';
export const SANDBOX_MESSAGE_CHANNEL = 'render-sandbox:message';
