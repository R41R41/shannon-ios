import type { SchemaStep } from './schemaSteps.js';
import { ACTION_THREADS_STEP } from './execution/001_action_threads.js';
import { MIND_WORKER_STARTS_STEP } from './execution/002_mind_worker_starts.js';
import { LIVENESS_EPISODES_STEP } from './execution/003_liveness_episodes.js';
import { FCA_TASK_AUTHORITY_STEP } from './execution/004_fca_task_authority.js';
import { FCA_TASK_RUNTIME_STEP } from './execution/005_fca_task_runtime.js';
import { TASK_TREES_STEP } from './execution/006_task_trees.js';
import { FCA_TOUCH_STEP } from './execution/007_fca_touch.js';
import { TASK_EXECUTION_COLUMNS_STEP } from './execution/008_task_execution_columns.js';
import { ACTION_SLOTS_STEP } from './execution/009_action_slots.js';
import { TASK_HOST_STARTING_STEP } from './execution/010_task_host_starting.js';
import { OWNER_SLOT_LIMITS_STEP } from './execution/011_owner_slot_limits.js';
import { OPERATOR_AUDIT_STEP } from './execution/012_operator_audit.js';
import { FCA_PROVENANCE_SETS_STEP } from './execution/013_fca_provenance_sets.js';

export {
  ACTION_SLOTS_STEP, ACTION_THREADS_STEP, FCA_PROVENANCE_SETS_STEP, FCA_TASK_AUTHORITY_STEP, FCA_TASK_RUNTIME_STEP, FCA_TOUCH_STEP,
  LIVENESS_EPISODES_STEP, MIND_WORKER_STARTS_STEP, OPERATOR_AUDIT_STEP, OWNER_SLOT_LIMITS_STEP, TASK_EXECUTION_COLUMNS_STEP,
  TASK_HOST_STARTING_STEP, TASK_TREES_STEP,
};

/**
 * Every schema step of the execution system, in order (Syzygy ADR-0009 stage 1: 001-007 moved the historical DDL in S2, 008 and
 * 009 are the additive columns and slot tables of S3, 010 the stored Host starting flag of S4, 011 the owner's slot limits of
 * S6), 012 the operator's append-only audit (2026-10-14), 013 the FCA provenance sets (2026-10-15). Each owner applies its own
 * step when it opens (a step stays where its switch is: a database that never ran the common runtime, the touch reflex or the
 * task trees keeps its historical schema); this list is for tests and the deploy check.
 */
export const EXECUTION_STEPS: readonly SchemaStep[] = Object.freeze([
  ACTION_THREADS_STEP, MIND_WORKER_STARTS_STEP, LIVENESS_EPISODES_STEP, FCA_TASK_AUTHORITY_STEP, FCA_TASK_RUNTIME_STEP, TASK_TREES_STEP,
  FCA_TOUCH_STEP, TASK_EXECUTION_COLUMNS_STEP, ACTION_SLOTS_STEP, TASK_HOST_STARTING_STEP, OWNER_SLOT_LIMITS_STEP, OPERATOR_AUDIT_STEP,
  FCA_PROVENANCE_SETS_STEP,
]);
