import type { ExportFormatId, ExportMode } from './types';

export interface ExportFormatInfo {
  id: ExportFormatId;
  label: string;
  extension: '.mov' | '.webm' | '.mp4';
  /** True when the file carries a real alpha channel. */
  alpha: boolean;
  /** codec_name FFprobe reports for the file. */
  codec: string;
  /** Pixel format the encoder writes. */
  pixFmt: string;
  lossless: boolean;
  notes: string;
}

export const EXPORT_FORMATS: Record<ExportFormatId, ExportFormatInfo> = {
  'prores-4444': {
    id: 'prores-4444',
    label: 'ProRes 4444 + alpha (.mov)',
    extension: '.mov',
    alpha: true,
    codec: 'prores',
    pixFmt: 'yuva444p10le',
    lossless: false,
    notes: 'Industry standard for transparent graphics: Premiere Pro, After Effects, Resolve, Final Cut Pro. Alpha is stored losslessly (16-bit).',
  },
  'prores-422hq': {
    id: 'prores-422hq',
    label: 'ProRes 422 HQ (.mov)',
    extension: '.mov',
    alpha: false,
    codec: 'prores',
    pixFmt: 'yuv422p10le',
    lossless: false,
    notes: 'High-quality full-frame graphics without alpha.',
  },
  qtrle: {
    id: 'qtrle',
    label: 'QuickTime Animation + alpha (.mov)',
    extension: '.mov',
    alpha: true,
    codec: 'qtrle',
    pixFmt: 'argb',
    lossless: true,
    notes: 'Lossless RGB + alpha. Very large files; widely supported by older NLE versions.',
  },
  'png-mov': {
    id: 'png-mov',
    label: 'PNG in QuickTime + alpha (.mov)',
    extension: '.mov',
    alpha: true,
    codec: 'png',
    pixFmt: 'rgba',
    lossless: true,
    notes: 'Lossless RGBA, smaller than Animation for flat graphics; slower to decode.',
  },
  'vp9-webm': {
    id: 'vp9-webm',
    label: 'VP9 WebM + alpha (.webm)',
    extension: '.webm',
    alpha: true,
    codec: 'vp9',
    pixFmt: 'yuva420p',
    lossless: false,
    notes: 'Web/browser playback with alpha. Not a common NLE intermediate. Decoders must use libvpx to see the alpha.',
  },
  'h264-mp4': {
    id: 'h264-mp4',
    label: 'H.264 (.mp4)',
    extension: '.mp4',
    alpha: false,
    codec: 'h264',
    pixFmt: 'yuv420p',
    lossless: false,
    notes: 'Small and fast. Used for previews and full-motion deliverables without alpha.',
  },
};

export type RenderQuality = 'final' | 'preview';

/** Default container/codec for a mode. Transparent modes always get a real alpha format. */
export function defaultFormat(mode: ExportMode, quality: RenderQuality = 'final'): ExportFormatId {
  if (mode === 'full-motion') return quality === 'preview' ? 'h264-mp4' : 'prores-422hq';
  return 'prores-4444';
}

export function formatAllowedForMode(format: ExportFormatId, mode: ExportMode): boolean {
  return mode === 'full-motion' || EXPORT_FORMATS[format].alpha;
}
