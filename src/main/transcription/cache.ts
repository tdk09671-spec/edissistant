import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { parseTranscript, serializeTranscript, type Transcript } from '../../shared/transcription';

const SAMPLE_BYTES = 1024 * 1024;

export interface FileFingerprint {
  /** Hash of the size, modification time and sampled content. */
  fingerprint: string;
  size: number;
  mtimeMs: number;
}

/**
 * Fingerprints a file without reading all of it: size + mtime + 1 MiB samples at the start,
 * 25 %, 50 %, 75 % and end. Multi-GB camera files are fingerprinted in milliseconds, and a re-exported
 * file (new mtime or different content anywhere sampled) gets a new fingerprint.
 */
export function fingerprintFile(filePath: string): FileFingerprint {
  const stat = fs.statSync(filePath);
  const hash = createHash('sha256');
  hash.update(`${stat.size}:${Math.floor(stat.mtimeMs)}:`);
  const ranges: Array<[number, number]> =
    stat.size <= SAMPLE_BYTES * 5
      ? [[0, stat.size]]
      : [0, 0.25, 0.5, 0.75].map((f): [number, number] => [Math.floor(stat.size * f), SAMPLE_BYTES]).concat([[stat.size - SAMPLE_BYTES, SAMPLE_BYTES]]);
  const fd = fs.openSync(filePath, 'r');
  try {
    for (const [offset, length] of ranges) {
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = fs.readSync(fd, buffer, read, length - read, offset + read);
        if (n === 0) break;
        read += n;
      }
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { fingerprint: hash.digest('hex'), size: stat.size, mtimeMs: stat.mtimeMs };
}

/** Stable key from everything that changes the engine's output. */
export function cacheKey(parts: Record<string, string | number | boolean | undefined>): string {
  const ordered = Object.keys(parts)
    .sort()
    .map((k) => [k, parts[k] ?? null]);
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex').slice(0, 32);
}

/** One JSON file per transcript in `<userData>/transcripts`. Writes are atomic. */
export class TranscriptCache {
  constructor(private readonly dir: string, private readonly maxEntries = 500) {}

  private file(key: string): string {
    if (!/^[a-f0-9]{16,64}$/.test(key)) throw new Error('Invalid cache key');
    return path.join(this.dir, `${key}.json`);
  }

  get(key: string): Transcript | null {
    const file = this.file(key);
    try {
      if (!fs.existsSync(file)) return null;
      const transcript = parseTranscript(fs.readFileSync(file, 'utf8'));
      return transcript.id === key ? transcript : null;
    } catch {
      // Corrupt or outdated entry: drop it so it gets regenerated.
      fs.rmSync(file, { force: true });
      return null;
    }
  }

  set(transcript: Transcript): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(transcript.id);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, serializeTranscript(transcript), 'utf8');
    fs.renameSync(tmp, file);
    this.prune();
  }

  /** Removes the oldest entries beyond `maxEntries`. */
  prune(): void {
    let files: { file: string; mtime: number }[];
    try {
      files = fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => ({ file: path.join(this.dir, f), mtime: fs.statSync(path.join(this.dir, f)).mtimeMs }));
    } catch {
      return;
    }
    if (files.length <= this.maxEntries) return;
    files.sort((a, b) => b.mtime - a.mtime);
    for (const { file } of files.slice(this.maxEntries)) fs.rmSync(file, { force: true });
  }

  clear(): number {
    let removed = 0;
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (f.endsWith('.json') || f.endsWith('.tmp')) {
          fs.rmSync(path.join(this.dir, f), { force: true });
          removed++;
        }
      }
    } catch {
      // Nothing cached yet
    }
    return removed;
  }
}
