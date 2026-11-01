// The render job and the wire protocol between the app and the render host process.
//
// Framing (over the authenticated socket in ipc.ts, never stdin/stdout): "EDSH" magic, 4-byte big-endian
// header length, JSON header (with the job id), then `header.bin` raw bytes (0 if none). Header and
// payload sizes are capped; anything malformed is a hard error, never silently skipped.

export type SceneAdapter =
  /** A static design (no animation): captured as PNG stills at t = 0. */
  | { kind: 'static' }
  /** One scene per page: `window.SCENE = { dur, render(t) }` with t in seconds from the scene start. */
  | { kind: 'scene' }
  /**
   * Many scenes on one page on an absolute timeline (the SaaS "scene registry" style). `list` names a
   * global array of `{ id, t0, t1 }`, `render` a global `(T) => void`, `camera` an optional global
   * `(T) => { scale, originX?, originY?, x?, y? }` read after each render for the post-capture camera.
   */
  | { kind: 'registry'; sceneId: string; list?: string; render?: string; camera?: string };

export interface SceneFile {
  /** Path inside the job, e.g. "index.html", "kit/core.js", "fonts/Brand-Bold.woff2". */
  path: string;
  data: Uint8Array;
}

export interface SceneLimits {
  /** Page load, fonts and first layout. */
  loadMs: number;
  /** One frame (all subframes). */
  frameMs: number;
  /** Renderer memory (working set) before the job is stopped. */
  memoryMB: number;
}

export interface SceneJob {
  /** Entry HTML file (one of `files`). */
  entry: string;
  files: SceneFile[];
  adapter: SceneAdapter;
  /** Layout size in CSS pixels. Output is this × deviceScale. */
  width: number;
  height: number;
  deviceScale: number;
  /** Capture with a transparent page background (straight alpha). */
  alpha: boolean;
  /** Query string for the entry page, e.g. "nocap=1" (the skills' render modes). */
  query?: string;
  /** Seed for Math.random. */
  seed: number;
}

export const DEFAULT_LIMITS: SceneLimits = { loadMs: 30_000, frameMs: 30_000, memoryMB: 2048 };

/** What the page reported after loading. */
export interface SceneInfo {
  /** Scene duration in seconds (SCENE.dur, or t1 − t0 for a registry scene). */
  duration: number;
  /** Absolute start of the scene on the page timeline (0 for single scenes). */
  offset: number;
  /** Registry scenes found on the page. */
  scenes?: { id: string; t0: number; t1: number }[];
  /** Output size in pixels. */
  outputWidth: number;
  outputHeight: number;
  fontFamilies: string[];
}

export type HostCommand =
  | { type: 'file'; path: string; bin: number }
  | { type: 'open'; job: Omit<SceneJob, 'files'>; limits: SceneLimits }
  /** Capture at scene time `t` (seconds), averaging `times` (absolute scene times) if more than one. */
  | { type: 'capture'; id: number; times: number[]; postCamera: boolean }
  /** Test hook: returns JSON of the page's `window.__probe` (a plain value the page chose to expose). */
  | { type: 'probe'; id: number }
  | { type: 'close' };

export type HostMessage =
  | { type: 'ready'; pid: number; versions: Record<string, string> }
  | { type: 'opened'; info: SceneInfo; warnings: string[] }
  | { type: 'frame'; id: number; width: number; height: number; bin: number; ms: number }
  | { type: 'probe'; id: number; value: string }
  | { type: 'error'; id?: number; code: SceneErrorCode; message: string };

export type SceneErrorCode =
  | 'HOST_FAILED'
  | 'LOAD_FAILED'
  | 'LOAD_TIMEOUT'
  | 'NO_SCENE'
  | 'SCENE_ERROR'
  | 'FRAME_TIMEOUT'
  | 'MEMORY_LIMIT'
  | 'RENDERER_CRASHED'
  | 'INVALID_JOB'
  | 'CANCELLED';

export class SceneError extends Error {
  constructor(
    readonly code: SceneErrorCode,
    message: string
  ) {
    super(message);
  }
}

const MAGIC = Buffer.from('EDSH');

export function encodeMessage(header: object, bin?: Uint8Array): Buffer[] {
  const json = Buffer.from(JSON.stringify({ ...header, ...(bin ? { bin: bin.byteLength } : {}) }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length, 0);
  return bin ? [MAGIC, len, json, Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength)] : [MAGIC, len, json];
}

/** Incremental decoder: push chunks, get complete { header, bin } messages. */
export class MessageReader {
  private chunks: Buffer[] = [];
  private size = 0;
  private header: (Record<string, unknown> & { bin?: number }) | null = null;

  constructor(
    private readonly maxHeader = 1 << 20,
    /** Largest binary payload accepted (bounded buffering); larger declarations are protocol errors. */
    private readonly maxBinary = 512 * 1024 * 1024
  ) {}

  /** Bytes received but not yet part of a complete message. */
  get buffered(): number {
    return this.size;
  }

  push(chunk: Buffer): { header: Record<string, unknown>; bin: Buffer | null }[] {
    this.chunks.push(chunk);
    this.size += chunk.length;
    const out: { header: Record<string, unknown>; bin: Buffer | null }[] = [];
    for (;;) {
      if (!this.header) {
        if (this.size < 8) break;
        const head = this.take(8, true);
        if (!head.subarray(0, 4).equals(MAGIC)) throw new Error('Render host protocol error (unexpected output on its message channel).');
        const len = head.readUInt32BE(4);
        if (len > this.maxHeader) throw new Error('Render host message header is too large.');
        if (this.size < 8 + len) break;
        this.take(8);
        this.header = JSON.parse(this.take(len).toString('utf8'));
      }
      const need = typeof this.header!.bin === 'number' ? this.header!.bin : 0;
      if (!Number.isInteger(need) || need < 0 || need > this.maxBinary) throw new Error('Render host protocol error (payload size out of range).');
      if (this.size < need) break;
      const bin = need ? this.take(need) : null;
      out.push({ header: this.header!, bin });
      this.header = null;
    }
    return out;
  }

  private take(n: number, peek = false): Buffer {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const part = all.subarray(0, n);
    if (!peek) {
      const rest = all.subarray(n);
      this.chunks = rest.length ? [rest] : [];
      this.size = rest.length;
    } else {
      this.chunks = [all];
    }
    return part;
  }
}
