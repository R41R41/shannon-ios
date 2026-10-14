// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * Her feeling events (Syzygy ADR-0013 stage 1, `SHANNON_FEELING_EVENTS`): one row per touch, word or reply of hers, as closed values
 * (`facts_json` holds closed symbols and counts, never words). Keyed by who it is about (`person_key`, `identity`) and who saw it
 * (`audience`), with the scene it belongs to. The episode ledger is folded from these rows; forgetting a row's `source_id` takes it
 * out of every fold. `composure` and `register` (ADR-0013 D16) are kept per event from the first stage so that stage 2 needs no
 * migration: full and `normal` until it moves them.
 */
export const FEELING_EVENTS_STEP: SchemaStep = {
  id: 'emotion/004_feeling_events',
  operations: [
    { sql: `
      CREATE TABLE IF NOT EXISTS shannon_feeling_events (
        scope_key TEXT NOT NULL,
        event_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        person_key TEXT NOT NULL,
        identity TEXT NOT NULL,
        audience TEXT NOT NULL,
        channel TEXT NOT NULL,
        scene_id TEXT,
        source_id TEXT,
        facts_json TEXT NOT NULL,
        composure REAL NOT NULL DEFAULT 1 CHECK (composure >= 0 AND composure <= 1),
        register TEXT NOT NULL DEFAULT 'normal',
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, event_id)
      );
    ` },
    { sql: 'CREATE INDEX IF NOT EXISTS shannon_feeling_events_time ON shannon_feeling_events (scope_key, occurred_at);' },
  ],
};
