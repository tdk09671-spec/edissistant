// Request ledger for paid Claude work (designs, animation code, captions, revisions).
//
// Fixes the duplicate-Generate problem found in Windows testing of PR #7: in a 24-row project the first
// Generate sent 2 requests and Claude answered only 11 rows; clicking Generate again with nothing changed
// sent 2 more paid requests for the 13 unanswered rows, because they were still "unplanned" and the new
// batch didn't match any cached request.
//
// Here every item (a segment's design, its animation, a caption page…) has a fingerprint of exactly what
// would be sent for it. The ledger remembers, per item fingerprint, whether Claude answered it or was asked
// and gave no answer. Then:
//  - an unchanged item that was answered is reused, never re-sent;
//  - an unchanged item that was asked and not answered is NOT re-sent automatically; it is reported, and
//    only a deliberate regenerate (with a reason the editor chose) sends it again;
//  - a changed item (new fingerprint) is sent;
//  - two clicks while a request is in flight join the same request (single flight).

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Canonical JSON (sorted keys) so equal inputs always hash equally. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

export interface LedgerItem<I> {
  /** Stable id (e.g. segment id + kind). */
  id: string;
  /** Everything that would be sent for this item: text, instruction, approved design code, model, style… */
  input: I;
}

export type ItemState<A> =
  | { status: 'answered'; answer: A; at: string; request: string }
  | { status: 'no-answer'; at: string; request: string; attempts: number };

interface Stored<A> {
  version: 1;
  items: Record<string, ItemState<A>>;
  regenerations: { at: string; ids: string[]; reason: string }[];
}

export interface Partition<I, A> {
  /** New or changed items: will be sent. */
  toSend: LedgerItem<I>[];
  /** Answered before with exactly this input: reused, free. */
  reused: { item: LedgerItem<I>; answer: A }[];
  /** Asked before with exactly this input, but Claude gave no answer: not re-sent unless regenerated. */
  unanswered: LedgerItem<I>[];
}

export class RequestLedger<I, A> {
  private data: Stored<A>;
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly file: string) {
    this.data = this.load();
  }

  private load(): Stored<A> {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Stored<A>;
      if (d.version === 1 && d.items) return d;
    } catch {
      // first use
    }
    return { version: 1, items: {}, regenerations: [] };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }

  static key(item: LedgerItem<unknown>): string {
    return fingerprint({ id: item.id, input: item.input });
  }

  /** What a Generate would do for these items, without sending anything. */
  partition(items: LedgerItem<I>[], regenerate: string[] = []): Partition<I, A> {
    const out: Partition<I, A> = { toSend: [], reused: [], unanswered: [] };
    const forced = new Set(regenerate);
    for (const item of items) {
      const state = this.data.items[RequestLedger.key(item)];
      if (forced.has(item.id) || !state) out.toSend.push(item);
      else if (state.status === 'answered') out.reused.push({ item, answer: state.answer });
      else out.unanswered.push(item);
    }
    return out;
  }

  /**
   * Runs a Generate: sends only new/changed items (plus any the editor deliberately regenerates, with a
   * reason), in batches, through `send`, which returns answers by item id (missing = no answer).
   * Concurrent identical runs share one execution.
   */
  async generate(
    items: LedgerItem<I>[],
    send: (batch: LedgerItem<I>[]) => Promise<Record<string, A | undefined>>,
    opts: { batchSize?: number; regenerate?: { ids: string[]; reason: string }; now?: () => string } = {}
  ): Promise<Partition<I, A> & { requests: number; answered: { item: LedgerItem<I>; answer: A }[]; noAnswer: LedgerItem<I>[] }> {
    if (opts.regenerate && !opts.regenerate.reason.trim()) throw new Error('Regenerating needs a reason (it is a deliberate, paid request).');
    const runKey = fingerprint({ items: items.map((i) => RequestLedger.key(i)), regenerate: opts.regenerate?.ids ?? [] });
    const running = this.inflight.get(runKey);
    if (running) return running as ReturnType<RequestLedger<I, A>['generate']>;
    const work = (async () => {
      const now = opts.now ?? (() => new Date().toISOString());
      const plan = this.partition(items, opts.regenerate?.ids ?? []);
      if (opts.regenerate) this.data.regenerations.push({ at: now(), ids: opts.regenerate.ids, reason: opts.regenerate.reason.trim() });
      const size = Math.max(1, opts.batchSize ?? 12);
      const answered: { item: LedgerItem<I>; answer: A }[] = [];
      const noAnswer: LedgerItem<I>[] = [];
      let requests = 0;
      for (let i = 0; i < plan.toSend.length; i += size) {
        const batch = plan.toSend.slice(i, i + size);
        const request = fingerprint(batch.map((b) => RequestLedger.key(b)));
        requests++;
        const answers = await send(batch);
        for (const item of batch) {
          const key = RequestLedger.key(item);
          const a = answers[item.id];
          if (a !== undefined) {
            this.data.items[key] = { status: 'answered', answer: a, at: now(), request };
            answered.push({ item, answer: a });
          } else {
            const prev = this.data.items[key];
            this.data.items[key] = { status: 'no-answer', at: now(), request, attempts: (prev?.status === 'no-answer' ? prev.attempts : 0) + 1 };
            noAnswer.push(item);
          }
        }
        this.save(); // after every batch: a failure later still remembers what was paid for
      }
      this.save();
      return { ...plan, requests, answered, noAnswer };
    })();
    this.inflight.set(runKey, work);
    try {
      return await work;
    } finally {
      this.inflight.delete(runKey);
    }
  }

  /** Deliberate regenerations so far (who asked for what, and why). */
  get regenerations() {
    return this.data.regenerations;
  }
}
