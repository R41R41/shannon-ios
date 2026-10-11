import type { DatabaseSync } from 'node:sqlite';
import { LIVENESS_EPISODE_TABLE } from '../../src/contracts/livenessNoticeContract.js';

/**
 * The execution DDL as the constructors ran it at 88d7bfd0, before Syzygy ADR-0009 stage 1, S2 moved it into the schema steps
 * (`src/infra/sqlite/migrations/execution/`). Copied verbatim, with the old conditional ALTERs (PRAGMA table_info) and the old
 * write lock of the FCA authority (BEGIN IMMEDIATE). `executionSchemaSteps.test.ts` builds a golden database with these and
 * checks that the new code leaves it as it is. Never edit these to follow the source: they are the old path.
 */

function immediate(db: DatabaseSync, work: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    work();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** `SQLiteActionStore`'s constructor, then `ensureRetainedResourceSchema`. */
export function oldActionStoreSchema(db: DatabaseSync): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS mind_actions (
        id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, kind TEXT NOT NULL, origin TEXT NOT NULL, source_id TEXT NOT NULL,
        parent_id TEXT, state TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, holder TEXT, last_holder TEXT, lease_until TEXT,
        resources_json TEXT NOT NULL, base_resources_json TEXT NOT NULL, owner_informed INTEGER NOT NULL, deadline TEXT, progress TEXT, result TEXT,
        sent INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, last_failure TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(scope_key, kind, source_id)
      );
      CREATE INDEX IF NOT EXISTS mind_actions_scope ON mind_actions(scope_key,state,created_at);
      CREATE INDEX IF NOT EXISTS mind_actions_state_updated ON mind_actions(state,updated_at);
      CREATE TABLE IF NOT EXISTS mind_action_budget (
        reservation_id TEXT PRIMARY KEY, action_id TEXT NOT NULL, generation INTEGER NOT NULL, scope_key TEXT NOT NULL,
        day TEXT NOT NULL, yen REAL NOT NULL CHECK(yen >= 0), state TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
        UNIQUE(action_id,generation,reservation_id)
      );
      CREATE TABLE IF NOT EXISTS mind_action_notice_receipts (
        request_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, action_id TEXT NOT NULL, notification_id TEXT NOT NULL, acknowledged_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mind_action_notice_episode ON mind_action_notice_receipts(scope_key,action_id,notification_id);
      CREATE TABLE IF NOT EXISTS mind_action_controls (
        request_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, target_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mind_action_acknowledgements (
        id TEXT PRIMARY KEY,report_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mind_action_resource_acknowledgements (
        id TEXT PRIMARY KEY,report_json TEXT NOT NULL
      );
    `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS mind_action_retained_resources (
      action_id TEXT NOT NULL, resource TEXT NOT NULL, retained_at TEXT NOT NULL, PRIMARY KEY (action_id, resource)
    );
    CREATE TABLE IF NOT EXISTS mind_action_retained_releases (
      request_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, action_id TEXT NOT NULL, released_by TEXT NOT NULL,
      reason TEXT NOT NULL, resources_json TEXT NOT NULL, released_at TEXT NOT NULL
    );
  `);
}

/** `recordMindWorkerStart`, its DDL. */
export function oldMindWorkerStartSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS mind_worker_starts (started_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mind_worker_start_revisions (started_at TEXT NOT NULL, revision TEXT)`);
}

/** `syncLivenessEpisodes`, its DDL. */
export function oldLivenessEpisodeSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${LIVENESS_EPISODE_TABLE} (episode_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL,
    incident TEXT NOT NULL, opened_at TEXT NOT NULL, closed_at TEXT)`);
}

/** `SQLiteFcaTaskAuthority`'s constructor. */
export function oldFcaTaskAuthoritySchema(db: DatabaseSync): void {
  const additions = [
    ['fca_kind', 'TEXT'], ['fca_parent_id', 'TEXT REFERENCES agent_tasks(task_id)'],
    ['fca_origin', 'TEXT'], ['fca_completion_criteria', "TEXT NOT NULL DEFAULT ''"],
  ];
  immediate(db, () => {
    const columns = db.prepare("PRAGMA table_info('agent_tasks')").all() as Array<{ name: string }>;
    if (!columns.length) throw new Error('FCA_AGENT_TASKS_MIGRATION_REQUIRED');
    for (const [name, definition] of additions) if (!columns.some(column => column.name === name)) {
      db.exec(`ALTER TABLE agent_tasks ADD COLUMN ${name} ${definition}`);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS agent_tasks_fca_root ON agent_tasks(scope_key) WHERE fca_kind='root';
        CREATE INDEX IF NOT EXISTS agent_tasks_fca_parent ON agent_tasks(scope_key,fca_parent_id);`);
  });
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}

/** `ensureTaskRuntimeSchema` (`taskRuntimeSchema.ts`). */
function oldTaskRuntimeSchemaFile(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS fca_task_checkpoints (
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
      lease_json TEXT NOT NULL, created_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'completed');`);
  immediate(db, () => {
    if (!hasColumn(db, 'fca_task_checkpoints', 'observed_messages_json')) {
      db.exec('ALTER TABLE fca_task_checkpoints ADD COLUMN observed_messages_json TEXT');
    }
    if (!hasColumn(db, 'fca_task_checkpoints', 'last_admission')) {
      db.exec('ALTER TABLE fca_task_checkpoints ADD COLUMN last_admission INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasColumn(db, 'fca_task_segment_receipts', 'state')) {
      db.exec("ALTER TABLE fca_task_segment_receipts ADD COLUMN state TEXT NOT NULL DEFAULT 'completed'");
    }
  });
}

/** `TaskSourceStore`'s constructor. */
function oldTaskSourceSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS fca_task_sources (
      step_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, thread_id TEXT NOT NULL, experience_id TEXT,
      observed_at TEXT NOT NULL, recalled_ids_json TEXT NOT NULL DEFAULT '[]', read_ids_json TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS fca_task_source_links (
      task_id TEXT NOT NULL REFERENCES agent_tasks(task_id), step_id TEXT NOT NULL REFERENCES fca_task_sources(step_id),
      message_id TEXT NOT NULL DEFAULT '', PRIMARY KEY(task_id,step_id,message_id));`);
  if (!hasColumn(db, 'fca_task_sources', 'read_ids_json')) {
    db.exec("ALTER TABLE fca_task_sources ADD COLUMN read_ids_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!hasColumn(db, 'fca_task_sources', 'source_kind')) {
    db.exec("ALTER TABLE fca_task_sources ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'conversation'");
  }
}

/** `TaskHistoryStore`'s constructor. */
function oldTaskHistorySchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS fca_task_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES agent_tasks(task_id),
      step_id TEXT NOT NULL UNIQUE, entries_json TEXT NOT NULL, committed_at TEXT NOT NULL,
      committed_status TEXT NOT NULL DEFAULT 'unknown', sources_json TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS fca_task_history_summaries (
      task_id TEXT PRIMARY KEY REFERENCES agent_tasks(task_id), revision INTEGER NOT NULL,
      from_sequence INTEGER NOT NULL, through_sequence INTEGER NOT NULL,
      template_json TEXT NOT NULL, sources_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      reset_through_sequence INTEGER NOT NULL DEFAULT 0, bootstrap_text TEXT NOT NULL DEFAULT '');`);
  const columns = new Set(db.prepare('PRAGMA table_info(fca_task_history)').all().map(row => row.name));
  if (!columns.has('committed_status')) db.exec("ALTER TABLE fca_task_history ADD COLUMN committed_status TEXT NOT NULL DEFAULT 'unknown'");
  if (!columns.has('sources_json')) db.exec("ALTER TABLE fca_task_history ADD COLUMN sources_json TEXT NOT NULL DEFAULT '[]'");
  const summaries = new Set(db.prepare('PRAGMA table_info(fca_task_history_summaries)').all().map(row => row.name));
  if (!summaries.has('reset_through_sequence')) {
    db.exec('ALTER TABLE fca_task_history_summaries ADD COLUMN reset_through_sequence INTEGER NOT NULL DEFAULT 0');
  }
  if (!summaries.has('bootstrap_text')) db.exec("ALTER TABLE fca_task_history_summaries ADD COLUMN bootstrap_text TEXT NOT NULL DEFAULT ''");
}

/** `SQLiteTaskRuntimeStore`'s constructor: the schema file, then the progress, source, history, maintenance and delivery stores. */
export function oldTaskRuntimeSchema(db: DatabaseSync): void {
  oldTaskRuntimeSchemaFile(db);
  db.exec(`CREATE TABLE IF NOT EXISTS fca_task_progress (
      task_id TEXT PRIMARY KEY REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
      step_id TEXT NOT NULL, operation_id TEXT NOT NULL, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fca_task_place_context (task_id TEXT PRIMARY KEY REFERENCES agent_tasks(task_id) ON DELETE CASCADE, context_json TEXT NOT NULL);`);
  oldTaskSourceSchema(db);
  oldTaskHistorySchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS fca_task_maintenance(
      task_id TEXT PRIMARY KEY REFERENCES agent_tasks(task_id), scope_key TEXT NOT NULL,
      job_id TEXT NOT NULL, day_key TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL,
      UNIQUE(scope_key,job_id));`);
  db.exec(`CREATE TABLE IF NOT EXISTS fca_conversation_deliveries (
      scope_key TEXT NOT NULL, thread_id TEXT NOT NULL, utterance_id TEXT NOT NULL,
      device_id TEXT NOT NULL, input_digest TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES agent_tasks(task_id),
      step_id TEXT NOT NULL UNIQUE REFERENCES fca_task_sources(step_id), state TEXT NOT NULL,
      source_json TEXT, messages_json TEXT NOT NULL DEFAULT '[]', experience_id TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY(scope_key,thread_id,utterance_id));`);
}

/** `TaskTreeStore`'s constructor with `createSchema`, then `migrateTaskTreeCallbacks`. */
export function oldTaskTreeSchema(db: DatabaseSync): void {
  db.exec(`
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
    `);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_task_tree_learning (
    id TEXT PRIMARY KEY,event_json TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);`);
}

/** `createFcaTouchWiring`, its DDL. */
export function oldFcaTouchSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS fca_touch_receipts (
    operation_id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,device_id TEXT NOT NULL,touch_id TEXT NOT NULL,input_json TEXT NOT NULL,
    target_id TEXT NOT NULL,state TEXT NOT NULL,gesture TEXT,lease_json TEXT,expires_at TEXT NOT NULL,issued INTEGER NOT NULL DEFAULT 0,
    observed_delivered INTEGER NOT NULL DEFAULT 0,result_delivered INTEGER NOT NULL DEFAULT 0,
    reaction_json TEXT,reaction_delivered INTEGER NOT NULL DEFAULT 0,UNIQUE(scope_key,touch_id));`);
}

/** Every old constructor's DDL in the order a process with every switch on ran them. */
export function oldExecutionSchema(db: DatabaseSync): void {
  oldActionStoreSchema(db);
  oldMindWorkerStartSchema(db);
  oldLivenessEpisodeSchema(db);
  oldFcaTaskAuthoritySchema(db);
  oldTaskRuntimeSchema(db);
  oldTaskTreeSchema(db);
  oldFcaTouchSchema(db);
}
