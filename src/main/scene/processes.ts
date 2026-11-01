// Process ownership for render jobs: which processes belong to a job, and how to stop leftovers
// without ever touching anything else.
//
// The Windows report found that cleanup ran `taskkill /T` on the host's PID after the host had exited;
// the PID had been reused and an unrelated process tree was targeted. Rules here:
//  1. A process is identified by (PID, OS start time), never by PID alone.
//  2. The host itself is stopped only through its ChildProcess handle while it is still our unreaped
//     child (the OS cannot reuse its PID before that).
//  3. Helpers (Chromium's GPU, network and renderer processes) are recorded while the host is alive, as
//     descendants of the host by parent PID, each with its own start time; a child must have started
//     after its parent (rules out stale parent links to a reused PID).
//  4. After the host exits, a recorded helper is killed only if a process with that PID still exists AND
//     has the recorded start time, checked immediately before the kill. On Windows the check and the kill
//     use the same process handle (no window for reuse). No tree kills (/T), no process-group kills.

import { spawnSync } from 'child_process';
import * as fs from 'fs';

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** OS start time, opaque but comparable: Linux clock ticks since boot; Windows FILETIME in ms; else ps lstart. */
  start: string;
  name: string;
}

export interface OwnedProcess extends ProcInfo {
  role: 'host' | 'helper';
}

export interface CleanupReport {
  /** Processes owned by the job (recorded while it ran). */
  owned: OwnedProcess[];
  /** Exited by themselves. */
  exited: number[];
  /** Killed after their identity (PID + start time) was confirmed. */
  killed: number[];
  /** Not touched: the PID now belongs to a different process (reused) or couldn't be verified. */
  skipped: { pid: number; reason: string }[];
}

function linuxList(): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).split(' ');
      // fields[0] = state, [1] = ppid, … [19] = starttime (field 22 of stat)
      out.push({ pid: Number(d), ppid: Number(fields[1]), start: fields[19], name: stat.slice(stat.indexOf('(') + 1, close) });
    } catch {
      // exited while listing
    }
  }
  return out;
}

const PS = 'powershell.exe';
const psArgs = (script: string) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];

function windowsList(): ProcInfo[] {
  const script =
    "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, [math]::Floor($_.CreationDate.ToFileTimeUtc() / 10000), $_.Name }";
  const r = spawnSync(PS, psArgs(script), { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`Could not list processes: ${r.stderr || r.error?.message}`);
  return r.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [pid, ppid, start, ...name] = l.split('|');
      return { pid: Number(pid), ppid: Number(ppid), start, name: name.join('|') };
    })
    .filter((p) => p.pid > 0);
}

function psList(): ProcInfo[] {
  const r = spawnSync('ps', ['-axo', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8' });
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(l);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), start: m[3], name: m[4] } : null;
    })
    .filter((p): p is ProcInfo => p !== null);
}

/** All processes, with parent and start time. */
export function listProcesses(platform: NodeJS.Platform = process.platform): ProcInfo[] {
  if (platform === 'linux') return linuxList();
  if (platform === 'win32') return windowsList();
  return psList();
}

/** Start-time comparison (Linux/ps: exact; Windows: the ms values from CreationDate). */
export function startBefore(a: string, b: string): boolean {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return BigInt(a) <= BigInt(b);
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) ? ta <= tb : true;
}

/**
 * The host and its descendants (by parent PID), from one process listing. A child only counts if it
 * started no earlier than its parent, so a reused PID with a stale parent link is never adopted.
 */
export function ownedTree(host: { pid: number; start: string }, list: ProcInfo[]): OwnedProcess[] {
  const self = list.find((p) => p.pid === host.pid && p.start === host.start);
  if (!self) return [];
  const out: OwnedProcess[] = [{ ...self, role: 'host' }];
  const queue = [self];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const c of list) {
      if (c.ppid === parent.pid && c.pid !== parent.pid && startBefore(parent.start, c.start) && !out.some((o) => o.pid === c.pid)) {
        out.push({ ...c, role: 'helper' });
        queue.push(c);
      }
    }
  }
  return out;
}

/** Which recorded processes are still running with the same identity (PID + start time). */
export function stillRunning(owned: ProcInfo[], list: ProcInfo[]): { alive: ProcInfo[]; exited: number[]; reused: number[] } {
  const alive: ProcInfo[] = [];
  const exited: number[] = [];
  const reused: number[] = [];
  for (const o of owned) {
    const now = list.find((p) => p.pid === o.pid);
    if (!now) exited.push(o.pid);
    else if (now.start !== o.start) reused.push(o.pid);
    else alive.push(o);
  }
  return { alive, exited, reused };
}

/** Kills processes only if they still have the recorded identity. Returns what was killed. */
export function killVerified(targets: ProcInfo[], platform: NodeJS.Platform = process.platform): { killed: number[]; skipped: { pid: number; reason: string }[] } {
  const killed: number[] = [];
  const skipped: { pid: number; reason: string }[] = [];
  if (!targets.length) return { killed, skipped };
  if (platform === 'win32') {
    // Open each process, compare its start time through the same handle, and terminate through it.
    const list = targets.map((t) => `@(${t.pid},${t.start})`).join(',');
    const script = [
      `foreach ($t in @(${list})) {`,
      '  try { $p = [System.Diagnostics.Process]::GetProcessById($t[0]) } catch { Write-Output "$($t[0])|gone"; continue }',
      '  try { $s = [math]::Floor($p.StartTime.ToUniversalTime().ToFileTimeUtc() / 10000) } catch { Write-Output "$($t[0])|unverifiable"; continue }',
      '  if ($s -ne $t[1]) { Write-Output "$($t[0])|reused"; continue }',
      '  try { $p.Kill(); Write-Output "$($t[0])|killed" } catch { Write-Output "$($t[0])|kill-failed" }',
      '}',
    ].join('\n');
    const r = spawnSync(PS, psArgs(script), { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    for (const line of (r.stdout ?? '').split(/\r?\n/).filter(Boolean)) {
      const [pid, what] = line.split('|');
      if (what === 'killed') killed.push(Number(pid));
      else if (what !== 'gone') skipped.push({ pid: Number(pid), reason: what });
    }
    return { killed, skipped };
  }
  const now = listProcesses(platform);
  for (const t of targets) {
    const cur = now.find((p) => p.pid === t.pid);
    if (!cur) continue;
    if (cur.start !== t.start) {
      skipped.push({ pid: t.pid, reason: 'reused' });
      continue;
    }
    try {
      process.kill(t.pid, 'SIGKILL');
      killed.push(t.pid);
    } catch {
      skipped.push({ pid: t.pid, reason: 'kill-failed' });
    }
  }
  return { killed, skipped };
}

/** This process's own identity (cached). */
let selfIdentity: { pid: number; start: string } | null = null;
export function selfProcess(): { pid: number; start: string } {
  if (!selfIdentity) {
    const me = listProcesses().find((p) => p.pid === process.pid);
    selfIdentity = { pid: process.pid, start: me?.start ?? 'unknown' };
  }
  return selfIdentity;
}

/** True if a process with exactly this identity is running. */
export function isRunning(id: { pid: number; start: string }, list?: ProcInfo[]): boolean {
  const l = list ?? listProcesses();
  return l.some((p) => p.pid === id.pid && p.start === id.start);
}
