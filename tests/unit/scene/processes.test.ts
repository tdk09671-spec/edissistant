import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { killVerified, listProcesses, ownedTree, stillRunning, type ProcInfo } from '../../../src/main/scene/processes';
import { recoverAbandonedRenderArtifacts, registerPartial, writeOwnerMarker } from '../../../src/main/scene/recovery';

const P = (pid: number, ppid: number, start: string, name = 'x'): ProcInfo => ({ pid, ppid, start, name });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('process ownership (PID + start time)', () => {
  it('owned tree: the host and descendants that started after their parent; stale parent links are ignored', () => {
    const list = [
      P(100, 1, '5000', 'electron'), // host
      P(101, 100, '5001', 'zygote'),
      P(102, 101, '5002', 'renderer'),
      P(103, 100, '5003', 'gpu'),
      P(200, 100, '4000', 'old-unrelated'), // claims parent 100 but started BEFORE the host: a reused PID's stale link
      P(300, 1, '5004', 'user-ffmpeg'),
    ];
    const owned = ownedTree({ pid: 100, start: '5000' }, list);
    expect(owned.map((o) => [o.pid, o.role])).toEqual([[100, 'host'], [101, 'helper'], [103, 'helper'], [102, 'helper']]);
    // A host record whose start time doesn't match (PID reused) owns nothing.
    expect(ownedTree({ pid: 100, start: '4999' }, list)).toEqual([]);
  });

  it('still running: exited, reused (same PID, different start) and alive are told apart', () => {
    const owned = [P(101, 100, '5001'), P(102, 100, '5002'), P(103, 100, '5003')];
    const now = [P(102, 1, '9999'), P(103, 1, '5003')];
    expect(stillRunning(owned, now)).toEqual({ alive: [P(103, 100, '5003')], exited: [101], reused: [102] });
  });

  it('never kills a reused PID: an unrelated live process with a recorded PID but another start time survives', async () => {
    if (process.platform === 'win32') return; // the Windows path is covered by the scene suite
    const unrelated = spawn('sleep', ['30']);
    await sleep(100);
    const real = listProcesses().find((p) => p.pid === unrelated.pid)!;
    expect(real).toBeTruthy();
    // A stale ownership record for that PID (as if our helper had exited and the PID been reused).
    const stale = { ...real, start: String(BigInt(real.start) - 1n) };
    const r = killVerified([stale]);
    expect(r).toEqual({ killed: [], skipped: [{ pid: unrelated.pid, reason: 'reused' }] });
    await sleep(100);
    expect(alive(unrelated.pid!)).toBe(true);
    // With its real identity it would be stopped (the leftover-helper case).
    expect(killVerified([real]).killed).toEqual([unrelated.pid]);
    await new Promise((r) => unrelated.once('exit', r));
  });
});

describe('crash recovery', () => {
  let tmp: string;
  let state: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-tmp-'));
    state = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-state-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  });

  const marked = (name: string, owner: { pid: number; start: string }) => {
    const d = path.join(tmp, name);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'owner.json'), JSON.stringify({ app: 'edissistant-scene', owner, created: '2026-01-01' }));
    fs.writeFileSync(path.join(d, 'Cookies'), 'chromium');
    return d;
  };

  it('removes only marked job folders whose owner is gone; keeps live owners, unmarked and look-alike folders', () => {
    const procs = [P(4242, 1, '777')];
    const dead = marked('edissistant-scene-dead', { pid: 9999, start: '1' });
    const reused = marked('edissistant-scene-reused', { pid: 4242, start: '776' }); // PID now belongs to someone else
    const live = marked('edissistant-scene-live', { pid: 4242, start: '777' });
    const unmarked = path.join(tmp, 'edissistant-scene-unmarked');
    fs.mkdirSync(unmarked);
    const other = path.join(tmp, 'someone-elses-folder');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'owner.json'), JSON.stringify({ app: 'edissistant-scene', owner: { pid: 9999, start: '1' } }));
    const r = recoverAbandonedRenderArtifacts({ stateDir: state, tmpDir: tmp, processes: procs });
    expect(r.removedJobFolders.sort()).toEqual([dead, reused].sort());
    for (const d of [live, unmarked, other]) expect(fs.existsSync(d)).toBe(true);
    expect(r.kept.map((k) => k.reason)).toEqual(expect.arrayContaining(['owner still running', 'no Edissistant owner marker']));
  });

  it("removes a crashed render's registered partial, never the finished export or other files", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-out-'));
    try {
      const output = path.join(out, 'trailer_v3.mov');
      fs.writeFileSync(output, 'finished export from an earlier render');
      fs.writeFileSync(path.join(out, 'client-asset.mov'), 'user asset');
      const { partial } = registerPartial(state, output, 'mov');
      fs.writeFileSync(partial, 'half-written');
      fs.writeFileSync(`${output}.edissistant-partial-0000000000000000.mov`, 'not registered: never touched');
      // Make the registry entry belong to a dead process.
      const reg = path.join(state, 'partials');
      const entry = path.join(reg, fs.readdirSync(reg)[0]);
      const rec = JSON.parse(fs.readFileSync(entry, 'utf8'));
      fs.writeFileSync(entry, JSON.stringify({ ...rec, owner: { pid: 9999, start: '1' } }));
      const r = recoverAbandonedRenderArtifacts({ stateDir: state, tmpDir: tmp, processes: [] });
      expect(r.removedPartials).toEqual([partial]);
      expect(fs.existsSync(partial)).toBe(false);
      expect(fs.readdirSync(out).sort()).toEqual(['client-asset.mov', 'trailer_v3.mov', 'trailer_v3.mov.edissistant-partial-0000000000000000.mov']);
      expect(fs.readdirSync(reg)).toEqual([]);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  it("a registered partial of a render still in progress (owner alive) is left alone", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-out-'));
    try {
      const { partial } = registerPartial(state, path.join(out, 'x.mov'), 'mov');
      fs.writeFileSync(partial, 'in progress');
      const r = recoverAbandonedRenderArtifacts({ stateDir: state, tmpDir: tmp }); // this process is alive
      expect(r.removedPartials).toEqual([]);
      expect(fs.existsSync(partial)).toBe(true);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  it('the owner marker names this process by PID and start time', () => {
    const d = fs.mkdtempSync(path.join(tmp, 'edissistant-scene-'));
    writeOwnerMarker(d);
    const m = JSON.parse(fs.readFileSync(path.join(d, 'owner.json'), 'utf8'));
    expect(m.owner.pid).toBe(process.pid);
    expect(m.owner.start).toBe(listProcesses().find((p) => p.pid === process.pid)?.start);
  });
});
