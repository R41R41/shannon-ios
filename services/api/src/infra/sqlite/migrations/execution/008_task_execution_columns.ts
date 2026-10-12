// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * The one task vocabulary on the existing task authority (Syzygy ADR-0009 stage 1, S3): additive, nullable columns, no CHECK
 * (the values are validated in `packages/mind/src/tasks.ts`). `status` and `pause_reason` stay the authority; these columns
 * are written beside them and filled for older rows by the backfill (`taskExecutionColumns.ts`). Applied by the Agent Host
 * store and the FCA authority after `agent_tasks` exists; an older build ignores them.
 */
export const TASK_EXECUTION_COLUMNS_STEP: SchemaStep = {
  id: 'execution/008_task_execution_columns',
  operations: [
    { requireTable: { table: 'agent_tasks', error: 'TASK_EXECUTION_AGENT_TASKS_REQUIRED' } },
    { addColumn: { table: 'agent_tasks', column: 'task_kind', definition: 'TEXT' } },
    { addColumn: { table: 'agent_tasks', column: 'capability', definition: 'TEXT' } },
    { addColumn: { table: 'agent_tasks', column: 'exec_state', definition: 'TEXT' } },
    { addColumn: { table: 'agent_tasks', column: 'wait_reason', definition: 'TEXT' } },
    { addColumn: { table: 'agent_tasks', column: 'unknown_since', definition: 'TEXT' } },
    { addColumn: { table: 'agent_tasks', column: 'effect_class', definition: 'TEXT' } },
    { addColumn: { table: 'agent_tasks', column: 'exec_state_at', definition: 'TEXT' } },
  ],
};
