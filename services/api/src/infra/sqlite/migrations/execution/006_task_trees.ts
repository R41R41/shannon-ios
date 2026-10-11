import type { SchemaStep } from '../schemaSteps.js';

/**
 * The task trees of stage 5 (`TaskTreeStore`) and their learning outbox (`taskTreeCallbacks.ts`), moved verbatim at 88d7bfd0.
 * Applied by a task tree store that makes its schema (the Agent Host store with task trees on).
 */
export const TASK_TREES_STEP: SchemaStep = {
  id: 'execution/006_task_trees',
  operations: [
    { sql: `
      CREATE TABLE IF NOT EXISTS agent_task_trees (
        scope_key TEXT NOT NULL, task_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, tree_json TEXT NOT NULL,
        updated_at TEXT NOT NULL, FOREIGN KEY(task_id) REFERENCES agent_tasks(task_id));
      CREATE TABLE IF NOT EXISTS agent_task_tree_versions (
        scope_key TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL, tree_json TEXT NOT NULL,
        made_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(task_id,revision));
      CREATE TABLE IF NOT EXISTS agent_task_tree_attempts (
        scope_key TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL, attempt_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_task_tree_proposals (
        scope_key TEXT NOT NULL, task_id TEXT NOT NULL, proposal_id TEXT PRIMARY KEY, proposal_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_task_tree_proposal_ops (
        scope_key TEXT NOT NULL,task_id TEXT NOT NULL,operation_id TEXT NOT NULL,proposal_id TEXT NOT NULL,request_hash TEXT NOT NULL,
        PRIMARY KEY(scope_key,task_id,operation_id));
      CREATE TABLE IF NOT EXISTS agent_task_tree_receipts (
        task_id TEXT NOT NULL, event_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL);
    ` },
    { sql: `CREATE TABLE IF NOT EXISTS agent_task_tree_learning (
    id TEXT PRIMARY KEY,event_json TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);` },
  ],
};
