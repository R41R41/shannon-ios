// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * The owner's slot limits of 2026-10-12 as data (Syzygy ADR-0009 stage 1, S6; `SLOT_LIMITS_OWNER_2026_10_12`): one foreground
 * slot; three background slots, with creative 1, research 2, Minecraft 1, Codex 1, sleep 1 and other 1; the touch reflex in a
 * pool of its own with one. It replaces the rows step 009 seeded (today's limits); no table or column changes. Rolling back the
 * build leaves these rows, which an older build does not read (it keeps its fixed limits).
 */
export const OWNER_SLOT_LIMITS_STEP: SchemaStep = {
  id: 'execution/011_owner_slot_limits',
  operations: [
    { requireTable: { table: 'mind_action_slot_pools', error: 'OWNER_SLOT_LIMITS_POOLS_REQUIRED' } },
    { requireTable: { table: 'mind_action_slot_classes', error: 'OWNER_SLOT_LIMITS_CLASSES_REQUIRED' } },
    { sql: `
      INSERT OR REPLACE INTO mind_action_slot_pools (pool, max_live) VALUES ('foreground', 1), ('background', 3), ('touch', 1);
      INSERT OR REPLACE INTO mind_action_slot_classes (slot_class, pool, max_live) VALUES
        ('respond', 'foreground', 1), ('touch', 'touch', 1), ('creative', 'background', 1), ('research', 'background', 2),
        ('minecraft', 'background', 1), ('codex', 'background', 1), ('sleep', 'background', 1), ('other', 'background', 1);
    ` },
  ],
};
