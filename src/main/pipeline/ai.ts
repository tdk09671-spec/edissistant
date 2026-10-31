// Claude (Anthropic) settings and checks for the editor: provider choice, connection test, model and
// spending limits, usage, and the reference material a run may send. The main process is the only
// place that ever holds the API key: it is read from the encrypted secrets store per request and is
// never returned to the renderer, written to a file other than secrets.bin, or put in a message.

import * as fs from 'fs';
import * as path from 'path';
import type { PlanningConfig } from '../../shared/planning/config';
import { DEFAULT_PRICING } from '../../shared/planning/cost';
import { DEFAULT_MODELS, type PlanningReferences } from '../../shared/planning/modelProvider';
import type { AiConfig, AiConfigUpdate, AiConnection, AiProvider, AiStatus, AiUsage, PlanReferences, ProjectPlanningInput } from '../../shared/pipeline/types';
import { testAnthropicConnection } from '../planning/anthropicTransport';
import type { PlanningService } from '../planning';

export class AiError extends Error {
  constructor(
    readonly code: 'PROVIDER_OFF' | 'NO_API_KEY' | 'INVALID_REQUEST' | 'INVALID_REFERENCE' | 'BUSY',
    message: string
  ) {
    super(message);
  }
}

export interface AiServiceOptions {
  planning: PlanningService;
  getApiKey: () => Promise<string | null | undefined>;
  encryptionAvailable: () => Promise<boolean>;
  /** Anthropic API base URL; only ever set in test mode (a local mock server). */
  baseURL?: string;
  now?: () => string;
  /** Override the connection test (tests). */
  testConnection?: typeof testAnthropicConnection;
}

interface AiState {
  provider: AiProvider;
  lastTest?: AiConnection;
}

export const REFERENCE_LIMITS = {
  notes: 20,
  noteChars: 2_000,
  images: 4,
  /** Raw bytes; base64 adds a third, which keeps each image under Anthropic's 5 MB limit. */
  imageBytes: 3_750_000,
};

const IMAGE_TYPES: Record<string, PlanningReferences['images'][number]['mediaType']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** The file really is the image type its name says (so a renamed video or document is refused). */
function sniff(head: Buffer, mediaType: string): boolean {
  if (mediaType === 'image/png') return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mediaType === 'image/jpeg') return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (mediaType === 'image/webp') return head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

export class AiService {
  constructor(private readonly options: AiServiceOptions) {}

  private get file(): string {
    return path.join(this.options.planning.store.root, 'ai.json');
  }

  private readState(): AiState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<AiState>;
      return { provider: raw.provider === 'anthropic' ? 'anthropic' : 'local', ...(raw.lastTest && typeof raw.lastTest === 'object' ? { lastTest: raw.lastTest } : {}) };
    } catch {
      return { provider: 'local' };
    }
  }

  private writeState(state: AiState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, this.file);
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  /** The model Claude runs use (config.json, else the built-in default). */
  model(): string {
    const config = this.options.planning.store.loadConfig();
    return (config.state === 'ok' ? config.config.models?.['creative-planning'] : undefined) ?? DEFAULT_MODELS['creative-planning'];
  }

  async status(): Promise<AiStatus> {
    const state = this.readState();
    const model = this.model();
    const config = this.options.planning.store.loadConfig();
    return {
      provider: state.provider,
      keyStored: Boolean(await this.options.getApiKey()),
      encryptionAvailable: await this.options.encryptionAvailable(),
      model,
      // A test of another model (or before the key changed; see keyChanged) says nothing about now.
      lastTest: state.lastTest && state.lastTest.model === model ? state.lastTest : null,
      ...(config.state === 'invalid' ? { configIssue: `${config.file} is invalid, so Claude won't be used until it is fixed: ${config.issues.join(' ')}` } : {}),
    };
  }

  async setProvider(provider: unknown): Promise<AiStatus> {
    if (provider !== 'local' && provider !== 'anthropic') throw new AiError('INVALID_REQUEST', 'provider must be "local" or "anthropic".');
    this.writeState({ ...this.readState(), provider });
    return this.status();
  }

  /** Called when the key is saved, replaced or removed: an old test result no longer applies. */
  keyChanged(): void {
    const { lastTest: _old, ...rest } = this.readState();
    this.writeState(rest);
  }

  /** Checks the stored key and model with Anthropic's Models API (free: no tokens are billed). */
  async test(): Promise<AiConnection> {
    const model = this.model();
    const apiKey = await this.options.getApiKey();
    let result: AiConnection;
    if (!apiKey) {
      result = { ok: false, at: this.now(), model, code: 'NO_API_KEY', message: 'No Claude API key is saved. Add one in Settings first.' };
    } else {
      const test = this.options.testConnection ?? testAnthropicConnection;
      const r = await test({ apiKey, model, timeoutMs: 15_000, ...(this.options.baseURL ? { baseURL: this.options.baseURL } : {}) });
      result = r.ok
        ? { ok: true, at: this.now(), model: r.model, ...(r.displayName ? { displayName: r.displayName } : {}) }
        : { ok: false, at: this.now(), model, code: r.code, message: r.message };
    }
    this.writeState({ ...this.readState(), lastTest: result });
    return result;
  }

  config(): AiConfig {
    const store = this.options.planning.store;
    const loaded = store.loadConfig();
    if (loaded.state === 'invalid') throw new AiError('INVALID_REQUEST', `${loaded.file} is invalid: ${loaded.issues.join(' ')} Fix or delete the file, then try again.`);
    const c: Partial<PlanningConfig> = loaded.state === 'ok' ? loaded.config : {};
    const pricing = c.pricing ?? DEFAULT_PRICING;
    return {
      model: c.models?.['creative-planning'] ?? DEFAULT_MODELS['creative-planning'],
      defaultModel: DEFAULT_MODELS['creative-planning'],
      knownModels: Object.keys(pricing.models),
      ...(c.budget?.softLimit !== undefined ? { softLimit: c.budget.softLimit } : {}),
      ...(c.budget?.hardLimit !== undefined ? { hardLimit: c.budget.hardLimit } : {}),
      ...(c.monthlyLimit !== undefined ? { monthlyLimit: c.monthlyLimit } : {}),
      pricingVersion: pricing.version,
    };
  }

  /** Writes the editor's settings into planning/config.json, keeping every other setting in it. */
  setConfig(raw: unknown): AiConfig {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new AiError('INVALID_REQUEST', 'Settings must be an object.');
    const update = raw as AiConfigUpdate;
    for (const k of Object.keys(update)) {
      if (!['model', 'softLimit', 'hardLimit', 'monthlyLimit'].includes(k)) throw new AiError('INVALID_REQUEST', `${k} is not an AI setting.`);
    }
    const store = this.options.planning.store;
    const loaded = store.loadConfig();
    if (loaded.state === 'invalid') throw new AiError('INVALID_REQUEST', `${loaded.file} is invalid: ${loaded.issues.join(' ')} Fix or delete the file, then try again.`);
    const before = this.model();
    const next: Record<string, unknown> = loaded.state === 'ok' ? (structuredClone(loaded.config) as unknown as Record<string, unknown>) : { schema: 'edissistant.planning-config', version: 1 };
    const money = (v: unknown, what: string): number | null => {
      if (v === null) return null;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100_000) throw new AiError('INVALID_REQUEST', `${what} must be an amount in USD from 0 to 100000.`);
      return Math.round(v * 100) / 100;
    };
    if (update.model !== undefined) {
      const models = { ...((next.models as Record<string, string>) ?? {}) };
      if (update.model === null || (typeof update.model === 'string' && !update.model.trim())) delete models['creative-planning'];
      else if (typeof update.model === 'string') models['creative-planning'] = update.model.trim();
      else throw new AiError('INVALID_REQUEST', 'model must be a model id such as claude-opus-5-5.');
      if (Object.keys(models).length) next.models = models;
      else delete next.models;
    }
    const budget = { ...((next.budget as Record<string, unknown>) ?? {}) };
    for (const k of ['softLimit', 'hardLimit'] as const) {
      if (update[k] === undefined) continue;
      const v = money(update[k], k === 'softLimit' ? 'The warning amount' : 'The project limit');
      if (v === null) delete budget[k];
      else budget[k] = v;
    }
    if (typeof budget.softLimit === 'number' && typeof budget.hardLimit === 'number' && budget.softLimit > budget.hardLimit) {
      throw new AiError('INVALID_REQUEST', 'The warning amount must not be above the project limit.');
    }
    if (Object.keys(budget).length) next.budget = budget;
    else delete next.budget;
    if (update.monthlyLimit !== undefined) {
      const v = money(update.monthlyLimit, 'The monthly limit');
      if (v === null) delete next.monthlyLimit;
      else next.monthlyLimit = v;
    }
    try {
      store.saveConfig(next);
    } catch (error) {
      throw new AiError('INVALID_REQUEST', error instanceof Error ? error.message : String(error));
    }
    if (this.model() !== before) this.keyChanged();
    return this.config();
  }

  usage(projectId?: unknown): AiUsage {
    const overview = this.options.planning.usageOverview();
    if (projectId === undefined) return overview;
    if (typeof projectId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(projectId)) throw new AiError('INVALID_REQUEST', 'Invalid project id.');
    const history = this.options.planning.usageHistory(projectId).map((e) => ({
      at: e.at,
      model: e.model,
      segments: e.segments,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheReadInputTokens: e.cacheReadInputTokens,
      cacheCreationInputTokens: e.cacheCreationInputTokens,
      estimatedCost: e.estimatedCost,
    }));
    return { ...overview, history };
  }

  /** Refuses a Claude run unless the editor chose Claude and a key is stored. */
  async assertCanRun(): Promise<void> {
    if (this.readState().provider !== 'anthropic') {
      throw new AiError('PROVIDER_OFF', 'Claude is turned off. Choose Anthropic Claude in Settings → AI planning to use it.');
    }
    if (!(await this.options.getApiKey())) throw new AiError('NO_API_KEY', 'No Claude API key is saved. Add one in Settings → AI planning.');
  }

  /** Why a run would be refused before anything is sent, or null. */
  async blocked(): Promise<string | null> {
    try {
      await this.assertCanRun();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Reads and checks the reference material the editor chose for a run. Notes are capped; images
   * must be PNG, JPEG or WebP files (checked by content, not just the name) under the size limit.
   * Nothing else is read, and videos are never accepted.
   */
  references(raw: PlanReferences | undefined, input?: Pick<ProjectPlanningInput, 'preset' | 'notes'>): PlanningReferences | undefined {
    if (!raw) return undefined;
    // The editor's own words, taken from the same request the plan is made from (never from a
    // separate field), and only the ones ticked in the dialog.
    const brief: NonNullable<PlanningReferences['brief']> = [];
    const pick = (on: boolean | undefined, kind: NonNullable<PlanningReferences['brief']>[number]['kind'], text: string | undefined) => {
      if (on && text?.trim()) brief.push({ kind, text });
    };
    pick(raw.brief?.creativeBrief, 'creative-brief', input?.preset.creativeBrief);
    pick(raw.brief?.brandingNotes, 'branding-notes', input?.preset.brandingNotes);
    pick(raw.brief?.projectNotes, 'project-notes', input?.notes);
    const notes = raw.notes.map((n) => n.trim()).filter(Boolean);
    if (notes.length > REFERENCE_LIMITS.notes) throw new AiError('INVALID_REFERENCE', `At most ${REFERENCE_LIMITS.notes} reference notes can be sent.`);
    for (const n of notes) {
      if (n.length > REFERENCE_LIMITS.noteChars) throw new AiError('INVALID_REFERENCE', `Each reference note can be at most ${REFERENCE_LIMITS.noteChars} characters.`);
    }
    const paths = [...new Set(raw.imagePaths)];
    if (paths.length > REFERENCE_LIMITS.images) throw new AiError('INVALID_REFERENCE', `At most ${REFERENCE_LIMITS.images} reference images can be sent.`);
    const images = paths.map((file) => {
      const name = path.basename(file);
      const mediaType = IMAGE_TYPES[path.extname(file).toLowerCase()];
      if (!mediaType) throw new AiError('INVALID_REFERENCE', `${name} isn't a PNG, JPEG or WebP image. Only still images can be sent; videos never are.`);
      if (!path.isAbsolute(file)) throw new AiError('INVALID_REFERENCE', `${name}: the path must be absolute.`);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        throw new AiError('INVALID_REFERENCE', `${name} was not found. It may have been moved or deleted.`);
      }
      if (!stat.isFile()) throw new AiError('INVALID_REFERENCE', `${name} is not a file.`);
      if (stat.size > REFERENCE_LIMITS.imageBytes) {
        throw new AiError('INVALID_REFERENCE', `${name} is ${(stat.size / 1e6).toFixed(1)} MB; reference images can be at most ${(REFERENCE_LIMITS.imageBytes / 1e6).toFixed(2)} MB.`);
      }
      const data = fs.readFileSync(file);
      if (!sniff(data.subarray(0, 16), mediaType)) throw new AiError('INVALID_REFERENCE', `${name} isn't a valid ${mediaType.slice(6).toUpperCase()} image.`);
      return { name, mediaType, base64: data.toString('base64') };
    });
    return { notes, images, ...(brief.length ? { brief } : {}) };
  }
}
