import { v4 as uuid } from 'uuid';
import type { AppSettings, ExportSettings, Project, Segment } from '../types';

export function getSegments(project: Project): Segment[] {
  return [...(project.segments ?? [])].sort((a, b) => a.start - b.start);
}

export function createSegment(start: number, end: number, partial: Partial<Segment> = {}): Segment {
  return {
    id: uuid(),
    start: Math.max(0, start),
    end: Math.max(start, end),
    transcript: '',
    visualMode: 'speaker',
    instruction: '',
    aiSuggestion: '',
    status: 'pending',
    ...partial,
  };
}

export function segmentAt(segments: Segment[], time: number): Segment | undefined {
  return segments.find((s) => time >= s.start && time < s.end);
}

export function defaultExportSettings(project: Project, settings: AppSettings): ExportSettings {
  return {
    format: 'full-motion',
    resolution: settings.defaultResolution,
    frameRate: settings.defaultFrameRate,
    destination: settings.outputDirectory,
    fileName: project.name.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Untitled',
    ...(project.exportSettings ?? {}),
  };
}

export function projectFps(project: Project, settings: AppSettings): number {
  return parseFloat(project.exportSettings?.frameRate ?? settings.defaultFrameRate) || 25;
}

/** URL for streaming a local file through the main-process media protocol. */
export function mediaUrl(filePath: string): string {
  return `edissistant-media://local/${encodeURIComponent(filePath.replace(/\\/g, '/'))}`;
}

export function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

export const isElectron = typeof window !== 'undefined' && Boolean(window.electronAPI);
