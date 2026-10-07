import { stage5Enabled } from '../infra/config/stage5Config.js';
import type { SQLiteShannonStore } from '../infra/sqlite/sqliteStore.js';
import { STORE_MEMORY_PARTS } from '../infra/sqlite/storeMemoryParts.js';
import { stage3StoreOptions } from './peopleFactsWiring.js';
import { selfInterestNightlyPort, selfInterestProjectionPort, selfInterestStoreOptions } from './selfInterestWiring.js';
import { valueNightSchedule } from '../mind/sleep/valueSleep.js';

/** Stage5 supplements the existing stage3 connection; OFF returns its options unchanged. */
export function stage5MemoryStoreOptions(environment: Readonly<Record<string, string | undefined>>) {
  const previous = stage3StoreOptions(environment);
  if (!stage5Enabled(environment) || !previous.memoryOutbox) return previous;
  return { ...previous, ...selfInterestStoreOptions(true, previous.memoryParts ?? STORE_MEMORY_PARTS, environment.SHANNON_SLEEP_TIMEZONE?.trim() || 'Asia/Tokyo') };
}
export function stage5MemoryReaders(store: SQLiteShannonStore) {
  const memory = store.selfInterests();
  return { projection: selfInterestProjectionPort(memory),
    ...(memory ? { stage5: true, selfInterests: (scope: string) => memory.snapshot(scope).items } : {}) };
}
/** Independent real-night adoption also runs when no sleep conversation batch exists. */
export function stage5InterestNightSchedule(store: SQLiteShannonStore, options: { now: () => string; timeZone: string; sleepHour: number }) {
  const memory = store.selfInterests();
  const proposals = store.memoryProposals();
  const night = memory && proposals ? selfInterestNightlyPort(memory, proposals, options.now) : null;
  return night ? valueNightSchedule({ ...options, scopes: () => memory!.store.scopes(), run: scope => night.nightly(scope) }) : null;
}
