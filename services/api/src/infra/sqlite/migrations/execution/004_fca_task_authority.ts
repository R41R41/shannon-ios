// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * The common runtime's additive columns on the existing task authority (`SQLiteFcaTaskAuthority`), moved verbatim at 88d7bfd0:
 * each column is added only when it is missing, and nothing is made before `agent_tasks` exists. Applied only where the
 * common runtime is switched on, so a database that never ran it keeps the historical `agent_tasks`.
 */
export const FCA_TASK_AUTHORITY_STEP: SchemaStep = {
  id: 'execution/004_fca_task_authority',
  operations: [
    { requireTable: { table: 'agent_tasks', error: 'FCA_AGENT_TASKS_MIGRATION_REQUIRED' } },
    { addColumn: { table: 'agent_tasks', column: 'fca_kind', definition: 'TEXT' } },
    { addColumn: { table: 'agent_tasks', column: 'fca_parent_id', definition: 'TEXT REFERENCES agent_tasks(task_id)' } },
    { addColumn: { table: 'agent_tasks', column: 'fca_origin', definition: 'TEXT' } },
    { addColumn: { table: 'agent_tasks', column: 'fca_completion_criteria', definition: "TEXT NOT NULL DEFAULT ''" } },
    { sql: `CREATE UNIQUE INDEX IF NOT EXISTS agent_tasks_fca_root ON agent_tasks(scope_key) WHERE fca_kind='root';
        CREATE INDEX IF NOT EXISTS agent_tasks_fca_parent ON agent_tasks(scope_key,fca_parent_id);` },
  ],
};
