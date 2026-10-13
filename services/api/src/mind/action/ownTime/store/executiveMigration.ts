import type { DatabaseSync } from 'node:sqlite';

/**
 * The Executive's deliberation record (Syzygy ADR-0009 stage 2, E5), in her own time's tables: additive, outside the numbered
 * migrations, and made on first use, so a database the Executive never ran in keeps its schema (the stage-3 byte proofs).
 * One row per deliberation: what was chosen, where it stood by value, her one-line reason and intent (her words, never the
 * owner's: the material holds numbers and closed values only), how it was dispatched, and what came of it.
 */
export function ensureDeliberationSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS executive_deliberations (
      deliberation_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      at TEXT NOT NULL,
      trigger TEXT NOT NULL,
      capability TEXT NOT NULL,
      goal_id TEXT,
      reason TEXT,
      intent TEXT,
      value_rank INTEGER,
      top_by_value INTEGER NOT NULL DEFAULT 0,
      off_candidates INTEGER NOT NULL DEFAULT 0,
      candidates_json TEXT NOT NULL DEFAULT '[]',
      material_json TEXT NOT NULL DEFAULT '{}',
      dispatch TEXT NOT NULL,
      cycle_id TEXT,
      task_id TEXT,
      outcome TEXT NOT NULL,
      outcome_at TEXT,
      next_think_at TEXT NOT NULL,
      choice_id TEXT,
      forgotten_at TEXT
    );
    CREATE INDEX IF NOT EXISTS executive_deliberations_scope ON executive_deliberations (scope_key, at DESC);
    CREATE TRIGGER IF NOT EXISTS executive_deliberations_no_delete BEFORE DELETE ON executive_deliberations
      BEGIN SELECT RAISE(ABORT, 'DELIBERATIONS_APPEND_ONLY'); END;
  `);
}
