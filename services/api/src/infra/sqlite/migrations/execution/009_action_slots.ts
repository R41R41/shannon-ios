// Never edit a step once it may have been applied anywhere: its checksum is pinned and a changed step stops every process at
// boot (SHANNON_SCHEMA_STEP_CHANGED). Add a new step instead.
import type { SchemaStep } from '../schemaSteps.js';

/**
 * The action threads' task link and slot class (Syzygy ADR-0009 stage 1, S3): additive, nullable columns on `mind_actions`, and
 * the slot limits as data. The seed is today's limits exactly (`SLOT_LIMITS_TODAY`: one foreground slot, two background slots,
 * every class up to two); the scheduler does not read the tables yet (S6 switches the enforcement to them and writes the
 * owner's limits as a later step). Applied by the action store after `mind_actions` exists.
 */
export const ACTION_SLOTS_STEP: SchemaStep = {
  id: 'execution/009_action_slots',
  operations: [
    { requireTable: { table: 'mind_actions', error: 'ACTION_SLOTS_MIND_ACTIONS_REQUIRED' } },
    { addColumn: { table: 'mind_actions', column: 'task_id', definition: 'TEXT' } },
    { addColumn: { table: 'mind_actions', column: 'slot_class', definition: 'TEXT' } },
    { addColumn: { table: 'mind_actions', column: 'effect_sent', definition: 'INTEGER' } },
    { sql: `
      CREATE TABLE IF NOT EXISTS mind_action_slot_pools (pool TEXT PRIMARY KEY, max_live INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mind_action_slot_classes (slot_class TEXT PRIMARY KEY, pool TEXT NOT NULL, max_live INTEGER NOT NULL);
      INSERT OR IGNORE INTO mind_action_slot_pools (pool, max_live) VALUES ('foreground', 1), ('background', 2);
      INSERT OR IGNORE INTO mind_action_slot_classes (slot_class, pool, max_live) VALUES
        ('respond', 'foreground', 1), ('touch', 'background', 2), ('creative', 'background', 2), ('research', 'background', 2),
        ('minecraft', 'background', 2), ('codex', 'background', 2), ('sleep', 'background', 2), ('other', 'background', 2);
    ` },
  ],
};
