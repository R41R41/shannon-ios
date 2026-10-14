// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * The shadow of her fast layer (Syzygy ADR-0013 stage 2, `SHANNON_CORE_AFFECT`): one row per feeling event, the core affect, mood,
 * blame, composure and register folded up to it, beside the current state's two numbers, for comparison and for the Observer's
 * graph. Closed numbers and labels only. Nothing reads it back into her state or a prompt until the owner approves.
 */
export const FEELING_SHADOW_STEP: SchemaStep = {
  id: 'emotion/005_feeling_shadow',
  operations: [
    { sql: `
      CREATE TABLE IF NOT EXISTS shannon_feeling_shadow (
        scope_key TEXT NOT NULL,
        event_id TEXT NOT NULL,
        person_key TEXT NOT NULL,
        audience TEXT NOT NULL,
        scene_id TEXT,
        source_id TEXT,
        kind TEXT NOT NULL,
        valence REAL NOT NULL,
        arousal REAL NOT NULL,
        dominance REAL NOT NULL,
        mood REAL NOT NULL,
        blame REAL NOT NULL,
        composure REAL NOT NULL,
        level INTEGER NOT NULL,
        register TEXT NOT NULL,
        label TEXT NOT NULL,
        slip INTEGER NOT NULL,
        cover_up INTEGER NOT NULL,
        current_valence REAL,
        current_arousal REAL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, event_id)
      );
    ` },
    { sql: 'CREATE INDEX IF NOT EXISTS shannon_feeling_shadow_time ON shannon_feeling_shadow (scope_key, occurred_at);' },
  ],
};
