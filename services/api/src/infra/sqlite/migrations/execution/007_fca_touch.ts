// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * The receipts of the touch reflex (`wiring/fcaTouchWiring.ts`), moved verbatim at 88d7bfd0. Applied when the reflex is on.
 */
export const FCA_TOUCH_STEP: SchemaStep = {
  id: 'execution/007_fca_touch',
  operations: [
    { sql: `CREATE TABLE IF NOT EXISTS fca_touch_receipts (
    operation_id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,device_id TEXT NOT NULL,touch_id TEXT NOT NULL,input_json TEXT NOT NULL,
    target_id TEXT NOT NULL,state TEXT NOT NULL,gesture TEXT,lease_json TEXT,expires_at TEXT NOT NULL,issued INTEGER NOT NULL DEFAULT 0,
    observed_delivered INTEGER NOT NULL DEFAULT 0,result_delivered INTEGER NOT NULL DEFAULT 0,
    reaction_json TEXT,reaction_delivered INTEGER NOT NULL DEFAULT 0,UNIQUE(scope_key,touch_id));` },
  ],
};
