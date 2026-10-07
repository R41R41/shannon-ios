import type { DatabaseSync } from 'node:sqlite';

/**
 * What the memory outbox keeps of a call the owner discarded, a person deleted or forgotten, or a turn he forgot (Syzygy ADR-0008
 * stage 3 review H2): nothing but the closed header. Rows tied to it (by subject, by the call or person their payload names, or by
 * an episode they came from) lose their payload, episodes and label; a pending one ends `superseded` with the closed code; the
 * model answers the writer kept for them are deleted. A no-op while the outbox's tables do not exist (stage 3 off).
 *
 * Its own module with no import, so the stores that call it (people memory, person identity, her state) load nothing of the outbox.
 */
export function scrubOutboxFor(
  database: DatabaseSync, scopeKey: string,
  target: { callId?: string; personId?: string; memoryIds?: readonly string[] }, code: 'discarded' | 'forgotten', at: string,
): number {
  if (!database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'memory_outbox'`).get()) return 0;
  const clauses: string[] = [];
  const values: string[] = [];
  const like = (value: string) => `%${value.replace(/[\\%_]/gu, match => `\\${match}`)}%`;
  if (target.callId) {
    clauses.push(`subject_key = ?`, `payload_json LIKE ? ESCAPE '\\'`);
    values.push(`call:${target.callId}`, like(`"callId":${JSON.stringify(target.callId)}`));
  }
  if (target.personId) {
    for (const prefix of ['person', 'identity', 'impressions']) { clauses.push('subject_key = ?'); values.push(`${prefix}:${target.personId}`); }
    for (const field of ['personId', 'intoPersonId', 'personKey']) { clauses.push(`payload_json LIKE ? ESCAPE '\\'`); values.push(like(`"${field}":${JSON.stringify(target.personId)}`)); }
    clauses.push(`payload_json LIKE ? ESCAPE '\\'`); values.push(like(JSON.stringify(target.personId)));
  }
  for (const memoryId of target.memoryIds ?? []) {
    clauses.push(`episode_ids_json LIKE ? ESCAPE '\\'`, `subject_key LIKE ? ESCAPE '\\'`);
    values.push(like(JSON.stringify(memoryId)), `%:${memoryId.replace(/[\\%_]/gu, match => `\\${match}`)}`);
  }
  if (!clauses.length) return 0;
  const seqs = (database.prepare(`SELECT seq FROM memory_outbox WHERE scope_key = ? AND (${clauses.join(' OR ')})`).all(scopeKey, ...values) as Array<{ seq: number }>)
    .map(row => Number(row.seq));
  if (!seqs.length) return 0;
  const list = seqs.map(() => '?').join(', ');
  database.prepare(`UPDATE memory_outbox SET status = CASE WHEN status = 'pending' THEN 'superseded' ELSE status END,
      outcome_code = CASE WHEN status = 'pending' THEN ? ELSE outcome_code END, applied_at = COALESCE(applied_at, ?), next_attempt_at = NULL,
      payload_json = '{}', episode_ids_json = '[]', disclosure_json = NULL WHERE seq IN (${list})`).run(code, at, ...seqs);
  if (database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'memory_writer_calls'`).get()) {
    database.prepare(`DELETE FROM memory_writer_calls WHERE op_seq IN (${list})`).run(...seqs);
  }
  return seqs.length;
}
