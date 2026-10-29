// Main-process entry point for the creative planning engine. Not wired into IPC yet (no UI changes in
// this phase); see docs/PLANNING.md "Integration" for the exact steps.

import * as path from 'path';
import { applyEditorAction, type EditorAction } from '../../shared/planning/approval';
import { CostTracker, DEFAULT_PRICING, type Budget, type CostReport, type PricingTable } from '../../shared/planning/cost';
import { PlanningError } from '../../shared/planning/errors';
import { ModelConceptProvider, type ModelProviderConfig } from '../../shared/planning/modelProvider';
import { CreativePlanner, type PlanResult } from '../../shared/planning/planner';
import { LocalConceptProvider } from '../../shared/planning/provider';
import type { PlanningRequest, ProjectPlan } from '../../shared/planning/types';
import { AnthropicTransport, type AnthropicTransportOptions } from './anthropicTransport';
import { PlanningStore } from './stores';

export { AnthropicTransport } from './anthropicTransport';
export { PlanningStore } from './stores';
export { analyzeReference, ingestLink } from './referenceAnalysis';

export interface PlanningServiceOptions {
  userDataPath: string;
  /** From the secure settings layer (main.ts readSecrets().claudeApiKey). Called per request; never cached. */
  getApiKey: AnthropicTransportOptions['getApiKey'];
  pricing?: PricingTable;
  /** Default budget per project (USD estimates). */
  budget?: Budget;
  model?: Omit<ModelProviderConfig, 'transport' | 'tracker'>;
  /** Override the transport (tests). */
  transport?: ModelProviderConfig['transport'];
  now?: () => string;
}

export class PlanningService {
  readonly store: PlanningStore;
  private readonly planner = new CreativePlanner();

  constructor(private readonly options: PlanningServiceOptions) {
    this.store = new PlanningStore(path.join(options.userDataPath, 'planning'));
  }

  private tracker(projectId: string, budget?: Budget): CostTracker {
    return new CostTracker(projectId, this.options.pricing ?? DEFAULT_PRICING, budget ?? this.options.budget ?? {}, this.store.loadUsage(projectId));
  }

  /**
   * Plans a project. `useModel: false` (the default) is free and local. With `useModel: true` the
   * model is asked for candidates within the budget; failures fall back to local suggestions.
   */
  async plan(request: PlanningRequest, opts: { useModel?: boolean; allowReplan?: string[]; budget?: Budget; signal?: AbortSignal } = {}): Promise<PlanResult & { cost: CostReport }> {
    const tracker = this.tracker(request.projectId, opts.budget);
    const before = tracker.usageEntries().length;
    const provider = opts.useModel
      ? new ModelConceptProvider({ ...(this.options.model ?? {}), transport: this.options.transport ?? new AnthropicTransport({ getApiKey: this.options.getApiKey }), tracker })
      : new LocalConceptProvider();
    const clientHistory = request.clientHistory ?? this.store.clientHistory(request.profile.id);
    const result = await this.planner.plan({ ...request, clientHistory }, { provider, previous: this.store.loadPlan(request.projectId), allowReplan: opts.allowReplan, signal: opts.signal, now: this.options.now });
    this.store.savePlan(result.plan);
    this.store.appendUsage(tracker.usageEntries().slice(before));
    return { ...result, cost: tracker.report() };
  }

  /** Applies an editor action to one segment and saves the plan. */
  act(projectId: string, segmentId: string, action: EditorAction): ProjectPlan {
    const plan = this.store.loadPlan(projectId);
    if (!plan) throw new PlanningError('INVALID_INPUT', `No plan for project ${projectId}.`);
    const at = this.options.now?.() ?? new Date().toISOString();
    const segments = plan.segments.map((s) => (s.segmentId === segmentId ? applyEditorAction(s, action, at) : s));
    if (!segments.some((s, i) => s !== plan.segments[i])) throw new PlanningError('INVALID_INPUT', `No segment ${segmentId} in the plan.`);
    const next = { ...plan, segments, updatedAt: at };
    this.store.savePlan(next);
    return next;
  }

  costReport(projectId: string, budget?: Budget): CostReport {
    return this.tracker(projectId, budget).report();
  }
}
