import type { DatabaseSync } from 'node:sqlite';
import { QUIET_END_HOUR, QUIET_START_HOUR } from '../../../contracts/initiativeTiming.js';
import { dueCommitmentCandidate } from '../../../mind/action/respond/commitmentInitiative.js';
import { localDateParts, pad, type CandidateRow } from '../../../mind/action/respond/initiativeSelection.js';
import type { InitiativeWrite } from '../initiativeIntent.js';

/**
 * Due promises, told at their time (`SHANNON_PROMISE_ON_TIME`, default on; `SQLiteInitiativeStore.deliverDuePromises`). Measured on
 * 2026-10-14: a promise due at 09:20 was told at 10:07, because the topic loop held it too (its 90-minute conversation cooldown: he
 * had written at 08:34; then its 15-minute recheck). A promise is something he asked for, not a topic of hers: it has its own key of
 * the day (`<day>:<item>`), so it neither waits for nor takes the day's one topic, and it does not wait for a conversation to cool
 * down. Each is written once (its item id). The proactive gate still sees and notes it; of its holds only the gate's own error and
 * a repeat hold a promise (`promisePassesHold`): he is not kept from his reminder because he is talking, nor because it was spoken
 * of before. The quiet hours stay as they were. The world worker calls this on every pass of its loop (at most a minute apart).
 *
 * It never speaks over him (review of b867e66c): while he is in a voice call with her (`inCall`, his devices' call events) or wrote
 * or spoke within the owner-active hold (10 minutes, `PROMISE_QUIET_MILLISECONDS`), the promise is told as text only (the Talk, the
 * app's notice, a body's bubble with `spoken: false`), never read aloud. No in-call line path exists that could carry it into the
 * call safely, so none is used.
 */
export const PROMISE_QUIET_MILLISECONDS = 10 * 60_000;

export function tellDuePromises(
  database: DatabaseSync, at: string, timeZone: string,
  write: (scopeKey: string, snapshotJson: string, candidate: CandidateRow & { score: number }, dayKey: string, textOnly: boolean) => InitiativeWrite,
  inCall: (scopeKey: string, at: string) => boolean = () => false,
): { due: number; sent: number } {
  const local = localDateParts(new Date(at), timeZone);
  if (local.hour >= QUIET_START_HOUR || local.hour < QUIET_END_HOUR) return { due: 0, sent: 0 };
  const exists = (name: string) => Boolean(database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
  if (!exists('companion_states') || !exists('conversation_messages') || !exists('initiative_messages')) return { due: 0, sent: 0 };
  const scopes = database.prepare('SELECT scope_key, snapshot_json FROM companion_states ORDER BY scope_key').all() as unknown as Array<{
    scope_key: string; snapshot_json: string;
  }>;
  const dayKey = `${local.year}-${pad(local.month)}-${pad(local.day)}`;
  let due = 0;
  let sent = 0;
  for (const scope of scopes) {
    const delivered = (itemId: string) => Boolean(database
      .prepare('SELECT 1 FROM initiative_messages WHERE scope_key = ? AND source_item_id = ?').get(scope.scope_key, itemId));
    const open = dueCommitmentCandidate(scope.scope_key, JSON.parse(scope.snapshot_json), at).filter(candidate => !delivered(candidate.item_id));
    due += open.length;
    if (!open.length) continue;
    const textOnly = quiet(database, scope.scope_key, at, inCall);
    for (const candidate of open) if (write(scope.scope_key, scope.snapshot_json, candidate, `${dayKey}:${candidate.item_id}`, textOnly) === 'sent') sent += 1;
  }
  return { due, sent };
}

/** He is in a call with her, or wrote or spoke within the hold: a promise is then text only. Unsure (an error) counts as quiet. */
function quiet(database: DatabaseSync, scopeKey: string, at: string, inCall: (scopeKey: string, at: string) => boolean): boolean {
  try {
    if (inCall(scopeKey, at)) return true;
    const since = new Date(Date.parse(at) - PROMISE_QUIET_MILLISECONDS).toISOString();
    const sql = `SELECT 1 AS found FROM conversation_messages WHERE scope_key = ? AND role = 'user' AND observed_at >= ? LIMIT 1`;
    return Boolean(database.prepare(sql).get(scopeKey, since));
  } catch { return true; }
}

/** The gate's holds a due promise told on time passes: he is talking, it was spoken of, its intent is old (it arises when it is due). */
const PROMISE_PASSES: ReadonlySet<string> = new Set(['owner_active', 'topic_reused', 'intent_expired']);

export function promisePassesHold(code: string): boolean {
  return PROMISE_PASSES.has(code);
}
