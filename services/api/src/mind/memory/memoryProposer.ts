/** What a proposer is handed, and the proposer on the caller's connection (Syzygy ADR-0008 stage 3, F5; split out of `memoryWriter.ts` after the pre-deploy review so that a process that only proposes, or only opens the store, loads none of the writer). */
import { closedKey, memoryOpCodec, type MemoryOpDraft } from './memoryOpCodec.js';
import { SQLiteMemoryOutbox } from './store/memoryOutboxStore.js';

/**
 * The one memory writer (Syzygy ADR-0008 stage 3, step F5, `docs/mind-workspace-contract.md`; after N.E.K.O. and Miru): every
 * proposal to her long-term memory is appended to `memory_outbox`, and this writer, under a lease, applies them in order.
 *
 * One batch: read up to 32 pending rows by `seq`; for each, take the subject's revision and compute outside the lock (a model
 * call, where the kind needs one, outside the lock and through `memory_writer_calls`); then `BEGIN IMMEDIATE`, compare-and-set
 * the revision, check the owner's controls again (a forget that came meanwhile wins), write, mark the row and move the cursor, in
 * one transaction. A lost compare-and-set is tried again from a new snapshot, three times, then the row is `superseded`; a row
 * the codec refuses is `rejected`; five failures (of its model call or of its write, whose transaction rolls back) make it
 * `failed`, and a failing row holds only its own subject meanwhile. The cursor (`applied_seq`) only moves over final rows,
 * so a restart reads from it again, and `op_id` keeps a replayed proposal from being stored twice.
 *
 * The conversation hot path, emotion, the ledgers, the activity record, skills and embeddings write directly as before. The
 * owner's commands stay synchronous: `MemoryCommands.run` calls the same `applyMemoryOp` under the same lock and stores its row
 * as `applied`.
 */

/** What a proposer is handed: one function. */
export interface MemoryProposals {
  propose(draft: MemoryOpDraft): void;
}

export class ModelFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

export const errorCode = (error: unknown) => {
  if (error instanceof ModelFailure) return error.code;
  if (!(error instanceof Error)) return 'error';
  return /^[A-Z0-9_:-]{1,80}$/u.test(error.message) ? error.message.toLowerCase() : error.name.toLowerCase();
};

/** Proposals on the caller's connection: each is encoded (closed fields) and appended; a refused one is kept as `rejected`, text-free. */
export class MemoryProposer implements MemoryProposals {
  constructor(
    private readonly outbox: SQLiteMemoryOutbox,
    private readonly options: { now: () => string; notify?: () => void; log?: (line: string) => void },
  ) {}

  propose(draft: MemoryOpDraft): void {
    const at = this.options.now();
    const encoded = memoryOpCodec.encode(draft);
    this.outbox.underLock(at, () => {
      if (encoded.ok) this.outbox.insert(encoded.value, at);
      else {
        this.options.log?.(`Shannon memory proposal refused: kind=${String(draft.kind)} code=${encoded.code}`);
        // A refused op keeps no free text in its header either (review): its keys are closed (`closedKey`), its kind and origin words.
        this.outbox.insert({ opId: closedKey(String(draft.opId), 200), scopeKey: closedKey(String(draft.scopeKey), 120), kind: closedKey(String(draft.kind), 40),
          origin: closedKey(String(draft.origin), 40), subjectKey: closedKey(String(draft.subjectKey), 240), baseRevision: null,
          payloadJson: SQLiteMemoryOutbox.REFUSED_PAYLOAD, episodeIdsJson: '[]', disclosureJson: null }, at, 'rejected', encoded.code);
      }
    });
    if (encoded.ok) this.options.notify?.();
  }
}
