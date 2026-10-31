import * as fs from 'fs';
import { TranscriptionError } from '../../shared/transcription';
import { runProcess } from './process';

export interface ExtractOptions {
  /** Index of the audio stream to use (0 = first). */
  audioTrack?: number;
  signal?: AbortSignal;
  /** Fraction 0–1 of the media processed. */
  onProgress?: (fraction: number) => void;
}

export interface ExtractResult {
  /** Media duration in seconds, 0 if FFmpeg didn't report one. */
  duration: number;
}

export function parseFfmpegDuration(line: string): number | null {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** Microseconds of output written so far, from `-progress` output (`out_time_us=` / `out_time_ms=`). */
export function parseFfmpegProgress(line: string): number | null {
  const match = /^out_time_(?:us|ms)=(\d+)$/.exec(line.trim());
  return match ? Number(match[1]) / 1_000_000 : null;
}

const NO_AUDIO = /matches no streams|does not contain any stream|Output file .* does not contain any stream|Stream specifier .* matches no streams/i;
const BAD_INPUT = /Invalid data found when processing input|moov atom not found|could not find codec parameters|Invalid argument/i;

/**
 * Decodes the chosen audio stream to 16 kHz mono 16-bit PCM WAV, the input format whisper.cpp
 * expects. Works for any container FFmpeg can read (MP4, MOV, MKV, WAV, MP3, …).
 */
export async function extractAudio(ffmpeg: string, input: string, output: string, options: ExtractOptions = {}): Promise<ExtractResult> {
  const track = Math.max(0, Math.floor(options.audioTrack ?? 0));
  let duration = 0;
  const args = [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-y',
    '-i',
    input,
    '-map',
    `0:a:${track}`,
    '-vn',
    '-sn',
    '-dn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    '-progress',
    'pipe:1',
    output,
  ];

  let result;
  try {
    result = await runProcess(ffmpeg, args, {
      signal: options.signal,
      onStderrLine: (line) => {
        const d = parseFfmpegDuration(line);
        if (d !== null && duration === 0) duration = d;
      },
      onStdoutLine: (line) => {
        const t = parseFfmpegProgress(line);
        if (t !== null && duration > 0) options.onProgress?.(Math.min(1, t / duration));
      },
    });
  } catch (error) {
    if (error instanceof TranscriptionError) throw error;
    throw new TranscriptionError('FFMPEG_NOT_FOUND', `FFmpeg could not be started (${ffmpeg}).`, String(error));
  }

  if (result.code !== 0) {
    if (NO_AUDIO.test(result.stderrTail)) {
      throw new TranscriptionError(
        'NO_AUDIO_STREAM',
        track > 0 ? `The file has no audio track ${track + 1}.` : 'The file has no audio track to transcribe.',
        result.stderrTail
      );
    }
    const message = BAD_INPUT.test(result.stderrTail)
      ? 'FFmpeg could not read this file. It may be damaged or use an unsupported codec.'
      : `FFmpeg failed to extract audio (exit code ${result.code}).`;
    throw new TranscriptionError('EXTRACTION_FAILED', message, result.stderrTail);
  }

  // A 44-byte WAV is a header with no samples.
  const size = fs.existsSync(output) ? fs.statSync(output).size : 0;
  if (size <= 44) throw new TranscriptionError('NO_AUDIO_STREAM', 'The audio track is empty.', result.stderrTail);
  options.onProgress?.(1);
  return { duration };
}

export async function ffmpegVersion(ffmpeg: string): Promise<string | undefined> {
  try {
    const { stdout } = await runProcess(ffmpeg, ['-hide_banner', '-version']);
    return /ffmpeg version (\S+)/.exec(stdout)?.[1];
  } catch {
    return undefined;
  }
}
