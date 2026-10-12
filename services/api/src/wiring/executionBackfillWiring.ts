import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { underWriteLock } from '../infra/sqlite/lockWaits.js';
import { isSqliteBusy } from '../infra/sqlite/sqliteBusy.js';
import { openDatabase } from '../infra/sqlite/sqliteOpen.js';
import { applyTaskExecutionStep, backfillTaskExecutionBatch } from '../mind/action/agentTasks/store/taskExecutionColumns.js';
import { applyActionSlotStep, backfillActionSlotBatch } from '../mind/action/threads/store/actionSlotColumns.js';

/**
 * The S3 backfill (Syzygy ADR-0009 stage 1): at each start of the API, the execution columns of `agent_tasks` (step 008) and of
 * the action threads (step 009) are derived again from the old columns, so a row an older build wrote (after a rollback) is
 * filled too. Batches of 500 rows, each under its own short write lock, with the event loop free between them; a busy batch
 * waits and is tried again. A row already right is not written: the second run changes nothing.
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

/** Applies steps 008 and 009 where their tables exist (outside any transaction; the ledger makes it once). */
export function applyExecutionColumnSteps(db: DatabaseSync): void {
  applyTaskExecutionStep(db);
  applyActionSlotStep(db);
}

async function lockedBatch(db: DatabaseSync, batch: Batch, after: number, options: Required<Omit<ExecutionBackfillOptions, 'stopped'>>) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return underWriteLock(db, null, '', () => batch(db, after, options.batch), 'shannon_execution_backfill');
    } catch (error) {
      if (!isSqliteBusy(error) || attempt >= options.busyRetries) throw error;
      await delay(options.busyRetryMs);
    }
  }
}

async function backfillTable(db: DatabaseSync, batch: Batch, options: ExecutionBackfillOptions, result: { changed: number; batches: number }) {
  const settings = { batch: options.batch ?? EXECUTION_BACKFILL_BATCH, busyRetryMs: options.busyRetryMs ?? 1_000, busyRetries: options.busyRetries ?? 30 };
  let after: number | null = 0;
  while (after !== null && !options.stopped?.()) {
    const done: { next: number | null; changed: number } = await lockedBatch(db, batch, after, settings);
    result.changed += done.changed;
    result.batches += 1;
    after = done.next;
    await delay(0);
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
