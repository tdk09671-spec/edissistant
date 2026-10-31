// Main-process pipeline: keeps the creative plan (PR #3) in step with the sequence rows the editor
// works on, and turns approved plans into PR #2 sequences. Planning is local and deterministic unless
// a request explicitly asks for the model. Rendering itself stays on PR #2's render:* channels.

import { hashHex } from '../../shared/planning/hash';
import { parseLocalEdit } from '../../shared/planning/localEdits';
import { buildStyleProfile, type PresetLike } from '../../shared/planning/styleProfile';
import type { PlanResult } from '../../shared/planning/planner';
import type { StyleProfile } from '../../shared/planning/types';
import { buildSequence, presetWithNotes, segmentUpdates, toPlanningInputs } from '../../shared/pipeline/convert';
import type { ActRequest, BuildRequest, BuildResponse, PlanOutcome, PlanRequest, ProjectPlanningInput } from '../../shared/pipeline/types';
import { PlanningService, type PlanningServiceOptions } from '../planning';

export class PipelineError extends Error {
  constructor(
    readonly code: 'PLANNING_FAILED' | 'INVALID_ACTION' | 'INVALID_REQUEST',
    message: string
  ) {
    super(message);
  }
}

export class PipelineService {
  readonly planning: PlanningService;

  constructor(private readonly options: PlanningServiceOptions) {
    this.planning = new PlanningService(options);
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  /**
   * The client's style profile, cached in the planning store. Project notes make a project-specific
   * profile so they never change the client's shared one.
   */
  profile(input: ProjectPlanningInput): StyleProfile {
    const notes = input.notes?.trim();
    const id = notes ? `${input.preset.id}.p${hashHex(`${input.projectId}:${notes}`).slice(0, 10)}` : input.preset.id;
    const preset: PresetLike = { ...presetWithNotes(input.preset, notes), id };
    const previous = this.planning.store.loadProfile(id);
    const profile = buildStyleProfile({ preset }, this.now(), previous ?? undefined);
    if (!previous || previous.fingerprint !== profile.fingerprint) this.planning.store.saveProfile(profile);
    return profile;
  }

  private outcome(result: PlanResult & { cost: { calls: number; estimatedCost: number; warnings: string[] } }, profile: StyleProfile): PlanOutcome {
    return {
      updates: segmentUpdates(result.plan),
      planned: result.planned,
      kept: result.kept,
      flagged: result.flagged,
      warnings: result.warnings,
      findings: result.plan.findings,
      profile: { id: profile.id, revision: profile.revision, confidence: profile.confidence, uncertainties: profile.uncertainties },
      cost: { calls: result.cost.calls, estimatedCost: result.cost.estimatedCost, warnings: result.cost.warnings },
    };
  }

  /** Plans new and changed rows; approved and edited rows are kept (see PR #3 replanning rules). */
  async plan(request: PlanRequest, signal?: AbortSignal): Promise<PlanOutcome> {
    const profile = this.profile(request);
    const result = await this.planning.plan(
      {
        projectId: request.projectId,
        profile,
        segments: toPlanningInputs(request.segments),
        variety: request.variety ?? 'balanced',
        clientHistory: this.planning.store.clientHistory(request.preset.id),
      },
      { useModel: request.useModel === true, allowReplan: request.allowReplan, signal }
    );
    return this.outcome(result, profile);
  }

  /**
   * Applies an editor decision to the current version of a row: the plan is brought up to date
   * locally first, so "approve" approves what the row says now, not an older suggestion.
   */
  async act(request: ActRequest): Promise<PlanOutcome> {
    if (request.action.type === 'approve') {
      const withInstruction = await this.approveChangedInstruction(request);
      if (withInstruction) return withInstruction;
    }
    const synced = await this.plan({ ...request, useModel: false });
    if (!synced.updates.some((u) => u.id === request.segmentId)) {
      throw new PipelineError('INVALID_ACTION', 'This segment has no transcript to plan yet.');
    }
    // Bringing the plan up to date produced a new idea for this segment (its text changed, or it
    // was rejected): never approve something the editor hasn't seen.
    if (request.action.type === 'approve' && synced.planned.includes(request.segmentId)) {
      return { ...synced, deferred: 'This segment has a new suggestion. Review it, then approve.' };
    }
    let action = request.action;
    if (action.type === 'approve') {
      const current = this.segmentPlan(request);
      if (current?.status === 'approved' && !current.stale) return synced; // already approved: nothing to do
      if (current?.status === 'approved') action = { type: 'acknowledge-change' }; // transcript moved under it
    }
    let plan;
    try {
      plan = this.planning.act(request.projectId, request.segmentId, action);
    } catch (error) {
      throw new PipelineError('INVALID_ACTION', error instanceof Error ? error.message : String(error));
    }
    return { ...synced, updates: segmentUpdates(plan) };
  }

  private segmentPlan(request: ActRequest) {
    return this.planning.store.loadPlan(request.projectId)?.segments.find((s) => s.segmentId === request.segmentId);
  }

  /**
   * Approving a segment whose editor instruction changed since its graphic was planned means "apply
   * my instruction". Windows validation round 2 (bug D): approving used to keep the old graphic.
   * A fully understood instruction is applied and approved in one step: it's the editor's own
   * request for a graphic they already approved. Anything less is applied as far as it goes and left
   * for review, with a message saying what wasn't applied.
   * Returns null when the instruction didn't change (the ordinary approve path handles it).
   */
  private async approveChangedInstruction(request: ActRequest): Promise<PlanOutcome | null> {
    const row = request.segments.find((s) => s.id === request.segmentId);
    const prior = this.segmentPlan(request);
    if (!row || !prior) return null;
    const instruction = row.instruction.trim();
    const planned = (prior.stale?.instructionFrom ?? prior.instruction ?? '').trim();
    // Only for a graphic the editor already approved: a suggestion that was never approved is
    // replanned with the instruction and shown first (see act), never approved unseen.
    if (instruction === planned || prior.status !== 'approved') return null;

    if (!instruction) {
      // The instruction was removed: nothing new was asked for, so the approved graphic stays.
      const synced = await this.plan({ ...request, useModel: false });
      const current = this.segmentPlan(request);
      if (current?.status !== 'approved' || !current.stale) return null;
      const plan = this.planning.act(request.projectId, request.segmentId, { type: 'acknowledge-change' });
      return { ...synced, updates: segmentUpdates(plan), instruction: { status: 'kept', message: 'The instruction was removed; the approved graphic stays as it is.' } };
    }

    const parsed = parseLocalEdit(instruction);
    if (parsed.understood.length === 0) {
      // Replanning would only produce an unrelated idea. Leave the plan (an approved one stays
      // flagged, so it isn't rendered as if the change had been made) and say so.
      const synced = await this.plan({ ...request, useModel: false });
      const keeps = 'The segment keeps its approved graphic, which doesn’t follow the instruction, and is left out of renders until you decide.';
      return {
        ...synced,
        instruction: {
          status: 'not-applied',
          message: `“${instruction}” wasn’t applied: the local planner didn’t understand it. ${keeps} Pick the concept in the Inspector, or reword it (for example “make it a list”, “slower”, “just captions”).`,
        },
      };
    }

    // Replan this one segment with the instruction (approved segments need explicit permission).
    const synced = await this.plan({ ...request, useModel: false, allowReplan: [request.segmentId] });
    const understood = parsed.understood.join(', ');
    if (!parsed.handled) {
      return {
        ...synced,
        instruction: {
          status: 'partial',
          message: `Applied part of “${instruction}” (${understood}). “${parsed.remainder}” needs AI planning or a manual edit, so the new suggestion isn’t approved yet. Review it, then approve.`,
        },
      };
    }
    const plan = this.planning.act(request.projectId, request.segmentId, { type: 'approve' });
    return { ...synced, updates: segmentUpdates(plan), instruction: { status: 'applied', message: `Applied “${instruction}” (${understood}) and approved it. Update the preview to see it.` } };
  }

  /** Approved plan → PR #2 sequence for one deliverable, plus why each other row doesn't render. */
  async build(request: BuildRequest): Promise<BuildResponse> {
    const synced = await this.plan({ ...request, useModel: false });
    const plan = this.planning.store.loadPlan(request.projectId);
    if (!plan) throw new PipelineError('PLANNING_FAILED', 'No plan for this project yet. Run Suggest visuals first.');
    const built = buildSequence(plan, toPlanningInputs(request.segments), this.profile(request), {
      projectId: request.projectId,
      target: request.target,
      width: request.width,
      height: request.height,
      fps: request.fps,
      duration: request.duration,
      allowFontFallback: request.allowFontFallback,
      visualTiming: Object.fromEntries(request.segments.flatMap((s) => (s.visualTiming ? [[s.id, s.visualTiming]] : []))),
    });
    return { ...built, updates: synced.updates };
  }
}
