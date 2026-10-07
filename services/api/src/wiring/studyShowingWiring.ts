import type { DatabaseSync } from 'node:sqlite';
import { SQLiteStudyShowing as ShowingStore } from '../mind/action/ownTime/store/studyShowingStore.js';
import type { ShowingGate } from '../mind/action/ownTime/autonomyShowing.js';
import { commitmentAwaitingTodaySlot, dueCommitmentCandidate } from '../mind/action/respond/commitmentInitiative.js';

/** The conversation owns reservation policy. The showing store receives only its boolean, on the same connection. */
function reserved(connection: DatabaseSync, scopeKey: string, at: string, timeZone: string): boolean {
  if (!connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_states'").get()) return false;
  const row = connection.prepare('SELECT snapshot_json FROM companion_states WHERE scope_key=?').get(scopeKey);
  if (!row) return false;
  try {
    const snapshot: unknown = JSON.parse(String(row.snapshot_json));
    const delivered = (itemId: string) => Boolean(connection.prepare('SELECT 1 FROM initiative_messages WHERE scope_key=? AND source_item_id=?').get(scopeKey,itemId));
    return dueCommitmentCandidate(scopeKey,snapshot,at).some(candidate => !delivered(candidate.item_id))
      || commitmentAwaitingTodaySlot(scopeKey,snapshot,at,timeZone,delivered);
  } catch { return false; }
}
export class SQLiteStudyShowing extends ShowingStore {
  constructor(path: string, timeZone = 'Asia/Tokyo', gate: ShowingGate | null = null) {
    super(path,timeZone,gate,reserved);
  }
}
