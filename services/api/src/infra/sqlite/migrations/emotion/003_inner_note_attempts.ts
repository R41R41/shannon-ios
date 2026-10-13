// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * The reflections attempted per owner-local day (Syzygy ADR-0012 D3, the cost guard), kept in the database so that a restart (the
 * VM is a Spot instance) does not reset the day's count. Failures and timeouts count too.
 */
export const INNER_NOTE_ATTEMPTS_STEP: SchemaStep = {
  id: 'emotion/003_inner_note_attempts',
  operations: [
    { sql: `
      CREATE TABLE IF NOT EXISTS shannon_inner_note_attempts (
        scope_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        PRIMARY KEY (scope_key, day_key)
      );
    ` },
  ],
};
