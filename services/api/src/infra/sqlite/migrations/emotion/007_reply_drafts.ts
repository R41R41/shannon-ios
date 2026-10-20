// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * Her drafts that the reply check had rewritten (owner 2026-10-20, `SHANNON_NATURAL_TALK`: what a rewrite took out could not be told
 * afterwards). The owner alone only: the first draft, its flags and the rewrite, kept a few days for diagnosis and pruned after. Not the
 * Observer's (it keeps no words). Applied only when the switch opens its store.
 */
export const REPLY_DRAFTS_STEP: SchemaStep = {
  id: 'emotion/007_reply_drafts',
  operations: [
    { sql: `
      CREATE TABLE IF NOT EXISTS shannon_reply_drafts (
        scope_key TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        flags_json TEXT NOT NULL,
        first_draft TEXT NOT NULL,
        rewrite TEXT,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, turn_id)
      );
    ` },
    { sql: 'CREATE INDEX IF NOT EXISTS shannon_reply_drafts_recorded ON shannon_reply_drafts (scope_key, recorded_at);' },
  ],
};
