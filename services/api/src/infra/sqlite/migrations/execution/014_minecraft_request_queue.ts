// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * The owner's list of requests for her Minecraft body (`contracts/minecraftQueueContract.ts`). Two new tables only: an entry per
 * request (the stored list, kept across a restart, since the task of the request that runs outlives it), and one row per owner scope
 * with whether the list runs, a revision that rises at each change, and the next number. Nothing older is read or written.
 */
export const MINECRAFT_REQUEST_QUEUE_STEP: SchemaStep = {
  id: 'execution/014_minecraft_request_queue',
  operations: [
    { sql: `
      CREATE TABLE IF NOT EXISTS minecraft_request_queue (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        seq INTEGER NOT NULL,
        goal TEXT NOT NULL,
        state TEXT NOT NULL,
        pos INTEGER NOT NULL,
        origin TEXT NOT NULL,
        request_id TEXT,
        experience_id TEXT,
        observed_at TEXT,
        asked_by TEXT,
        task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT,
        note TEXT
      );
    ` },
    { sql: 'CREATE UNIQUE INDEX IF NOT EXISTS minecraft_request_queue_seq ON minecraft_request_queue(scope_key, seq);' },
    { sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS minecraft_request_queue_request
        ON minecraft_request_queue(scope_key, request_id) WHERE request_id IS NOT NULL;
    ` },
    { sql: `
      CREATE TABLE IF NOT EXISTS minecraft_request_queue_state (
        scope_key TEXT PRIMARY KEY,
        auto_run INTEGER NOT NULL,
        rev INTEGER NOT NULL,
        next_seq INTEGER NOT NULL
      );
    ` },
  ],
};
