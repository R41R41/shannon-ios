// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * Which request a held request is waiting for (`resumeAfter`, `surfaces/minecraft/minecraftRequestQueue.ts`): one nullable column on the list of
 * requests of 014. A request let go because another was put in front of it (`now`, or a start of another) is marked with that request's id and
 * is taken back when that one has ended; a request the owner held himself has none and stays held. An older build ignores the column (it writes
 * its rows without it, which reads as none).
 */
export const MINECRAFT_QUEUE_RESUME_AFTER_STEP: SchemaStep = {
  id: 'execution/015_minecraft_queue_resume_after',
  operations: [
    { requireTable: { table: 'minecraft_request_queue', error: 'MINECRAFT_QUEUE_RESUME_AFTER_TABLE_REQUIRED' } },
    { addColumn: { table: 'minecraft_request_queue', column: 'resume_after', definition: 'TEXT' } },
  ],
};
