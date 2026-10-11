import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { LIVENESS_EPISODE_TABLE } from '../../../contracts/livenessNoticeContract.js';

/** Closed facts the liveness check reads: timestamps and counts only, never a message, payload or error text. */
export interface LivenessFacts {
  /** Latest completed nightly sleep (legacy or FCA), any scope's worker writes the same table. */
  lastSleepCompletedAt: string | null;
  /** Oldest sleep job that is due but neither completed nor failed. */
  oldestDueSleepAt: string | null;
  /** Latest own-time session start or step, for the owner's scope. */
  lastOwnTimeActivityAt: string | null;
  /** Latest own-time session start (ADR-0009 stage 1 execution metrics). */
  lastOwnTimeSessionAt: string | null;
  ownTimePaused: boolean;
  /** When she said she would come back (latest closed session) and when the schedule allows the next start. */
  ownTimeResumeAt: string | null;
  ownTimeNextCycleAt: string | null;
  /** Counted sessions (not `idle`) on the given owner-local day, and the day her budget blocked, if any. */
  ownTimeSessionsOnDay: number;
  ownTimeBudgetBlockedDay: string | null;
  /** Mind worker process starts recorded by the worker itself. */
  mindWorkerStarts: { lastHour: number; lastDay: number; lastAt: string | null };
}

const KEEP_STARTS_MS = 7 * 86_400_000;

/** Called once by the mind worker after it holds the socket. Additive table; the last week is kept. */
export function recordMindWorkerStart(db: DatabaseSync, at: string): void {
  db.exec('CREATE TABLE IF NOT EXISTS mind_worker_starts (started_at TEXT NOT NULL)');
  db.prepare('INSERT INTO mind_worker_starts(started_at) VALUES (?)').run(at);
  db.prepare('DELETE FROM mind_worker_starts WHERE started_at < ?').run(new Date(Date.parse(at) - KEEP_STARTS_MS).toISOString());
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** Read-only. A table that does not exist yet reads as "nothing happened". `dayKey` is the owner-local day of `at`. */
export function readLivenessFacts(db: DatabaseSync, ownerScope: string, at: string, dayKey = at.slice(0, 10)): LivenessFacts {
  const hour = new Date(Date.parse(at) - 3_600_000).toISOString();
  const day = new Date(Date.parse(at) - 86_400_000).toISOString();
  const jobs = hasTable(db, 'background_jobs');
  const lastSleep = jobs ? db.prepare(`SELECT MAX(completed_at) AS at FROM background_jobs
    WHERE scope_key = ? AND job_kind = 'sleep-consolidation' AND status = 'completed'`).get(ownerScope) : undefined;
  const dueSleep = jobs ? db.prepare(`SELECT MIN(available_at) AS at FROM background_jobs
    WHERE scope_key = ? AND job_kind = 'sleep-consolidation' AND status IN ('pending', 'leased') AND available_at <= ?`).get(ownerScope, at) : undefined;
  let lastOwnTime: string | null = null;
  if (hasTable(db, 'autonomy_loop_cycles')) {
    const cycle = db.prepare('SELECT MAX(started_at) AS at FROM autonomy_loop_cycles WHERE scope_key = ?').get(ownerScope);
    lastOwnTime = text(cycle?.at);
  }
  if (hasTable(db, 'autonomy_loop_steps')) {
    const step = text(db.prepare('SELECT MAX(created_at) AS at FROM autonomy_loop_steps WHERE scope_key = ?').get(ownerScope)?.at);
    if (step && (!lastOwnTime || step > lastOwnTime)) lastOwnTime = step;
  }
  const sessions = hasTable(db, 'autonomy_loop_sessions');
  const lastSession = sessions ? db.prepare('SELECT MAX(started_at) AS at FROM autonomy_loop_sessions WHERE scope_key = ?').get(ownerScope) : undefined;
  const resume = sessions ? db.prepare(`SELECT resume_at FROM autonomy_loop_sessions WHERE scope_key = ? AND ended_at IS NOT NULL
    ORDER BY ended_at DESC, rowid DESC LIMIT 1`).get(ownerScope) : undefined;
  const today = sessions ? db.prepare(`SELECT COUNT(*) AS count FROM autonomy_loop_sessions WHERE scope_key = ? AND day_key = ?
    AND COALESCE(end_code, '') <> 'idle'`).get(ownerScope, dayKey) : undefined;
  const schedule = hasTable(db, 'autonomy_loop_schedule')
    ? db.prepare('SELECT next_cycle_at, budget_blocked_day FROM autonomy_loop_schedule WHERE scope_key = ?').get(ownerScope) : undefined;
  const control = hasTable(db, 'autonomy_control')
    ? db.prepare('SELECT paused FROM autonomy_control WHERE scope_key = ?').get(ownerScope) : undefined;
  const starts = hasTable(db, 'mind_worker_starts') ? db.prepare(`SELECT
      SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END) AS hour,
      SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END) AS day,
      MAX(started_at) AS last
    FROM mind_worker_starts`).get(hour, day) : undefined;
  return {
    lastSleepCompletedAt: text(lastSleep?.at),
    oldestDueSleepAt: text(dueSleep?.at),
    lastOwnTimeActivityAt: lastOwnTime,
    lastOwnTimeSessionAt: text(lastSession?.at),
    ownTimePaused: Number(control?.paused ?? 0) === 1,
    ownTimeResumeAt: text(resume?.resume_at), ownTimeNextCycleAt: text(schedule?.next_cycle_at),
    ownTimeSessionsOnDay: Number(today?.count ?? 0), ownTimeBudgetBlockedDay: text(schedule?.budget_blocked_day),
    mindWorkerStarts: { lastHour: Number(starts?.hour ?? 0), lastDay: Number(starts?.day ?? 0), lastAt: text(starts?.last) },
  };
}

/**
 * Opens one episode when an incident begins and closes it when it ends (ADR-0009 §9): the owner's notice is one per episode,
 * also across a restart of the server, because an open episode is found again instead of opened twice. Additive table.
 */
export function syncLivenessEpisodes(db: DatabaseSync, scopeKey: string, incidents: readonly string[], at: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${LIVENESS_EPISODE_TABLE} (episode_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL,
    incident TEXT NOT NULL, opened_at TEXT NOT NULL, closed_at TEXT)`);
  const open = db.prepare(`SELECT episode_id, incident FROM ${LIVENESS_EPISODE_TABLE} WHERE scope_key = ? AND closed_at IS NULL`).all(scopeKey);
  const openIncidents = new Set(open.map(row => String(row.incident)));
  const close = db.prepare(`UPDATE ${LIVENESS_EPISODE_TABLE} SET closed_at = ? WHERE episode_id = ?`);
  for (const row of open) if (!incidents.includes(String(row.incident))) close.run(at, String(row.episode_id));
  const insert = db.prepare(`INSERT INTO ${LIVENESS_EPISODE_TABLE}(episode_id, scope_key, incident, opened_at) VALUES (?, ?, ?, ?)`);
  for (const incident of incidents) if (!openIncidents.has(incident)) insert.run(randomUUID(), scopeKey, incident, at);
}
