import { once } from 'events';
import { cancelled, RenderError } from '../../shared/animation/errors';
import { EXPORT_FORMATS } from '../../shared/animation/formats';
import { fpsString } from '../../shared/animation/timeline';
import type { ExportFormatId } from '../../shared/animation/types';
import { spawnTool, tailCollector } from './process';

export interface EncodeTarget {
  format: ExportFormatId;
  width: number;
  height: number;
  fps: number;
  /** H.264 encoder to use for h264-mp4 (libx264 or a validated hardware encoder). */
  h264Encoder?: string;
  /** Faster, smaller settings for previews. */
  preview?: boolean;
}

// Rec. 709 tagging and matrix for every YUV output, so graphics match footage in an NLE.
const BT709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
const YUV_FILTER = (pixFmt: string) => ['-vf', `scale=out_color_matrix=bt709:out_range=tv,format=${pixFmt}`];

/** FFmpeg encoder arguments (after the input) for a format. Exposed for tests and documentation. */
export function codecArgs(target: EncodeTarget): string[] {
  const info = EXPORT_FORMATS[target.format];
  switch (target.format) {
    case 'prores-4444':
      return [...YUV_FILTER(info.pixFmt), '-c:v', 'prores_ks', '-profile:v', '4444', '-alpha_bits', '16', '-vendor', 'apl0', ...BT709, '-f', 'mov'];
    case 'prores-422hq':
      return [...YUV_FILTER(info.pixFmt), '-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', ...BT709, '-f', 'mov'];
    case 'qtrle':
      return ['-c:v', 'qtrle', '-pix_fmt', 'argb', '-f', 'mov'];
    case 'png-mov':
      return ['-c:v', 'png', '-pix_fmt', 'rgba', '-f', 'mov'];
    case 'vp9-webm':
      return [
        ...YUV_FILTER(info.pixFmt),
        '-c:v',
        'libvpx-vp9',
        '-b:v',
        '0',
        '-crf',
        target.preview ? '36' : '24',
        '-deadline',
        'good',
        '-cpu-used',
        target.preview ? '5' : '2',
        '-row-mt',
        '1',
        // Alt-ref frames are incompatible with alpha in libvpx.
        '-auto-alt-ref',
        '0',
        ...BT709,
        '-f',
        'webm',
      ];
    case 'h264-mp4': {
      const encoder = target.h264Encoder ?? 'libx264';
      const quality =
        encoder === 'libx264'
          ? ['-preset', target.preview ? 'veryfast' : 'slow', '-crf', target.preview ? '26' : '16']
          : ['-b:v', target.preview ? '4M' : '20M'];
      return [...YUV_FILTER(info.pixFmt), '-c:v', encoder, ...quality, ...BT709, '-movflags', '+faststart', '-f', 'mp4'];
    }
  }
}

/** Full argument list: raw RGBA frames on stdin → encoded file. */
export function encoderArgs(target: EncodeTarget, output: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${target.width}x${target.height}`,
    '-framerate',
    fpsString(target.fps),
    '-i',
    'pipe:0',
    '-an',
    ...codecArgs(target),
    output,
  ];
}

export interface EncodeOptions {
  signal?: AbortSignal;
  /** Called after each frame is handed to FFmpeg. */
  onFrame?: (written: number) => void;
}

/**
 * Pulls `frames` frames from `nextFrame` and pipes them to FFmpeg, one at a time with backpressure,
 * so memory stays at a few frames regardless of length. Aborting kills FFmpeg.
 */
export async function encodeFrames(
  ffmpeg: string,
  target: EncodeTarget,
  output: string,
  frames: number,
  nextFrame: (index: number) => Promise<Uint8Array>,
  options: EncodeOptions = {}
): Promise<void> {
  if (options.signal?.aborted) throw cancelled();
  const child = spawnTool(ffmpeg, encoderArgs(target, output));
  const stderr = tailCollector();
  child.stderr.on('data', (c: Buffer) => stderr.push(c));
  child.stdout.resume();
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on('error', (e) => reject(new RenderError('FFMPEG_NOT_FOUND', `Could not start FFmpeg (${ffmpeg}).`, { details: String(e) })));
    child.on('close', (code) => resolve(code));
  });
  // Writes after FFmpeg exits raise EPIPE; the exit code is what we report.
  child.stdin.on('error', () => undefined);
  let exited = false;
  closed.then(() => (exited = true), () => (exited = true));
  const onAbort = () => child.kill();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  const frameBytes = target.width * target.height * 4;
  try {
    for (let i = 0; i < frames; i++) {
      if (options.signal?.aborted) throw cancelled();
      const data = await nextFrame(i);
      if (data.byteLength !== frameBytes) {
        throw new RenderError('RENDER_FAILED', `Frame ${i} has ${data.byteLength} bytes; expected ${frameBytes}.`);
      }
      if (exited) break;
      const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      if (!child.stdin.write(buffer)) {
        await Promise.race([once(child.stdin, 'drain'), closed]);
      }
      options.onFrame?.(i + 1);
    }
    child.stdin.end();
    const code = await closed;
    if (options.signal?.aborted) throw cancelled();
    if (code !== 0) {
      throw new RenderError('ENCODE_FAILED', `FFmpeg failed to encode ${EXPORT_FORMATS[target.format].label} (exit code ${code}).`, { details: stderr.text() });
    }
  } catch (error) {
    // 'close' only fires once stdin is closed too, so destroy it before waiting.
    child.stdin.destroy();
    child.kill();
    await closed.catch(() => undefined);
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}
