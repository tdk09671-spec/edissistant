import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ExportFormatId } from '../../shared/animation/types';
import type { MediaMetadata } from './probe';

export interface CacheManifest {
  key: string;
  /** Segment that first produced this render (renders are shared by content, not by ID). */
  segmentId: string;
  format: ExportFormatId;
  scale: number;
  file: string;
  metadata: MediaMetadata;
  createdAt: string;
  /** Extra information, e.g. the H.264 encoder used. */
  encoder?: string;
}

export interface CacheEntry {
  manifest: CacheManifest;
  path: string;
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

const KEY = /^[a-f0-9]{64}$/;
const TMP_DIR = '.tmp';
const MANIFEST = 'manifest.json';

/**
 * Content-addressed render cache: `<root>/<sha256>/output.<ext>` + `manifest.json`.
 * Work in progress lives in `<root>/.tmp/<job>/` on the same volume, so publishing an entry is a
 * rename, and an interrupted render can never leave a half-written entry behind.
 */
export class RenderCache {
  constructor(readonly root: string) {}

  private entryDir(key: string): string {
    if (!KEY.test(key)) throw new Error('Invalid render cache key');
    return path.join(this.root, key);
  }

  get(key: string): CacheEntry | null {
    const dir = this.entryDir(key);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')) as CacheManifest;
      const file = path.join(dir, path.basename(manifest.file));
      if (manifest.key !== key || fs.statSync(file).size !== manifest.metadata.sizeBytes) throw new Error('stale');
      // Touch for least-recently-used pruning.
      const now = new Date();
      fs.utimesSync(path.join(dir, MANIFEST), now, now);
      return { manifest, path: file };
    } catch {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      return null;
    }
  }

  /** A fresh scratch folder for one job. Remove it with `discard` (or publish its output with `put`). */
  createWorkDir(): string {
    const dir = path.join(this.root, TMP_DIR, `${Date.now()}-${randomBytes(4).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  discard(workDir: string): void {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  /** Moves a finished, validated file into the cache atomically. */
  put(key: string, file: string, manifest: Omit<CacheManifest, 'key' | 'file' | 'createdAt'>): CacheEntry {
    const dir = this.entryDir(key);
    const staging = `${file}.entry`;
    fs.mkdirSync(staging, { recursive: true });
    const name = `output${path.extname(file)}`;
    fs.renameSync(file, path.join(staging, name));
    const full: CacheManifest = { ...manifest, key, file: name, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(staging, MANIFEST), JSON.stringify(full, null, 2));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
    return { manifest: full, path: path.join(dir, name) };
  }

  /** Deletes scratch folders left by renders that crashed or were killed (older than `maxAgeMs`). */
  cleanupStale(maxAgeMs = 60 * 60 * 1000): number {
    const tmp = path.join(this.root, TMP_DIR);
    let removed = 0;
    try {
      for (const name of fs.readdirSync(tmp)) {
        const full = path.join(tmp, name);
        if (Date.now() - fs.statSync(full).mtimeMs >= maxAgeMs) {
          fs.rmSync(full, { recursive: true, force: true });
          removed++;
        }
      }
    } catch {
      // Nothing to clean
    }
    return removed;
  }

  entries(): CacheEntry[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.root).filter((n) => KEY.test(n));
    } catch {
      return [];
    }
    return names.map((n) => this.get(n)).filter((e): e is CacheEntry => e !== null);
  }

  /** Removes least-recently-used entries until the cache is under `maxBytes`. */
  prune(maxBytes: number): number {
    const entries = this.entries()
      .map((e) => ({ e, used: fs.statSync(path.join(path.dirname(e.path), MANIFEST)).mtimeMs }))
      .sort((a, b) => b.used - a.used);
    let total = 0;
    let removed = 0;
    for (const { e } of entries) {
      total += e.manifest.metadata.sizeBytes;
      if (total > maxBytes) {
        fs.rmSync(path.dirname(e.path), { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }

  clear(): number {
    const entries = this.entries();
    for (const e of entries) fs.rmSync(path.dirname(e.path), { recursive: true, force: true });
    fs.rmSync(path.join(this.root, TMP_DIR), { recursive: true, force: true });
    return entries.length;
  }

  /** True if `file` is inside the cache (used to restrict what the renderer may copy out). */
  contains(file: string): boolean {
    const rel = path.relative(this.root, path.resolve(file));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }
}
