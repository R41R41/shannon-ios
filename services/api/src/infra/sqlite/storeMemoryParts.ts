import type { DatabaseSync } from 'node:sqlite';
import { MemoryProposer } from '../../mind/memory/memoryProposer.js';
import { SQLiteMemoryOutbox } from '../../mind/memory/store/memoryOutboxStore.js';
import { SQLitePersonFacts } from '../../mind/memory/store/personFactsStore.js';
import { SQLiteTrustLedger } from '../../mind/memory/store/trustLedgerStore.js';
import { LockWaitMeter } from './lockWaits.js';
import type { SelfInterestMemory, SelfInterestSources } from '../../mind/self/selfPorts.js';

/**
 * The memory parts of stage 3 that her store opens on its connection (Syzygy ADR-0008 stage 3, F5 and F6): the outbox, its
 * proposer, people facts and the trust ledger. They are handed to `SQLiteShannonStore` by wiring (`stage3StoreOptions`) and never
 * imported by the store itself, so a process that never switches them on (the activity loop's worker, the world worker) does not
 * load them (stage 3 closure review; pinned by `tests/entryClosures.test.ts`).
 */
export interface StoreMemoryParts {
  outbox(database: DatabaseSync): SQLiteMemoryOutbox;
  proposer(outbox: SQLiteMemoryOutbox, options: { now: () => string; notify?: () => void; log?: (line: string) => void }): MemoryProposer;
  facts(database: DatabaseSync, parts: { temporal: boolean; identity: boolean }): SQLitePersonFacts;
  trust(database: DatabaseSync): SQLiteTrustLedger;
  selfInterests?: (database: DatabaseSync, sources: SelfInterestSources) => SelfInterestMemory;
}

export const STORE_MEMORY_PARTS: StoreMemoryParts = {
  outbox: database => new SQLiteMemoryOutbox(database, { meter: new LockWaitMeter('memory writer') }),
  proposer: (outbox, options) => new MemoryProposer(outbox, options),
  facts: (database, parts) => new SQLitePersonFacts(database, parts),
  trust: database => new SQLiteTrustLedger(database),
};
