import { DatabaseSync } from 'node:sqlite';
import { restoreCompanionState, type CompanionStateSnapshot } from '@shannon/cognition';
import { calendarIngestEnabled } from './calendarContract.js';
import { OwnerUpcoming, type UpcomingTaskCatalog } from './ownerUpcoming.js';
import { SQLiteUpcomingStore } from './upcomingStore.js';

/**
 * What each process gives the projection of the owner's upcoming items.
 *
 * The API process reads the owner's state from its own store and, when Voyager offers a read
 * of dated tasks, keeps a snapshot of them fresh. The activity loop's process holds no Voyager
 * credential and no conversation store: it reads the snapshots and the stored promises only.
 */
const TASK_REFRESH_MILLISECONDS = 15 * 60_000;

export interface ConfiguredOwnerUpcoming {
  upcoming: OwnerUpcoming;
  close(): void;
}

export function configuredOwnerUpcoming(
  environment: Readonly<Record<string, string | undefined>>,
  databasePath: string,
  options: { snapshot: (scopeKey: string, at: string) => CompanionStateSnapshot | null; now: () => string; tasks?: UpcomingTaskCatalog | null },
): ConfiguredOwnerUpcoming {
  const store = new SQLiteUpcomingStore(databasePath);
  const upcoming = new OwnerUpcoming({
    store, snapshot: options.snapshot, now: options.now, calendarEnabled: calendarIngestEnabled(environment),
    timeZone: environment.SHANNON_AUTONOMY_TIMEZONE?.trim() || 'Asia/Tokyo',
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  if (options.tasks?.upcomingTasks) {
    const scopeKey = environment.SHANNON_OWNER_SCOPE_KEY?.trim() || 'owner';
    const refresh = () => { void upcoming.refreshTasks(scopeKey, options.tasks); };
    refresh();
    timer = setInterval(refresh, TASK_REFRESH_MILLISECONDS);
    timer.unref();
  }
  return { upcoming, close: () => { if (timer) clearInterval(timer); store.close(); } };
}

/**
 * The owner's stored state, read straight from SQLite for a process without the state store.
 * Only `OwnerUpcoming` is handed it, and only promises with a due time leave that class.
 */
export function sqliteOwnerSnapshot(databasePath: string): { read: (scopeKey: string, at: string) => CompanionStateSnapshot | null; close(): void } {
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  return {
    read(scopeKey, at) {
      try {
        if (!database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'companion_states'`).get()) return null;
        const row = database.prepare('SELECT snapshot_json FROM companion_states WHERE scope_key = ?').get(scopeKey) as unknown as { snapshot_json: string } | undefined;
        return row ? restoreCompanionState(scopeKey, JSON.parse(row.snapshot_json), at) : null;
      } catch { return null; }
    },
    close() { if (database.isOpen) database.close(); },
  };
}
