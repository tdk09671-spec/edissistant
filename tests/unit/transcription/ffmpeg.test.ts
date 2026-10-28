import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractAudio, ffmpegVersion, parseFfmpegDuration, parseFfmpegProgress } from '../../../src/main/transcription/ffmpeg';
import { TranscriptionError } from '../../../src/shared/transcription';
import { ffmpegPath, fixtures, tempDir } from './helpers';

describe('FFmpeg output parsing', () => {
  it('reads the duration line', () => {
    expect(parseFfmpegDuration('  Duration: 01:02:03.50, start: 0.000000, bitrate: 76 kb/s')).toBe(3723.5);
    expect(parseFfmpegDuration('  Duration: N/A, bitrate: N/A')).toBeNull();
  });

  it('reads -progress output times', () => {
    expect(parseFfmpegProgress('out_time_us=1500000')).toBe(1.5);
    expect(parseFfmpegProgress('out_time_ms=2000000')).toBe(2);
    expect(parseFfmpegProgress('out_time=00:00:01.500000')).toBeNull();
  });
});

function wavInfo(file: string) {
  const buf = fs.readFileSync(file);
  return { riff: buf.toString('ascii', 0, 4), channels: buf.readUInt16LE(22), rate: buf.readUInt32LE(24), bits: buf.readUInt16LE(34), size: buf.length };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(TranscriptionError);
    expect((error as TranscriptionError).code).toBe(code);
  }
}

describe.skipIf(!ffmpegPath)('extractAudio (real FFmpeg)', () => {
  const ffmpeg = ffmpegPath as string;
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.each([
    ['MP4 (H.264 + AAC)', '../sample.mp4', 3],
    ['MOV (H.264 + 2 AAC tracks)', 'clip.mov', 2],
    ['WAV', 'tone.wav', 2],
    ['MP3', 'tone.mp3', 2],
  ])('converts %s to 16 kHz mono 16-bit WAV and reports progress', async (_label, file, seconds) => {
    const out = path.join(dir, 'audio.wav');
    const progress: number[] = [];
    const { duration } = await extractAudio(ffmpeg, path.join(fixtures, file), out, { onProgress: (p) => progress.push(p) });
    expect(duration).toBeCloseTo(seconds, 0);
    const info = wavInfo(out);
    expect(info).toMatchObject({ riff: 'RIFF', channels: 1, rate: 16000, bits: 16 });
    // 16 kHz × 2 bytes per second of audio, plus the header (MP3 decoders may add a little padding).
    expect(info.size).toBeGreaterThan(seconds * 32000 * 0.95);
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1])).toBe(true);
  });

  it('extracts a chosen audio track', async () => {
    const out = path.join(dir, 'audio.wav');
    // Track 2 of clip.mov is 1 s long, track 1 is 2 s.
    await extractAudio(ffmpeg, path.join(fixtures, 'clip.mov'), out, { audioTrack: 1 });
    expect(wavInfo(out).size).toBeLessThan(40000);
  });

  it('reports NO_AUDIO_STREAM for video without audio and for a missing track', async () => {
    await expectCode(extractAudio(ffmpeg, path.join(fixtures, 'no-audio.mp4'), path.join(dir, 'a.wav')), 'NO_AUDIO_STREAM');
    await expectCode(extractAudio(ffmpeg, path.join(fixtures, 'clip.mov'), path.join(dir, 'b.wav'), { audioTrack: 5 }), 'NO_AUDIO_STREAM');
  });

  it('reports EXTRACTION_FAILED for a damaged file', async () => {
    const bad = path.join(dir, 'broken.mp4');
    fs.writeFileSync(bad, Buffer.from('definitely not a video file'));
    await expectCode(extractAudio(ffmpeg, bad, path.join(dir, 'a.wav')), 'EXTRACTION_FAILED');
  });

  it('can be cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expectCode(extractAudio(ffmpeg, path.join(fixtures, 'tone.wav'), path.join(dir, 'a.wav'), { signal: controller.signal }), 'CANCELLED');
  });

  it('reads the FFmpeg version', async () => {
    expect(await ffmpegVersion(ffmpeg)).toMatch(/\d/);
  });
});

describe('extractAudio without FFmpeg', () => {
  it('reports FFMPEG_NOT_FOUND when the binary cannot be started', async () => {
    await expectCode(extractAudio(path.join(fixtures, 'no-such-ffmpeg'), path.join(fixtures, 'tone.wav'), 'out.wav'), 'FFMPEG_NOT_FOUND');
  });
});
