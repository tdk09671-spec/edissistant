// Crash recovery for render artifacts Edissistant itself created, and nothing else.
//
// A hard kill of the app can leave a job folder in the temp directory (the host's profile and IPC socket)
// and a partial output next to the editor's chosen output path. Recovery removes only:
//  - temp folders named edissistant-scene-* that contain an owner.json marker written by Edissistant, whose
//    owning process (PID + start time) is no longer running;
//  - partial outputs listed in Edissistant's own registry (<stateDir>/partials/*.json), whose owner is no
//    longer running, and only if the file name still has the registered partial suffix.
// Unmarked folders, completed exports, user assets and other applications' files are never touched, and
// user folders are never scanned.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isRunning, listProcesses, selfProcess, type ProcInfo } from './processes';

export const JOB_DIR_PREFIX = 'edissistant-scene-';
const MARKER = 'owner.json';
const APP = 'edissistant-scene';

interface Marker {
  app: typeof APP;
  owner: { pid: number; start: string };
  created: string;
}

export function writeOwnerMarker(dir: string): void {
  const m: Marker = { app: APP, owner: selfProcess(), created: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify(m), { mode: 0o600 });
}

/** Registers a partial output before it is written; returns its path and a function to unregister. */
export function registerPartial(stateDir: string, output: string, ext: string): { partial: string; done: () => void } {
  const token = crypto.randomBytes(8).toString('hex');
  const partial = `${output}.edissistant-partial-${token}.${ext}`;
  const dir = path.join(stateDir, 'partials');
  fs.mkdirSync(dir, { recursive: true });
  const entry = path.join(dir, `${token}.json`);
  fs.writeFileSync(entry, JSON.stringify({ app: APP, partial, token, owner: selfProcess(), created: new Date().toISOString() }));
  return { partial, done: () => fs.rmSync(entry, { force: true }) };
}

export interface RecoveryReport {
  removedJobFolders: string[];
  removedPartials: string[];
  kept: { path: string; reason: string }[];
}

/** Removes abandoned Edissistant render artifacts. Safe to run at every app start. */
export function recoverAbandonedRenderArtifacts(opts: { stateDir: string; tmpDir?: string; processes?: ProcInfo[] }): RecoveryReport {
  const report: RecoveryReport = { removedJobFolders: [], removedPartials: [], kept: [] };
  const list = opts.processes ?? listProcesses();
  const tmp = opts.tmpDir ?? os.tmpdir();
  let names: string[] = [];
  try {
    names = fs.readdirSync(tmp).filter((n) => n.startsWith(JOB_DIR_PREFIX));
  } catch {
    names = [];
  }
  for (const n of names) {
    const dir = path.join(tmp, n);
    let m: Marker | null = null;
    try {
      if (!fs.lstatSync(dir).isDirectory()) continue;
      m = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')) as Marker;
    } catch {
      report.kept.push({ path: dir, reason: 'no Edissistant owner marker' });
      continue;
    }
    if (m?.app !== APP || typeof m.owner?.pid !== 'number' || typeof m.owner?.start !== 'string') {
      report.kept.push({ path: dir, reason: 'unrecognised marker' });
      continue;
    }
    if (isRunning(m.owner, list)) {
      report.kept.push({ path: dir, reason: 'owner still running' });
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      report.removedJobFolders.push(dir);
    } catch (e) {
      report.kept.push({ path: dir, reason: `could not remove: ${(e as Error).message}` });
    }
  }
  const reg = path.join(opts.stateDir, 'partials');
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(reg).filter((n) => /^[0-9a-f]{16}\.json$/.test(n));
  } catch {
    entries = [];
  }
  for (const e of entries) {
    const file = path.join(reg, e);
    let rec: { app?: string; partial?: string; token?: string; owner?: { pid: number; start: string } };
    try {
      rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      report.kept.push({ path: file, reason: 'unreadable registry entry' });
      continue;
    }
    if (rec.app !== APP || !rec.partial || !rec.token || !rec.owner || `${rec.token}.json` !== e) {
      report.kept.push({ path: file, reason: 'unrecognised registry entry' });
      continue;
    }
    if (isRunning(rec.owner, list)) continue; // a render in progress
    // Only the registered partial name, with its token; never the final output or anything else.
    if (path.basename(rec.partial).includes(`.edissistant-partial-${rec.token}.`)) {
      try {
        if (fs.existsSync(rec.partial)) {
          fs.rmSync(rec.partial, { force: true });
          report.removedPartials.push(rec.partial);
        }
      } catch (err) {
        report.kept.push({ path: rec.partial, reason: `could not remove: ${(err as Error).message}` });
        continue;
      }
    } else {
      report.kept.push({ path: rec.partial, reason: 'name is not a registered partial' });
    }
    fs.rmSync(file, { force: true });
  }
  return report;
}
