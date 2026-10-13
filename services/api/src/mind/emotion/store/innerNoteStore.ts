import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  isInnerNoteDayReason, isInnerNoteIntent, isInnerNoteScale, isInnerNoteTell, isInnerNoteTrigger, shownKind,
  type InnerNote, type InnerNoteEvent, type InnerNoteFlags, type InnerNoteHooks, type InnerNoteText, type InnerNoteTrigger,
} from '@shannon/cognition';
import { applySchemaSteps } from '../../../infra/sqlite/migrations/schemaSteps.js';
import { EMOTION_STEPS } from '../../../infra/sqlite/migrations/emotionSteps.js';
import { secureDatabaseFiles } from '../../../infra/sqlite/sqliteStoreContext.js';
import { openDatabase } from '../../../infra/sqlite/sqliteOpen.js';

/**
 * Her inner notes (Syzygy ADR-0012, stage 1; table `shannon_inner_notes`, schema step `emotion/001_inner_notes`). Core: emotion.
 *
 * Appended by the one writer, the reflection (`innerNoteService.ts`); a reply never writes here. Each append marks the note before
 * it as replaced; the note that closes her day is stored closed. What the owner asked her to forget is deleted with the notes it
 * prompted (`forget`), so no note keeps a forgotten moment. Owner scope only: the service is given the owner's scope alone.
 */
export interface NewInnerNote {
  scopeKey: string;
  dayId: string | null;
  dayKey: string;
  dayEndsAt: string;
  text: InnerNoteText;
  hooks: InnerNoteHooks;
  triggers: readonly InnerNoteTrigger[];
  events: readonly InnerNoteEvent[];
  sourceIds: readonly string[];
  flags: InnerNoteFlags;
  changeReason: string | null;
  summary: string | null;
  coreVersion: string;
  coreHash: string;
  /** When the sulk this note belongs to began (null for a calm note): the ordinary hour counts from it. */
  episodeStartedAt: string | null;
  usage: InnerNoteUsage | null;
  elapsedMs: number;
  createdAt: string;
  closing: boolean;
}

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

type Row = Record<string, unknown>;

const COLUMNS = `note_id, scope_key, sequence, day_id, day_key, day_ends_at, honne, tatemae, reason, plan, bottom, shown, tell, until_at,
  scale, day_reason, intent, route_summary, change_reason, summary, triggers_json, events_json, source_ids_json, flags_json, core_version,
  core_hash, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, elapsed_ms, created_at, replaced_at, closed_at,
  episode_started_at`;

function parsedJson<T>(value: unknown, fallback: T): T {
  try { return typeof value === 'string' ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');
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

function noteOf(row: Row): StoredInnerNote {
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

export class SQLiteInnerNoteStore {
  private readonly database: DatabaseSync;
  private readonly owned: boolean;

  /** A path opens its own connection; a connection is borrowed (tests, or a caller that already holds the file). */
  constructor(source: string | DatabaseSync) {
    this.owned = typeof source === 'string';
    this.database = typeof source === 'string' ? openDatabase(source, 'innerNotes') : source;
    applySchemaSteps(this.database, EMOTION_STEPS);
    if (typeof source === 'string') secureDatabaseFiles(source);
  }

  /** Her newest note, or null. */
  latest(scopeKey: string): StoredInnerNote | null {
    const row = this.database.prepare(`SELECT ${COLUMNS} FROM shannon_inner_notes WHERE scope_key = ? ORDER BY sequence DESC LIMIT 1`).get(scopeKey);
    return row ? noteOf(row as Row) : null;
  }

  /** The notes of one day episode, oldest first. */
  day(scopeKey: string, dayId: string): StoredInnerNote[] {
    return (this.database.prepare(`SELECT ${COLUMNS} FROM shannon_inner_notes WHERE scope_key = ? AND day_id = ? ORDER BY sequence ASC LIMIT 400`)
      .all(scopeKey, dayId) as Row[]).map(noteOf);
  }

  /** Notes written since an instant, newest first, at most `limit`. */
  since(scopeKey: string, since: string, limit: number): StoredInnerNote[] {
    return (this.database.prepare(`SELECT ${COLUMNS} FROM shannon_inner_notes WHERE scope_key = ? AND created_at >= ? ORDER BY sequence DESC LIMIT ?`)
      .all(scopeKey, since, Math.max(1, Math.min(limit, 2_000))) as Row[]).map(noteOf);
  }

  /** The summary of the last day she closed (something that happened; never an attitude to carry on), with its sources (lineage). */
  lastClosedSummary(scopeKey: string): { id: string; summary: string; closedAt: string; sourceIds: readonly string[] } | null {
    const row = this.database.prepare(`SELECT note_id, summary, closed_at, source_ids_json FROM shannon_inner_notes WHERE scope_key = ?
      AND closed_at IS NOT NULL AND summary IS NOT NULL ORDER BY sequence DESC LIMIT 1`).get(scopeKey) as Row | undefined;
    return row && typeof row.summary === 'string' && typeof row.closed_at === 'string'
      ? { id: text(row.note_id), summary: row.summary, closedAt: row.closed_at, sourceIds: parsedJson<string[]>(row.source_ids_json, []) } : null;
  }

  /** A source known later by its stored id (a voice turn's utterance, once the turn is stored as an experience). */
  rebindSource(scopeKey: string, from: string, to: string): void {
    const rows = this.database.prepare('SELECT note_id, source_ids_json FROM shannon_inner_notes WHERE scope_key = ? AND source_ids_json LIKE ? LIMIT 400')
      .all(scopeKey, `%${JSON.stringify(from).slice(1, -1)}%`) as Row[];
    const update = this.database.prepare('UPDATE shannon_inner_notes SET source_ids_json = ? WHERE scope_key = ? AND note_id = ?');
    for (const row of rows) {
      const ids = parsedJson<string[]>(row.source_ids_json, []).map(id => (id === from ? to : id));
      update.run(JSON.stringify([...new Set(ids)]), scopeKey, text(row.note_id));
    }
  }

  /** Counts one reflection attempt of a day, unless `limit` were reached; true when it may run. One statement, so it is atomic. */
  attempt(scopeKey: string, dayKey: string, limit: number): boolean {
    const result = this.database.prepare(`INSERT INTO shannon_inner_note_attempts (scope_key, day_key, attempts) VALUES (?, ?, 1)
      ON CONFLICT (scope_key, day_key) DO UPDATE SET attempts = attempts + 1 WHERE attempts < ?`).run(scopeKey, dayKey, limit);
    return Number(result.changes) > 0;
  }

  /** Deletes notes written before an instant (retention: they follow what the touches and turns they come from keep). Returns how many. */
  pruneBefore(scopeKey: string, before: string): number {
    this.database.prepare('DELETE FROM shannon_inner_note_attempts WHERE scope_key = ? AND day_key < ?').run(scopeKey, before.slice(0, 10));
    return Number(this.database.prepare('DELETE FROM shannon_inner_notes WHERE scope_key = ? AND created_at < ?').run(scopeKey, before).changes);
  }

  /** Appends a note as the newest, marks the one before it replaced, and returns it as stored. One transaction. */
  append(note: NewInnerNote): StoredInnerNote {
    const id = randomUUID();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const last = this.database.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM shannon_inner_notes WHERE scope_key = ?')
        .get(note.scopeKey) as Row;
      const sequence = Number(last.sequence) + 1;
      this.database.prepare('UPDATE shannon_inner_notes SET replaced_at = ? WHERE scope_key = ? AND replaced_at IS NULL').run(note.createdAt, note.scopeKey);
      this.insert(id, sequence, note);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.latest(note.scopeKey)!;
  }

  private insert(id: string, sequence: number, note: NewInnerNote): void {
    const { hooks, usage } = note;
    this.database.prepare(`INSERT INTO shannon_inner_notes (${COLUMNS}) VALUES (${new Array(37).fill('?').join(', ')})`).run(
      id, note.scopeKey, sequence, note.dayId ?? id, note.dayKey, note.dayEndsAt, note.text.honne, note.text.tatemae, note.text.reason,
      note.text.plan, note.text.bottom, hooks.shown, hooks.tell, hooks.until, hooks.scale, hooks.dayReason, hooks.intent, hooks.routeSummary,
      note.changeReason, note.summary, JSON.stringify(note.triggers), JSON.stringify(note.events), JSON.stringify(note.sourceIds),
      JSON.stringify(note.flags), note.coreVersion, note.coreHash, usage?.model ?? null, usage?.inputTokens ?? null, usage?.outputTokens ?? null,
      usage?.cacheReadTokens ?? null, usage?.cacheWriteTokens ?? null, usage?.costUsd ?? null, Math.max(0, Math.round(note.elapsedMs)),
      note.createdAt, null, note.closing ? note.createdAt : null, note.episodeStartedAt,
    );
  }

  /** Closes her newest note as it stands (a closing reflection that failed): it is then a memory of its day, never carried on. */
  markClosed(scopeKey: string, at: string): void {
    this.database.prepare(`UPDATE shannon_inner_notes SET closed_at = ? WHERE scope_key = ? AND closed_at IS NULL
      AND sequence = (SELECT MAX(sequence) FROM shannon_inner_notes WHERE scope_key = ?)`).run(at, scopeKey, scopeKey);
  }

  /**
   * Deletes the notes `forgotten` names (a source she was asked to forget, or a forgotten turn's words in its events; every note
   * derived from one carries its sources), with what they said. Returns how many.
   * The forgetting is the owner's: a note is not kept with the moment removed, since its words were written about that moment.
   */
  forget(scopeKey: string, forgotten: (note: StoredInnerNote) => boolean): number {
    const rows = this.database.prepare(`SELECT ${COLUMNS} FROM shannon_inner_notes WHERE scope_key = ? ORDER BY sequence DESC LIMIT 2000`)
      .all(scopeKey) as Row[];
    const doomed = cascade(rows.map(noteOf), forgotten);
    const remove = this.database.prepare('DELETE FROM shannon_inner_notes WHERE scope_key = ? AND note_id = ?');
    for (const id of doomed) remove.run(scopeKey, id);
    return doomed.length;
  }

  close(): void {
    if (this.owned && this.database.isOpen) this.database.close();
  }
}

/**
 * The notes to delete when the owner forgets (N6): those `forgotten` names, every later note of the same day (each read the one
 * before it, whatever its capped lineage still lists), and every note that read a deleted day's summary (`note:<id>`) with the rest
 * of its day. One pass in the order they were written.
 */
function cascade(notes: readonly StoredInnerNote[], forgotten: (note: StoredInnerNote) => boolean): string[] {
  const doomed = new Set<string>();
  const fromDay = new Map<string, number>();
  for (const note of [...notes].sort((left, right) => left.sequence - right.sequence)) {
    const readDeleted = note.sourceIds.some(id => id.startsWith('note:') && doomed.has(id.slice('note:'.length)));
    const afterDeleted = (fromDay.get(note.dayId) ?? Number.POSITIVE_INFINITY) <= note.sequence;
    if (!readDeleted && !afterDeleted && !forgotten(note)) continue;
    doomed.add(note.id);
    if (!fromDay.has(note.dayId)) fromDay.set(note.dayId, note.sequence);
  }
  return [...doomed];
}
