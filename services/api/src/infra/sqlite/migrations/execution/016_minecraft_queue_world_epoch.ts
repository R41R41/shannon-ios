// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * When the world was last made new (`worldEpoch`, `surfaces/minecraft/minecraftRequestQueue.ts`): one nullable column on the list's state
 * row of 014. A held or stopped request that last changed before it is a request of the world before; nothing takes it up by itself. An
 * older build ignores the column (it writes the state row without it, which reads as none).
 */
export const MINECRAFT_QUEUE_WORLD_EPOCH_STEP: SchemaStep = {
  id: 'execution/016_minecraft_queue_world_epoch',
  operations: [
    { requireTable: { table: 'minecraft_request_queue_state', error: 'MINECRAFT_QUEUE_WORLD_EPOCH_TABLE_REQUIRED' } },
    { addColumn: { table: 'minecraft_request_queue_state', column: 'world_epoch', definition: 'TEXT' } },
  ],
};
