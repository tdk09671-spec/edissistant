import type { IpcMain } from 'electron';
import { CONCEPT_IDS } from '../../shared/planning/concepts';
import { isSupportedFps } from '../../shared/animation/timeline';
import type { EditorAction } from '../../shared/planning/approval';
import type { ActRequest, BuildRequest, PipelineResult, PipelineSegment, PlanReferences, PlanRequest, ProjectPlanningInput, RenderTarget } from '../../shared/pipeline/types';
import { AiError, type AiService } from './ai';
import { checkMedia, MediaError, probeSource } from './media';
import { PipelineError, type PipelineService } from './service';

// Everything arriving here comes from the app's own renderer, but it is still checked: types, sizes
// and ranges, so a bad request fails with a clear message instead of reaching the engines.

class Invalid extends Error {}

const ID = /^[A-Za-z0-9_.-]{1,128}$/;
const HEX = /^#[0-9a-fA-F]{3,8}$/;
const MODES = ['speaker', 'b-roll', 'motion-graphics', 'background-graphics', 'captions'];
const TARGETS: RenderTarget[] = ['composite', 'alpha', 'captions'];

type Obj = Record<string, unknown>;
const obj = (v: unknown, what: string): Obj => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Invalid(`${what} must be an object.`);
  return v as Obj;
};
const str = (v: unknown, what: string, max: number, optional = false): string => {
  if (v === undefined && optional) return '';
  if (typeof v !== 'string' || v.length > max) throw new Invalid(`${what} must be text (at most ${max} characters).`);
  return v;
};
const num = (v: unknown, what: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Invalid(`${what} must be a number from ${min} to ${max}.`);
  return v;
};

function segments(v: unknown): PipelineSegment[] {
  if (!Array.isArray(v) || v.length > 5000) throw new Invalid('segments must be a list (at most 5000).');
  return v.map((raw, i) => {
    const s = obj(raw, `segments[${i}]`);
    const start = num(s.start, `segments[${i}].start`, 0, 86_400);
    const end = num(s.end, `segments[${i}].end`, 0, 86_400);
    if (end < start) throw new Invalid(`segments[${i}] ends before it starts.`);
    const words = s.words === undefined ? undefined : Array.isArray(s.words) && s.words.length <= 2000 ? s.words : null;
    if (words === null) throw new Invalid(`segments[${i}].words must be a list.`);
    // The editor's on-screen in/out (snapped and checked against the timeline when the sequence is built).
    let visualTiming: { start: number; end: number } | undefined;
    if (s.visualTiming !== undefined) {
      const t = obj(s.visualTiming, `segments[${i}].visualTiming`);
      visualTiming = { start: num(t.start, `segments[${i}].visualTiming.start`, 0, 86_400), end: num(t.end, `segments[${i}].visualTiming.end`, 0, 86_400) };
      if (visualTiming.end <= visualTiming.start) throw new Invalid(`segments[${i}].visualTiming must end after it starts.`);
    }
    return {
      id: str(s.id, `segments[${i}].id`, 128),
      start,
      end,
      transcript: str(s.transcript, `segments[${i}].transcript`, 10_000),
      instruction: str(s.instruction, `segments[${i}].instruction`, 4_000, true),
      ...(words
        ? {
            words: words.map((w, j) => {
              const o = obj(w, `segments[${i}].words[${j}]`);
              return { text: str(o.text, 'word', 200), start: num(o.start, 'word start', 0, 86_400), end: num(o.end, 'word end', 0, 86_400) };
            }),
          }
        : {}),
      ...(visualTiming ? { visualTiming } : {}),
    };
  });
}

function planningInput(v: unknown): ProjectPlanningInput {
  const r = obj(v, 'request');
  const p = obj(r.preset, 'preset');
  const colors = p.brandColors === undefined ? undefined : p.brandColors;
  if (colors !== undefined && (!Array.isArray(colors) || colors.length > 24 || !colors.every((c) => typeof c === 'string' && HEX.test(c)))) {
    throw new Invalid('preset.brandColors must be a list of hex colours.');
  }
  const projectId = str(r.projectId, 'projectId', 128);
  const presetId = str(p.id, 'preset.id', 128);
  if (!ID.test(projectId) || !ID.test(presetId)) throw new Invalid('Project and preset ids may only contain letters, digits, ".", "_" and "-".');
  const variety = r.variety === undefined ? undefined : r.variety;
  if (variety !== undefined && !['low', 'balanced', 'experimental'].includes(variety as string)) throw new Invalid('variety must be low, balanced or experimental.');
  return {
    projectId,
    preset: {
      id: presetId,
      name: str(p.name, 'preset.name', 200),
      clientName: str(p.clientName, 'preset.clientName', 200, true),
      creativeBrief: str(p.creativeBrief, 'preset.creativeBrief', 10_000, true),
      fonts: str(p.fonts, 'preset.fonts', 500, true),
      tracking: str(p.tracking, 'preset.tracking', 100, true),
      logoPath: str(p.logoPath, 'preset.logoPath', 1_000, true),
      brandingNotes: str(p.brandingNotes, 'preset.brandingNotes', 10_000, true),
      ...(colors ? { brandColors: colors as string[] } : {}),
    },
    notes: str(r.notes, 'notes', 10_000, true),
    segments: segments(r.segments),
    ...(variety ? { variety: variety as ProjectPlanningInput['variety'] } : {}),
  };
}

function planRequest(v: unknown): PlanRequest {
  const r = obj(v, 'request');
  const allowReplan = r.allowReplan === undefined ? undefined : r.allowReplan;
  if (allowReplan !== undefined && (!Array.isArray(allowReplan) || !allowReplan.every((x) => typeof x === 'string'))) throw new Invalid('allowReplan must be a list of segment ids.');
  if (r.useModel !== undefined && typeof r.useModel !== 'boolean') throw new Invalid('useModel must be true or false.');
  const jobId = r.jobId === undefined ? undefined : str(r.jobId, 'jobId', 128);
  if (jobId !== undefined && !ID.test(jobId)) throw new Invalid('jobId may only contain letters, digits, ".", "_" and "-".');
  return {
    ...planningInput(v),
    ...(allowReplan ? { allowReplan: allowReplan as string[] } : {}),
    useModel: r.useModel === true,
    ...(r.references !== undefined ? { references: references(r.references) } : {}),
    ...(jobId ? { jobId } : {}),
  };
}

function references(v: unknown): PlanReferences {
  const r = obj(v, 'references');
  const list = (x: unknown, what: string, max: number, chars: number): string[] => {
    if (x === undefined) return [];
    if (!Array.isArray(x) || x.length > max) throw new Invalid(`${what} must be a list (at most ${max}).`);
    return x.map((s, i) => str(s, `${what}[${i}]`, chars));
  };
  return { notes: list(r.notes, 'references.notes', 50, 4_000), imagePaths: list(r.imagePaths, 'references.imagePaths', 10, 4_096) };
}

function action(v: unknown): EditorAction {
  const a = obj(v, 'action');
  if (JSON.stringify(a).length > 8_000) throw new Invalid('action is too large.');
  const reason = a.reason === undefined ? undefined : str(a.reason, 'action.reason', 500);
  switch (a.type) {
    case 'approve':
    case 'acknowledge-change':
      return { type: a.type };
    case 'reject':
    case 'request-regeneration':
      return { type: a.type, ...(reason ? { reason } : {}) };
    case 'edit': {
      const o = obj(a.overrides ?? {}, 'action.overrides');
      if (o.conceptId !== undefined && !CONCEPT_IDS.includes(o.conceptId as string)) throw new Invalid(`Unknown concept "${String(o.conceptId)}".`);
      if (o.visualMode !== undefined && !MODES.includes(o.visualMode as string)) throw new Invalid(`Unknown visual mode "${String(o.visualMode)}".`);
      const params = o.params === undefined ? undefined : obj(o.params, 'action.overrides.params');
      return { type: 'edit', overrides: { ...(o.conceptId ? { conceptId: o.conceptId as string } : {}), ...(o.visualMode ? { visualMode: o.visualMode as never } : {}), ...(params ? { params } : {}) }, ...(reason ? { reason } : {}) };
    }
    default:
      throw new Invalid(`Unknown action "${String(a.type)}".`);
  }
}

function buildRequest(v: unknown): BuildRequest {
  const r = obj(v, 'request');
  if (!TARGETS.includes(r.target as RenderTarget)) throw new Invalid('target must be composite, alpha or captions.');
  const width = num(r.width, 'width', 16, 7680);
  const height = num(r.height, 'height', 16, 7680);
  if (width % 2 || height % 2) throw new Invalid('width and height must be even.');
  const fps = num(r.fps, 'fps', 1, 120);
  if (!isSupportedFps(fps)) throw new Invalid('fps must be a whole number or an NTSC rate (23.976, 29.97, 59.94).');
  return {
    ...planningInput(v),
    target: r.target as RenderTarget,
    width,
    height,
    fps,
    duration: num(r.duration, 'duration', 0, 86_400),
    allowFontFallback: r.allowFontFallback === true,
  };
}

/** The request validators, exported for tests. */
export const validators = { segments, planningInput, buildRequest, planRequest };

function failure(error: unknown): PipelineResult<never> {
  if (error instanceof Invalid) return { ok: false, error: { code: 'INVALID_REQUEST', message: error.message } };
  if (error instanceof MediaError || error instanceof PipelineError || error instanceof AiError) return { ok: false, error: { code: error.code, message: error.message } };
  const code = (error as { code?: unknown })?.code;
  return { ok: false, error: { code: typeof code === 'string' ? code : 'PLANNING_FAILED', message: error instanceof Error ? error.message : String(error) } };
}

async function wrap<T>(run: () => Promise<T> | T): Promise<PipelineResult<T>> {
  try {
    return { ok: true, result: await run() };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Channels (results are { ok, result } | { ok: false, error: { code, message } }):
 *  - pipeline:probeSource (path)       → SourceInfo
 *  - pipeline:plan (PlanRequest)        → PlanOutcome
 *  - pipeline:act (ActRequest)          → PlanOutcome
 *  - pipeline:build (BuildRequest)      → BuildOutcome (+ updates)
 *  - pipeline:checkMedia (path)         → MediaCheck
 *  - pipeline:estimate (PlanRequest)    → PlanEstimate (local; nothing is sent)
 *  - pipeline:cancel (jobId)            → boolean (raw)
 *  - ai:status / ai:setProvider / ai:test / ai:config:get / ai:config:set / ai:usage
 * None of them ever returns the API key.
 */
export function registerPipelineIpc(ipcMain: IpcMain, service: PipelineService, ffprobe: () => string | undefined, ai: AiService): void {
  // Claude runs in progress: cancel by job id; one run per project at a time (a double click must
  // never pay twice).
  const jobs = new Map<string, AbortController>();
  const busy = new Set<string>();

  const plan = async (request: PlanRequest) => {
    if (!request.useModel) return service.plan(request);
    await ai.assertCanRun();
    if (busy.has(request.projectId)) throw new AiError('BUSY', 'A Claude run for this project is already in progress.');
    const refs = ai.references(request.references);
    const controller = new AbortController();
    if (request.jobId) jobs.set(request.jobId, controller);
    busy.add(request.projectId);
    try {
      return await service.plan(request, { signal: controller.signal, references: refs });
    } finally {
      busy.delete(request.projectId);
      if (request.jobId) jobs.delete(request.jobId);
    }
  };

  ipcMain.handle('pipeline:probeSource', (_e, file: unknown) => wrap(() => probeSource(ffprobe(), file)));
  ipcMain.handle('pipeline:plan', (_e, request: unknown) => wrap(() => plan(planRequest(request))));
  ipcMain.handle('pipeline:estimate', (_e, request: unknown) =>
    wrap(async () => {
      const r = planRequest(request);
      const estimate = await service.estimate(r, ai.references(r.references));
      const blocked = await ai.blocked();
      return blocked ? { ...estimate, blockedBy: blocked } : estimate;
    })
  );
  ipcMain.handle('pipeline:cancel', (_e, jobId: unknown) => {
    const controller = typeof jobId === 'string' ? jobs.get(jobId) : undefined;
    controller?.abort();
    return Boolean(controller);
  });
  ipcMain.handle('ai:status', () => wrap(() => ai.status()));
  ipcMain.handle('ai:setProvider', (_e, provider: unknown) => wrap(() => ai.setProvider(provider)));
  ipcMain.handle('ai:test', () => wrap(() => ai.test()));
  ipcMain.handle('ai:config:get', () => wrap(() => ai.config()));
  ipcMain.handle('ai:config:set', (_e, update: unknown) => wrap(() => ai.setConfig(update)));
  ipcMain.handle('ai:usage', (_e, projectId: unknown) => wrap(() => ai.usage(projectId ?? undefined)));
  ipcMain.handle('pipeline:act', (_e, request: unknown) =>
    wrap(() => {
      const r = obj(request, 'request');
      const input: ActRequest = { ...planningInput(request), segmentId: str(r.segmentId, 'segmentId', 128), action: action(r.action) };
      return service.act(input);
    })
  );
  ipcMain.handle('pipeline:build', (_e, request: unknown) => wrap(() => service.build(buildRequest(request))));
  ipcMain.handle('pipeline:checkMedia', (_e, file: unknown) => wrap(() => checkMedia(ffprobe(), file)));
}
