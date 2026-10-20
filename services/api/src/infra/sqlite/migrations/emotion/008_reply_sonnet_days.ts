// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * Her replies on Sonnet, counted per server day (owner 2026-10-21, `SHANNON_REPLY_SONNET`: one cap a day for voice and text together,
 * kept across restarts). One row a day: how many of the day's replies were given to Sonnet. No words, no one's name. Applied only when
 * the switch opens its store.
 */
export const REPLY_SONNET_DAYS_STEP: SchemaStep = {
  id: 'emotion/008_reply_sonnet_days',
  operations: [
    { sql: `
      CREATE TABLE IF NOT EXISTS shannon_reply_sonnet_days (
        day TEXT PRIMARY KEY,
        used INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    ` },
  ],
};
