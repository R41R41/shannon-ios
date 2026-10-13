// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * When the sulk a note belongs to began (Syzygy ADR-0012 D4): an ordinary sulk ends an hour from its episode's start, however its
 * notes rewrite `until`. Null for a calm note and for notes written before this step.
 */
export const INNER_NOTE_EPISODES_STEP: SchemaStep = {
  id: 'emotion/002_inner_note_episodes',
  operations: [
    { addColumn: { table: 'shannon_inner_notes', column: 'episode_started_at', definition: 'TEXT' } },
  ],
};
