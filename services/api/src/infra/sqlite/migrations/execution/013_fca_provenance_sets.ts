// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * A step record's sources stored once, by reference (owner decision 2026-10-15, 「推奨の形で進める」; `infra/sqlite/fcaProvenanceSets.ts`):
 * an evidence row and a committed history row keep `{"set":"<id>"}` in their `sources_json`, and the set keeps the ordered step ids
 * of the `fca_task_sources` rows (never deleted) instead of a copy of each (Minecraft runs 7–11: ~313 KB to ~2 MB in every row).
 * A new table only, made when `SHANNON_FCA_PROVENANCE_REFS` is on; rows written before it keep their copy and are read as before.
 * An older build cannot resolve a reference: rolling back needs the backup taken before the deploy (`docs/fca-runtime-contract.md`,
 * "Provenance by reference").
 */
export const FCA_PROVENANCE_SETS_STEP: SchemaStep = {
  id: 'execution/013_fca_provenance_sets',
  operations: [
    { sql: `
      CREATE TABLE IF NOT EXISTS fca_provenance_sets (
        set_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        step_ids_json TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    ` },
  ],
};
