import { DatabaseSync } from 'node:sqlite';

/**
 * The one place that opens the shared SQLite file and sets its connection PRAGMAs (Syzygy ADR-0009 stage 1, D9: S2). A profile
 * keeps exactly the values its opener set before the move; only the order is fixed (the busy timeout first, so that switching
 * the journal to WAL waits for a writer instead of failing at once). The execution system's openers use it; the other
 * openers move later (`docs/architecture.md`, *Opening the database*).
 */
export interface SqliteProfile {
  readonly busyTimeoutMs: number;
  readonly foreignKeys: boolean;
  readonly wal: boolean;
  readonly synchronous: 'NORMAL' | null;
  readonly readOnly: boolean;
}

/** Below MIND_IPC_LIMITS.timeoutMs (1 s): a caller's deadline outlasts the mind worker's longest wait for the write lock. */
export const MIND_WORKER_BUSY_TIMEOUT_MS = 750;

/** How long applying a schema step may wait for the write lock, whatever the connection's own timeout. */
export const SCHEMA_STEP_BUSY_TIMEOUT_MS = 5000;

const profile = (values: Partial<SqliteProfile>): SqliteProfile => Object.freeze({
  busyTimeoutMs: 5000, foreignKeys: false, wal: false, synchronous: null, readOnly: false, ...values,
});

export const SQLITE_PROFILES = Object.freeze({
  /** The mind worker (`wiring/mindWorkerWiring.ts`): the scheduler's writer. */
  mindWorker: profile({ busyTimeoutMs: MIND_WORKER_BUSY_TIMEOUT_MS, wal: true }),
  /** The common task runtime (`wiring/serverFcaWiring.ts`), also on the sleep store's borrowed connection. */
  taskRuntime: profile({ foreignKeys: true, wal: true }),
  /** The Agent Host task store (`SQLiteAgentTaskStore`). */
  agentTasks: profile({ foreignKeys: true, wal: true, synchronous: 'NORMAL' }),
  /** The Minecraft lifecycle operator (`wiring/minecraftLifecycleWiring.ts`). */
  minecraftLifecycle: profile({ wal: true }),
  /** The liveness monitor (`wiring/livenessWiring.ts`): its episode is its one write. */
  liveness: profile({}),
  /**
   * The S3 backfill of the execution columns at each start of the API (`wiring/executionBackfillWiring.ts`): a short wait, since
   * the API's event loop waits with it; a busy batch is tried again later.
   */
  executionBackfill: profile({ busyTimeoutMs: 250, wal: true }),
  /** The sleep worker's read-only view of task proofs (`wiring/configuredWorkerFeedback.ts`). */
  readOnly: profile({ readOnly: true }),
});

export type SqliteProfileName = keyof typeof SQLITE_PROFILES;

/** Sets a profile's PRAGMAs on a connection that is already open (a borrowed one keeps its owner's file and handle). */
export function configureDatabase(database: DatabaseSync, name: SqliteProfileName): DatabaseSync {
  const settings = SQLITE_PROFILES[name];
  database.exec(`PRAGMA busy_timeout=${settings.busyTimeoutMs};`);
  if (settings.foreignKeys) database.exec('PRAGMA foreign_keys=ON;');
  if (settings.wal) database.exec('PRAGMA journal_mode=WAL;');
  if (settings.synchronous) database.exec(`PRAGMA synchronous=${settings.synchronous};`);
  return database;
}

/** Opens the file with a profile. */
export function openDatabase(path: string, name: SqliteProfileName): DatabaseSync {
  const database = new DatabaseSync(path, SQLITE_PROFILES[name].readOnly ? { readOnly: true } : {});
  try {
    return configureDatabase(database, name);
  } catch (error) {
    database.close();
    throw error;
  }
}

/** The names of a table's columns (empty when the table does not exist). */
export function tableColumns(database: DatabaseSync, table: string): Set<string> {
  if (!/^[a-z_]+$/u.test(table)) throw new Error('SCHEMA_TABLE');
  const rows = database.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return new Set(rows.map(row => row.name));
}

/** Runs `work` with a busy timeout of at least `milliseconds`, and puts the connection's own timeout back afterwards. */
export function withBusyTimeout<T>(database: DatabaseSync, milliseconds: number, work: () => T): T {
  const row = database.prepare('PRAGMA busy_timeout').get() as Record<string, unknown> | undefined;
  const own = Number(Object.values(row ?? {})[0] ?? 0);
  if (own >= milliseconds) return work();
  database.exec(`PRAGMA busy_timeout=${milliseconds};`);
  try {
    return work();
  } finally {
    database.exec(`PRAGMA busy_timeout=${own};`);
  }
}

/** Folds the write-ahead log back into the file without waiting for readers (before a store closes). */
export function checkpointPassive(database: DatabaseSync): void {
  database.exec('PRAGMA wal_checkpoint(PASSIVE)');
}
