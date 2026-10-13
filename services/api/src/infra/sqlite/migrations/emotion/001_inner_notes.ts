// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * Her inner notes (Syzygy ADR-0012 D1–D4, stage 1): one row per note, appended by the one reflection writer
 * (`mind/emotion/store/innerNoteStore.ts`). A later note sets `replaced_at` on the one before; the note that closes her day sets
 * `closed_at`. Her own words (the five fields, the change reason, the day's summary), closed hooks, closed trigger and event
 * facts, the ids of what prompted it (for forgetting), the version of her character core, and the call's model, usage and cost.
 * Applied only when `SHANNON_INNER_NOTE` is on: a database that never ran it keeps its schema.
 */
export const INNER_NOTES_STEP: SchemaStep = {
  id: 'emotion/001_inner_notes',
  operations: [
    { sql: `
      CREATE TABLE IF NOT EXISTS shannon_inner_notes (
        note_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        day_id TEXT NOT NULL,
        day_key TEXT NOT NULL,
        day_ends_at TEXT NOT NULL,
        honne TEXT NOT NULL,
        tatemae TEXT NOT NULL,
        reason TEXT NOT NULL,
        plan TEXT NOT NULL,
        bottom TEXT NOT NULL,
        shown TEXT NOT NULL,
        tell TEXT NOT NULL CHECK (tell IN ('none', 'blush')),
        until_at TEXT,
        scale TEXT NOT NULL CHECK (scale IN ('ordinary', 'day')),
        day_reason TEXT CHECK (day_reason IS NULL OR day_reason IN ('intentional', 'repeated', 'big')),
        intent TEXT NOT NULL CHECK (intent IN ('keep', 'soften', 'forgive', 'none')),
        route_summary TEXT NOT NULL,
        change_reason TEXT,
        summary TEXT,
        triggers_json TEXT NOT NULL,
        events_json TEXT NOT NULL,
        source_ids_json TEXT NOT NULL,
        flags_json TEXT NOT NULL,
        core_version TEXT NOT NULL,
        core_hash TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        cost_usd REAL,
        elapsed_ms INTEGER,
        created_at TEXT NOT NULL,
        replaced_at TEXT,
        closed_at TEXT,
        UNIQUE (scope_key, sequence)
      );
      CREATE INDEX IF NOT EXISTS shannon_inner_notes_day ON shannon_inner_notes (scope_key, day_id, sequence);
      CREATE INDEX IF NOT EXISTS shannon_inner_notes_created ON shannon_inner_notes (scope_key, created_at);
    ` },
  ],
};

export const EMOTION_STEPS: readonly SchemaStep[] = Object.freeze([INNER_NOTES_STEP]);
