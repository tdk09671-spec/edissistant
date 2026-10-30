import { cancelled, RenderError } from '../../shared/animation/errors';
import { fpsRational, fpsString, frameToSeconds, secondsToFrames } from '../../shared/animation/timeline';
import { runTool } from './process';

export interface CompositionClip {
  /** Rendered segment file. */
  path: string;
  /** Seconds on the timeline. */
  start: number;
  /** Seconds. */
  duration: number;
  /** Codec of the clip (VP9 needs the libvpx decoder to keep alpha). */
  codec: string;
}

export interface CompositionRequest {
  width: number;
  height: number;
  fps: number;
  /** Seconds. */
  duration: number;
  clips: CompositionClip[];
  /** Optional source footage (with audio) to lay graphics over; otherwise black. */
  baseVideo?: string;
  output: string;
  h264Encoder?: string;
}

const fpsValue = (fps: number) => {
  const r = fpsRational(fps);
  return r.num / r.den;
};

/** Start frame on the timeline, snapped to the sequence frame grid. */
export function clipStartSeconds(start: number, fps: number): number {
  return frameToSeconds(secondsToFrames(start, fps), fps);
}

/**
 * FFmpeg arguments that overlay every clip on the base at its exact start frame. Clips with alpha
 * composite over the base; full-frame clips cover it. Output is an H.264 preview.
 */
export function compositionArgs(req: CompositionRequest): string[] {
  const { width: w, height: h } = req;
  const rate = fpsString(req.fps);
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats'];
  if (req.baseVideo) args.push('-i', req.baseVideo);
  else args.push('-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:r=${rate}:d=${req.duration}`);
  for (const clip of req.clips) {
    if (clip.codec === 'vp9') args.push('-c:v', 'libvpx-vp9');
    // One decoder thread per clip: by default each input gets a frame thread per CPU core, which costs
    // ~0.45 GB per 1080p ProRes 4444 clip and grows with the number of segments.
    args.push('-threads', '1', '-i', clip.path);
  }

  const pad = req.baseVideo ? 'tpad=stop=-1:stop_mode=add:color=black,' : '';
  const filters: string[] = [`[0:v]${pad}fps=${rate},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuva444p[base0]`];
  // Every boundary sits half a frame before the frame it belongs to. Frame times at NTSC rates are
  // irrational in decimal (frame 484 at 29.97 is 16.14946…s), so an exact boundary written with 6
  // decimals can round past its own frame and start the graphic one frame late. Half a frame of
  // margin keeps each boundary on the right frame, and base frame n still picks clip frame n − start.
  const half = 0.5 / fpsValue(req.fps);
  req.clips.forEach((clip, i) => {
    const first = clipStartSeconds(clip.start, req.fps);
    const start = (first - half).toFixed(6);
    // The clip has frameCount(duration) frames, so it ends on a frame boundary too.
    const end = (first + frameToSeconds(Math.max(1, secondsToFrames(clip.duration, req.fps)), req.fps) - half).toFixed(6);
    filters.push(`[${i + 1}:v]scale=${w}:${h},format=yuva444p,setpts=PTS-STARTPTS+${start}/TB[clip${i}]`);
    filters.push(`[base${i}][clip${i}]overlay=eof_action=pass:enable='gte(t,${start})*lt(t,${end})'[base${i + 1}]`);
  });
  filters.push(`[base${req.clips.length}]format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709[out]`);

  args.push('-filter_complex', filters.join(';'), '-map', '[out]');
  if (req.baseVideo) args.push('-map', '0:a?', '-c:a', 'aac', '-b:a', '160k');
  const encoder = req.h264Encoder ?? 'libx264';
  args.push(
    '-c:v',
    encoder,
    ...(encoder === 'libx264' ? ['-preset', 'veryfast', '-crf', '24'] : ['-b:v', '6M']),
    '-r',
    rate,
    '-t',
    String(req.duration),
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-movflags',
    '+faststart',
    req.output
  );
  return args;
}

/** Composes the preview. Progress is reported 0–1 from FFmpeg's output time. */
export async function composePreview(ffmpeg: string, req: CompositionRequest, options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): Promise<void> {
  if (options.signal?.aborted) throw cancelled();
  const result = await runTool(ffmpeg, compositionArgs(req), {
    signal: options.signal,
    maxStdout: 1024 * 1024,
    onStdoutLine: (line) => {
      const m = /^out_time_us=(\d+)/.exec(line);
      if (m && req.duration > 0) options.onProgress?.(Math.min(1, Number(m[1]) / 1e6 / req.duration));
    },
  });
  if (result.code !== 0) throw new RenderError('COMPOSE_FAILED', `FFmpeg could not compose the preview (exit code ${result.code}).`, { details: result.stderrTail });
  options.onProgress?.(1);
}
