import { mindSwitches, type SwitchValues } from '@shannon/mind';
import type { SQLiteShannonStore } from '../infra/sqlite/sqliteStore.js';

/**
 * People facts, wired (Syzygy ADR-0008 stage 3, step F6, `docs/mind-workspace-contract.md`). From the switches:
 * - `SHANNON_TEMPORAL_FACTS` (needs the memory outbox): validity columns on `person_memory_items` (backfilled), luna's
 *   contradiction and duplicate step in the writer, recall without closed facts, temporal fields on her impressions;
 * - `SHANNON_IDENTITY_TIERS`: a newly met name goes to tiers 3 and 4 in the background (they only suggest), and the speakers of
 *   platform messages are kept;
 * - `SHANNON_TRUST_LEDGER`: the ledger's table, inert;
 * - `SHANNON_EVIDENCE_DECAY` (off by default) is read where impressions are recalled (`impressionRecall.ts`).
 * Each off: no column, no table, no reader; everything is what it was.
 */
export function peopleFactsStoreOptions(environment: SwitchValues): { peopleFacts?: { temporal: boolean; identity: boolean }; trustLedger?: true } {
  const switches = mindSwitches(environment);
  return {
    ...(switches.temporalFacts || switches.identityTiers ? { peopleFacts: { temporal: switches.temporalFacts, identity: switches.identityTiers } } : {}),
    ...(switches.trustLedger ? { trustLedger: true as const } : {}),
  };
}

/** What people memory and the platform's people read and record of it, on `store`'s connection; null while it is all off. */
export function peopleFactReaders(store: SQLiteShannonStore, now: () => string): {
  closedIds(scopeKey: string): ReadonlySet<string>;
  candidates(scopeKey: string): readonly { personId: string; candidatePersonId: string; tier: 3 | 4 }[];
  speaker(scopeKey: string, turnId: string, personId: string, at: string): void;
  identity: boolean;
} | null {
  const facts = store.personFacts();
  if (!facts) return null;
  return {
    closedIds: scopeKey => facts.closedItemIds(scopeKey, now()),
    candidates: scopeKey => facts.candidates(scopeKey),
    speaker: (scopeKey, turnId, personId, at) => facts.recordSpeaker(scopeKey, { turnId, speakerKind: 'person', personId, tier: 1, verified: true, recordedAt: at }),
    identity: facts.parts.identity,
  };
}

/**
 * The options of the conversation's store for every memory part of stage 3, from the environment: the outbox (F5), structured
 * compaction (F7), and people facts and the trust ledger (F6), each behind its switch. All off: the store of afb38c28.
 */
export function stage3StoreOptions(environment: SwitchValues): { memoryOutbox: boolean; structuredCompaction: boolean; peopleFacts?: { temporal: boolean; identity: boolean }; trustLedger?: true } {
  const switches = mindSwitches(environment); // As memoryOutboxOn and structuredCompactionOn read them.
  return { memoryOutbox: switches.memoryOutbox, structuredCompaction: switches.structuredCompaction, ...peopleFactsStoreOptions(environment) };
}
