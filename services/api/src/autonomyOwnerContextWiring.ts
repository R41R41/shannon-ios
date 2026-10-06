import { createOwnerContext } from './autonomyOwnerContext.js';
import type { AutonomyOwnerContext } from './autonomyLoopOwnerContext.js';
import { SQLiteDailyMindStore } from './dailyMind.js';
import { sqliteOwnerSnapshot } from './ownerUpcomingWiring.js';
import { PeopleMemory } from './mind/memory/peopleMemory.js';
import { SQLitePeopleMemoryStore } from './mind/memory/store/peopleMemoryStore.js';
import { SQLiteShannonStore } from './infra/sqlite/sqliteStore.js';

/**
 * What the activity loop's process opens to read the owner's context (owner decision 2026-10-02, Syzygy ADR-0003).
 * Core: memory.
 *
 * The same stores the API process answers a conversation from, opened on the same database, and handed to
 * `createOwnerContext` and to nothing else: the loop receives the interface, never a store. Only reads are made
 * through them here. The process still holds no conversation model key and no Voyager credential.
 */
export function configuredOwnerContext(
  databasePath: string,
  options: { now: () => string; characters: number; timeZone: string },
): { context: AutonomyOwnerContext; close(): void } {
  const exists = sqliteOwnerSnapshot(databasePath);
  // Read-only here: this store leaves the mood history alone (no table created, nothing pruned, nothing recorded).
  const store = new SQLiteShannonStore({ path: databasePath, now: options.now, leavesMoodHistory: true });
  const peopleStore = new SQLitePeopleMemoryStore(databasePath);
  const dailyMind = new SQLiteDailyMindStore(databasePath, options.now);
  const context = createOwnerContext({
    // The state store writes a first state for a scope it has never seen; the loop never causes that write.
    snapshot: (scopeKey, at) => (exists.read(scopeKey, at) ? store.snapshot(scopeKey) : null),
    conversations: store, profile: store, people: new PeopleMemory(peopleStore, store), dailyMind,
  }, { characters: options.characters, timeZone: options.timeZone });
  return {
    context,
    close: () => { exists.close(); dailyMind.close(); peopleStore.close?.(); store.close(); },
  };
}
