import { createHash, randomUUID } from 'node:crypto';
import { memoryOpCodec, type MemoryOp, type MemoryOpDraft } from './memoryOpCodec.js';
import { applyMemoryOp, memoryOpBlockedBeforePrepare, memoryOpHandler, ownerCommandPeople, subjectRevision, type MemoryModelCall, type MemoryTargets } from './memoryOps.js';
import { isSqliteBusy } from '../../infra/sqlite/lockWaits.js';
import { SQLiteMemoryOutbox, type MemoryOutboxRow } from './store/memoryOutboxStore.js';
import { deferredSelfInterestKinds } from './selfInterestHandlers.js';
import { ModelFailure, errorCode } from './memoryProposer.js';
export { type MemoryProposals, MemoryProposer } from './memoryProposer.js';

export const MEMORY_WRITER_V1 = Object.freeze({
  batch: 32,
  casTries: 3,
  modelFailures: 5,
  leaseMilliseconds: 60_000,
  /** After a model failure: tried again after attempts × this. */
  retryMilliseconds: 30_000,
  /** The writer's model answers are kept this long (review H2: about 3 days), then deleted whatever their row. */
  callRetentionDays: 3,
  /** A final row keeps its payload this long (review H2: a day's grace), then only its closed header. */
  payloadGraceMilliseconds: 24 * 60 * 60_000,
});

class LeaseLost extends Error {
  constructor() { super('MEMORY_WRITER_LEASE_LOST'); }
}

/** A crash the tests stage (`beforeLock`): it stops the run, as a crashed process would, and is not a failure of the row. */
class StagedCrash extends Error {
  constructor(readonly error: unknown) { super('MEMORY_WRITER_STAGED_CRASH'); }
}

const callKey = (kind: string, purpose: string, request: unknown) => createHash('sha256').update(`${kind}\u0000${purpose}\u0000${JSON.stringify(request)}`).digest('hex');

export interface MemoryWriterOptions {
  outbox: SQLiteMemoryOutbox;
  targets: MemoryTargets;
  now: () => string;
  /** The lease holder's name (one writer at a time). */
  owner?: string;
  log?: (line: string) => void;
  /** Tests only: runs after the compute and before the lock (a crash between the model call and the compare-and-set). */
  beforeLock?: (op: MemoryOp) => void;
}

export type MemoryWriterRun = 'idle' | 'worked' | 'leased_elsewhere';

export class MemoryWriter {
  readonly owner: string;
  private draining: Promise<void> = Promise.resolve();
  private pendingDrain = false;
  private readonly outbox: SQLiteMemoryOutbox;
  private readonly targets: MemoryTargets;

  constructor(private readonly options: MemoryWriterOptions) {
    this.owner = options.owner ?? `memory-writer-${randomUUID()}`;
    this.outbox = options.outbox;
    this.targets = options.targets;
  }

  private now(): string { return this.options.now(); }
  private leaseUntil(): string { return new Date(Date.parse(this.now()) + MEMORY_WRITER_V1.leaseMilliseconds).toISOString(); }

  /** One batch under the lease. */
  async runOnce(): Promise<MemoryWriterRun> {
    const at = this.now();
    const leased = this.outbox.underLock(at, () => this.outbox.acquireLease(this.owner, at, this.leaseUntil()));
    if (!leased) return 'leased_elsewhere';
    // A retry or disabled self port holds only its subject; eligible subjects still fill the batch (review M7).
    const rows = this.outbox.pending(MEMORY_WRITER_V1.batch, at, deferredSelfInterestKinds(this.targets));
    if (!rows.length) {
      this.outbox.underLock(at, () => {
        this.outbox.advanceCursor(at);
        this.outbox.pruneCallsBefore(new Date(Date.parse(at) - MEMORY_WRITER_V1.callRetentionDays * 86_400_000).toISOString());
        this.outbox.scrubFinal(new Date(Date.parse(at) - MEMORY_WRITER_V1.payloadGraceMilliseconds).toISOString());
      });
      return 'idle';
    }
    // A subject waiting for a model retry keeps its later ops waiting too: ops on one subject are applied in order.
    const waiting = new Set<string>();
    let worked = false;
    try {
      for (const row of rows) {
        const subject = `${row.scopeKey}\u0000${row.subjectKey}`;
        if (waiting.has(subject)) continue;
        if (row.nextAttemptAt && row.nextAttemptAt > this.now()) { waiting.add(subject); continue; }
        // An owner's rename or merge runs after every row still pending about its people (review: commands never overtake them).
        const people = ownerCommandPeople(row);
        if (people.length && this.outbox.pendingAboutPeople(row.scopeKey, people, row.seq)) { waiting.add(subject); continue; }
        if (!this.outbox.underLock(this.now(), () => this.outbox.acquireLease(this.owner, this.now(), this.leaseUntil()))) throw new LeaseLost();
        let finished: boolean;
        try {
          finished = await this.process(row);
        } catch (error) {
          if (error instanceof LeaseLost) throw error;
          if (error instanceof StagedCrash) throw error.error;
          // A busy database is contention, not the row's fault (review L4): it waits for the next batch, its tries unchanged.
          if (isSqliteBusy(error)) { waiting.add(subject); continue; }
          // One bad row never stops the others: its transaction was rolled back (`underLock`), it is tried again later, and it is
          // `failed` after five tries; only its own subject waits meanwhile.
          finished = this.rowFailed(row.seq, row.attempts, row.kind, `apply_${errorCode(error)}`.slice(0, 80));
        }
        worked = true;
        if (!finished) waiting.add(subject);
      }
    } catch (error) {
      if (error instanceof LeaseLost) return worked ? 'worked' : 'leased_elsewhere';
      throw error;
    }
    this.outbox.underLock(this.now(), () => this.outbox.advanceCursor(this.now()));
    return worked ? 'worked' : 'idle';
  }

  /** Runs batches until nothing is left that may run now. Calls are serialized; a call during a drain runs one more after it. */
  drain(): Promise<void> {
    if (this.pendingDrain) return this.draining;
    this.pendingDrain = true;
    this.draining = this.draining.then(async () => {
      this.pendingDrain = false;
      for (let round = 0; round < 1_000; round += 1) {
        const run = await this.runOnce();
        if (run !== 'worked') break;
      }
    }).catch(error => { this.options.log?.(`Shannon memory writer failed: ${errorCode(error)}`); });
    return this.draining;
  }

  /** Resolves when the drains asked for so far have run. */
  idle(): Promise<void> { return this.draining; }

  releaseLease(): void { this.outbox.underLock(this.now(), () => this.outbox.releaseLease(this.owner, this.now())); }

  /** One row to its end (true), or left for a retry after a model failure (false). */
  private async process(row: MemoryOutboxRow): Promise<boolean> {
    const decoded = memoryOpCodec.decode(row);
    if (!decoded.ok) {
      this.final(row.seq, 'rejected', decoded.code);
      return true;
    }
    const op = decoded.value;
    const handler = memoryOpHandler(op.kind);
    // What the owner's controls stop already (a discarded call, a forgotten person or turn) is stopped before any model is asked
    // (review: privacy), and checked again under the lock below.
    const before = memoryOpBlockedBeforePrepare(this.targets, op, this.targets.state.snapshot(op.scopeKey));
    if (before) {
      this.final(op.seq, before === 'no_store' ? 'rejected' : 'superseded', before);
      return true;
    }
    let expected = op.baseRevision;
    for (let attempt = 0; attempt < MEMORY_WRITER_V1.casTries; attempt += 1) {
      // Outside the lock: the snapshot and the compute.
      const revision = subjectRevision(this.targets, op);
      if (expected !== null && expected !== revision) {
        // The subject changed since the proposal (or since the last try): one lost compare-and-set, tried from what is there now.
        expected = null;
        continue;
      }
      const state = this.targets.state.snapshot(op.scopeKey);
      let plan: unknown;
      try {
        const prepared = handler.prepare ? await handler.prepare(this.targets, op, this.model(op), state) : { write: null };
        if ('done' in prepared) {
          this.final(op.seq, prepared.done, prepared.code);
          return true;
        }
        plan = prepared.write;
      } catch (error) {
        if (isSqliteBusy(error)) return false; // Contention while it read: tried again, not a model failure (review L4).
        return this.modelFailed(op, errorCode(error));
      }
      try { this.options.beforeLock?.(op); } catch (error) { throw new StagedCrash(error); }
      // Under the lock: compare-and-set, the owner's controls again, the write, the row and the cursor, in one transaction.
      const result = this.outbox.underLock(this.now(), () => {
        if (!this.outbox.holdsLease(this.owner, this.now())) throw new LeaseLost();
        if (subjectRevision(this.targets, op) !== revision) return 'lost' as const;
        const outcome = applyMemoryOp(this.targets, op, plan);
        this.outbox.finish(op.seq, outcome.status, outcome.code, this.now());
        this.outbox.advanceCursor(this.now());
        return outcome;
      });
      if (result !== 'lost') return true;
      expected = null;
    }
    this.final(op.seq, 'superseded', 'cas_lost');
    return true;
  }

  private final(seq: number, status: 'applied' | 'superseded' | 'rejected' | 'failed', code: string, attempts?: number): void {
    this.outbox.underLock(this.now(), () => {
      this.outbox.finish(seq, status, code, this.now(), attempts);
      this.outbox.advanceCursor(this.now());
    });
  }

  private modelFailed(op: MemoryOp, code: string): boolean {
    return this.rowFailed(op.seq, op.attempts, op.kind, code);
  }

  /**
   * A row that failed (its model call, or its write): tried again after attempts × the retry time, `failed` after five tries.
   * Answers whether the row is final (true) or waits for its retry (false: its subject's later rows wait with it).
   */
  private rowFailed(seq: number, previousAttempts: number, kind: string, code: string): boolean {
    const attempts = previousAttempts + 1;
    if (attempts >= MEMORY_WRITER_V1.modelFailures) {
      this.final(seq, 'failed', code, attempts);
      this.options.log?.(`Shannon memory op failed: kind=${kind} code=${code}`);
      return true;
    }
    const next = new Date(Date.parse(this.now()) + attempts * MEMORY_WRITER_V1.retryMilliseconds).toISOString();
    this.outbox.underLock(this.now(), () => this.outbox.retryLater(seq, attempts, next, code));
    return false;
  }

  /** A model call through the cache: an answer once given is given again (a restart between the call and the write calls nothing). */
  private model(op: MemoryOp): MemoryModelCall {
    return async <T>(purpose: string, request: unknown, call: () => Promise<T | null>): Promise<T> => {
      const key = callKey(op.kind, purpose, request);
      const cached = this.outbox.cachedCall(key);
      if (cached !== null) return JSON.parse(cached) as T;
      let answer: T | null;
      try { answer = await call(); } catch (error) { throw new ModelFailure(`model_${errorCode(error)}`.slice(0, 80)); }
      if (answer === null || answer === undefined) throw new ModelFailure('model_empty');
      this.outbox.underLock(this.now(), () => this.outbox.storeCall(key, op.seq, op.kind, JSON.stringify(answer), this.now()));
      return answer;
    };
  }
}

/**
 * The owner's commands, synchronous (ADR-0008 stage 3): the same `applyMemoryOp`, under the same lock, and the row stored as
 * applied (or as what stopped it). Answers whether it was applied.
 */
export class MemoryCommands {
  constructor(private readonly outbox: SQLiteMemoryOutbox, private readonly targets: MemoryTargets) {}

  /**
   * `queued`: a rename or merge whose people still have proposals pending is not applied ahead of them (stage 3 review): it is
   * stored pending and the writer applies it after them, in order, under its rules. Answers `applied: false, code: 'queued'`.
   */
  run(draft: Omit<MemoryOpDraft, 'origin'>): { applied: boolean; code: string } {
    const at = this.targets.now();
    const encoded = memoryOpCodec.encode({ ...draft, origin: 'owner' });
    if (!encoded.ok) return { applied: false, code: encoded.code };
    return this.outbox.underLock(at, () => {
      const people = ownerCommandPeople({ kind: encoded.value.kind, origin: 'owner', payloadJson: encoded.value.payloadJson });
      if (people.length && this.outbox.pendingAboutPeople(draft.scopeKey, people)) {
        return { applied: false, code: this.outbox.insert(encoded.value, at) === null ? 'duplicate' : 'queued' };
      }
      const seq = this.outbox.insert(encoded.value, at);
      if (seq === null) return { applied: false, code: 'duplicate' };
      const decoded = memoryOpCodec.decode({ ...encoded.value, seq, attempts: 0 });
      if (!decoded.ok) { this.outbox.finish(seq, 'rejected', decoded.code, at); return { applied: false, code: decoded.code }; }
      const outcome = applyMemoryOp(this.targets, decoded.value, null);
      this.outbox.finish(seq, outcome.status, outcome.code, at);
      this.outbox.advanceCursor(at);
      return { applied: outcome.status === 'applied', code: outcome.code };
    });
  }
}
