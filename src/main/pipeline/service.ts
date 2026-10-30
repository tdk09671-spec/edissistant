// Main-process pipeline: keeps the creative plan (PR #3) in step with the sequence rows the editor
// works on, and turns approved plans into PR #2 sequences. Planning is local and deterministic unless
// a request explicitly asks for the model. Rendering itself stays on PR #2's render:* channels.

import { hashHex } from '../../shared/planning/hash';
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
    const synced = await this.plan({ ...request, useModel: false });
    if (!synced.updates.some((u) => u.id === request.segmentId)) {
      throw new PipelineError('INVALID_ACTION', 'This segment has no transcript to plan yet.');
    }
    let plan;
    try {
      plan = this.planning.act(request.projectId, request.segmentId, request.action);
    } catch (error) {
      throw new PipelineError('INVALID_ACTION', error instanceof Error ? error.message : String(error));
    }
    return { ...synced, updates: segmentUpdates(plan) };
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
    });
    return { ...built, updates: synced.updates };
  }
}
