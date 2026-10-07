import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryAudience, SelfInterestOwnerCommand } from '@shannon/cognition';
import { SelfInterestMemory, type SelfInterestSources } from '../mind/self/selfPorts.js';
import { SQLiteSelfInterests, selfInterestRequestHash } from '../mind/self/store/sqliteSelfInterests.js';
import type { MemoryCommands, MemoryProposals } from '../mind/memory/memoryPorts.js';
import type { StoreMemoryParts } from '../infra/sqlite/storeMemoryParts.js';

/** Called with the store's existing connection only when stage 5 is enabled. OFF opens no self tables. */
export function selfInterestMemoryOnConnection(database: DatabaseSync, options: {
  enabled: boolean; sources: SelfInterestSources; timeZone?: string;
}): SelfInterestMemory | null {
  return options.enabled ? new SelfInterestMemory(new SQLiteSelfInterests(database), options.sources, options.timeZone) : null;
}
/** Entries merge this with stage 3 store options. No environment reads or schema access while OFF. */
export function selfInterestStoreOptions(enabled: boolean, memoryParts: StoreMemoryParts, timeZone?: string): {
  stage5?: boolean; memoryParts: StoreMemoryParts;
} {
  return enabled ? { stage5: true, memoryParts: { ...memoryParts,
    selfInterests: (database, sources) => selfInterestMemoryOnConnection(database, { enabled: true, sources, timeZone })! } }
    : { memoryParts };
}
export function selfInterestOwnerPort(memory: SelfInterestMemory | null, commands: Pick<MemoryCommands, 'run'>, now: () => string) {
  if (!memory) return null;
  return {
    read: (scopeKey: string, cursor?: number) => memory.snapshot(scopeKey, cursor),
    detail: (scopeKey: string, itemId: string, cursor?: number) => memory.detail(scopeKey, itemId, cursor),
    operation: (scopeKey: string, operationId: string) => memory.operation(scopeKey, operationId),
    mutate(scopeKey: string, command: SelfInterestOwnerCommand) {
      const cached = memory.receipt(scopeKey, command.operationId);
      if (cached) return { code: cached.requestHash === selfInterestRequestHash(command) ? cached.code : 'operation_conflict',
        item: cached.item ? memory.snapshot(scopeKey).items.find(item => item.id === cached.item!.id) ?? null : null, revision: memory.store.revision(scopeKey) };
      const key = createHash('sha256').update(`${scopeKey}\0${command.operationId}`).digest('hex').slice(0, 32);
      const result = commands.run({ opId: `self-interest-owner:${key}`, scopeKey, kind: 'self.interest.owner',
        subjectKey: `self-interest:${command.itemId}`, payload: { ...command } });
      return { code: memory.receipt(scopeKey, command.operationId)?.code ?? result.code,
        item: memory.snapshot(scopeKey).items.find(item => item.id === command.itemId) ?? null, revision: memory.store.revision(scopeKey) };
    },
  };
}
/** Narrow read function for workspace/ownTime: no stores, writes, or candidates leave this port. */
export function selfInterestProjectionPort(memory: SelfInterestMemory | null): ((scopeKey: string, audience?: MemoryAudience) => string) | undefined {
  return memory ? (scopeKey, audience) => memory.projection(scopeKey, audience) : undefined;
}
/** Existing worker's nightly hook. The current clock is used by the writer, never a backfilled batch's date. */
export function selfInterestNightlyPort(memory: SelfInterestMemory | null, proposals: MemoryProposals, now: () => string) {
  return memory ? { nightly(scopeKey: string): void {
    // A fresh run may pick up new candidates; the durable allowance is checked by the writer on every adoption.
    proposals.propose({ opId: `self-interest-night:${scopeKey}:${now()}`, scopeKey, kind: 'self.interest.night', origin: 'sleep',
      subjectKey: 'self-interest-night', payload: {} });
  } } : null;
}
export type SelfInterestOwnerPort = NonNullable<ReturnType<typeof selfInterestOwnerPort>>;
