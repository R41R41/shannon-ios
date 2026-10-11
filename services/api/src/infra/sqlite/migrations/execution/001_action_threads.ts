// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * The action threads of the mind worker (`SQLiteActionStore`) and their retained resources (`retainedResourceStore.ts`), moved
 * verbatim from those constructors at 88d7bfd0 (Syzygy ADR-0009 stage 1, S2). Applied by the action store's constructor.
 */
export const ACTION_THREADS_STEP: SchemaStep = {
  id: 'execution/001_action_threads',
  operations: [
    { sql: `
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
    ` },
    { sql: `
    CREATE TABLE IF NOT EXISTS mind_action_retained_resources (
      action_id TEXT NOT NULL, resource TEXT NOT NULL, retained_at TEXT NOT NULL, PRIMARY KEY (action_id, resource)
    );
    CREATE TABLE IF NOT EXISTS mind_action_retained_releases (
      request_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, action_id TEXT NOT NULL, released_by TEXT NOT NULL,
      reason TEXT NOT NULL, resources_json TEXT NOT NULL, released_at TEXT NOT NULL
    );
  ` },
  ],
};
