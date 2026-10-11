import type { SchemaStep } from './schemaSteps.js';
import { ACTION_THREADS_STEP } from './execution/001_action_threads.js';
import { MIND_WORKER_STARTS_STEP } from './execution/002_mind_worker_starts.js';
import { LIVENESS_EPISODES_STEP } from './execution/003_liveness_episodes.js';
import { FCA_TASK_AUTHORITY_STEP } from './execution/004_fca_task_authority.js';
import { FCA_TASK_RUNTIME_STEP } from './execution/005_fca_task_runtime.js';
import { TASK_TREES_STEP } from './execution/006_task_trees.js';
import { FCA_TOUCH_STEP } from './execution/007_fca_touch.js';

export {
  ACTION_THREADS_STEP, FCA_TASK_AUTHORITY_STEP, FCA_TASK_RUNTIME_STEP, FCA_TOUCH_STEP, LIVENESS_EPISODES_STEP, MIND_WORKER_STARTS_STEP,
  TASK_TREES_STEP,
};

/**
 * Every schema step of the execution system, in order (Syzygy ADR-0009 stage 1, S2). Each owner applies its own step when it
 * opens (a step stays where its switch is: a database that never ran the common runtime, the touch reflex or the task trees
 * keeps its historical schema); this list is for tests and the deploy check.
 */
export const EXECUTION_STEPS: readonly SchemaStep[] = Object.freeze([
  ACTION_THREADS_STEP, MIND_WORKER_STARTS_STEP, LIVENESS_EPISODES_STEP, FCA_TASK_AUTHORITY_STEP, FCA_TASK_RUNTIME_STEP, TASK_TREES_STEP,
  FCA_TOUCH_STEP,
]);
