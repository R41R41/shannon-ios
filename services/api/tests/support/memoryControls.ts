import type { SQLiteShannonStore } from '../../src/infra/sqlite/sqliteStore.js';

/**
 * A memory control written straight to the state, for any remembered item (the memory dashboard only lists the latest 80 turns, which is
 * where `ShannonMemoryService.mutate` can reach). The fields are the ones `mutate` writes for an experience: the status, the instant (also
 * the boundary before which a reading is withheld), the owner's words as the evidence the item is recognised by, and a correction's text.
 */
export function writeMemoryControl(store: SQLiteShannonStore, at: string, memoryId: string, mode: 'forget' | 'reject' | 'correct',
  options: { text?: string; evidence?: string; kind?: 'experience' | 'user-fact' } = {}): void {
  store.apply('owner', { type: 'memory-control-upserted', control: { memoryId, kind: options.kind ?? 'experience',
    status: mode === 'forget' ? 'forgotten' : mode === 'reject' ? 'rejected' : 'active', pinned: false, updatedAt: at, changeReason: 'test', contextInvalidatedAt: at,
    ...(options.evidence ? { sourceEvidence: options.evidence } : {}), ...(mode === 'correct' ? { overrideText: options.text ?? '直した本文' } : {}) } } as never);
}
