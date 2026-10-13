import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { applySchemaSteps } from '../../../infra/sqlite/migrations/schemaSteps.js';
import { VISION_STEPS } from '../../../infra/sqlite/migrations/vision/001_vision_budget.js';

export type VisionBudgetPurpose = 'decision' | 'notice_line' | 'escalate';
export interface VisionDayTotals { settledUsd: number; heldUsd: number; reservedUsd: number }

/**
 * The reservation ledger of the vision budget (Syzygy ADR-0011 §7.2; ADR-0009 D9): a paid call is reserved before it is sent,
 * inside one write transaction that also reads the day's total, so two processes can never both pass the cap. A call whose usage
 * is unknown keeps its reservation (`held`); a reservation left `reserved` by a process that died keeps counting too.
 */
export class SQLiteVisionBudgetStore {
  constructor(private readonly database: DatabaseSync, now: () => string = () => new Date().toISOString()) {
    applySchemaSteps(database, VISION_STEPS, now);
  }

  totals(scopeKey: string, day: string): VisionDayTotals {
    const row = this.database.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN state = 'settled' THEN actual_usd ELSE 0 END), 0) AS settled,
        COALESCE(SUM(CASE WHEN state = 'held' THEN MAX(reserved_usd, COALESCE(actual_usd, 0)) ELSE 0 END), 0) AS held,
        COALESCE(SUM(CASE WHEN state = 'reserved' THEN reserved_usd ELSE 0 END), 0) AS reserved
      FROM vision_budget_reservations WHERE scope_key = ? AND day = ?
    `).get(scopeKey, day) as { settled: number; held: number; reserved: number };
    return { settledUsd: row.settled, heldUsd: row.held, reservedUsd: row.reserved };
  }

  /** Reserves `amountUsd` unless the day's spend, holds and reservations with it would pass `capUsd`. */
  reserve(scopeKey: string, day: string, purpose: VisionBudgetPurpose, amountUsd: number, capUsd: number, at: string): string | null {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error('VISION_BUDGET_AMOUNT');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const totals = this.totals(scopeKey, day);
      if (totals.settledUsd + totals.heldUsd + totals.reservedUsd + amountUsd > capUsd) {
        this.database.exec('ROLLBACK');
        return null;
      }
      const id = randomUUID();
      this.database.prepare(`
        INSERT INTO vision_budget_reservations (reservation_id, scope_key, day, purpose, reserved_usd, state, created_at)
        VALUES (?, ?, ?, ?, ?, 'reserved', ?)
      `).run(id, scopeKey, day, purpose, amountUsd, at);
      this.database.exec('COMMIT');
      return id;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /** A known cost: the reservation is released and the actual cost counts. */
  settle(reservationId: string, actualUsd: number, at: string): boolean {
    if (!Number.isFinite(actualUsd) || actualUsd < 0) throw new Error('VISION_BUDGET_AMOUNT');
    const result = this.database.prepare(`
      UPDATE vision_budget_reservations SET state = 'settled', actual_usd = ?, settled_at = ? WHERE reservation_id = ? AND state = 'reserved'
    `).run(actualUsd, at, reservationId);
    return result.changes === 1;
  }

  /** An unknown cost: the reservation stays counted (at least what is known). */
  hold(reservationId: string, knownUsd: number | null, at: string): boolean {
    const result = this.database.prepare(`
      UPDATE vision_budget_reservations SET state = 'held', actual_usd = ?, settled_at = ? WHERE reservation_id = ? AND state = 'reserved'
    `).run(knownUsd, at, reservationId);
    return result.changes === 1;
  }
}
