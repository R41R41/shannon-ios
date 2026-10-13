// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * The vision budget's reservation ledger (Syzygy ADR-0011 §7.2): one row per paid vision call, reserved before the call is sent.
 * `state` is `reserved` while the call is out, `settled` with its known cost, or `held` when its usage is unknown (the reservation
 * keeps counting). Amounts only: no frame, no text, no candidate words.
 */
export const VISION_BUDGET_STEP: SchemaStep = {
  id: 'vision/001_vision_budget',
  operations: [
    { sql: `
      CREATE TABLE IF NOT EXISTS vision_budget_reservations (
        reservation_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        day TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('decision', 'notice_line', 'escalate')),
        reserved_usd REAL NOT NULL CHECK (reserved_usd > 0),
        actual_usd REAL,
        state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'held')),
        created_at TEXT NOT NULL,
        settled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS vision_budget_reservations_day ON vision_budget_reservations (scope_key, day);
    ` },
  ],
};

export const VISION_STEPS: readonly SchemaStep[] = Object.freeze([VISION_BUDGET_STEP]);
