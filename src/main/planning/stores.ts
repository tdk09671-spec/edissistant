// Local persistence for the planning engine (all under <userData>): style profiles with revision
// history, per-client usage history (for cross-video variety), project plans, and usage/cost logs.
// Atomic writes; no API keys or prompts are ever written.

import * as fs from 'fs';
import * as path from 'path';
import type { UsageEntry } from '../../shared/planning/cost';
import { parseStyleProfile } from '../../shared/planning/styleProfile';
import { PROJECT_PLAN_SCHEMA, type ClientUsageHistory, type ProjectPlan, type StyleProfile } from '../../shared/planning/types';
import { effectiveSegment } from '../../shared/planning/approval';

const SAFE = /^[A-Za-z0-9_.-]{1,128}$/;

function safeName(id: string): string {
  if (!SAFE.test(id) || id.startsWith('.')) throw new Error(`Invalid id "${id}"`);
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

export class PlanningStore {
  constructor(private readonly root: string, private readonly keepRevisions = 10) {}

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

  // --- usage / cost log ---

  appendUsage(entries: UsageEntry[]): void {
    for (const e of entries) {
      const file = path.join(this.root, 'usage', `${safeName(e.projectId)}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(e)}\n`, 'utf8');
    }
  }

  loadUsage(projectId: string): UsageEntry[] {
    try {
      return fs
        .readFileSync(path.join(this.root, 'usage', `${safeName(projectId)}.jsonl`), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as UsageEntry);
    } catch {
      return [];
    }
  }
}
