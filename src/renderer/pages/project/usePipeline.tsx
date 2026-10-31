import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { startTranscription, TranscriptionError } from '../../lib/transcription';
import { renderSequence } from '../../lib/render';
import { RenderError } from '../../../shared/animation/errors';
import { getSegments } from '../../lib/project';
import {
  actionForStatus,
  adoptSourceTiming,
  editorMessage,
  applyUpdates,
  exportProblems,
  changesNotRendered,
  fileTimecode,
  instructionPending,
  PipelineFailure,
  planningInput,
  timeline,
  transcriptRows,
  unwrap,
} from '../../lib/pipeline';
import type { EditorAction } from '../../../shared/planning/approval';
import { segmentFrames } from '../../../shared/animation/timeline';
import { visualModeInfo } from '../../lib/catalog';
import type { AppSettings, ExportRecord, MediaCheck, Preset, Project, RenderTarget, Segment, SegmentStatus } from '../../types';

export type JobKind = 'transcribe' | 'plan' | 'render' | 'export';


export interface PipelineJob {
  kind: JobKind;
  title: string;
  /** 0–1, or null while the engine hasn't reported progress yet. */
  progress: number | null;
  message: string;
  cancellable: boolean;
}

export interface PipelineError {
  title: string;
  message: string;
  code?: string;
}

export interface PipelineNotice {
  title: string;
  message: string;
  tone: 'success' | 'info' | 'warning';
}

export interface ExportOptions {
  target: RenderTarget;
  folder: string;
  fileName: string;
}

export interface Pipeline {
  job: PipelineJob | null;
  error: PipelineError | null;
  notice: PipelineNotice | null;
  dismiss: () => void;
  cancel: () => void;
  checkSource: () => Promise<boolean>;
  probeSource: (project?: Project) => Promise<void>;
  transcribe: () => Promise<void>;
  suggest: (options?: { allowReplan?: string[] }) => Promise<void>;
  act: (segmentId: string, action: EditorAction) => Promise<void>;
  setStatus: (segment: Segment, status: SegmentStatus) => Promise<void>;
  renderPreview: () => Promise<void>;
  exportOutput: (options: ExportOptions) => Promise<ExportRecord | null>;
}

const TITLES: Record<JobKind, string> = {
  transcribe: 'Transcribing',
  plan: 'Planning visuals',
  render: 'Rendering preview',
  export: 'Exporting',
};

function describe(error: unknown): PipelineError {
  if (error instanceof TranscriptionError || error instanceof RenderError || error instanceof PipelineFailure) {
    return { title: titleFor(error.code), message: editorMessage(error.code, error.message), code: error.code };
  }
  return { title: 'Something went wrong', message: error instanceof Error ? error.message : String(error) };
}

function titleFor(code: string): string {
  switch (code) {
    case 'FILE_NOT_FOUND':
    case 'MEDIA_NOT_FOUND':
      return 'Source media not found';
    case 'ENGINE_NOT_FOUND':
      return 'whisper.cpp is not installed';
    case 'MODEL_NOT_FOUND':
      return 'No transcription model installed';
    case 'FFMPEG_NOT_FOUND':
    case 'FFPROBE_NOT_FOUND':
      return 'FFmpeg not found';
    case 'FONT_NOT_FOUND':
      return 'A brand font is not installed';
    case 'NO_AUDIO_STREAM':
      return 'The source has no audio';
    case 'PRESET_NOT_FOUND':
      return 'Preset missing';
    default:
      return 'The job failed';
  }
}

const isCancel = (error: unknown) => (error as { code?: string })?.code === 'CANCELLED';

/**
 * The editor's pipeline for one project: transcribe → plan → approve → render → export. Results are
 * applied through `update`, so they are saved and undoable like any other edit. One job at a time;
 * leaving the project cancels a running job.
 */
export function usePipeline(
  projectRef: React.RefObject<Project | null>,
  update: (fn: (p: Project) => Project) => void,
  presets: Preset[],
  settings: AppSettings
): Pipeline {
  const api = window.electronAPI;
  const [job, setJob] = useState<PipelineJob | null>(null);
  const [error, setError] = useState<PipelineError | null>(null);
  const [notice, setNotice] = useState<PipelineNotice | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const busy = useRef(false);
  const presetsRef = useRef(presets);
  presetsRef.current = presets;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => () => cancelRef.current?.(), []);

  const project = () => {
    const p = projectRef.current;
    if (!p) throw new PipelineFailure('INVALID_REQUEST', 'No project is open.');
    return p;
  };

  /** Runs one job with shared busy/progress/error handling. */
  const run = useCallback(async <T,>(kind: JobKind, work: (progress: (p: number | null, message: string) => void, onCancel: (fn: () => void) => void) => Promise<T>): Promise<T | null> => {
    if (busy.current) {
      setNotice({ title: 'Another job is running', message: 'Wait for it to finish or cancel it first.', tone: 'info' });
      return null;
    }
    busy.current = true;
    setError(null);
    setNotice(null);
    setJob({ kind, title: TITLES[kind], progress: null, message: 'Starting…', cancellable: false });
    try {
      return await work(
        (progress, message) => setJob((j) => (j ? { ...j, progress, message } : j)),
        (fn) => {
          cancelRef.current = fn;
          setJob((j) => (j ? { ...j, cancellable: true } : j));
        }
      );
    } catch (e) {
      if (isCancel(e)) setNotice({ title: `${TITLES[kind]} cancelled`, message: 'Nothing was changed.', tone: 'info' });
      else setError(describe(e));
      return null;
    } finally {
      busy.current = false;
      cancelRef.current = null;
      setJob(null);
    }
  }, []);

  const checkSource = useCallback(async () => {
    const p = projectRef.current;
    if (!p?.source || !api) return false;
    return api.fileExists(p.source.path);
  }, [api, projectRef]);

  const requireSource = async (): Promise<string> => {
    const p = project();
    if (!p.source) throw new PipelineFailure('MEDIA_NOT_FOUND', 'Choose the source video first.');
    if (!(await api!.fileExists(p.source.path))) {
      throw new PipelineFailure('MEDIA_NOT_FOUND', `The source video was moved or deleted: ${p.source.path}. Relink it in the Source tab.`);
    }
    return p.source.path;
  };

  const probeSource = useCallback(
    async (target?: Project) => {
      const p = target ?? projectRef.current;
      if (!api || !p?.source) return;
      const result = await api.probeSource(p.source.path);
      if (!result.ok) {
        setError(describe(new PipelineFailure(result.error.code, result.error.message)));
        return;
      }
      const info = result.result;
      update((current) => (current.source?.path === info.path ? adoptSourceTiming(current, info, settingsRef.current) : current));
      if (!info.fps) setNotice({ title: 'Unusual frame rate', message: `The source runs at ${info.frameRate} fps. The timeline will use the project frame rate and convert the footage.`, tone: 'info' });
      else if (!info.hasAudio) setNotice({ title: 'The source has no audio', message: 'Transcription needs speech. You can still import captions.', tone: 'info' });
    },
    [api, projectRef, update]
  );

  const transcribe = useCallback(async () => {
    await run('transcribe', async (progress, onCancel) => {
      const mediaPath = await requireSource();
      const transcription = startTranscription(mediaPath, {}, (p) => progress(p.progress, p.message));
      onCancel(() => void transcription.cancel());
      const { transcript, fromCache } = await transcription.result;
      const rows = transcriptRows(transcript);
      if (!rows.length) throw new PipelineFailure('EMPTY_TRANSCRIPT', 'No speech was found in the source.');
      update((p) => ({
        ...p,
        segments: rows,
        render: null,
        transcription: {
          transcriptId: transcript.id,
          language: transcript.language,
          model: transcript.engine.model,
          wordTiming: transcript.wordTiming,
          createdAt: transcript.createdAt,
          warnings: transcript.warnings,
        },
        source: p.source && transcript.duration ? { ...p.source, duration: p.source.duration ?? transcript.duration } : p.source,
      }));
      const timing = transcript.warnings.find((w) => /couldn't be checked|DTW alignment off/.test(w));
      setNotice({
        title: `Transcribed ${rows.length} segments`,
        message: `${fromCache ? 'Reused the saved transcript of this file (no re-transcription).' : `Language: ${transcript.language} · model ${transcript.engine.model}`}${timing ? ` ${timing}` : ''}`,
        tone: timing ? 'info' : 'success',
      });
    });
  }, [run, update]);

  const suggest = useCallback(
    async (options: { allowReplan?: string[] } = {}) => {
      await run('plan', async (progress) => {
        progress(null, 'Planning locally (deterministic)…');
        const p = project();
        if (!getSegments(p).some((s) => s.transcript.trim())) throw new PipelineFailure('NO_TRANSCRIPT', 'Transcribe the source or add transcript text first.');
        const outcome = unwrap(await api!.planProject({ ...planningInput(p, presetsRef.current), ...options, useModel: false }));
        update((current) => ({
          ...applyUpdates(current, outcome.updates),
          planning: { variety: current.planning?.variety ?? 'balanced', plannedAt: new Date().toISOString(), findings: outcome.findings.map((f) => f.message) },
        }));
        const flagged = outcome.flagged.length ? ` · ${outcome.flagged.length} approved segment(s) changed and need review` : '';
        setNotice({ title: `Planned ${outcome.planned.length} segment(s)`, message: `Kept ${outcome.kept.length} unchanged or decided${flagged}.`, tone: 'success' });
      });
    },
    [run, update]
  );

  const act = useCallback(
    async (segmentId: string, action: EditorAction) => {
      await run('plan', async (progress) => {
        progress(null, 'Updating the plan…');
        const before = getSegments(project()).find((s) => s.id === segmentId)?.plan;
        const outcome = unwrap(await api!.planAction({ ...planningInput(project(), presetsRef.current), segmentId, action }));
        update((current) => applyUpdates(current, outcome.updates));
        const after = outcome.updates.find((u) => u.id === segmentId)?.plan;
        if (outcome.instruction) {
          const { status, message } = outcome.instruction;
          const title = status === 'applied' ? 'Instruction applied' : status === 'kept' ? 'Graphic kept' : status === 'partial' ? 'Instruction partly applied' : 'Instruction not applied';
          setNotice({ title, message, tone: status === 'applied' || status === 'kept' ? 'success' : 'warning' });
        } else if (outcome.deferred) setNotice({ title: 'New suggestion', message: outcome.deferred, tone: 'info' });
        else if (action.type === 'edit' && before && after) {
          // A concept and a visual mode that don't fit are aligned automatically; say so on screen.
          const modeLabel = (m: string) => visualModeInfo(m as Parameters<typeof visualModeInfo>[0])?.label ?? m;
          if (action.overrides.conceptId && before.mode !== after.mode) {
            setNotice({ title: 'Visual mode switched', message: `${after.conceptLabel} needs ${modeLabel(after.mode)}, so the visual mode changed from ${modeLabel(before.mode)} to ${modeLabel(after.mode)}.`, tone: 'info' });
          } else if (action.overrides.visualMode && before.conceptId !== after.conceptId) {
            setNotice({ title: 'Concept switched', message: `${before.conceptLabel} can’t be shown as ${modeLabel(after.mode)}, so the concept changed to ${after.conceptLabel}.`, tone: 'info' });
          }
        }
      });
    },
    [run, update]
  );

  const setStatus = useCallback(
    async (segment: Segment, status: SegmentStatus) => {
      if (!segment.plan) {
        update((p) => ({ ...p, segments: (p.segments ?? []).map((s) => (s.id === segment.id ? { ...s, status } : s)) }));
        return;
      }
      const action = actionForStatus(segment.plan, status, { instructionPending: instructionPending(segment, segment.plan) });
      if (action) await act(segment.id, action);
    },
    [act, update]
  );

  /** Builds the deliverable's sequence; applies the plan sync to the rows. */
  const build = async (target: RenderTarget) => {
    const p = project();
    const t = timeline(p, settingsRef.current);
    const response = unwrap(
      await api!.buildSequence({ ...planningInput(p, presetsRef.current), target, ...t, allowFontFallback: p.exportSettings?.allowFontFallback === true })
    );
    update((current) => applyUpdates(current, response.updates));
    return { ...response, timeline: t };
  };

  const renderPreview = useCallback(async () => {
    await run('render', async (progress, onCancel) => {
      const sourcePath = await requireSource();
      progress(null, 'Building the animation specs…');
      const built = await build('composite');
      if (!built.sequence.segments.length) {
        throw new PipelineFailure('NOTHING_TO_RENDER', 'No approved graphics to render. Approve suggestions (or pick a graphic concept) first.');
      }
      const job = renderSequence(built.sequence, { quality: 'preview', baseVideo: sourcePath }, (p) => progress(p.progress, p.message));
      onCancel(() => void job.cancel());
      const result = await job.result;
      if (!result.preview) throw new PipelineFailure('COMPOSE_FAILED', 'The renderer returned no preview.');
      const toRow = (specId: string) => built.specIds[specId] ?? specId;
      update((current) => ({
        ...current,
        render: {
          previewPath: result.preview!.path,
          sourcePath,
          quality: 'preview',
          width: result.preview!.metadata.width,
          height: result.preview!.metadata.height,
          fps: built.timeline.fps,
          duration: built.sequence.duration,
          renderedAt: new Date().toISOString(),
          rendered: result.rendered.map(toRow),
          reused: result.reused.map(toRow),
          segments: built.results,
        },
      }));
      const counts = `Rendered ${result.rendered.length} graphic(s), reused ${result.reused.length} unchanged from the cache.`;
      const left = changesNotRendered(applyUpdates(project(), built.updates));
      setNotice(
        left
          ? { title: 'Preview updated, but not every change is in it', message: `${counts} ${left}`, tone: 'warning' }
          : { title: 'Preview ready', message: counts, tone: 'success' }
      );
    });
  }, [run, update]);

  const exportOutput = useCallback(
    async ({ target, folder, fileName }: ExportOptions): Promise<ExportRecord | null> =>
      run('export', async (progress, onCancel) => {
        if (!folder) throw new PipelineFailure('INVALID_REQUEST', 'Choose an output folder first.');
        if (!(await api!.fileExists(folder))) throw new PipelineFailure('INVALID_REQUEST', `The output folder doesn't exist: ${folder}`);
        const sourcePath = await requireSource();
        progress(null, 'Building the animation specs…');
        const built = await build(target);
        if (!built.sequence.segments.length) {
          throw new PipelineFailure('NOTHING_TO_RENDER', target === 'captions' ? 'No segment has transcript text for captions.' : 'No approved graphics to export.');
        }
        const composite = target === 'composite';
        const job = renderSequence(
          built.sequence,
          composite ? { quality: 'final', baseVideo: sourcePath } : { quality: 'final', format: 'prores-4444', compose: false },
          (p) => progress(p.progress, p.message)
        );
        onCancel(() => void job.cancel());
        const result = await job.result;
        const sourceInfo = composite ? unwrap(await api!.probeSource(sourcePath)) : null;
        const t = built.timeline;
        const outputs: Array<{ path: string; name: string; expect: Parameters<typeof exportProblems>[1] }> = composite
          ? [{ path: result.preview!.path, name: fileName, expect: { width: t.width, height: t.height, fps: t.fps, duration: built.sequence.duration, alpha: false, audio: Boolean(sourceInfo?.hasAudio) } }]
          : result.segments.map((s, i) => {
              const spec = built.sequence.segments[i];
              return {
                path: s.path,
                name: `${fileName}_${String(i + 1).padStart(2, '0')}_${fileTimecode(spec.start, t.fps)}${target === 'captions' ? '_captions' : ''}`,
                // Exactly the frames the graphic covers on the timeline, so the NLE out-point is right.
                expect: { width: t.width, height: t.height, fps: t.fps, duration: spec.duration, frames: segmentFrames(spec.start, spec.duration, t.fps).count, alpha: true, audio: false },
              };
            });
        progress(0.99, 'Copying and checking the exported files…');
        const files: MediaCheck[] = [];
        for (const out of outputs) {
          const copied = await api!.exportRender(out.path, folder, out.name);
          if (!copied.ok) throw new RenderError(copied.error.code, copied.error.message);
          const check = unwrap(await api!.checkMedia(copied.result));
          const problems = exportProblems(check, out.expect);
          if (problems.length) throw new PipelineFailure('EXPORT_INVALID', `${check.path}: ${problems.join(' ')}`);
          files.push(check);
        }
        const record: ExportRecord = { id: uuid(), target, createdAt: new Date().toISOString(), folder, files };
        update((current) => ({ ...current, exports: [record, ...(current.exports ?? [])].slice(0, 20) }));
        const left = target === 'captions' ? null : changesNotRendered(applyUpdates(project(), built.updates));
        setNotice(
          left
            ? { title: 'Export complete, but not every change is in it', message: `${files.length} file(s) written and checked in ${folder}. ${left}`, tone: 'warning' }
            : { title: 'Export complete', message: `${files.length} file(s) written and checked in ${folder}.`, tone: 'success' }
        );
        return record;
      }),
    [run, update]
  );

  return {
    job,
    error,
    notice,
    dismiss: () => {
      setError(null);
      setNotice(null);
    },
    cancel: () => cancelRef.current?.(),
    checkSource,
    probeSource,
    transcribe,
    suggest,
    act,
    setStatus,
    renderPreview,
    exportOutput,
  };
}
