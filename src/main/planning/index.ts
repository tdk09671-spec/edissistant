// Main-process entry point for the creative planning engine. Not wired into IPC yet (no UI changes in
// this phase); see docs/PLANNING.md "Integration" for the exact steps.

import * as path from 'path';
import { applyEditorAction, type EditorAction } from '../../shared/planning/approval';
import type { PlanningConfig } from '../../shared/planning/config';
import { CostTracker, DEFAULT_PRICING, type Budget, type CostReport, type PricingTable } from '../../shared/planning/cost';
import { PlanningError } from '../../shared/planning/errors';
import { ModelConceptProvider, type ModelProviderConfig } from '../../shared/planning/modelProvider';
import { CreativePlanner, type PlanResult } from '../../shared/planning/planner';
import { LocalConceptProvider } from '../../shared/planning/provider';
import type { PlanningRequest, ProjectPlan } from '../../shared/planning/types';
import { AnthropicTransport, type AnthropicTransportOptions } from './anthropicTransport';
import { PlanningStore, type ConfigState } from './stores';

export { AnthropicTransport } from './anthropicTransport';
export { PlanningStore, type ConfigState } from './stores';
export { analyzeReference, ingestLink } from './referenceAnalysis';

export interface PlanningServiceOptions {
  userDataPath: string;
  /** From the secure settings layer (main.ts readSecrets().claudeApiKey). Called per request; never cached. */
  getApiKey: AnthropicTransportOptions['getApiKey'];
  // Code defaults. <userData>/planning/config.json overrides all of these on every run (see
  // docs/PLANNING.md "Configuration"), so models, limits and prices change without a code change.
  pricing?: PricingTable;
  /** Default budget per project (USD estimates). */
  budget?: Budget;
  model?: Omit<ModelProviderConfig, 'transport' | 'tracker'>;
  /** Override the transport (tests). */
  transport?: ModelProviderConfig['transport'];
  now?: () => string;
}

/** The settings a run actually uses, after config.json is applied. Contains no credentials. */
export interface EffectivePlanningSettings {
  config: ConfigState;
  /** False when config.json exists but is invalid: model runs are refused until it is fixed. */
  modelAllowed: boolean;
  model: Omit<ModelProviderConfig, 'transport' | 'tracker'>;
  refusalFallback: boolean;
  pricing: PricingTable;
  budget: Budget;
  warnings: string[];
}

/** A per-call budget can tighten the configured hard limit, never raise it. */
function tighten(base: Budget, call?: Budget): Budget {
  if (!call) return base;
  const limits = [base.hardLimit, call.hardLimit].filter((x): x is number => x !== undefined);
  const merged: Budget = { ...base, ...call };
  if (limits.length) merged.hardLimit = Math.min(...limits);
  return merged;
}

export class PlanningService {
  readonly store: PlanningStore;
  private readonly planner = new CreativePlanner();

  constructor(private readonly options: PlanningServiceOptions) {
    this.store = new PlanningStore(path.join(options.userDataPath, 'planning'));
  }

  /** Resolves code defaults + config.json (re-read every time) for one project. */
  settings(projectId: string, callBudget?: Budget): EffectivePlanningSettings {
    const config = this.store.loadConfig();
    const c: Partial<PlanningConfig> = config.state === 'ok' ? config.config : {};
    const warnings =
      config.state === 'invalid'
        ? [`Planning settings file ${config.file} is invalid, so Claude won't be used until it is fixed: ${config.issues.join(' ')}`]
        : [];
    const base = this.options.model ?? {};
    const model: EffectivePlanningSettings['model'] = {
      ...base,
      models: { ...base.models, ...c.models },
      effort: { ...base.effort, ...c.effort },
      retry: { ...base.retry, ...c.retry },
      ...(c.maxSegmentsPerBatch !== undefined ? { maxSegmentsPerBatch: c.maxSegmentsPerBatch } : {}),
      ...(c.maxOutputTokens !== undefined ? { maxOutputTokens: c.maxOutputTokens } : {}),
      ...(c.timeoutMs !== undefined ? { timeoutMs: c.timeoutMs } : {}),
      ...(c.fallbackToLocal !== undefined ? { fallbackToLocal: c.fallbackToLocal } : {}),
    };
    const budget = tighten(c.projectBudgets?.[projectId] ?? c.budget ?? this.options.budget ?? {}, callBudget);
    return {
      config,
      modelAllowed: config.state !== 'invalid',
      model,
      refusalFallback: c.refusalFallback ?? true,
      pricing: c.pricing ?? this.options.pricing ?? DEFAULT_PRICING,
      budget,
      warnings,
    };
  }

  private tracker(projectId: string, settings: EffectivePlanningSettings): CostTracker {
    return new CostTracker(projectId, settings.pricing, settings.budget, this.store.loadUsage(projectId));
  }

  /**
   * Plans a project. `useModel: false` (the default) is free and local. With `useModel: true` the
   * model is asked for candidates within the budget; failures fall back to local suggestions.
   */
  async plan(request: PlanningRequest, opts: { useModel?: boolean; allowReplan?: string[]; budget?: Budget; signal?: AbortSignal } = {}): Promise<PlanResult & { cost: CostReport }> {
    const settings = this.settings(request.projectId, opts.budget);
    const tracker = this.tracker(request.projectId, settings);
    const before = tracker.usageEntries().length;
    const provider =
      opts.useModel && settings.modelAllowed
        ? new ModelConceptProvider({
            ...settings.model,
            transport: this.options.transport ?? new AnthropicTransport({ getApiKey: this.options.getApiKey, refusalFallback: settings.refusalFallback }),
            tracker,
          })
        : new LocalConceptProvider();
    const clientHistory = request.clientHistory ?? this.store.clientHistory(request.profile.id);
    const result = await this.planner.plan({ ...request, clientHistory }, { provider, previous: this.store.loadPlan(request.projectId), allowReplan: opts.allowReplan, signal: opts.signal, now: this.options.now });
    this.store.savePlan(result.plan);
    this.store.appendUsage(tracker.usageEntries().slice(before));
    return { ...result, warnings: [...settings.warnings, ...result.warnings], cost: tracker.report() };
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
    const settings = this.settings(projectId, budget);
    const report = this.tracker(projectId, settings).report();
    return { ...report, warnings: [...settings.warnings, ...report.warnings] };
  }
}
