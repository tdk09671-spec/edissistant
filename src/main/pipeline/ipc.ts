import type { IpcMain } from 'electron';
import { CONCEPT_IDS } from '../../shared/planning/concepts';
import { isSupportedFps } from '../../shared/animation/timeline';
import type { EditorAction } from '../../shared/planning/approval';
import type { ActRequest, BuildRequest, PipelineResult, PipelineSegment, PlanRequest, ProjectPlanningInput, RenderTarget } from '../../shared/pipeline/types';
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
  return { ...planningInput(v), ...(allowReplan ? { allowReplan: allowReplan as string[] } : {}), useModel: r.useModel === true };
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
export const validators = { segments, planningInput, buildRequest };

function failure(error: unknown): PipelineResult<never> {
  if (error instanceof Invalid) return { ok: false, error: { code: 'INVALID_REQUEST', message: error.message } };
  if (error instanceof MediaError || error instanceof PipelineError) return { ok: false, error: { code: error.code, message: error.message } };
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
 */
export function registerPipelineIpc(ipcMain: IpcMain, service: PipelineService, ffprobe: () => string | undefined): void {
  ipcMain.handle('pipeline:probeSource', (_e, file: unknown) => wrap(() => probeSource(ffprobe(), file)));
  ipcMain.handle('pipeline:plan', (_e, request: unknown) => wrap(() => service.plan(planRequest(request))));
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
