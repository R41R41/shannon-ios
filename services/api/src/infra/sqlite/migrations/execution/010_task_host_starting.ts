// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * Whether an active Codex task is still connecting to its Host (Syzygy ADR-0009 stage 1, S4): stored when the state machine
 * writes the task, so the projection check compares `starting`/`running` with a recorded flag instead of deriving it from the
 * status it checks (S3 review L3). Additive and nullable (null for FCA tasks and for rows the backfill has not reached); an
 * older build ignores it.
 */
export const TASK_HOST_STARTING_STEP: SchemaStep = {
  id: 'execution/010_task_host_starting',
  operations: [
    { requireTable: { table: 'agent_tasks', error: 'TASK_HOST_STARTING_AGENT_TASKS_REQUIRED' } },
    { addColumn: { table: 'agent_tasks', column: 'exec_starting', definition: 'INTEGER' } },
  ],
};
