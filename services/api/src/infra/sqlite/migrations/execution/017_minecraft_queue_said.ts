// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * What the person said when a request of the list was made by voice (`SpokenWords`): one nullable column on the list of requests of 014 holding it as
 * JSON, so that the task made for the request later (when its turn comes) is given the words, the time and the place along with its goal. An older build
 * ignores the column (it writes its rows without it, which reads as none).
 */
export const MINECRAFT_QUEUE_SAID_STEP: SchemaStep = {
  id: 'execution/017_minecraft_queue_said',
  operations: [
    { requireTable: { table: 'minecraft_request_queue', error: 'MINECRAFT_QUEUE_SAID_TABLE_REQUIRED' } },
    { addColumn: { table: 'minecraft_request_queue', column: 'said_json', definition: 'TEXT' } },
  ],
};
