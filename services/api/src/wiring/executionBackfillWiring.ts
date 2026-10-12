import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { underWriteLock } from '../infra/sqlite/lockWaits.js';
import { isSqliteBusy } from '../infra/sqlite/sqliteBusy.js';
import { openDatabase } from '../infra/sqlite/sqliteOpen.js';
import { applyTaskExecutionStep, backfillTaskExecutionBatch } from '../mind/action/agentTasks/store/taskExecutionColumns.js';
import { applyActionSlotStep, backfillActionSlotBatch } from '../mind/action/threads/store/actionSlotColumns.js';

/**
 * The start's re-derivation (Syzygy ADR-0009 stage 1, S3 and S4): at each start of the API, the task rows another writer touched
 * after the state machine (an older build during a rollback window: `updated_at` later than `exec_state_at`) and the action rows
 * missing a column are derived again from their old columns. Batches of 500 rows, each under its own short write lock, with the
 * event loop free between them; a busy batch waits (on an unref'd timer) and is tried again until the API closes. A row already
 * right is not written: the second run changes nothing.
 */
export const EXECUTION_BACKFILL_BATCH = 500;

export interface ExecutionBackfillResult {
  tasks: number;
  actions: number;
  batches: number;
}

export interface ExecutionBackfillOptions {
  batch?: number;
  busyRetryMs?: number;
  busyRetries?: number;
  /** Stops between batches (the API is closing). */
  stopped?(): boolean;
}

type Batch = (db: DatabaseSync, after: number, limit: number) => { next: number | null; changed: number };

/** Applies steps 008, 010 and 009, 011 where their tables exist (outside any transaction; the ledger makes it once). */
export function applyExecutionColumnSteps(db: DatabaseSync): void {
  applyTaskExecutionStep(db);
  applyActionSlotStep(db);
}

type Settings = Required<Omit<ExecutionBackfillOptions, 'stopped'>> & Pick<ExecutionBackfillOptions, 'stopped'>;

/** Waits without holding the process open: a closing API is never kept alive by the backfill (S3 review L1). */
const pause = (ms: number) => delay(ms, undefined, { ref: false });

/** One batch under its own write lock; a busy database waits and tries again, unless the API is closing (null). */
async function lockedBatch(db: DatabaseSync, batch: Batch, after: number, options: Settings) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return underWriteLock(db, null, '', () => batch(db, after, options.batch), 'shannon_execution_backfill');
    } catch (error) {
      if (!isSqliteBusy(error) || attempt >= options.busyRetries) throw error;
      await pause(options.busyRetryMs);
      if (options.stopped?.()) return null;
    }
  }
}

async function backfillTable(db: DatabaseSync, batch: Batch, options: ExecutionBackfillOptions, result: { changed: number; batches: number }) {
  const settings: Settings = { batch: options.batch ?? EXECUTION_BACKFILL_BATCH, busyRetryMs: options.busyRetryMs ?? 1_000,
    busyRetries: options.busyRetries ?? 30, stopped: options.stopped };
  let after: number | null = 0;
  while (after !== null && !options.stopped?.()) {
    const done: { next: number | null; changed: number } | null = await lockedBatch(db, batch, after, settings);
    if (!done) return;
    result.changed += done.changed;
    result.batches += 1;
    after = done.next;
    await pause(0);
  }
}

/** One full pass over both tables. */
export async function backfillExecutionColumns(db: DatabaseSync, options: ExecutionBackfillOptions = {}): Promise<ExecutionBackfillResult> {
  applyExecutionColumnSteps(db);
  const tasks = { changed: 0, batches: 0 };
  const actions = { changed: 0, batches: 0 };
  await backfillTable(db, backfillTaskExecutionBatch, options, tasks);
  await backfillTable(db, backfillActionSlotBatch, options, actions);
  return { tasks: tasks.changed, actions: actions.changed, batches: tasks.batches + actions.batches };
}

export interface ExecutionBackfillParts {
  databasePath: string;
  log?(line: string): void;
}

/** Starts the backfill on its own connection at the API's start; `close` stops it between batches and closes the connection. */
export function startExecutionBackfill(parts: ExecutionBackfillParts) {
  const log = parts.log ?? (line => console.log(line));
  let stopped = false;
  let db: DatabaseSync | null = null;
  try {
    db = openDatabase(parts.databasePath, 'executionBackfill');
  } catch (error) {
    log(`Shannon execution backfill not started: ${error instanceof Error ? error.message.slice(0, 120) : 'error'}`);
    return { done: Promise.resolve(), close: () => Promise.resolve() };
  }
  const finish = () => {
    db?.close();
    db = null;
  };
  const done = backfillExecutionColumns(db, { stopped: () => stopped })
    .then(result => log(`Shannon execution backfill: tasks=${result.tasks} actions=${result.actions} batches=${result.batches}`))
    .catch(error => log(`Shannon execution backfill stopped: ${error instanceof Error ? error.message.slice(0, 120) : 'error'}`))
    .finally(finish);
  const close = (): Promise<void> => {
    stopped = true;
    return done;
  };
  return { done, close };
}
