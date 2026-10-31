// Main-process entry point for the creative planning engine. The pipeline service (src/main/pipeline)
// calls it for local planning and for editor-started Claude runs; see docs/PLANNING.md.

import * as crypto from 'crypto';
import * as path from 'path';
import { applyEditorAction, type EditorAction } from '../../shared/planning/approval';
import type { PlanningConfig } from '../../shared/planning/config';
import { CostTracker, DEFAULT_PRICING, estimateTokens, priceOf, type Budget, type CostReport, type PricingTable, type UsageEntry } from '../../shared/planning/cost';
import { PlanningError } from '../../shared/planning/errors';
import { ModelConceptProvider, type ModelProviderConfig, type PlanningReferences, type ResponseCache } from '../../shared/planning/modelProvider';
import { CreativePlanner, type PlanResult } from '../../shared/planning/planner';
import { LocalConceptProvider, type ConceptRequest, type ConceptResponse, type PlanningProvider } from '../../shared/planning/provider';
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
  /** Anthropic API base URL; set only in test mode (a local mock server). */
  baseURL?: string;
  now?: () => string;
}

/**
 * How a model run behaves when something goes wrong. The defaults below are for runs the editor
 * starts and pays for: no automatic retries, no second paid try on an invalid answer, and no silent
 * switch to local suggestions (a failed run changes nothing and says why).
 */
export interface ModelRunPolicy {
  maxAttempts: number;
  validationRetries: number;
  fallbackToLocal: boolean;
}

export const EDITOR_RUN_POLICY: ModelRunPolicy = { maxAttempts: 1, validationRetries: 0, fallbackToLocal: false };

/** What a model run would send and cost, worked out locally before anything is sent. */
export interface PlanEstimate {
  model: string;
  /** Segments that would be sent (new, changed, rejected or awaiting a new idea). */
  segments: number;
  requests: number;
  /** Requests answered from the local cache (free). */
  cachedRequests: number;
  inputTokens: number;
  /** Typical cost (assumes about 900 + 250 output tokens per segment, thinking included). */
  expectedCost: number;
  /** Upper bound: every request uses its full output allowance. */
  maxCost: number;
  pricingVersion: string;
  priced: boolean;
  images: number;
  projectSpent: number;
  monthSpent: number;
  /** The project's own limits as configured (not lowered to fit the monthly limit). */
  budget: Budget;
  monthlyLimit?: number;
  /** Set when even the upper bound would pass a limit: the run would be refused. */
  blockedBy?: string;
  /** Set when the project is past, or this run would likely take it past, the "warn at" amount. */
  warning?: string;
  /** The transcript rows that would be sent. */
  segmentIds: string[];
}

export interface UsageOverview {
  month: string;
  monthSpent: number;
  monthlyLimit?: number;
  projects: { projectId: string; calls: number; estimatedCost: number; inputTokens: number; outputTokens: number; lastAt: string | null }[];
  disclaimer: string;
}

/** What one plan() call sent and cost (the project totals are in `cost`). */
export interface RunUsage {
  /** Requests sent to Anthropic (billed). */
  calls: number;
  /** Requests answered from the local cache (not sent, not billed). */
  cachedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** USD estimate; null when a call's model has no price in the table. */
  estimatedCost: number | null;
  models: string[];
  /** Spending warnings after this run (the "warn at" amount). */
  warnings: string[];
}

const monthOf = (iso: string) => iso.slice(0, 7);

/** Records the ConceptRequest the planner would send, without sending it (for estimates). */
class ProbeProvider implements PlanningProvider {
  readonly name = 'probe';
  request: ConceptRequest | null = null;
  private readonly local = new LocalConceptProvider();
  async suggest(request: ConceptRequest): Promise<ConceptResponse> {
    this.request = request;
    return this.local.suggest(request);
  }
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

const money = (n: number) => `$${n.toFixed(2)}`;

/** The "warn at" message for a project's spend, or undefined. */
function softWarning(spent: number, soft: number | undefined, next = 0): string | undefined {
  if (soft === undefined) return undefined;
  if (spent >= soft) return `This project’s Claude spend (${money(spent)}) has passed your warning amount of ${money(soft)}.`;
  if (next > 0 && spent + next > soft) return `This run would likely take the project past your warning amount of ${money(soft)} (${money(spent)} spent so far).`;
  return undefined;
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

  private get responseCache(): ResponseCache {
    return { get: (key) => this.store.getCachedReply(key), set: (key, reply) => this.store.setCachedReply(key, reply) };
  }

  private static hash(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  /** Estimated spend this calendar month (UTC) across all projects. */
  monthSpent(now = new Date().toISOString()): number {
    const month = monthOf(now);
    return this.store
      .usageProjects()
      .flatMap((id) => this.store.loadUsage(id))
      .filter((e) => typeof e.at === 'string' && monthOf(e.at) === month)
      .reduce((s, e) => s + (e.estimatedCost ?? 0), 0);
  }

  /** The project's budget, tightened so the call also can't pass the monthly limit. */
  private budgetFor(projectId: string, settings: EffectivePlanningSettings): Budget {
    const monthly = settings.config.state === 'ok' ? settings.config.config.monthlyLimit : undefined;
    if (monthly === undefined) return settings.budget;
    const projectSpent = this.store.loadUsage(projectId).reduce((s, e) => s + (e.estimatedCost ?? 0), 0);
    const left = Math.max(0, monthly - this.monthSpent(this.options.now?.()));
    return tighten(settings.budget, { hardLimit: projectSpent + left });
  }

  private modelProvider(projectId: string, settings: EffectivePlanningSettings, tracker: CostTracker, policy?: ModelRunPolicy, references?: PlanningReferences, cache: ResponseCache = this.responseCache): ModelConceptProvider {
    return new ModelConceptProvider({
      ...settings.model,
      ...(policy ? { retry: { ...settings.model.retry, maxAttempts: policy.maxAttempts }, validationRetries: policy.validationRetries, fallbackToLocal: policy.fallbackToLocal } : {}),
      transport: this.options.transport ?? new AnthropicTransport({ getApiKey: this.options.getApiKey, refusalFallback: settings.refusalFallback, baseURL: this.options.baseURL }),
      tracker,
      cache,
      hash: PlanningService.hash,
      ...(references ? { references } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
    });
  }

  /**
   * What a model run would send and cost, computed locally (nothing is sent). Uses the same planner
   * pass and the same request builder as the real run, so the segments and prompts are the ones
   * that would really go out.
   */
  async estimate(request: PlanningRequest, opts: { allowReplan?: string[]; references?: PlanningReferences } = {}): Promise<PlanEstimate> {
    const settings = this.settings(request.projectId);
    const budget = this.budgetFor(request.projectId, settings);
    const tracker = new CostTracker(request.projectId, settings.pricing, budget, this.store.loadUsage(request.projectId));
    const probe = new ProbeProvider();
    const clientHistory = request.clientHistory ?? this.store.clientHistory(request.profile.id);
    await this.planner.plan({ ...request, clientHistory }, { provider: probe, previous: this.store.loadPlan(request.projectId), allowReplan: opts.allowReplan, now: this.options.now });
    const provider = this.modelProvider(request.projectId, settings, tracker, EDITOR_RUN_POLICY, opts.references);
    const calls = probe.request && probe.request.segments.length ? provider.plannedCalls(probe.request) : [];
    const model = calls[0]?.call.model ?? settings.model.models?.['creative-planning'] ?? 'claude-opus-5-5';
    const price = settings.pricing.models[model];
    let inputTokens = 0;
    let expected = 0;
    let max = 0;
    for (const { call, segments, cached } of calls) {
      const input = estimateTokens(call.system.map((b) => b.text).join('\n') + call.user) + (call.images?.length ?? 0) * 1600;
      inputTokens += input;
      if (cached) continue;
      const out = Math.min(call.maxOutputTokens, 900 + 250 * segments);
      expected += priceOf({ inputTokens: input, outputTokens: out, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, model, settings.pricing) ?? tracker.worstCase(model, input, out);
      max += tracker.worstCase(model, input, call.maxOutputTokens);
    }
    const projectSpent = tracker.spent;
    const monthSpent = this.monthSpent(this.options.now?.());
    const monthlyLimit = settings.config.state === 'ok' ? settings.config.config.monthlyLimit : undefined;
    let blockedBy: string | undefined;
    if (!settings.modelAllowed) blockedBy = settings.warnings[0];
    else if (budget.hardLimit !== undefined && projectSpent + max > budget.hardLimit) {
      blockedBy =
        monthlyLimit !== undefined && monthSpent + max > monthlyLimit
          ? `This run could cost up to $${max.toFixed(2)}, which could pass your monthly limit of $${monthlyLimit.toFixed(2)} ($${monthSpent.toFixed(2)} spent this month).`
          : `This run could cost up to $${max.toFixed(2)}, which could pass this project’s limit of $${budget.hardLimit.toFixed(2)} ($${projectSpent.toFixed(2)} spent).`;
    }
    return {
      model,
      segments: calls.reduce((n, c) => n + c.segments, 0),
      requests: calls.length,
      cachedRequests: calls.filter((c) => c.cached).length,
      inputTokens,
      expectedCost: Math.round(expected * 1e4) / 1e4,
      maxCost: Math.round(max * 1e4) / 1e4,
      pricingVersion: settings.pricing.version,
      priced: Boolean(price),
      images: opts.references?.images.length ?? 0,
      projectSpent: Math.round(projectSpent * 1e4) / 1e4,
      monthSpent: Math.round(monthSpent * 1e4) / 1e4,
      budget: settings.budget,
      ...(monthlyLimit !== undefined ? { monthlyLimit } : {}),
      ...(blockedBy ? { blockedBy } : {}),
      ...(softWarning(projectSpent, settings.budget.softLimit, expected) ? { warning: softWarning(projectSpent, settings.budget.softLimit, expected) } : {}),
      segmentIds: probe.request?.segments.map((x) => x.segmentId) ?? [],
    };
  }

  /** Spend per project and this month, from the local usage logs (estimates, not billing). */
  usageOverview(): UsageOverview {
    const now = this.options.now?.() ?? new Date().toISOString();
    const settings = this.store.loadConfig();
    const projects = this.store.usageProjects().map((projectId) => {
      const entries: UsageEntry[] = this.store.loadUsage(projectId);
      return {
        projectId,
        calls: entries.length,
        estimatedCost: Math.round(entries.reduce((s, e) => s + (e.estimatedCost ?? 0), 0) * 1e6) / 1e6,
        inputTokens: entries.reduce((s, e) => s + e.inputTokens + e.cacheCreationInputTokens + e.cacheReadInputTokens, 0),
        outputTokens: entries.reduce((s, e) => s + e.outputTokens, 0),
        lastAt: entries.map((e) => e.at).sort().pop() ?? null,
      };
    });
    return {
      month: monthOf(now),
      monthSpent: Math.round(this.monthSpent(now) * 1e6) / 1e6,
      ...(settings.state === 'ok' && settings.config.monthlyLimit !== undefined ? { monthlyLimit: settings.config.monthlyLimit } : {}),
      projects,
      disclaimer: 'Estimates from the token counts Anthropic returned and the price table; not your bill. Check the Anthropic Console for actual charges.',
    };
  }

  /** The usage entries recorded for one project (newest last). */
  usageHistory(projectId: string): UsageEntry[] {
    return this.store.loadUsage(projectId);
  }

  /**
   * Plans a project. `useModel: false` (the default) is free and local. With `useModel: true` the
   * model is asked for candidates within the budget. Without a policy, failures fall back to local
   * suggestions (PR #3 behaviour); with EDITOR_RUN_POLICY a failure throws and changes nothing.
   */
  async plan(
    request: PlanningRequest,
    opts: { useModel?: boolean; allowReplan?: string[]; budget?: Budget; signal?: AbortSignal; policy?: ModelRunPolicy; references?: PlanningReferences } = {}
  ): Promise<PlanResult & { cost: CostReport; run: RunUsage }> {
    const settings = this.settings(request.projectId, opts.budget);
    // An editor's Claude run (it carries a policy) never quietly turns into a local one.
    if (opts.useModel && !settings.modelAllowed && opts.policy) throw new PlanningError('INVALID_INPUT', settings.warnings[0] ?? 'Planning settings are invalid.');
    const useModel = opts.useModel === true && settings.modelAllowed;
    const effective = useModel ? { ...settings, budget: this.budgetFor(request.projectId, settings) } : settings;
    const tracker = this.tracker(request.projectId, effective);
    const before = tracker.usageEntries().length;
    let cachedRequests = 0;
    const cache: ResponseCache = {
      get: (key) => {
        const hit = this.responseCache.get(key);
        if (hit) cachedRequests++;
        return hit;
      },
      set: (key, reply) => this.responseCache.set(key, reply),
    };
    const provider = useModel ? this.modelProvider(request.projectId, effective, tracker, opts.policy, opts.references, cache) : new LocalConceptProvider();
    const clientHistory = request.clientHistory ?? this.store.clientHistory(request.profile.id);
    try {
      const result = await this.planner.plan({ ...request, clientHistory }, { provider, previous: this.store.loadPlan(request.projectId), allowReplan: opts.allowReplan, signal: opts.signal, now: this.options.now });
      this.store.savePlan(result.plan);
      const entries = tracker.usageEntries().slice(before);
      const sum = (f: (e: UsageEntry) => number) => entries.reduce((n, e) => n + f(e), 0);
      const run: RunUsage = {
        calls: entries.length,
        cachedRequests,
        inputTokens: sum((e) => e.inputTokens),
        outputTokens: sum((e) => e.outputTokens),
        cacheReadInputTokens: sum((e) => e.cacheReadInputTokens),
        cacheCreationInputTokens: sum((e) => e.cacheCreationInputTokens),
        estimatedCost: entries.some((e) => e.estimatedCost === null) ? null : Math.round(sum((e) => e.estimatedCost ?? 0) * 1e6) / 1e6,
        models: [...new Set(entries.map((e) => e.model))],
        warnings: entries.length ? [softWarning(tracker.spent, settings.budget.softLimit)].filter((w): w is string => Boolean(w)) : [],
      };
      return { ...result, warnings: [...settings.warnings, ...result.warnings], cost: tracker.report(), run };
    } catch (error) {
      // The tracker only knows "the limit"; say which one it was.
      const monthly = settings.config.state === 'ok' ? settings.config.config.monthlyLimit : undefined;
      const project = settings.budget.hardLimit;
      const effectiveLimit = effective.budget.hardLimit;
      if (error instanceof PlanningError && error.code === 'BUDGET_EXCEEDED' && monthly !== undefined && effectiveLimit !== undefined && (project === undefined || effectiveLimit < project)) {
        throw new PlanningError('BUDGET_EXCEEDED', `This request could pass your monthly limit of ${money(monthly)} (${money(this.monthSpent(this.options.now?.()))} spent this month across all projects).`, { retryable: false });
      }
      throw error;
    } finally {
      // Whatever happened, every billed response is recorded (a failed run still costs money).
      this.store.appendUsage(tracker.usageEntries().slice(before));
    }
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
