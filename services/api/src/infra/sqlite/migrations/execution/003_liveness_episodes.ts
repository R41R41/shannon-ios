// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * The episodes of the liveness check (`syncLivenessEpisodes`), moved verbatim at 88d7bfd0 with its table name written out
 * (`LIVENESS_EPISODE_TABLE`), so that the step never changes with a constant. Applied by the first episode sync.
 */
export const LIVENESS_EPISODES_STEP: SchemaStep = {
  id: 'execution/003_liveness_episodes',
  operations: [
    { sql: `CREATE TABLE IF NOT EXISTS ops_liveness_episodes (episode_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL,
    incident TEXT NOT NULL, opened_at TEXT NOT NULL, closed_at TEXT)` },
  ],
};
