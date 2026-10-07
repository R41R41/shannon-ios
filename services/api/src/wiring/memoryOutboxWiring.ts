import { mindSwitches, type SwitchValues } from '@shannon/mind';
import type { SQLiteShannonStore } from '../infra/sqlite/sqliteStore.js';
import { MemoryCommands, MemoryWriter, type MemoryProposals } from '../mind/memory/memoryWriter.js';
import type { MemoryTargets } from '../mind/memory/memoryPorts.js';
import type { ConversationReplaySummarizer } from '../mind/memory/conversationReplaySummary.js';
import type { ImpressionUpdater } from '../mind/memory/impressionUpdater.js';
import type { IdentityChooser, PersonFactJudge } from '../mind/memory/memoryPorts.js';
import type { PeopleMemoryParts } from '../mind/memory/peopleMemory.js';
import { ownerDayKey } from '../infra/sqlite/lockWaits.js';
import { peopleFactReaders } from './peopleFactsWiring.js';

/**
 * The memory outbox and its one writer, wired (Syzygy ADR-0008 stage 3, step F5, `docs/mind-workspace-contract.md`).
 * `SHANNON_MEMORY_OUTBOX` (and `SHANNON_ADR8_STAGE3`) off: `memoryOutboxOn` is false, no store opens the outbox, every writer
 * writes where it did, and every table is afb38c28's.
 *
 * - The API process proposes (people memory saves, the platform's people) and runs the owner's commands synchronously on its
 *   store's connection; it does not run the writer.
 * - The worker proposes (a turn's refinement, sleep, knowledge, impressions, the platform summaries, the replay summary) and runs
 *   the writer on its own store's connection, under the lease, between jobs.
 * - The local kernel (tests, the scenarios) runs the writer in its process, drained after each proposal.
 */
export function memoryOutboxOn(environment: SwitchValues): boolean {
  return mindSwitches(environment).memoryOutbox;
}

/** The writer's targets: every memory write of an op on the one connection of `store`, so that its lock covers them. */
export function memoryTargetsOf(store: SQLiteShannonStore, parts: {
  now: () => string;
  replaySummaries?: ConversationReplaySummarizer | null;
  impressions?: ImpressionUpdater | null;
  /** F6: luna's contradiction and duplicate step (null: the rule), and tier 4's chooser (null: tiers 1 to 3 only). */
  judge?: PersonFactJudge | null;
  chooser?: IdentityChooser | null;
}): MemoryTargets {
  const facts = store.personFacts();
  const outbox = store.memoryOutbox();
  // The owner-local day of the judge's cap (40 calls).
  const dayStart = (at: string) => new Date(`${ownerDayKey(at)}T00:00:00+09:00`).toISOString();
  return {
    personFacts: facts?.parts.temporal ? { store: facts, judge: parts.judge ?? null, callsToday: at => outbox?.callsSince('person.fact', dayStart(at)) ?? 0 } : null,
    identity: facts?.parts.identity ? { store: facts, chooser: parts.chooser ?? null } : null,
    state: store, conversations: store, knowledge: store, impressions: store.impressionStore(), people: store.peopleMemoryOnConnection(),
    refreshProfile: scopeKey => store.refreshProfile(scopeKey),
    replaySummaries: parts.replaySummaries ? { planned: (scopeKey, threadId, call) => parts.replaySummaries!.planned(scopeKey, threadId, call) } : null,
    impressionChange: parts.impressions ? (op, state) => parts.impressions!.changeFor(op, state) : null,
    now: parts.now,
  };
}

/** The proposals and the owner's commands of a store opened with `memoryOutbox: true`, or null while it is switched off. */
export function memoryPortsOf(store: SQLiteShannonStore, now: () => string): ({ proposals: MemoryProposals; commands: MemoryCommands } & Pick<PeopleMemoryParts, 'facts' | 'identity'>) | null {
  const outbox = store.memoryOutbox();
  const proposals = store.memoryProposals();
  if (!outbox || !proposals) return null;
  const readers = peopleFactReaders(store, now);
  return { proposals, commands: new MemoryCommands(outbox, memoryTargetsOf(store, { now })), ...(readers ? { facts: readers, identity: readers.identity } : {}) };
}

/** The writer of the worker (or of the local kernel), on `store`'s connection, or null while the outbox is switched off. */
export function memoryWriterOf(store: SQLiteShannonStore, parts: Parameters<typeof memoryTargetsOf>[1] & {
  owner?: string; log?: (line: string) => void; beforeLock?: ConstructorParameters<typeof MemoryWriter>[0]['beforeLock'];
}): MemoryWriter | null {
  const outbox = store.memoryOutbox();
  if (!outbox) return null;
  return new MemoryWriter({ outbox, targets: memoryTargetsOf(store, parts), now: parts.now, ...(parts.owner ? { owner: parts.owner } : {}),
    log: parts.log ?? (line => console.log(line)), ...(parts.beforeLock ? { beforeLock: parts.beforeLock } : {}) });
}
