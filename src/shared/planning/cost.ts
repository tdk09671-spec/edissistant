// Token and cost instrumentation. These are ESTIMATES from response usage and a configurable,
// versioned price table: they are not billing. Check the Anthropic Console for actual charges.

import { PlanningError } from './errors';

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  /** 5-minute cache writes. */
  cacheWrite: number;
  cacheRead: number;
}

export interface PricingTable {
  /** Bump when prices change; stored with every usage entry. */
  version: string;
  currency: 'USD';
  source: string;
  models: Record<string, ModelPrice>;
}

/**
 * Default prices (Anthropic first-party API, from the Claude API reference cached 2026-10-06).
 * Cache writes are estimated at 1.25× input. Verify against https://platform.claude.com pricing before
 * relying on these; override with your own table.
 */
export const DEFAULT_PRICING: PricingTable = {
  version: '2026-10-06',
  currency: 'USD',
  source: 'Claude API model table (cached 2026-10-06); cache write = 1.25 × input (estimate)',
  models: {
    'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
    'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
    'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  },
};

export type ModelTask = 'creative-planning' | 'implementation' | 'vision';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface UsageEntry extends TokenUsage {
  projectId: string;
  task: ModelTask;
  model: string;
  at: string;
  /** Estimated USD, or null when the model has no price in the table. */
  estimatedCost: number | null;
  pricingVersion: string;
  /** Segments covered by the call (for per-segment cost). */
  segments: number;
  attempt: number;
}

export interface Budget {
  /** Warn when spend passes these fractions of the soft limit. */
  warnAt?: number[];
  /** USD. Crossing it produces a warning. */
  softLimit?: number;
  /** USD. Calls that could exceed it are refused before they are sent. */
  hardLimit?: number;
  /** Optional per-video benchmark (e.g. 0.10) — a goal to report against, not a guarantee. */
  targetPerVideo?: number;
}

export interface CostReport {
  projectId: string;
  calls: number;
  usage: TokenUsage;
  estimatedCost: number;
  /** Calls with no price in the table. */
  unpricedCalls: number;
  byTask: Record<string, { calls: number; estimatedCost: number }>;
  byModel: Record<string, { calls: number; estimatedCost: number }>;
  /** Share of input served from the prompt cache. */
  cacheHitRate: number;
  budget: Budget;
  warnings: string[];
  disclaimer: string;
}

export function priceOf(usage: TokenUsage, model: string, pricing: PricingTable): number | null {
  const p = pricing.models[model];
  if (!p) return null;
  return (usage.inputTokens * p.input + usage.outputTokens * p.output + usage.cacheCreationInputTokens * p.cacheWrite + usage.cacheReadInputTokens * p.cacheRead) / 1_000_000;
}

/** Rough pre-flight token estimate (≈ 3.5 characters per token for English prose and JSON). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export class CostTracker {
  private readonly entries: UsageEntry[] = [];
  private readonly warned = new Set<string>();

  constructor(
    readonly projectId: string,
    private readonly pricing: PricingTable = DEFAULT_PRICING,
    private budget: Budget = {},
    restore: UsageEntry[] = []
  ) {
    this.entries.push(...restore.filter((e) => e.projectId === projectId));
  }

  setBudget(budget: Budget): void {
    this.budget = budget;
  }

  get spent(): number {
    return this.entries.reduce((s, e) => s + (e.estimatedCost ?? 0), 0);
  }

  /** Throws BUDGET_EXCEEDED if a call costing up to `worstCase` USD could pass the hard limit. */
  assertCanSpend(worstCase: number): void {
    const hard = this.budget.hardLimit;
    if (hard !== undefined && this.spent + worstCase > hard) {
      throw new PlanningError(
        'BUDGET_EXCEEDED',
        `This request could cost up to $${worstCase.toFixed(4)}, which would pass the project limit of $${hard.toFixed(2)} (estimated spend so far $${this.spent.toFixed(4)}).`
      );
    }
  }

  /** Worst-case USD for a call: estimated input as uncached + full output budget. */
  worstCase(model: string, inputTokens: number, maxOutputTokens: number): number {
    const p = this.pricing.models[model];
    // Unknown price: assume the most expensive model in the table, so limits still hold.
    const price = p ?? Object.values(this.pricing.models).sort((a, b) => b.output - a.output)[0];
    if (!price) return 0;
    return (inputTokens * Math.max(price.input, price.cacheWrite) + maxOutputTokens * price.output) / 1_000_000;
  }

  record(usage: TokenUsage, meta: { task: ModelTask; model: string; segments: number; attempt: number; at: string }): UsageEntry {
    const entry: UsageEntry = { ...usage, ...meta, projectId: this.projectId, estimatedCost: priceOf(usage, meta.model, this.pricing), pricingVersion: this.pricing.version };
    this.entries.push(entry);
    return entry;
  }

  /** New budget warnings since the last call (each threshold warns once). */
  takeWarnings(): string[] {
    const out: string[] = [];
    const { softLimit, warnAt = [0.5, 0.8, 1] } = this.budget;
    if (softLimit) {
      for (const f of warnAt) {
        const key = `soft:${f}`;
        if (this.spent >= softLimit * f && !this.warned.has(key)) {
          this.warned.add(key);
          out.push(`Estimated AI spend for this project is $${this.spent.toFixed(4)} (${Math.round(f * 100)}% of the $${softLimit.toFixed(2)} budget).`);
        }
      }
    }
    return out;
  }

  usageEntries(): UsageEntry[] {
    return [...this.entries];
  }

  report(): CostReport {
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    const byTask: CostReport['byTask'] = {};
    const byModel: CostReport['byModel'] = {};
    let unpriced = 0;
    for (const e of this.entries) {
      usage.inputTokens += e.inputTokens;
      usage.outputTokens += e.outputTokens;
      usage.cacheCreationInputTokens += e.cacheCreationInputTokens;
      usage.cacheReadInputTokens += e.cacheReadInputTokens;
      if (e.estimatedCost === null) unpriced++;
      for (const [map, key] of [[byTask, e.task], [byModel, e.model]] as const) {
        map[key] ??= { calls: 0, estimatedCost: 0 };
        map[key].calls++;
        map[key].estimatedCost += e.estimatedCost ?? 0;
      }
    }
    const totalInput = usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
    const warnings: string[] = [];
    if (unpriced) warnings.push(`${unpriced} call(s) used a model with no price in table ${this.pricing.version}; their cost is not included.`);
    const spent = this.spent;
    if (this.budget.hardLimit !== undefined && spent >= this.budget.hardLimit) warnings.push('The hard spending limit has been reached; further model calls are blocked.');
    if (this.budget.targetPerVideo !== undefined && spent > this.budget.targetPerVideo) {
      warnings.push(`Above the $${this.budget.targetPerVideo.toFixed(2)} per-video benchmark (a goal, not a guarantee).`);
    }
    return {
      projectId: this.projectId,
      calls: this.entries.length,
      usage,
      estimatedCost: Math.round(spent * 1e6) / 1e6,
      unpricedCalls: unpriced,
      byTask,
      byModel,
      cacheHitRate: totalInput ? Math.round((usage.cacheReadInputTokens / totalInput) * 1000) / 1000 : 0,
      budget: this.budget,
      warnings,
      disclaimer: `Estimates from API usage and pricing table ${this.pricing.version}; not your bill.`,
    };
  }
}
