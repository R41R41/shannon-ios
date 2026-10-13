// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * What the camera's notice chose, so that its cooldowns and its hourly cap survive a restart of the vision worker (Syzygy
 * ADR-0011 §4.3, ADR-0008 §15: no repeated business). Closed candidate ids and times only: no frame, no words.
 */
export const VISION_CHOICES_STEP: SchemaStep = {
  id: 'vision/002_vision_choices',
  operations: [
    { sql: `
      CREATE TABLE IF NOT EXISTS vision_choices (
        scope_key TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('react', 'notice', 'escalate')),
        chosen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vision_choices_scope ON vision_choices (scope_key, chosen_at);
    ` },
  ],
};
