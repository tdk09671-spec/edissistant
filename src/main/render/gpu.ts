// Optional hardware H.264 encoding. An encoder is only used after a real test encode succeeds on
// this machine; otherwise rendering stays on libx264 (CPU). ProRes, Animation, PNG and VP9 always
// encode on the CPU.

import { runTool } from './process';
import { listEncoders } from './tools';

export type GpuPreference = 'auto' | 'off';

export function hardwareCandidates(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return ['h264_nvenc', 'h264_qsv', 'h264_amf'];
  if (platform === 'darwin') return ['h264_videotoolbox'];
  return ['h264_nvenc', 'h264_qsv'];
}

/** Encodes a few synthetic frames with `encoder`; true only if FFmpeg succeeds. */
export async function probeEncoder(ffmpeg: string, encoder: string): Promise<boolean> {
  try {
    const { code } = await runTool(ffmpeg, [
      '-hide_banner',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=gray:s=256x256:r=25:d=0.2',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      encoder,
      '-f',
      'null',
      '-',
    ]);
    return code === 0;
  } catch {
    return false;
  }
}

const chosen = new Map<string, Promise<string>>();

/** The H.264 encoder to use: the first validated hardware encoder, else libx264. Cached per FFmpeg path. */
export function selectH264Encoder(ffmpeg: string, preference: GpuPreference, platform: NodeJS.Platform = process.platform): Promise<string> {
  if (preference === 'off') return Promise.resolve('libx264');
  const cacheKey = `${ffmpeg}|${platform}`;
  let result = chosen.get(cacheKey);
  if (!result) {
    result = (async () => {
      const available = await listEncoders(ffmpeg).catch(() => new Set<string>());
      for (const encoder of hardwareCandidates(platform)) {
        if (available.has(encoder) && (await probeEncoder(ffmpeg, encoder))) return encoder;
      }
      return 'libx264';
    })();
    chosen.set(cacheKey, result);
  }
  return result;
}
