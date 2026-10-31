// User-editable planning settings (models, limits, prices), stored as <userData>/planning/config.json
// and re-read on every run, so they change without touching application code. A future settings
// screen can validate with the same parser. API keys never belong here: they live in the OS-encrypted
// secrets store, and a config that contains one is refused.

import type { Budget, ModelTask, PricingTable } from './cost';
import type { ModelCall, RetryPolicy } from './modelProvider';

export const PLANNING_CONFIG_SCHEMA = 'edissistant.planning-config';
export const PLANNING_CONFIG_VERSION = 1;

export interface PlanningConfig {
  schema: typeof PLANNING_CONFIG_SCHEMA;
  version: typeof PLANNING_CONFIG_VERSION;
  /** Model id per task, e.g. { "creative-planning": "claude-sonnet-5-5" }. */
  models?: Partial<Record<ModelTask, string>>;
  effort?: Partial<Record<ModelTask, ModelCall['effort']>>;
  maxSegmentsPerBatch?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  /** Server-side refusal fallback. Default true. */
  refusalFallback?: boolean;
  /** Use local suggestions when the model fails or a limit is reached. Default true. */
  fallbackToLocal?: boolean;
  /** Default limits for every project (USD estimates). */
  budget?: Budget;
  /** Per-project limits; replace `budget` for that project. */
  projectBudgets?: Record<string, Budget>;
  /** USD across all projects per calendar month (UTC). Calls that could pass it are refused. */
  monthlyLimit?: number;
  /** Replaces the built-in price table (bump `version` when prices change). */
  pricing?: PricingTable;
}

export type ConfigParseResult = { ok: true; config: PlanningConfig } | { ok: false; issues: string[] };

const TASKS: readonly ModelTask[] = ['creative-planning', 'implementation', 'vision'];
const EFFORTS: readonly ModelCall['effort'][] = ['low', 'medium', 'high'];
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/;
const PROJECT_ID = /^[A-Za-z0-9_.-]{1,128}$/;
/** Setting names that suggest a credential (not e.g. maxOutputTokens). */
const KEY_LIKE = /api[_-]?key|secret|password|bearer|auth[_-]?token|access[_-]?token/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates a parsed config.json. Every problem is reported; nothing is silently dropped. */
export function parsePlanningConfig(raw: unknown): ConfigParseResult {
  const issues: string[] = [];
  if (!isObj(raw)) return { ok: false, issues: ['The file must contain a JSON object.'] };

  // Refuse anything that looks like a credential, wherever it is.
  const scan = (v: unknown, at: string): void => {
    if (typeof v === 'string' && /sk-ant-/.test(v)) issues.push(`${at} looks like an API key. Keys belong in Settings (stored encrypted), never in config.json.`);
    if (isObj(v)) for (const [k, x] of Object.entries(v)) {
      if (KEY_LIKE.test(k)) issues.push(`${at}.${k}: credentials are not allowed in config.json; set the key in Settings.`);
      scan(x, `${at}.${k}`);
    }
  };
  scan(raw, 'config');

  const allowed = (o: Obj, keys: string[], at: string) => {
    for (const k of Object.keys(o)) if (!keys.includes(k) && !KEY_LIKE.test(k)) issues.push(`${at}.${k} is not a known setting.`);
  };
  const num = (v: unknown, at: string, min: number, max: number, integer = false): number | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
      issues.push(`${at} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}.`);
      return undefined;
    }
    return v;
  };
  const bool = (v: unknown, at: string): boolean | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') issues.push(`${at} must be true or false.`);
    return typeof v === 'boolean' ? v : undefined;
  };
  const perTask = <T>(v: unknown, at: string, check: (x: unknown) => x is T, what: string): Partial<Record<ModelTask, T>> | undefined => {
    if (v === undefined) return undefined;
    if (!isObj(v)) return void issues.push(`${at} must be an object keyed by task (${TASKS.join(', ')}).`), undefined;
    const out: Partial<Record<ModelTask, T>> = {};
    for (const [k, x] of Object.entries(v)) {
      if (!TASKS.includes(k as ModelTask)) issues.push(`${at}.${k} is not a task (${TASKS.join(', ')}).`);
      else if (!check(x)) issues.push(`${at}.${k} must be ${what}.`);
      else out[k as ModelTask] = x;
    }
    return out;
  };
  const budget = (v: unknown, at: string): Budget | undefined => {
    if (v === undefined) return undefined;
    if (!isObj(v)) return void issues.push(`${at} must be an object.`), undefined;
    allowed(v, ['softLimit', 'hardLimit', 'warnAt', 'targetPerVideo'], at);
    const out: Budget = {};
    const soft = num(v.softLimit, `${at}.softLimit`, 0, 100_000);
    const hard = num(v.hardLimit, `${at}.hardLimit`, 0, 100_000);
    const target = num(v.targetPerVideo, `${at}.targetPerVideo`, 0, 100_000);
    if (soft !== undefined) out.softLimit = soft;
    if (hard !== undefined) out.hardLimit = hard;
    if (target !== undefined) out.targetPerVideo = target;
    if (v.warnAt !== undefined) {
      if (!Array.isArray(v.warnAt) || !v.warnAt.every((f) => typeof f === 'number' && f > 0 && f <= 10)) issues.push(`${at}.warnAt must be a list of fractions such as [0.5, 0.8, 1].`);
      else out.warnAt = [...(v.warnAt as number[])].sort((a, b) => a - b);
    }
    return out;
  };
  const pricing = (v: unknown, at: string): PricingTable | undefined => {
    if (v === undefined) return undefined;
    if (!isObj(v)) return void issues.push(`${at} must be an object.`), undefined;
    allowed(v, ['version', 'currency', 'source', 'models'], at);
    if (typeof v.version !== 'string' || !v.version.trim()) issues.push(`${at}.version is required (bump it when prices change).`);
    if (v.currency !== 'USD') issues.push(`${at}.currency must be "USD".`);
    if (!isObj(v.models) || !Object.keys(v.models).length) return void issues.push(`${at}.models must list at least one model.`), undefined;
    const models: PricingTable['models'] = {};
    for (const [id, p] of Object.entries(v.models)) {
      const pat = `${at}.models.${id}`;
      if (!MODEL_ID.test(id)) issues.push(`${pat} is not a valid model id.`);
      if (!isObj(p)) {
        issues.push(`${pat} must be { input, output, cacheWrite, cacheRead } in USD per million tokens.`);
        continue;
      }
      allowed(p, ['input', 'output', 'cacheWrite', 'cacheRead'], pat);
      const [input, output, cacheWrite, cacheRead] = (['input', 'output', 'cacheWrite', 'cacheRead'] as const).map((k) => num(p[k], `${pat}.${k}`, 0, 10_000));
      if (p.input === undefined || p.output === undefined || p.cacheWrite === undefined || p.cacheRead === undefined) issues.push(`${pat} needs input, output, cacheWrite and cacheRead.`);
      else if ([input, output, cacheWrite, cacheRead].every((x) => x !== undefined)) models[id] = { input: input!, output: output!, cacheWrite: cacheWrite!, cacheRead: cacheRead! };
    }
    return { version: String(v.version ?? ''), currency: 'USD', source: typeof v.source === 'string' ? v.source : 'config.json', models };
  };

  allowed(raw, ['schema', 'version', 'models', 'effort', 'maxSegmentsPerBatch', 'maxOutputTokens', 'timeoutMs', 'retry', 'refusalFallback', 'fallbackToLocal', 'budget', 'projectBudgets', 'monthlyLimit', 'pricing'], 'config');
  if (raw.schema !== PLANNING_CONFIG_SCHEMA) issues.push(`config.schema must be "${PLANNING_CONFIG_SCHEMA}".`);
  if (raw.version !== PLANNING_CONFIG_VERSION) issues.push(`config.version must be ${PLANNING_CONFIG_VERSION}.`);

  const config: PlanningConfig = { schema: PLANNING_CONFIG_SCHEMA, version: PLANNING_CONFIG_VERSION };
  const models = perTask(raw.models, 'config.models', (x): x is string => typeof x === 'string' && MODEL_ID.test(x), 'a model id such as "claude-opus-5-5"');
  const effort = perTask(raw.effort, 'config.effort', (x): x is ModelCall['effort'] => EFFORTS.includes(x as ModelCall['effort']), `one of ${EFFORTS.join(', ')}`);
  if (models) config.models = models;
  if (effort) config.effort = effort;
  const batch = num(raw.maxSegmentsPerBatch, 'config.maxSegmentsPerBatch', 1, 50, true);
  const maxOut = num(raw.maxOutputTokens, 'config.maxOutputTokens', 256, 64_000, true);
  const timeout = num(raw.timeoutMs, 'config.timeoutMs', 5_000, 600_000, true);
  if (batch !== undefined) config.maxSegmentsPerBatch = batch;
  if (maxOut !== undefined) config.maxOutputTokens = maxOut;
  if (timeout !== undefined) config.timeoutMs = timeout;
  if (raw.retry !== undefined) {
    if (!isObj(raw.retry)) issues.push('config.retry must be an object.');
    else {
      allowed(raw.retry, ['maxAttempts', 'baseDelayMs', 'maxDelayMs'], 'config.retry');
      const retry: Partial<RetryPolicy> = {};
      const a = num(raw.retry.maxAttempts, 'config.retry.maxAttempts', 1, 10, true);
      const b = num(raw.retry.baseDelayMs, 'config.retry.baseDelayMs', 0, 120_000, true);
      const c = num(raw.retry.maxDelayMs, 'config.retry.maxDelayMs', 0, 600_000, true);
      if (a !== undefined) retry.maxAttempts = a;
      if (b !== undefined) retry.baseDelayMs = b;
      if (c !== undefined) retry.maxDelayMs = c;
      config.retry = retry;
    }
  }
  const refusal = bool(raw.refusalFallback, 'config.refusalFallback');
  const fallback = bool(raw.fallbackToLocal, 'config.fallbackToLocal');
  if (refusal !== undefined) config.refusalFallback = refusal;
  if (fallback !== undefined) config.fallbackToLocal = fallback;
  const b = budget(raw.budget, 'config.budget');
  if (b) config.budget = b;
  if (raw.projectBudgets !== undefined) {
    if (!isObj(raw.projectBudgets)) issues.push('config.projectBudgets must be an object keyed by project id.');
    else {
      config.projectBudgets = {};
      for (const [id, v] of Object.entries(raw.projectBudgets)) {
        if (!PROJECT_ID.test(id)) issues.push(`config.projectBudgets.${id} is not a valid project id.`);
        const pb = budget(v, `config.projectBudgets.${id}`);
        if (pb) config.projectBudgets[id] = pb;
      }
    }
  }
  const monthly = num(raw.monthlyLimit, 'config.monthlyLimit', 0, 100_000);
  if (monthly !== undefined) config.monthlyLimit = monthly;
  const p = pricing(raw.pricing, 'config.pricing');
  if (p) config.pricing = p;

  return issues.length ? { ok: false, issues: [...new Set(issues)] } : { ok: true, config };
}
