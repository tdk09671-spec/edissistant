// Local persistence for the planning engine (all under <userData>): style profiles with revision
// history, per-client usage history (for cross-video variety), project plans, and usage/cost logs.
// Atomic writes; no API keys or prompts are ever written.

import * as fs from 'fs';
import * as path from 'path';
import { parsePlanningConfig, type PlanningConfig } from '../../shared/planning/config';
import type { UsageEntry } from '../../shared/planning/cost';
import type { ModelReply } from '../../shared/planning/modelProvider';
import { parseStyleProfile } from '../../shared/planning/styleProfile';
import { PROJECT_PLAN_SCHEMA, type ClientUsageHistory, type ProjectPlan, type StyleProfile } from '../../shared/planning/types';
import { effectiveSegment } from '../../shared/planning/approval';

const SAFE = /^[A-Za-z0-9_.-]{1,128}$/;
/** Device names Windows reserves in any folder, with or without an extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function safeName(id: string): string {
  // Also refuses a trailing dot, which Windows strips (two ids would share one file).
  if (!SAFE.test(id) || id.startsWith('.') || id.endsWith('.') || WINDOWS_RESERVED.test(id)) throw new Error(`Invalid id "${id}"`);
  return id;
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** config.json state: absent (defaults apply), valid, or invalid (with every problem listed). */
export type ConfigState = { state: 'missing'; file: string } | { state: 'ok'; file: string; config: PlanningConfig } | { state: 'invalid'; file: string; issues: string[] };

export class PlanningStore {
  constructor(private readonly root: string, private readonly keepRevisions = 10) {}

  get configFile(): string {
    return path.join(this.root, 'config.json');
  }

  /** Reads <root>/config.json fresh each time, so edits apply on the next run without a restart. */
  loadConfig(): ConfigState {
    const file = this.configFile;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing', file };
      return { state: 'invalid', file, issues: [`Couldn't read the file (${(e as Error).message}).`] };
    }
    let raw: unknown;
    try {
      // Notepad can save "UTF-8 with BOM"; JSON.parse rejects the BOM.
      raw = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (e) {
      return { state: 'invalid', file, issues: [`Not valid JSON (${(e as Error).message}).`] };
    }
    const parsed = parsePlanningConfig(raw);
    return parsed.ok ? { state: 'ok', file, config: parsed.config } : { state: 'invalid', file, issues: parsed.issues };
  }

  /** Validates and writes config.json (for a future settings screen). Throws with every problem. */
  saveConfig(config: unknown): PlanningConfig {
    const parsed = parsePlanningConfig(config);
    if (!parsed.ok) throw new Error(`Invalid planning config: ${parsed.issues.join(' ')}`);
    writeJson(this.configFile, parsed.config);
    return parsed.config;
  }

  private profileFile(id: string): string {
    return path.join(this.root, 'style-profiles', `${safeName(id)}.json`);
  }

  /** Saves a profile; the previous revision is kept in `<id>.history/` (up to keepRevisions). */
  saveProfile(profile: StyleProfile): void {
    const file = this.profileFile(profile.id);
    const current = readJson<StyleProfile>(file);
    if (current && current.fingerprint !== profile.fingerprint) {
      const historyDir = path.join(path.dirname(file), `${profile.id}.history`);
      writeJson(path.join(historyDir, `r${String(current.revision).padStart(5, '0')}.json`), current);
      const old = fs.readdirSync(historyDir).sort();
      for (const f of old.slice(0, Math.max(0, old.length - this.keepRevisions))) fs.rmSync(path.join(historyDir, f), { force: true });
    }
    writeJson(file, profile);
  }

  loadProfile(id: string): StyleProfile | null {
    const data = readJson<unknown>(this.profileFile(id));
    if (!data) return null;
    try {
      return parseStyleProfile(data);
    } catch {
      return null;
    }
  }

  profileRevisions(id: string): number[] {
    const dir = path.join(this.root, 'style-profiles', `${safeName(id)}.history`);
    try {
      return fs.readdirSync(dir).map((f) => Number(/^r(\d+)\.json$/.exec(f)?.[1])).filter(Number.isFinite).sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  listProfiles(): string[] {
    try {
      return fs.readdirSync(path.join(this.root, 'style-profiles')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
  }

  // --- plans ---

  savePlan(plan: ProjectPlan): void {
    writeJson(path.join(this.root, 'plans', `${safeName(plan.projectId)}.json`), plan);
  }

  loadPlan(projectId: string): ProjectPlan | null {
    const plan = readJson<ProjectPlan>(path.join(this.root, 'plans', `${safeName(projectId)}.json`));
    return plan?.schema === PROJECT_PLAN_SCHEMA ? plan : null;
  }

  // --- client usage history (cross-video variety) ---

  clientHistory(clientId: string): ClientUsageHistory {
    return readJson<ClientUsageHistory>(path.join(this.root, 'client-history', `${safeName(clientId)}.json`)) ?? { clientId, projects: [] };
  }

  /** Records the approved concepts of a project (most recent first, last `keep` projects). */
  recordProjectUsage(clientId: string, plan: ProjectPlan, at: string, keep = 5): ClientUsageHistory {
    const approved = plan.segments.filter((s) => s.status === 'approved').map((s) => effectiveSegment(s));
    const entry = { projectId: plan.projectId, concepts: approved.map((s) => s.conceptId), transitions: approved.map((s) => s.transition), at };
    const history = this.clientHistory(clientId);
    const next: ClientUsageHistory = { clientId, projects: [entry, ...history.projects.filter((p) => p.projectId !== plan.projectId)].slice(0, keep) };
    writeJson(path.join(this.root, 'client-history', `${safeName(clientId)}.json`), next);
    return next;
  }

  // --- response cache: validated model replies by request hash (replies may quote transcript words;
  // prompts and keys are never stored) ---

  getCachedReply(key: string): ModelReply | null {
    if (!/^[a-f0-9]{64}$/.test(key)) return null;
    const r = readJson<ModelReply>(path.join(this.root, 'model-cache', `${key}.json`));
    return r && typeof r.text === 'string' && r.usage && typeof r.model === 'string' ? r : null;
  }

  setCachedReply(key: string, reply: ModelReply): void {
    if (!/^[a-f0-9]{64}$/.test(key)) return;
    writeJson(path.join(this.root, 'model-cache', `${key}.json`), { text: reply.text, stopReason: reply.stopReason, usage: reply.usage, model: reply.model });
  }

  // --- usage / cost log ---

  /** Project ids with a usage log. */
  usageProjects(): string[] {
    try {
      return fs
        .readdirSync(path.join(this.root, 'usage'))
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => f.slice(0, -'.jsonl'.length))
        .filter((id) => SAFE.test(id));
    } catch {
      return [];
    }
  }

  appendUsage(entries: UsageEntry[]): void {
    for (const e of entries) {
      const file = path.join(this.root, 'usage', `${safeName(e.projectId)}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(e)}\n`, 'utf8');
    }
  }

  /**
   * Reads the usage log. A damaged line (e.g. half-written when the app was killed) is skipped on its
   * own, so the rest of the recorded spend still counts towards the project's limits.
   */
  loadUsage(projectId: string): UsageEntry[] {
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.root, 'usage', `${safeName(projectId)}.jsonl`), 'utf8');
    } catch {
      return [];
    }
    const entries: UsageEntry[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as UsageEntry;
        if (e && typeof e === 'object' && typeof e.projectId === 'string') entries.push(e);
      } catch {
        // skip the damaged line only
      }
    }
    return entries;
  }
}
