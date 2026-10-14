import type { DatabaseSync } from 'node:sqlite';
import type { VoiceSummaryRecord } from './conversationStore.js';
import { switchOn } from '@shannon/switches';

/**
 * The rows of the voice summary's tables (`voiceSummaryMigration.ts`): a thread's versions, newest first, and when a voice turn
 * last asked for a newer one (`voiceHistorySummary.ts`).
 */

/** The voice summary's switches beside replay epochs (which the store checks itself): its own and the voice plan. */
export function voiceSummariesSwitchedOn(environment: Readonly<Record<string, string | undefined>>): boolean {
  return switchOn(environment, 'SHANNON_VOICE_HISTORY_SUMMARY') && switchOn(environment, 'SHANNON_CLAUDE_CACHE_PLAN_VOICE');
}

interface VoiceSummaryRow {
  version: number; summary: string; covers_from_message_id: string; covered_through_message_id: string; chain_started_at: string; updated_at: string;
}

export function selectVoiceSummaries(database: DatabaseSync, scopeKey: string, threadId: string): readonly VoiceSummaryRecord[] {
  const rows = database.prepare(`
    SELECT version, summary, covers_from_message_id, covered_through_message_id, chain_started_at, updated_at
    FROM conversation_voice_summaries WHERE scope_key = ? AND thread_id = ? ORDER BY version DESC
  `).all(scopeKey, threadId) as unknown as VoiceSummaryRow[];
  return Object.freeze(rows.map(row => Object.freeze({
    version: Number(row.version), summary: row.summary, coversFromMessageId: row.covers_from_message_id,
    coveredThroughMessageId: row.covered_through_message_id, chainStartedAt: row.chain_started_at, updatedAt: row.updated_at,
  })));
}

/** The new version, and every other version of the thread removed except `keep`. Called inside a transaction. */
export function insertVoiceSummary(database: DatabaseSync, scopeKey: string, threadId: string, record: VoiceSummaryRecord, keep: readonly number[]): void {
  const kept = [...new Set([record.version, ...keep])];
  database.prepare(`
    DELETE FROM conversation_voice_summaries WHERE scope_key = ? AND thread_id = ? AND version NOT IN (${kept.map(() => '?').join(', ')})
  `).run(scopeKey, threadId, ...kept);
  database.prepare(`
    INSERT INTO conversation_voice_summaries
      (scope_key, thread_id, version, summary, covers_from_message_id, covered_through_message_id, chain_started_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_key, thread_id, version) DO UPDATE SET
      summary = excluded.summary, covers_from_message_id = excluded.covers_from_message_id,
      covered_through_message_id = excluded.covered_through_message_id, chain_started_at = excluded.chain_started_at, updated_at = excluded.updated_at
  `).run(scopeKey, threadId, record.version, record.summary, record.coversFromMessageId, record.coveredThroughMessageId,
    record.chainStartedAt, record.updatedAt);
}

export function removeVoiceSummaries(database: DatabaseSync, scopeKey: string, threadId: string, versions: readonly number[]): void {
  if (!versions.length) return;
  database.prepare(`
    DELETE FROM conversation_voice_summaries WHERE scope_key = ? AND thread_id = ? AND version IN (${versions.map(() => '?').join(', ')})
  `).run(scopeKey, threadId, ...versions);
}

export function selectVoiceSummaryWanted(database: DatabaseSync, scopeKey: string, threadId: string): string | undefined {
  const row = database.prepare('SELECT wanted_at FROM conversation_voice_summary_wants WHERE scope_key = ? AND thread_id = ?')
    .get(scopeKey, threadId) as unknown as { wanted_at: string } | undefined;
  return row?.wanted_at;
}

export function upsertVoiceSummaryWanted(database: DatabaseSync, scopeKey: string, threadId: string, at: string): void {
  database.prepare(`
    INSERT INTO conversation_voice_summary_wants (scope_key, thread_id, wanted_at) VALUES (?, ?, ?)
    ON CONFLICT(scope_key, thread_id) DO UPDATE SET wanted_at = excluded.wanted_at
  `).run(scopeKey, threadId, at);
}
