import type { DatabaseSync } from 'node:sqlite';
import { GOAL_LIMITS, estimatedGoalProgress, goalsOverCap, staggeredReviews, type GoalWorkFacts } from '@shannon/mind';
import { ensureColumns } from '../../../../infra/sqlite/schemaColumns.js';
import { PursuitGoalLedger, atomically } from './pursuitGoals.js';

/**
 * The schema of her goals and its one-time data migration (Syzygy ADR-0009 stage 2, E2).
 *
 * Like every table of her own time's database, this is additive and outside the numbered migrations of the shared file
 * (`infra/sqlite/migrations/`, whose `execution/0xx` steps belong to the execution tables): the database is her own time's
 * file, opened by `SQLiteAutonomyStore`, and each process that opens it makes the same idempotent changes. `autonomy_pursuits`
 * keeps its CHECK constraints on status and origin, so the lifecycle is said in nullable columns, never in new statuses; an
 * older binary reads the table as before.
 */
export const PURSUIT_GOAL_COLUMNS: Readonly<Record<string, string>> = Object.freeze({
  source_kind: 'TEXT', source_ref: 'TEXT', interest_id: 'TEXT', expected_value: 'REAL', expected_score: 'REAL', completion_predicate: 'TEXT',
  review_at: 'TEXT', progress: 'REAL', last_worked_at: 'TEXT', evidence_json: 'TEXT', closed_reason: 'TEXT', closed_at: 'TEXT',
});

export const PURSUIT_GOAL_MIGRATION_MARK = 'adr9_e2_goals_v1';

export function ensurePursuitGoalSchema(database: DatabaseSync): void {
  ensureColumns(database, 'autonomy_pursuits', PURSUIT_GOAL_COLUMNS);
  database.exec(`
    CREATE TABLE IF NOT EXISTS autonomy_pursuit_events (
      event_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      pursuit_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      actor TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      detail_json TEXT NOT NULL DEFAULT '{}',
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS autonomy_pursuit_events_scope ON autonomy_pursuit_events (scope_key, at DESC);
    CREATE INDEX IF NOT EXISTS autonomy_pursuit_events_pursuit ON autonomy_pursuit_events (scope_key, pursuit_id, at DESC);
    CREATE TRIGGER IF NOT EXISTS autonomy_pursuit_events_no_update BEFORE UPDATE ON autonomy_pursuit_events
      BEGIN SELECT RAISE(ABORT, 'PURSUIT_EVENTS_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS autonomy_pursuit_events_no_delete BEFORE DELETE ON autonomy_pursuit_events
      BEGIN SELECT RAISE(ABORT, 'PURSUIT_EVENTS_APPEND_ONLY'); END;
    CREATE TABLE IF NOT EXISTS autonomy_pursuit_marks (
      mark TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      detail_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
}

export interface PursuitGoalMigrationReport {
  readonly scopes: number;
  readonly reviewed: number;
  readonly capped: number;
  readonly closed: number;
}

interface PursuitFactsRow {
  scope_key: string; pursuit_id: string; status: string; created_at: string; updated_at: string;
}

/**
 * Once per database (`autonomy_pursuit_marks`): the existing non-seed pursuits become goals. Seeds are left alone (their
 * rows cannot change). For each open one (active or resting): when it was last worked on (study pieces, readings and reported
 * loop steps filed under it), a first estimate of progress, and a first review spread over seven days, oldest first; then at
 * most eight stay active, the most recently worked, and the rest rest with `closed_reason` 'cap'. A done or dropped one gets
 * `closed_reason` 'legacy' and its last change as `closed_at`. Each change is an event. Null when it ran before.
 */
export function migratePursuitGoals(database: DatabaseSync, at: string): PursuitGoalMigrationReport | null {
  return atomically(database, () => {
    if (database.prepare('SELECT 1 FROM autonomy_pursuit_marks WHERE mark = ?').get(PURSUIT_GOAL_MIGRATION_MARK)) return null;
    const rows = database.prepare(`
      SELECT scope_key, pursuit_id, status, created_at, updated_at FROM autonomy_pursuits WHERE origin <> 'seed' ORDER BY scope_key, created_at, pursuit_id
    `).all() as unknown as PursuitFactsRow[];
    const goals = new PursuitGoalLedger(database);
    const facts = workFacts(database);
    const report = { scopes: 0, reviewed: 0, capped: 0, closed: 0 };
    for (const scopeKey of [...new Set(rows.map(row => row.scope_key))]) {
      report.scopes += 1;
      const scoped = rows.filter(row => row.scope_key === scopeKey);
      report.closed += closeLegacy(database, goals, scoped.filter(row => row.status === 'done' || row.status === 'dropped'), at);
      const open = scoped.filter(row => row.status === 'active' || row.status === 'resting');
      const worked = migrateOpen(database, goals, open, facts, at);
      report.reviewed += open.length;
      const active = open.filter(row => row.status === 'active');
      const over = goalsOverCap(active.map(row => ({ id: row.pursuit_id, lastWorkedAt: worked.get(row.pursuit_id) ?? null, updatedAt: row.updated_at })));
      for (const id of over) {
        database.prepare(`UPDATE autonomy_pursuits SET status = 'resting', closed_reason = 'cap', closed_at = ? WHERE scope_key = ? AND pursuit_id = ?`)
          .run(at, scopeKey, id);
        goals.append(scopeKey, {
          pursuitId: id, kind: 'capped', actor: 'system', fromStatus: 'active', toStatus: 'resting', detail: { cap: GOAL_LIMITS.active }, at,
        });
      }
      report.capped += over.length;
    }
    database.prepare('INSERT INTO autonomy_pursuit_marks (mark, applied_at, detail_json) VALUES (?, ?, ?)')
      .run(PURSUIT_GOAL_MIGRATION_MARK, at, JSON.stringify(report));
    return Object.freeze(report);
  });
}

function closeLegacy(database: DatabaseSync, goals: PursuitGoalLedger, closed: readonly PursuitFactsRow[], at: string): number {
  for (const row of closed) {
    database.prepare(`UPDATE autonomy_pursuits SET source_kind = COALESCE(source_kind, origin), closed_reason = COALESCE(closed_reason, 'legacy'),
      closed_at = COALESCE(closed_at, updated_at) WHERE scope_key = ? AND pursuit_id = ?`).run(row.scope_key, row.pursuit_id);
    goals.append(row.scope_key, {
      pursuitId: row.pursuit_id, kind: 'migrated', actor: 'system', fromStatus: row.status, toStatus: row.status, detail: { closed: true }, at,
    });
  }
  return closed.length;
}

/** The open goals of one scope, oldest first; answers when each was last worked on. */
function migrateOpen(
  database: DatabaseSync, goals: PursuitGoalLedger, open: readonly PursuitFactsRow[], facts: (scopeKey: string, id: string) => WorkFacts, at: string,
): Map<string, string | null> {
  const reviews = staggeredReviews(open.map(row => row.pursuit_id), at);
  const worked = new Map<string, string | null>();
  for (const row of open) {
    const known = facts(row.scope_key, row.pursuit_id);
    const progress = estimatedGoalProgress(known);
    const reviewAt = reviews.get(row.pursuit_id)!;
    worked.set(row.pursuit_id, known.lastWorkedAt);
    database.prepare(`UPDATE autonomy_pursuits SET source_kind = COALESCE(source_kind, origin), review_at = ?, progress = ?, last_worked_at = ?
      WHERE scope_key = ? AND pursuit_id = ?`).run(reviewAt, progress, known.lastWorkedAt, row.scope_key, row.pursuit_id);
    goals.append(row.scope_key, {
      pursuitId: row.pursuit_id, kind: 'migrated', actor: 'system', fromStatus: row.status, toStatus: row.status,
      detail: { reviewAt, progress, worked: known.lastWorkedAt }, at,
    });
  }
  return worked;
}

interface WorkFacts extends GoalWorkFacts {
  readonly lastWorkedAt: string | null;
}

/** What her study and her loop say of a pursuit's work; a table that does not exist yet counts as no work. */
function workFacts(database: DatabaseSync): (scopeKey: string, id: string) => WorkFacts {
  const has = (table: string) => Boolean(database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
  const study = has('study_pieces') && has('study_feedback');
  const readings = has('autonomy_loop_readings');
  const steps = has('autonomy_loop_steps');
  return (scopeKey, id) => {
    const pieces = study ? database.prepare(`
      SELECT
        SUM(kind = 'story') AS stories, SUM(kind = 'story' AND readable_version IS NOT NULL) AS shown, SUM(kind = 'note') AS notes,
        SUM(kind = 'story' AND EXISTS (SELECT 1 FROM study_feedback f WHERE f.scope_key = p.scope_key AND f.piece_id = p.piece_id)) AS reacted,
        MAX(updated_at) AS last
      FROM study_pieces p WHERE scope_key = ? AND pursuit_id = ?
    `).get(scopeKey, id) as { stories: number | null; shown: number | null; notes: number | null; reacted: number | null; last: string | null } : null;
    const read = readings ? database.prepare('SELECT COUNT(*) AS n, MAX(fetched_at) AS last FROM autonomy_loop_readings WHERE scope_key = ? AND pursuit_id = ?')
      .get(scopeKey, id) as { n: number; last: string | null } : null;
    const step = steps ? database.prepare(`
      SELECT MAX(finished_at) AS last FROM autonomy_loop_steps
      WHERE scope_key = ? AND status = 'reported' AND json_valid(step_json) AND json_extract(step_json, '$.pursuitId') = ?
    `).get(scopeKey, id) as { last: string | null } : null;
    const times = [pieces?.last, read?.last, step?.last].filter((value): value is string => typeof value === 'string');
    return {
      stories: pieces?.stories ?? 0, shownStories: pieces?.shown ?? 0, reactedStories: pieces?.reacted ?? 0, notes: pieces?.notes ?? 0, readings: read?.n ?? 0,
      lastWorkedAt: times.length ? times.sort().at(-1)! : null,
    };
  };
}
