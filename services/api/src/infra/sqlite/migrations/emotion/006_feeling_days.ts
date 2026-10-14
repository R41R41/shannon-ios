// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * Her closed days (Syzygy ADR-0013 stage 3: the relationship ledger, boundary memory and episode memory). One row per day, person,
 * audience and scene: that day's feeling events in their closed form (kinds, parts, stances, tags, source ids; never words), kept past
 * the events' own retention so the folds can read them. Read through the forgetting filter: a forgotten source is left out of every
 * fold, so the ledger, the boundaries and the episodes are computed again without it. Applied only when a stage-3 switch opens its store.
 */
export const FEELING_DAYS_STEP: SchemaStep = {
  id: 'emotion/006_feeling_days',
  operations: [
    { sql: `
      CREATE TABLE IF NOT EXISTS shannon_feeling_days (
        scope_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        person_key TEXT NOT NULL,
        audience TEXT NOT NULL,
        scene_id TEXT NOT NULL DEFAULT '',
        events_json TEXT NOT NULL,
        closed_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, day_key, person_key, audience, scene_id)
      );
    ` },
    { sql: 'CREATE INDEX IF NOT EXISTS shannon_feeling_days_person ON shannon_feeling_days (scope_key, person_key, day_key);' },
  ],
};
