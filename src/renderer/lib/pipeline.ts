// Renderer side of the end-to-end pipeline: builds the requests the main process expects from the
// project, applies plan results to sequence rows, and checks exported files. Transcription and
// rendering jobs use lib/transcription and lib/render (PR #1 / PR #2 bridges).

import { secondsToFrames } from '../../shared/animation/timeline';
import { roundTime } from '../../shared/transcription';
import { parseResolution } from '../../shared/pipeline/convert';
import type { PresetLike } from '../../shared/planning/styleProfile';
import type { MediaCheck, PipelineResult, ProjectPlanningInput, SegmentUpdate, SourceInfo } from '../../shared/pipeline/types';
import type { Transcript } from '../../shared/transcription';
import type { AppSettings, Preset, Project, Segment } from '../types';
import { builtInPresets } from './catalog';
import { createSegment, defaultExportSettings, getSegments, projectFps } from './project';

export { actionForStatus, parseResolution } from '../../shared/pipeline/convert';

export class PipelineFailure extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/** Unwraps an IPC result, throwing a PipelineFailure with the engine's code and message. */
export function unwrap<T>(result: PipelineResult<T>): T {
  if (!result.ok) throw new PipelineFailure(result.error.code, result.error.message);
  return result.result;
}

export function findPreset(project: Project, presets: Preset[]): Preset | undefined {
  return presets.find((p) => p.id === project.presetId) ?? builtInPresets.find((p) => p.id === project.presetId);
}

export function presetLike(preset: Preset): PresetLike {
  return {
    id: preset.id,
    name: preset.name,
    clientName: preset.clientName,
    creativeBrief: preset.creativeBrief,
    fonts: preset.fonts,
    tracking: preset.tracking,
    logoPath: preset.logoPath,
    brandingNotes: preset.brandingNotes,
    ...(preset.brandColors?.length ? { brandColors: preset.brandColors } : {}),
  };
}

/** What the planner needs from a project. Throws when the project's preset is gone. */
export function planningInput(project: Project, presets: Preset[]): ProjectPlanningInput {
  const preset = findPreset(project, presets);
  if (!preset) throw new PipelineFailure('PRESET_NOT_FOUND', `The preset “${project.presetName}” is no longer in your library. Choose another preset for this project.`);
  return {
    projectId: project.id,
    preset: presetLike(preset),
    notes: project.creativeNotes ?? '',
    variety: project.planning?.variety ?? 'balanced',
    segments: getSegments(project).map((s) => ({ id: s.id, start: s.start, end: s.end, transcript: s.transcript, instruction: s.instruction, ...(s.words ? { words: s.words } : {}) })),
  };
}

/** Writes plan results onto the rows. Transcript, timing and instructions are never changed. */
export function applyUpdates(project: Project, updates: SegmentUpdate[]): Project {
  const byId = new Map(updates.map((u) => [u.id, u]));
  return {
    ...project,
    segments: (project.segments ?? []).map((s): Segment => {
      const u = byId.get(s.id);
      if (!u) {
        if (!s.plan) return s;
        // No longer planned (e.g. the transcript was cleared): drop the stale plan.
        const { plan: _drop, ...rest } = s;
        return { ...rest, aiSuggestion: '' };
      }
      return { ...s, aiSuggestion: u.aiSuggestion, status: u.status, plan: u.plan, ...(u.visualMode ? { visualMode: u.visualMode } : {}) };
    }),
  };
}

/** One row per transcript sentence, with word timing for captions. */
export function transcriptRows(transcript: Transcript): Segment[] {
  return transcript.sentences
    .filter((s) => s.text.trim())
    .map((s) =>
      createSegment(roundTime(s.start), roundTime(Math.max(s.start, s.end)), {
        transcript: s.text.trim(),
        words: s.words.map((w) => ({ text: w.text.trim(), start: w.start, end: w.end })).filter((w) => w.text),
      })
    );
}

/** The timeline a render uses: export resolution and frame rate, source duration. */
export function timeline(project: Project, settings: AppSettings): { width: number; height: number; fps: number; duration: number } {
  const exportSettings = defaultExportSettings(project, settings);
  const size = parseResolution(exportSettings.resolution) ?? { width: 1920, height: 1080 };
  const last = Math.max(0, ...getSegments(project).map((s) => s.end));
  return { ...size, fps: projectFps(project, settings), duration: Math.max(project.source?.duration ?? 0, last) };
}

/** After probing the source: adopt its frame rate (and resolution) unless the editor already set them. */
export function adoptSourceTiming(project: Project, info: SourceInfo, settings: AppSettings): Project {
  const source = project.source ? { ...project.source, duration: info.duration } : project.source;
  if (project.exportSettings?.frameRate || !info.fps) return { ...project, source };
  const exportSettings = defaultExportSettings(project, settings);
  const resolution = `${info.width}x${info.height}`;
  const known = ['1920x1080', '3840x2160', '1080x1920', '1080x1350', '1080x1080'].includes(resolution);
  return { ...project, source, exportSettings: { ...exportSettings, frameRate: String(info.fps), ...(known ? { resolution } : {}) } };
}

/** File-name-safe timecode, e.g. 00-00-03-12. */
export function fileTimecode(seconds: number, fps: number): string {
  const rate = Math.round(fps);
  const frame = secondsToFrames(seconds, fps);
  const total = Math.floor(frame / rate);
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60, frame % rate].map((n) => String(n).padStart(2, '0')).join('-');
}

export interface ExportExpectation {
  width: number;
  height: number;
  fps: number;
  /** Seconds. */
  duration: number;
  alpha: boolean;
  audio: boolean;
}

/** Problems with an exported file, compared with what was asked for. Empty means it checks out. */
export function exportProblems(check: MediaCheck, expected: ExportExpectation): string[] {
  const problems: string[] = [];
  const v = check.video;
  if (!v) return ['The file has no video stream.'];
  if (v.width !== expected.width || v.height !== expected.height) problems.push(`Size is ${v.width}×${v.height}, expected ${expected.width}×${expected.height}.`);
  const frames = secondsToFrames(expected.duration, expected.fps);
  if (Math.abs(v.frames - frames) > 1) problems.push(`Has ${v.frames} frames, expected ${frames}.`);
  if (expected.alpha && !v.hasAlpha) problems.push('Has no alpha channel.');
  if (expected.audio && !check.audio) problems.push('Has no audio, but the source does.');
  if (check.sizeBytes <= 0) problems.push('The file is empty.');
  return problems;
}
