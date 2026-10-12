import type { DatabaseSync } from 'node:sqlite';
import type { SlotLimits } from '@shannon/mind';

/**
 * Writes a set of slot limits as the slot tables' rows (Syzygy ADR-0009 stage 1, S6: the limits are data). Tests of a mechanism
 * that was written against the S3 limits (`SLOT_LIMITS_TODAY`: two background slots, every class up to two) keep them this way.
 */
export function useSlotLimits(db: DatabaseSync, limits: SlotLimits): void {
  db.exec('DELETE FROM mind_action_slot_pools; DELETE FROM mind_action_slot_classes');
  for (const [pool, maxLive] of Object.entries(limits.pools)) db.prepare('INSERT INTO mind_action_slot_pools VALUES (?, ?)').run(pool, maxLive);
  for (const [slotClass, limit] of Object.entries(limits.classes)) {
    db.prepare('INSERT INTO mind_action_slot_classes VALUES (?, ?, ?)').run(slotClass, limit.pool, limit.maxLive);
  }
}
