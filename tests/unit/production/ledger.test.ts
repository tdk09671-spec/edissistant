import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonical, RequestLedger, type LedgerItem } from '../../../src/main/production/ledger';

// The duplicate-Generate case from Windows testing of PR #7, replayed with a mocked Claude:
// 24 rows → 2 requests, Claude answers 11; Generate again with no changes must send nothing.

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

type Input = { text: string; instruction: string; model: string };
const rows = (n: number, edit: Record<number, string> = {}): LedgerItem<Input>[] =>
  Array.from({ length: n }, (_, i) => ({ id: `row-${i + 1}`, input: { text: edit[i] ?? `Line ${i + 1}`, instruction: '', model: 'claude-opus-5-5' } }));

/** Mocked Claude: answers only the ids in `answers` (like a reply that skips rows). */
function mockClaude(answerIds: Set<string>) {
  const calls: string[][] = [];
  const send = async (batch: LedgerItem<Input>[]) => {
    calls.push(batch.map((b) => b.id));
    return Object.fromEntries(batch.filter((b) => answerIds.has(b.id)).map((b) => [b.id, `<scene for ${b.id}>`]));
  };
  return { calls, send };
}

describe('request ledger (duplicate-Generate safeguard)', () => {
  it('24 rows, 11 answered: the first Generate makes 2 requests; Generate again unchanged makes none', async () => {
    const file = path.join(dir, 'p1.json');
    const answered = new Set(['row-1', 'row-2', 'row-3', 'row-5', 'row-8', 'row-9', 'row-13', 'row-14', 'row-20', 'row-21', 'row-24']);
    const claude = mockClaude(answered);
    const ledger = new RequestLedger<Input, string>(file);
    const first = await ledger.generate(rows(24), claude.send);
    expect(first.requests).toBe(2);
    expect(first.answered).toHaveLength(11);
    expect(first.noAnswer).toHaveLength(13);

    // Second click, nothing changed: no paid request. The 13 are reported, not silently resent.
    const second = await ledger.generate(rows(24), claude.send);
    expect(second.requests).toBe(0);
    expect(claude.calls).toHaveLength(2);
    expect(second.reused).toHaveLength(11);
    expect(second.unanswered.map((u) => u.id)).toEqual(first.noAnswer.map((u) => u.id));

    // Reopening the project (a new ledger from disk) behaves the same.
    const reopened = await new RequestLedger<Input, string>(file).generate(rows(24), claude.send);
    expect(reopened.requests).toBe(0);
    expect(claude.calls).toHaveLength(2);
  });

  it('only changed rows are sent; unanswered rows go again only when deliberately regenerated, with a reason', async () => {
    const claude = mockClaude(new Set(rows(24).map((r) => r.id).filter((id) => id !== 'row-4')));
    const ledger = new RequestLedger<Input, string>(path.join(dir, 'p2.json'));
    await ledger.generate(rows(24), claude.send);
    expect(claude.calls.flat()).toHaveLength(24);

    // The editor edits row 7: exactly that row is sent.
    const edited = await ledger.generate(rows(24, { 6: 'Line 7, reworded' }), claude.send);
    expect(edited.requests).toBe(1);
    expect(claude.calls.at(-1)).toEqual(['row-7']);
    expect(edited.unanswered.map((u) => u.id)).toEqual(['row-4']);

    // Regenerating needs a reason, and then sends only what was asked for.
    await expect(ledger.generate(rows(24, { 6: 'Line 7, reworded' }), claude.send, { regenerate: { ids: ['row-4'], reason: ' ' } })).rejects.toThrow(/reason/);
    const regen = await ledger.generate(rows(24, { 6: 'Line 7, reworded' }), claude.send, { regenerate: { ids: ['row-4'], reason: 'Claude skipped it' } });
    expect(regen.requests).toBe(1);
    expect(claude.calls.at(-1)).toEqual(['row-4']);
    expect(ledger.regenerations).toEqual([{ at: expect.any(String), ids: ['row-4'], reason: 'Claude skipped it' }]);
  });

  it('a double click joins the request already in flight (one paid call)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const ledger = new RequestLedger<Input, string>(path.join(dir, 'p3.json'));
    const send = async (batch: LedgerItem<Input>[]) => {
      calls++;
      await gate;
      return Object.fromEntries(batch.map((b) => [b.id, 'ok']));
    };
    const a = ledger.generate(rows(5), send);
    const b = ledger.generate(rows(5), send);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(rb).toBe(ra);
  });

  it('a failure part-way keeps what was already paid for', async () => {
    const ledger = new RequestLedger<Input, string>(path.join(dir, 'p4.json'));
    let n = 0;
    const flaky = async (batch: LedgerItem<Input>[]) => {
      if (++n === 2) throw new Error('network');
      return Object.fromEntries(batch.map((b) => [b.id, 'ok']));
    };
    await expect(ledger.generate(rows(24), flaky)).rejects.toThrow('network');
    const plan = ledger.partition(rows(24));
    expect(plan.reused).toHaveLength(12); // the first batch was answered and recorded
    expect(plan.toSend).toHaveLength(12);
  });

  it('fingerprints ignore key order but not content', () => {
    expect(canonical({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(canonical({ a: [1, { c: 3, d: 2 }], b: 1 }));
    expect(canonical({ a: 1 })).not.toBe(canonical({ a: 2 }));
  });
});
