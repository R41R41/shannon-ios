import type { SchemaStep } from '../schemaSteps.js';

/**
 * The mind worker's record of its starts (`recordMindWorkerStart`, `infra/ops/store/livenessStore.ts`), moved verbatim at
 * 88d7bfd0. Applied when the worker records its first start.
 */
export const MIND_WORKER_STARTS_STEP: SchemaStep = {
  id: 'execution/002_mind_worker_starts',
  operations: [
    { sql: `CREATE TABLE IF NOT EXISTS mind_worker_starts (started_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mind_worker_start_revisions (started_at TEXT NOT NULL, revision TEXT)` },
  ],
};
