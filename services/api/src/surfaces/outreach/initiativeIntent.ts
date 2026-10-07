import { chmodSync, existsSync } from 'node:fs';
import type { ProactiveDeliveryIntent } from '../../mind/attention/attentionPorts.js';

/**
 * Two small parts of the initiative store (`store/initiativeStore.ts`), apart for its size.
 *
 * `initiativeIntent`: what the proactive gate (Syzygy ADR-0008 stage 3, owner answer 2) is told of one initiative where it would be
 * written. The loop chooses and writes at once, so the intent arises when it is written (the gate's expiry is for her own time's
 * thoughts); a promise is `promise`, a goal she follows `follow_up`, a topic of the world `world`, each with its item as the subject.
 */
export function initiativeIntent(candidate: { source_id: string; item_id: string }, content: string, at: string): ProactiveDeliveryIntent {
  return {
    point: 'initiative', reason: candidate.source_id === 'commitment' ? 'promise' : candidate.source_id === 'intent' ? 'follow_up' : 'world',
    subject: candidate.item_id, arisenAt: at, text: content,
  };
}

/** The database and its WAL files readable by the service user only (unchanged from the store). */
export function secureDatabaseFiles(path: string): void {
  if (path === ':memory:') return;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) chmodSync(candidate, 0o600);
  }
}
