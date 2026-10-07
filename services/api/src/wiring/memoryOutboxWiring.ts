import { mindSwitches, type SwitchValues } from '@shannon/mind';
import type { SQLiteShannonStore } from '../infra/sqlite/sqliteStore.js';
import { MemoryCommands, MemoryWriter, type MemoryProposals, type MemoryTargets } from '../mind/memory/memoryPorts.js';
import type { ConversationReplaySummarizer, ReplaySummaryWriter } from '../mind/memory/conversationReplaySummary.js';
import type { ImpressionUpdater } from '../mind/memory/impressionUpdater.js';

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
  replaySummaries?: { summarizer: ConversationReplaySummarizer; model: ReplaySummaryWriter | null } | null;
  impressions?: ImpressionUpdater | null;
}): MemoryTargets {
  return {
    state: store, conversations: store, knowledge: store, impressions: store.impressionStore(), people: store.peopleMemoryOnConnection(),
    refreshProfile: scopeKey => store.refreshProfile(scopeKey),
    replaySummaries: parts.replaySummaries ? {
      planned: (scopeKey, threadId, update) => parts.replaySummaries!.summarizer.planned(scopeKey, threadId, update),
      model: parts.replaySummaries.model ? (scopeKey, input) => parts.replaySummaries!.model!.update(scopeKey, input) : null,
    } : null,
    impressionChange: parts.impressions ? (op, state) => parts.impressions!.changeFor(op, state) : null,
    now: parts.now,
  };
}

/** The proposals and the owner's commands of a store opened with `memoryOutbox: true`, or null while it is switched off. */
export function memoryPortsOf(store: SQLiteShannonStore, now: () => string): { proposals: MemoryProposals; commands: MemoryCommands } | null {
  const outbox = store.memoryOutbox();
  const proposals = store.memoryProposals();
  if (!outbox || !proposals) return null;
  return { proposals, commands: new MemoryCommands(outbox, memoryTargetsOf(store, { now })) };
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
