// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * The subordinate tables of the common task runtime, moved verbatim at 88d7bfd0 in the order its constructor ran them:
 * `taskRuntimeSchema.ts`, then the progress, source, history, maintenance and conversation-delivery stores. A later column
 * is added only when it is missing, as before. Applied by `SQLiteTaskRuntimeStore`.
 */
export const FCA_TASK_RUNTIME_STEP: SchemaStep = {
  id: 'execution/005_fca_task_runtime',
  operations: [
    { sql: `CREATE TABLE IF NOT EXISTS fca_task_checkpoints (
      task_id TEXT PRIMARY KEY REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
      checkpoint_json TEXT, wait_reason TEXT, stop_requested INTEGER NOT NULL DEFAULT 0,
      step_id TEXT, lease_json TEXT, last_admission INTEGER NOT NULL DEFAULT 0, observed_messages_json TEXT);
      CREATE TABLE IF NOT EXISTS fca_task_dispatch_order (
      scope_key TEXT PRIMARY KEY, last_admission INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS fca_task_messages (
      scope_key TEXT NOT NULL, message_id TEXT NOT NULL, source_task_id TEXT NOT NULL REFERENCES agent_tasks(task_id),
      target_task_id TEXT NOT NULL REFERENCES agent_tasks(task_id), text TEXT NOT NULL, received_at TEXT NOT NULL,
      consumed_by TEXT, PRIMARY KEY(scope_key,message_id));
      CREATE INDEX IF NOT EXISTS fca_task_inbox ON fca_task_messages(target_task_id,consumed_by);
      CREATE TABLE IF NOT EXISTS fca_task_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES agent_tasks(task_id),
      step_id TEXT NOT NULL UNIQUE, entries_json TEXT NOT NULL, committed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fca_task_segment_receipts (
      step_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES agent_tasks(task_id),
      lease_json TEXT NOT NULL, created_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'completed');` },
    { addColumn: { table: 'fca_task_checkpoints', column: 'observed_messages_json', definition: 'TEXT' } },
    { addColumn: { table: 'fca_task_checkpoints', column: 'last_admission', definition: 'INTEGER NOT NULL DEFAULT 0' } },
    { addColumn: { table: 'fca_task_segment_receipts', column: 'state', definition: "TEXT NOT NULL DEFAULT 'completed'" } },
    { sql: `CREATE TABLE IF NOT EXISTS fca_task_progress (
      task_id TEXT PRIMARY KEY REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
      step_id TEXT NOT NULL, operation_id TEXT NOT NULL, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fca_task_place_context (task_id TEXT PRIMARY KEY REFERENCES agent_tasks(task_id) ON DELETE CASCADE, `
      + `context_json TEXT NOT NULL);` },
    { sql: `CREATE TABLE IF NOT EXISTS fca_task_sources (
      step_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, thread_id TEXT NOT NULL, experience_id TEXT,
      observed_at TEXT NOT NULL, recalled_ids_json TEXT NOT NULL DEFAULT '[]', read_ids_json TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS fca_task_source_links (
      task_id TEXT NOT NULL REFERENCES agent_tasks(task_id), step_id TEXT NOT NULL REFERENCES fca_task_sources(step_id),
      message_id TEXT NOT NULL DEFAULT '', PRIMARY KEY(task_id,step_id,message_id));` },
    { addColumn: { table: 'fca_task_sources', column: 'read_ids_json', definition: "TEXT NOT NULL DEFAULT '[]'" } },
    { addColumn: { table: 'fca_task_sources', column: 'source_kind', definition: "TEXT NOT NULL DEFAULT 'conversation'" } },
    { sql: `CREATE TABLE IF NOT EXISTS fca_task_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES agent_tasks(task_id),
      step_id TEXT NOT NULL UNIQUE, entries_json TEXT NOT NULL, committed_at TEXT NOT NULL,
      committed_status TEXT NOT NULL DEFAULT 'unknown', sources_json TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS fca_task_history_summaries (
      task_id TEXT PRIMARY KEY REFERENCES agent_tasks(task_id), revision INTEGER NOT NULL,
      from_sequence INTEGER NOT NULL, through_sequence INTEGER NOT NULL,
      template_json TEXT NOT NULL, sources_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      reset_through_sequence INTEGER NOT NULL DEFAULT 0, bootstrap_text TEXT NOT NULL DEFAULT '');` },
    { addColumn: { table: 'fca_task_history', column: 'committed_status', definition: "TEXT NOT NULL DEFAULT 'unknown'" } },
    { addColumn: { table: 'fca_task_history', column: 'sources_json', definition: "TEXT NOT NULL DEFAULT '[]'" } },
    { addColumn: { table: 'fca_task_history_summaries', column: 'reset_through_sequence', definition: 'INTEGER NOT NULL DEFAULT 0' } },
    { addColumn: { table: 'fca_task_history_summaries', column: 'bootstrap_text', definition: "TEXT NOT NULL DEFAULT ''" } },
    { sql: `CREATE TABLE IF NOT EXISTS fca_task_maintenance(
      task_id TEXT PRIMARY KEY REFERENCES agent_tasks(task_id), scope_key TEXT NOT NULL,
      job_id TEXT NOT NULL, day_key TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL,
      UNIQUE(scope_key,job_id));` },
    { sql: `CREATE TABLE IF NOT EXISTS fca_conversation_deliveries (
      scope_key TEXT NOT NULL, thread_id TEXT NOT NULL, utterance_id TEXT NOT NULL,
      device_id TEXT NOT NULL, input_digest TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES agent_tasks(task_id),
      step_id TEXT NOT NULL UNIQUE REFERENCES fca_task_sources(step_id), state TEXT NOT NULL,
      source_json TEXT, messages_json TEXT NOT NULL DEFAULT '[]', experience_id TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY(scope_key,thread_id,utterance_id));` },
  ],
};
