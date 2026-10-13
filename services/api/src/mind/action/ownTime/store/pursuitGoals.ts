import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  GOAL_LIMITS, checkedGoalEvidence, checkedGoalPredicate, evaluateGoalPredicate, goalsOverCap, mergedGoalEvidence,
  type GoalEvidence, type GoalPredicate, type GoalVerdict,
} from '@shannon/mind';

/**
 * Her pursuits as goals (Syzygy ADR-0009 stage 2, E2): the lifecycle columns of `autonomy_pursuits` and the append-only
 * `autonomy_pursuit_events` (both created by `pursuitGoalMigration.ts`). The statuses stay the four of the table's CHECK
 * (active, resting, done, dropped); what is new is said in added columns. A goal becomes `done` only here: with evidence that
 * meets its predicate, or by the owner's confirmation. Nobody else (the old loop included) can set `done`.
 */
export const PURSUIT_EVENT_KINDS = [
  'created', 'status', 'propose_complete', 'completed', 'owner_confirmed', 'evidence', 'predicate_set', 'capped', 'migrated',
] as const;
export type PursuitEventKind = typeof PURSUIT_EVENT_KINDS[number];
export type PursuitEventActor = 'shannon' | 'owner' | 'system';

/** Why a goal last left `active` (or how it closed). */
export type PursuitClosedReason =
  | 'cap' | 'shannon_rest' | 'shannon_drop' | 'owner_rest' | 'owner_drop' | 'evidence' | 'owner_confirm' | 'legacy';

export interface PursuitEvent {
  readonly id: string;
  readonly pursuitId: string;
  readonly kind: PursuitEventKind;
  readonly actor: PursuitEventActor;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  /** Closed values and numbers only. */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  readonly at: string;
}

export interface PursuitGoalColumns {
  readonly sourceKind: string | null;
  readonly sourceRef: string | null;
  readonly interestId: string | null;
  readonly expectedValue: number | null;
  readonly expectedScore: number | null;
  readonly predicate: GoalPredicate | null;
  readonly reviewAt: string | null;
  readonly progress: number;
  readonly lastWorkedAt: string | null;
  readonly evidence: readonly GoalEvidence[];
  readonly closedReason: PursuitClosedReason | null;
  readonly closedAt: string | null;
}

interface GoalRow {
  pursuit_id: string; status: string; origin: string; updated_at: string; source_kind: string | null; source_ref: string | null;
  interest_id: string | null; expected_value: number | null; expected_score: number | null; completion_predicate: string | null;
  review_at: string | null; progress: number | null; last_worked_at: string | null; evidence_json: string | null;
  closed_reason: string | null; closed_at: string | null;
}

interface EventRow {
  event_id: string; pursuit_id: string; kind: string; actor: string; from_status: string | null; to_status: string | null; detail_json: string; at: string;
}

export type GoalRejection = 'PURSUIT_NOT_FOUND' | 'PURSUIT_SEED_IMMUTABLE' | 'PURSUIT_CLOSED' | 'PURSUIT_NO_PREDICATE';

/** Runs `operation` in one transaction, or inside the caller's. */
export function atomically<T>(database: DatabaseSync, operation: () => T): T {
  if (database.isTransaction) return operation();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

const addDays = (at: string, days: number) => new Date(Date.parse(at) + days * 86_400_000).toISOString();

function parsed<T>(json: string | null, check: (value: unknown) => T | null): T | null {
  if (!json) return null;
  try { return check(JSON.parse(json)); } catch { return null; }
}

export function goalColumns(row: GoalRow): PursuitGoalColumns {
  const evidence = parsed(row.evidence_json, value => (Array.isArray(value) ? value.flatMap(item => checkedGoalEvidence(item) ?? []) : null)) ?? [];
  return Object.freeze({
    sourceKind: row.source_kind ?? (row.origin === 'seed' ? 'seed' : null), sourceRef: row.source_ref, interestId: row.interest_id,
    expectedValue: row.expected_value, expectedScore: row.expected_score, predicate: parsed(row.completion_predicate, checkedGoalPredicate),
    reviewAt: row.review_at, progress: row.progress ?? 0, lastWorkedAt: row.last_worked_at, evidence: Object.freeze(evidence),
    closedReason: row.closed_reason as PursuitClosedReason | null, closedAt: row.closed_at,
  });
}

export class PursuitGoalLedger {
  constructor(private readonly database: DatabaseSync) {}

  /** The goal columns of every pursuit of a scope, by id. */
  columns(scopeKey: string): ReadonlyMap<string, PursuitGoalColumns> {
    const rows = this.database.prepare('SELECT * FROM autonomy_pursuits WHERE scope_key = ?').all(scopeKey) as unknown as GoalRow[];
    return new Map(rows.map(row => [row.pursuit_id, goalColumns(row)]));
  }

  /** The newest events of a scope (or of one pursuit), newest first. */
  events(scopeKey: string, options: { pursuitId?: string; limit?: number } = {}): readonly PursuitEvent[] {
    const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50)));
    const rows = (options.pursuitId
      ? this.database.prepare(`SELECT * FROM autonomy_pursuit_events WHERE scope_key = ? AND pursuit_id = ? ORDER BY at DESC, rowid DESC LIMIT ?`)
        .all(scopeKey, options.pursuitId, limit)
      : this.database.prepare(`SELECT * FROM autonomy_pursuit_events WHERE scope_key = ? ORDER BY at DESC, rowid DESC LIMIT ?`)
        .all(scopeKey, limit)) as unknown as EventRow[];
    return Object.freeze(rows.map(eventOf));
  }

  /** Every event of a scope since an instant, oldest first (at most 5,000), for the daily counts. */
  eventsSince(scopeKey: string, since: string): readonly PursuitEvent[] {
    const rows = this.database.prepare('SELECT * FROM autonomy_pursuit_events WHERE scope_key = ? AND at >= ? ORDER BY at, rowid LIMIT 5000')
      .all(scopeKey, since) as unknown as EventRow[];
    return Object.freeze(rows.map(eventOf));
  }

  append(scopeKey: string, event: Omit<PursuitEvent, 'id' | 'fromStatus' | 'toStatus'> & { fromStatus?: string | null; toStatus?: string | null }): void {
    this.database.prepare(`
      INSERT INTO autonomy_pursuit_events (event_id, scope_key, pursuit_id, kind, actor, from_status, to_status, detail_json, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), scopeKey, event.pursuitId, event.kind, event.actor, event.fromStatus ?? null, event.toStatus ?? null,
      JSON.stringify(event.detail), event.at);
  }

  /** A new pursuit is a goal at once (owner answer 1): first review in a week, and the active cap kept with it active. */
  created(scopeKey: string, pursuitId: string, origin: string, at: string): void {
    const reviewAt = addDays(at, GOAL_LIMITS.firstReviewDays);
    this.database.prepare(`UPDATE autonomy_pursuits SET source_kind = ?, review_at = ?, progress = 0
      WHERE scope_key = ? AND pursuit_id = ? AND origin <> 'seed'`)
      .run(origin, reviewAt, scopeKey, pursuitId);
    this.append(scopeKey, { pursuitId, kind: 'created', actor: 'shannon', toStatus: 'active', detail: { reviewAt }, at });
    this.keepActiveCap(scopeKey, pursuitId, at);
  }

  /** After a status change by her or the owner: why it left `active`, the event, and the cap when it became active. */
  statusChanged(scopeKey: string, pursuitId: string, change: { from: string; to: string; actor: 'shannon' | 'owner' }, at: string): void {
    const reason: PursuitClosedReason | null = change.to === 'active' ? null
      : change.to === 'resting' ? (change.actor === 'owner' ? 'owner_rest' : 'shannon_rest')
        : change.to === 'dropped' ? (change.actor === 'owner' ? 'owner_drop' : 'shannon_drop') : null;
    this.database.prepare(`UPDATE autonomy_pursuits SET closed_reason = ?, closed_at = ? WHERE scope_key = ? AND pursuit_id = ? AND origin <> 'seed'`)
      .run(reason, reason ? at : null, scopeKey, pursuitId);
    this.append(scopeKey, { pursuitId, kind: 'status', actor: change.actor, fromStatus: change.from, toStatus: change.to, detail: {}, at });
    if (change.to === 'active') this.keepActiveCap(scopeKey, pursuitId, at);
  }

  /** She worked on it now (a dispatched capability for it finished). */
  worked(scopeKey: string, pursuitId: string, at: string): void {
    this.database.prepare(`UPDATE autonomy_pursuits SET last_worked_at = ? WHERE scope_key = ? AND pursuit_id = ? AND origin <> 'seed'`)
      .run(at, scopeKey, pursuitId);
  }

  /** She thinks it is done: recorded, and the goal stays as it is until evidence or the owner closes it. */
  proposedComplete(scopeKey: string, pursuitId: string, status: string, at: string): void {
    this.append(scopeKey, { pursuitId, kind: 'propose_complete', actor: 'shannon', fromStatus: status, toStatus: status, detail: {}, at });
  }

  setPredicate(scopeKey: string, pursuitId: string, predicate: GoalPredicate, actor: PursuitEventActor, at: string): PursuitGoalColumns | GoalRejection {
    const row = this.openRow(scopeKey, pursuitId);
    if (typeof row === 'string') return row;
    const checked = checkedGoalPredicate(predicate);
    if (!checked) return 'PURSUIT_NO_PREDICATE';
    return atomically(this.database, () => {
      this.database.prepare('UPDATE autonomy_pursuits SET completion_predicate = ? WHERE scope_key = ? AND pursuit_id = ?')
        .run(JSON.stringify(checked), scopeKey, pursuitId);
      this.append(scopeKey, { pursuitId, kind: 'predicate_set', actor, detail: { type: checked.type }, at });
      return goalColumns(this.row(scopeKey, pursuitId)!);
    });
  }

  /**
   * New evidence for a goal: kept on it (newest per ref), its progress raised to what the evidence shows, and the goal made
   * `done` when the evidence meets its predicate. A goal without a predicate keeps the evidence and stays open.
   */
  completeWithEvidence(scopeKey: string, pursuitId: string, evidence: readonly GoalEvidence[], at: string): GoalVerdict | GoalRejection {
    const row = this.openRow(scopeKey, pursuitId);
    if (typeof row === 'string') return row;
    const columns = goalColumns(row);
    const kept = mergedGoalEvidence(columns.evidence, evidence.flatMap(item => checkedGoalEvidence(item) ?? []));
    const verdict = columns.predicate ? evaluateGoalPredicate(columns.predicate, kept) : null;
    return atomically(this.database, () => {
      const progress = Math.max(columns.progress, verdict?.progress ?? 0);
      if (verdict?.met) {
        this.database.prepare(`UPDATE autonomy_pursuits
          SET status = 'done', progress = 1, evidence_json = ?, closed_reason = 'evidence', closed_at = ?, updated_at = ?
          WHERE scope_key = ? AND pursuit_id = ?`).run(JSON.stringify(kept), at, at, scopeKey, pursuitId);
        const detail = { evidence: verdict.used.length };
        this.append(scopeKey, { pursuitId, kind: 'completed', actor: 'system', fromStatus: row.status, toStatus: 'done', detail, at });
      } else {
        this.database.prepare('UPDATE autonomy_pursuits SET progress = ?, evidence_json = ? WHERE scope_key = ? AND pursuit_id = ?')
          .run(progress, JSON.stringify(kept), scopeKey, pursuitId);
        this.append(scopeKey, { pursuitId, kind: 'evidence', actor: 'system', detail: { progress, evidence: kept.length }, at });
      }
      return verdict ?? Object.freeze({ met: false, progress, used: Object.freeze([]) });
    });
  }

  /**
   * The owner says it is done (`POST /v1/autonomy/pursuits/{id}/confirm`): done, whatever its predicate, active or resting.
   * Idempotent: a goal already done is answered as it is, with no second event.
   */
  confirmByOwner(scopeKey: string, pursuitId: string, at: string): PursuitGoalColumns | GoalRejection {
    const done = this.row(scopeKey, pursuitId);
    if (done?.status === 'done' && done.origin !== 'seed') return goalColumns(done);
    const row = this.openRow(scopeKey, pursuitId);
    if (typeof row === 'string') return row;
    const kept = mergedGoalEvidence(goalColumns(row).evidence, [{ kind: 'owner_confirm', ref: 'owner', at }]);
    return atomically(this.database, () => {
      this.database.prepare(`UPDATE autonomy_pursuits
        SET status = 'done', progress = 1, evidence_json = ?, closed_reason = 'owner_confirm', closed_at = ?, updated_at = ?
        WHERE scope_key = ? AND pursuit_id = ?`).run(JSON.stringify(kept), at, at, scopeKey, pursuitId);
      this.append(scopeKey, { pursuitId, kind: 'owner_confirmed', actor: 'owner', fromStatus: row.status, toStatus: 'done', detail: {}, at });
      return goalColumns(this.row(scopeKey, pursuitId)!);
    });
  }

  /** Non-seed active goals over the cap rest (`closed_reason` 'cap'); `keep` stays active. */
  keepActiveCap(scopeKey: string, keep: string | null, at: string): readonly string[] {
    const active = (this.database.prepare(`
      SELECT pursuit_id, last_worked_at, updated_at FROM autonomy_pursuits WHERE scope_key = ? AND status = 'active' AND origin <> 'seed'
    `).all(scopeKey) as unknown as Array<{ pursuit_id: string; last_worked_at: string | null; updated_at: string }>)
      .map(row => ({ id: row.pursuit_id, lastWorkedAt: row.last_worked_at, updatedAt: row.updated_at }));
    const over = goalsOverCap(active, keep);
    for (const id of over) {
      this.database.prepare(`UPDATE autonomy_pursuits SET status = 'resting', closed_reason = 'cap', closed_at = ? WHERE scope_key = ? AND pursuit_id = ?`)
        .run(at, scopeKey, id);
      const detail = { cap: GOAL_LIMITS.active };
      this.append(scopeKey, { pursuitId: id, kind: 'capped', actor: 'system', fromStatus: 'active', toStatus: 'resting', detail, at });
    }
    return over;
  }

  private row(scopeKey: string, pursuitId: string): GoalRow | null {
    const row = this.database.prepare('SELECT * FROM autonomy_pursuits WHERE scope_key = ? AND pursuit_id = ?').get(scopeKey, pursuitId);
    return (row as unknown as GoalRow | undefined) ?? null;
  }

  /** A non-seed goal that is still open (active or resting). */
  private openRow(scopeKey: string, pursuitId: string): GoalRow | GoalRejection {
    const row = this.row(scopeKey, pursuitId);
    if (!row) return 'PURSUIT_NOT_FOUND';
    if (row.origin === 'seed') return 'PURSUIT_SEED_IMMUTABLE';
    return row.status === 'active' || row.status === 'resting' ? row : 'PURSUIT_CLOSED';
  }
}

function eventOf(row: EventRow): PursuitEvent {
  let detail: Record<string, string | number | boolean | null> = {};
  try {
    const value: unknown = JSON.parse(row.detail_json);
    if (value && typeof value === 'object' && !Array.isArray(value)) detail = value as typeof detail;
  } catch { /* an unreadable detail shows as none */ }
  return Object.freeze({
    id: row.event_id, pursuitId: row.pursuit_id, kind: row.kind as PursuitEventKind, actor: row.actor as PursuitEventActor,
    fromStatus: row.from_status, toStatus: row.to_status, detail: Object.freeze(detail), at: row.at,
  });
}
