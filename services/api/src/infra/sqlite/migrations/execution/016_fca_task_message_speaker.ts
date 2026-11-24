// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * What a person said beside the line that sums it up (`SpokenWords`, `taskExternalEventPorts.ts`): one nullable column on the messages of 005 holding
 * the speaker's name, their own words, when they said them and where they stood in the game, as JSON. A message sent without it has none, and an
 * older build ignores the column (it writes its rows without it, which reads as none).
 */
export const FCA_TASK_MESSAGE_SPEAKER_STEP: SchemaStep = {
  id: 'execution/016_fca_task_message_speaker',
  operations: [
    { requireTable: { table: 'fca_task_messages', error: 'FCA_TASK_MESSAGE_SPEAKER_TABLE_REQUIRED' } },
    { addColumn: { table: 'fca_task_messages', column: 'speaker_json', definition: 'TEXT' } },
  ],
};
