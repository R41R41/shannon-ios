import type { DatabaseSync } from 'node:sqlite';
import {
  isInnerNoteDayReason, isInnerNoteIntent, isInnerNoteScale, isInnerNoteTell, isInnerNoteTrigger, shownKind,
  type InnerNote, type InnerNoteEvent, type InnerNoteFlags, type InnerNoteHooks,
} from '@shannon/cognition';

/**
 * Her inner notes as rows (Syzygy ADR-0012; table `shannon_inner_notes`), apart from the writer and its schema steps
 * (`innerNoteStore.ts`): the columns, the mapping of a row to a note, and the one read another process makes. This module opens
 * nothing, creates nothing and writes nothing, so a process that only reads (her own time's moment speech,
 * `wiring/momentSpeechWiring.ts`) loads no migration and no writer. Core: emotion.
 */
export interface InnerNoteUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Unknown on the background route's usage row (it books reads, not writes, apart). */
  cacheWriteTokens: number | null;
  costUsd: number | null;
}

/** A stored note with what the readers beside the reply need: its events, its sources and its cost. */
export interface StoredInnerNote extends InnerNote {
  events: readonly InnerNoteEvent[];
  sourceIds: readonly string[];
  usage: InnerNoteUsage | null;
  elapsedMs: number | null;
}

export type Row = Record<string, unknown>;

export const COLUMNS = `note_id, scope_key, sequence, day_id, day_key, day_ends_at, honne, tatemae, reason, plan, bottom, shown, tell, until_at,
  scale, day_reason, intent, route_summary, change_reason, summary, triggers_json, events_json, source_ids_json, flags_json, core_version,
  core_hash, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, elapsed_ms, created_at, replaced_at, closed_at,
  episode_started_at`;

export function parsedJson<T>(value: unknown, fallback: T): T {
  try { return typeof value === 'string' ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

export const text = (value: unknown) => (typeof value === 'string' ? value : '');
const optionalText = (value: unknown) => (typeof value === 'string' ? value : null);
const optionalNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function hooksOf(row: Row): InnerNoteHooks {
  return {
    shown: shownKind(row.shown), tell: isInnerNoteTell(row.tell) ? row.tell : 'none', until: optionalText(row.until_at),
    scale: isInnerNoteScale(row.scale) ? row.scale : 'ordinary', dayReason: isInnerNoteDayReason(row.day_reason) ? row.day_reason : null,
    intent: isInnerNoteIntent(row.intent) ? row.intent : 'none', routeSummary: text(row.route_summary),
  };
}

function usageOf(row: Row): InnerNoteUsage | null {
  if (typeof row.model !== 'string') return null;
  return { model: row.model, inputTokens: optionalNumber(row.input_tokens) ?? 0, outputTokens: optionalNumber(row.output_tokens) ?? 0,
    cacheReadTokens: optionalNumber(row.cache_read_tokens) ?? 0, cacheWriteTokens: optionalNumber(row.cache_write_tokens),
    costUsd: optionalNumber(row.cost_usd) };
}

export function noteOf(row: Row): StoredInnerNote {
  return {
    id: text(row.note_id), sequence: Number(row.sequence), dayId: text(row.day_id), dayKey: text(row.day_key), dayEndsAt: text(row.day_ends_at),
    text: { honne: text(row.honne), tatemae: text(row.tatemae), reason: text(row.reason), plan: text(row.plan), bottom: text(row.bottom) },
    hooks: hooksOf(row), triggers: parsedJson<unknown[]>(row.triggers_json, []).filter(isInnerNoteTrigger),
    changeReason: optionalText(row.change_reason), summary: optionalText(row.summary), flags: parsedJson<InnerNoteFlags>(row.flags_json, {}),
    createdAt: text(row.created_at), replacedAt: optionalText(row.replaced_at), closedAt: optionalText(row.closed_at), coreVersion: text(row.core_version),
    episodeStartedAt: optionalText(row.episode_started_at),
    events: parsedJson<InnerNoteEvent[]>(row.events_json, []), sourceIds: parsedJson<string[]>(row.source_ids_json, []),
    usage: usageOf(row), elapsedMs: optionalNumber(row.elapsed_ms),
  };
}

/**
 * Her newest note read on a read-only connection of another process (her own time's moment speech, `wiring/momentSpeechWiring.ts`):
 * nothing is created or written; null without the table (the API has not created it) or without a note. The caller checks that it
 * is current and that nothing of it was forgotten (`noteForgotten`).
 */
export function readLatestInnerNote(database: DatabaseSync, scopeKey: string): StoredInnerNote | null {
  const exists = database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'shannon_inner_notes'`).get();
  if (!exists) return null;
  const row = database.prepare(`SELECT ${COLUMNS} FROM shannon_inner_notes WHERE scope_key = ? ORDER BY sequence DESC LIMIT 1`).get(scopeKey);
  return row ? noteOf(row as Row) : null;
}
