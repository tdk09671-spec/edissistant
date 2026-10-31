// Read-only media inspection for the pipeline: the source footage's timing (so the timeline uses its
// exact frame rate) and the files an export produced (so "done" means a valid file exists).

import * as fs from 'fs';
import * as path from 'path';
import { isSupportedFps } from '../../shared/animation/timeline';
import type { MediaCheck, SourceInfo } from '../../shared/pipeline/types';
import { runTool } from '../render/process';

export const MEDIA_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.mp3', '.wav', '.m4a', '.aac']);

export class MediaError extends Error {
  constructor(
    readonly code: 'MEDIA_NOT_FOUND' | 'FFPROBE_NOT_FOUND' | 'PROBE_FAILED' | 'INVALID_REQUEST',
    message: string
  ) {
    super(message);
  }
}

interface Stream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_read_packets?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  tags?: Record<string, string>;
}

/** A local media file the editor chose: absolute, existing, a media type. */
export function checkMediaPath(file: unknown): string {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new MediaError('INVALID_REQUEST', 'Media path must be absolute.');
  if (!MEDIA_EXTENSIONS.has(path.extname(file).toLowerCase())) throw new MediaError('INVALID_REQUEST', 'Not a supported media file.');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new MediaError('MEDIA_NOT_FOUND', `Media file not found: ${file}`);
  return file;
}

/** "30000/1001" → 29.97, "25/1" → 25; null when the timeline can't use the rate. */
export function projectFps(rate: string | undefined): number | null {
  const m = /^(\d+)\/(\d+)$/.exec(rate ?? '');
  if (!m || Number(m[2]) === 0) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  // NTSC rates keep their conventional labels (29.97, 23.976); timing uses the exact n/1001 rational.
  const fps = den === 1001 ? Number((num / den).toFixed(3)) : num / den;
  return isSupportedFps(fps) ? fps : null;
}

async function probe(ffprobe: string, file: string, countFrames: boolean): Promise<{ streams: Stream[]; format: { duration?: string; size?: string } }> {
  const args = ['-v', 'error', ...(countFrames ? ['-count_packets'] : []), '-show_streams', '-show_format', '-of', 'json', file];
  const { code, stdout, stderrTail } = await runTool(ffprobe, args, { maxStdout: 4 * 1024 * 1024 });
  if (code !== 0) throw new MediaError('PROBE_FAILED', `FFprobe could not read ${path.basename(file)}${stderrTail ? `: ${stderrTail.trim().split('\n').pop()}` : '.'}`);
  try {
    const data = JSON.parse(stdout.toString('utf8'));
    return { streams: data.streams ?? [], format: data.format ?? {} };
  } catch {
    throw new MediaError('PROBE_FAILED', 'FFprobe returned unreadable metadata.');
  }
}

export async function probeSource(ffprobe: string | undefined, file: unknown): Promise<SourceInfo> {
  const media = checkMediaPath(file);
  if (!ffprobe) throw new MediaError('FFPROBE_NOT_FOUND', 'FFprobe was not found. Set the FFmpeg folder in Settings.');
  const { streams, format } = await probe(ffprobe, media, false);
  const v = streams.find((s) => s.codec_type === 'video' && s.width);
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v) throw new MediaError('PROBE_FAILED', `${path.basename(media)} has no video stream.`);
  const fps = projectFps(v.r_frame_rate) ?? projectFps(v.avg_frame_rate);
  return {
    path: media,
    duration: Number(format.duration ?? v.duration ?? 0),
    width: v.width ?? 0,
    height: v.height ?? 0,
    frameRate: projectFps(v.r_frame_rate) !== null ? v.r_frame_rate! : (v.avg_frame_rate ?? v.r_frame_rate ?? ''),
    fps,
    videoCodec: v.codec_name ?? '',
    hasAudio: Boolean(a),
    ...(a ? { audioCodec: a.codec_name ?? '', sampleRate: Number(a.sample_rate ?? 0), channels: a.channels ?? 0 } : {}),
  };
}

const ALPHA = /^(yuva|rgba|bgra|argb|abgr|gbrap|ya)/;

/** Inspects an exported file: streams, real frame count, alpha, audio. */
export async function checkMedia(ffprobe: string | undefined, file: unknown): Promise<MediaCheck> {
  const media = checkMediaPath(file);
  if (!ffprobe) throw new MediaError('FFPROBE_NOT_FOUND', 'FFprobe was not found. Set the FFmpeg folder in Settings.');
  const { streams, format } = await probe(ffprobe, media, true);
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const tags = Object.fromEntries(Object.entries(v?.tags ?? {}).map(([k, val]) => [k.toLowerCase(), val]));
  return {
    path: media,
    sizeBytes: fs.statSync(media).size,
    duration: Number(format.duration ?? 0),
    video: v
      ? {
          codec: v.codec_name ?? '',
          width: v.width ?? 0,
          height: v.height ?? 0,
          frameRate: v.r_frame_rate ?? '',
          frames: Number(v.nb_read_packets ?? 0),
          pixFmt: v.pix_fmt ?? '',
          hasAlpha: ALPHA.test(v.pix_fmt ?? '') || tags.alpha_mode === '1',
        }
      : null,
    audio: a ? { codec: a.codec_name ?? '', sampleRate: Number(a.sample_rate ?? 0), channels: a.channels ?? 0, duration: Number(a.duration ?? 0) } : null,
  };
}
