import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { configuredDatabasePath } from '../src/infra/sqlite/sqliteStore.js';

/**
 * Drain before switching off or rolling back (Syzygy ADR-0008 stage 3 review M2, `docs/mind-workspace-contract.md`): reports the
 * memory outbox's pending rows (how many, the oldest's age, how many wait for a retry, `failed` rows) every two seconds and waits
 * until none is pending, with the worker (and its writer) still running. Exit 0: drained (or no outbox); 1: still pending at the
 * timeout (`--timeout-seconds`, default 300). Reads only; prints counts and ages, never a row's content.
 *
 *   pnpm --dir services/api memory:drain [--timeout-seconds 300]
 */
const argument = process.argv.indexOf('--timeout-seconds');
const timeoutSeconds = argument > 0 ? Number(process.argv[argument + 1]) : 300;
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) throw new Error('--timeout-seconds must be a number of seconds');
const database = new DatabaseSync(configuredDatabasePath(), { readOnly: true });
database.exec('PRAGMA busy_timeout = 5000;');
try {
  if (!database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'memory_outbox'`).get()) {
    console.log('memory outbox: no table (never switched on); nothing to drain');
    process.exitCode = 0;
  } else {
    const deadline = Date.now() + timeoutSeconds * 1000;
    for (;;) {
      const now = new Date().toISOString();
      const row = database.prepare(`SELECT
          (SELECT COUNT(*) FROM memory_outbox WHERE status = 'pending') AS pending,
          (SELECT COUNT(*) FROM memory_outbox WHERE status = 'pending' AND next_attempt_at IS NOT NULL AND next_attempt_at > ?) AS waiting,
          (SELECT MIN(created_at) FROM memory_outbox WHERE status = 'pending') AS oldest,
          (SELECT COUNT(*) FROM memory_outbox WHERE status = 'failed') AS failed`).get(now) as { pending: number; waiting: number; oldest: string | null; failed: number };
      const age = row.oldest ? Math.round((Date.parse(now) - Date.parse(row.oldest)) / 1000) : 0;
      console.log(`memory outbox: pending=${row.pending} waiting_retry=${row.waiting} oldest_seconds=${age} failed=${row.failed}`);
      if (!Number(row.pending)) { process.exitCode = 0; break; }
      if (Date.now() >= deadline) { console.log('memory outbox: still pending at the timeout; keep the worker running and run this again'); process.exitCode = 1; break; }
      await delay(2_000);
    }
  }
} finally {
  database.close();
}
