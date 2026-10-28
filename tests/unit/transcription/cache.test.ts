import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cacheKey, fingerprintFile, TranscriptCache } from '../../../src/main/transcription/cache';
import { TRANSCRIPT_SCHEMA, TRANSCRIPT_SCHEMA_VERSION, type Transcript } from '../../../src/shared/transcription';
import { tempDir } from './helpers';

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function transcript(id: string): Transcript {
  return {
    schema: TRANSCRIPT_SCHEMA,
    version: TRANSCRIPT_SCHEMA_VERSION,
    id,
    language: 'en',
    duration: 1,
    media: { path: '/a.wav', name: 'a.wav', size: 1, modifiedAt: '2026-01-01T00:00:00.000Z', fingerprint: 'f' },
    engine: { name: 'whisper.cpp', model: 'base', device: 'cpu', cpuFallback: false, threads: 1 },
    wordTiming: 'word',
    sentences: [{ id: 's1', start: 0, end: 1, text: 'Hi.', words: [{ text: 'Hi.', start: 0, end: 1 }] }],
    createdAt: '2026-01-01T00:00:00.000Z',
    warnings: [],
  };
}

describe('fingerprintFile', () => {
  it('is stable for unchanged files and changes with content or mtime', () => {
    const file = path.join(dir, 'a.bin');
    fs.writeFileSync(file, Buffer.alloc(1000, 1));
    const t = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(file, t, t);
    const first = fingerprintFile(file);
    expect(fingerprintFile(file)).toEqual(first);

    // Same size, different content, same mtime.
    const buf = Buffer.alloc(1000, 1);
    buf[500] = 2;
    fs.writeFileSync(file, buf);
    fs.utimesSync(file, t, t);
    expect(fingerprintFile(file).fingerprint).not.toBe(first.fingerprint);

    // Same content, new mtime (e.g. re-exported).
    fs.writeFileSync(file, Buffer.alloc(1000, 1));
    fs.utimesSync(file, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'));
    expect(fingerprintFile(file).fingerprint).not.toBe(first.fingerprint);
  });

  it('samples large files and still detects a change in the middle of a sample', () => {
    const file = path.join(dir, 'big.bin');
    const size = 8 * 1024 * 1024;
    fs.writeFileSync(file, Buffer.alloc(size));
    const t = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(file, t, t);
    const before = fingerprintFile(file).fingerprint;
    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, Buffer.from([7]), 0, 1, size / 2 + 10);
    fs.closeSync(fd);
    fs.utimesSync(file, t, t);
    expect(fingerprintFile(file).fingerprint).not.toBe(before);
  });
});

describe('cacheKey', () => {
  it('ignores property order and changes with any value', () => {
    expect(cacheKey({ a: 1, b: 'x' })).toBe(cacheKey({ b: 'x', a: 1 }));
    expect(cacheKey({ a: 1, b: 'x' })).not.toBe(cacheKey({ a: 1, b: 'y' }));
    expect(cacheKey({ a: 1 })).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe('TranscriptCache', () => {
  const key = (n: number) => cacheKey({ n });

  it('stores and loads transcripts', () => {
    const cache = new TranscriptCache(path.join(dir, 'transcripts'));
    expect(cache.get(key(1))).toBeNull();
    cache.set(transcript(key(1)));
    expect(cache.get(key(1))).toEqual(transcript(key(1)));
  });

  it('drops corrupt entries', () => {
    const cache = new TranscriptCache(dir);
    fs.writeFileSync(path.join(dir, `${key(1)}.json`), '{ nope');
    expect(cache.get(key(1))).toBeNull();
    expect(fs.existsSync(path.join(dir, `${key(1)}.json`))).toBe(false);
  });

  it('rejects keys that could escape the folder', () => {
    const cache = new TranscriptCache(dir);
    expect(() => cache.get('../../etc/passwd')).toThrow();
  });

  it('prunes the oldest entries and can be cleared', () => {
    const cache = new TranscriptCache(dir, 2);
    for (let i = 1; i <= 3; i++) {
      cache.set(transcript(key(i)));
      const t = new Date(Date.UTC(2026, 0, i));
      fs.utimesSync(path.join(dir, `${key(i)}.json`), t, t);
    }
    cache.prune();
    expect(cache.get(key(1))).toBeNull();
    expect(cache.get(key(3))).not.toBeNull();
    expect(cache.clear()).toBe(2);
    expect(cache.get(key(3))).toBeNull();
  });
});
