// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * The operator's audit (owner decision 2026-10-14, `docs/operator-minecraft-contract.md`): one append-only row per event of an
 * operator invocation (invoked, accepted, refused, settled, stopped, time limit), with the operator's label, the arguments, and
 * the ids it produced. Triggers refuse UPDATE, DELETE and INSERT OR REPLACE, like the activity record. A new table only; rolling
 * back the build leaves it, which an older build does not read.
 */
export const OPERATOR_AUDIT_STEP: SchemaStep = {
  id: 'execution/012_operator_audit',
  operations: [
    { sql: `
      CREATE TABLE IF NOT EXISTS operator_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        operation_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        operator TEXT NOT NULL,
        via TEXT NOT NULL CHECK (via = 'operator_cli'),
        command TEXT NOT NULL,
        event TEXT NOT NULL CHECK (event IN ('invoked', 'accepted', 'refused', 'settled', 'stopped', 'time_limit')),
        code TEXT NOT NULL,
        args_json TEXT NOT NULL,
        action TEXT,
        server_id TEXT,
        task_id TEXT,
        lifecycle_id TEXT,
        action_id TEXT,
        deadline_at TEXT,
        budget_yen INTEGER,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS operator_audit_scope ON operator_audit (scope_key, sequence);
      CREATE INDEX IF NOT EXISTS operator_audit_operation ON operator_audit (operation_id, sequence);
      CREATE INDEX IF NOT EXISTS operator_audit_task ON operator_audit (task_id, event);
      CREATE TRIGGER IF NOT EXISTS operator_audit_no_update BEFORE UPDATE ON operator_audit
        BEGIN SELECT RAISE(ABORT, 'OPERATOR_AUDIT_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS operator_audit_no_delete BEFORE DELETE ON operator_audit
        BEGIN SELECT RAISE(ABORT, 'OPERATOR_AUDIT_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS operator_audit_no_replace BEFORE INSERT ON operator_audit
        WHEN EXISTS (SELECT 1 FROM operator_audit WHERE sequence = NEW.sequence OR event_id = NEW.event_id)
        BEGIN SELECT RAISE(ABORT, 'OPERATOR_AUDIT_APPEND_ONLY'); END;
    ` },
  ],
};
