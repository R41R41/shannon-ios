import type { DatabaseSync } from 'node:sqlite';
import {
  deriveShannonFace, presentShannonFeeling, type CompanionStateSnapshot, type ShannonEmotionTiming,
} from '@shannon/cognition';
import { MOOD_HISTORY_LIMITS, type MoodHistoryRecording } from './moodHistoryContract.js';

/**
 * The record of her mood over time (`docs/mood-history-contract.md`). Core: emotion.
 *
 * A point is written beside a write of the companion state, from the state as it was stored: in
 * the API process and its workers once `SQLiteCompanionRepository.apply` has written (after its
 * transaction committed, or, when a caller holds a transaction around that write, inside it, so the
 * point commits or rolls back with it), and in the activity loop's process after the awake clock
 * committed. Nothing else writes here and nothing wakes for it: without a write of the state there
 * is no point.
 *
 * It only reads the stored state. It is handed the snapshot as written, computes a point with pure
 * functions, and writes one row of its own table; it never writes the state, and nothing reads this
 * table back into the state, a prompt, or a model. A failure here is logged by the name of the error
 * and the state write stands. The one exception: when SQLite itself rolled back a caller's whole
 * transaction (a full disk, an I/O error), the error is thrown on, so that the caller fails as it
 * would have failed at its own next statement, instead of going on outside a transaction.
 *
 * Coalesced: a new point when the quiet face of her mood or the kind she feels changed, when a
 * mood value moved by `moodStep` (0.05) or more, and otherwise at most every `everyMinutes` (10)
 * while writes happen. Points older than `keepDays` (14) are deleted when a point is written and
 * when a store of the API or its workers opens, also while recording is switched off (never in the activity loop's process). Only the owner's scope is recorded.
 */
export const MOOD_HISTORY_TABLE = 'shannon_mood_history';

/**
 * Additive and restart-safe: created when absent, never altered. Only the API's stores (the API and its workers) create it;
 * the activity loop's process creates nothing and skips while it is absent (its awake clock opens no store, and the store of
 * its owner context is opened with `leavesMoodHistory`).
 */
export function ensureMoodHistorySchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS shannon_mood_history (
      point_id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      valence REAL NOT NULL,
      arousal REAL NOT NULL,
      openness REAL NOT NULL,
      expression TEXT NOT NULL,
      feeling TEXT,
      present_kind TEXT,
      present_intensity REAL
    );
    CREATE INDEX IF NOT EXISTS shannon_mood_history_scope_time ON shannon_mood_history (scope_key, recorded_at);
    CREATE INDEX IF NOT EXISTS shannon_mood_history_time ON shannon_mood_history (recorded_at);
  `);
}

/**
 * Deletes points older than `keepDays` before `at`, for every scope. A store of the API or its workers calls it when it opens, whatever the
 * switch says; a failure is logged and the store opens.
 */
export function pruneMoodHistory(database: DatabaseSync, at: string): void {
  try {
    const time = Date.parse(at);
    if (!Number.isFinite(time)) return;
    database.prepare('DELETE FROM shannon_mood_history WHERE recorded_at < ?').run(keepCutoff(time));
  } catch (error) {
    logFailure(error);
  }
}

function keepCutoff(time: number): string {
  return new Date(time - MOOD_HISTORY_LIMITS.keepDays * 24 * 60 * 60_000).toISOString();
}

/** One point as stored. Numbers are rounded to 0.001. */
export interface StoredMoodPoint {
  at: string;
  valence: number;
  arousal: number;
  openness: number;
  expression: string;
  feeling: string | null;
  presentKind: string | null;
  presentIntensity: number | null;
}

/**
 * The point of a stored state at `at`: the mood values as stored, the quiet face of that mood, and
 * what she feels at that instant as `presentShannonFeeling` reads it (a kind and a strength, or
 * nothing when no feeling is showing). The cause and the target of a feeling are not read.
 */
export function moodPointOf(snapshot: CompanionStateSnapshot, at: string, timing: ShannonEmotionTiming): StoredMoodPoint {
  const mood = deriveShannonFace(snapshot.emotion);
  const present = presentShannonFeeling(snapshot, at, timing);
  const showing = present.primary !== 'neutral' && present.visibility !== 'hidden';
  return {
    at,
    valence: rounded(snapshot.emotion.valence, -1),
    arousal: rounded(snapshot.emotion.arousal, 0),
    openness: rounded(snapshot.emotion.openness, 0),
    expression: mood.expression,
    feeling: mood.feeling ?? null,
    presentKind: showing ? present.primary : null,
    presentIntensity: showing ? rounded(present.intensity, 0) : null,
  };
}

/** Whether `next` is a new point after `previous`, by the coalescing rule above. */
export function isNewMoodPoint(previous: StoredMoodPoint | null, next: StoredMoodPoint): boolean {
  if (!previous) return true;
  if (faceChanged(previous, next)) return true;
  const step = MOOD_HISTORY_LIMITS.moodStep - 1e-9;
  if (Math.abs(next.valence - previous.valence) >= step
    || Math.abs(next.arousal - previous.arousal) >= step
    || Math.abs(next.openness - previous.openness) >= step) return true;
  return Date.parse(next.at) - Date.parse(previous.at) >= MOOD_HISTORY_LIMITS.everyMinutes * 60_000;
}

/** The quiet face of her mood, or the kind she feels, is not what it was. */
export function faceChanged(previous: StoredMoodPoint, next: StoredMoodPoint): boolean {
  return previous.expression !== next.expression || previous.feeling !== next.feeling || previous.presentKind !== next.presentKind;
}

/**
 * Records the point of a state that was just written, when the rule says it is a new one. Never
 * throws: a failure is logged by name and code only (a message could quote a stored value).
 */
export function recordMoodPoint(
  database: DatabaseSync, recording: MoodHistoryRecording | null, scopeKey: string,
  snapshot: CompanionStateSnapshot, at: string, timing: ShannonEmotionTiming,
): void {
  if (!recording || scopeKey !== recording.ownerScopeKey) return;
  try {
    if (!database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = '${MOOD_HISTORY_TABLE}'`).get()) return;
    const point = moodPointOf(snapshot, at, timing);
    ownTransaction(database, () => {
      const previous = latestPoint(database, scopeKey);
      if (!isNewMoodPoint(previous, point)) return;
      database.prepare(`
        INSERT INTO shannon_mood_history
          (scope_key, recorded_at, valence, arousal, openness, expression, feeling, present_kind, present_intensity)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(scopeKey, point.at, point.valence, point.arousal, point.openness, point.expression, point.feeling, point.presentKind, point.presentIntensity);
      // On the index of the time alone: also the points of a scope that is no longer the owner's age out.
      database.prepare('DELETE FROM shannon_mood_history WHERE recorded_at < ?').run(keepCutoff(Date.parse(point.at)));
    });
  } catch (error) {
    if (error instanceof CallerTransactionLost) throw error.original;
    logFailure(error);
  }
}

/** The name and the code only: a message could quote a stored value. */
function logFailure(error: unknown): void {
  const code = (error as { code?: unknown } | null)?.code;
  console.error('Shannon mood history failed', error instanceof Error ? error.name : 'unknown', typeof code === 'string' && /^[A-Z_]+$/u.test(code) ? code : '');
}

/** SQLite rolled back the transaction a caller held around the state write; carries the original error. */
class CallerTransactionLost extends Error {
  constructor(readonly original: unknown) { super('MOOD_HISTORY_CALLER_TRANSACTION_LOST'); }
}

function latestPoint(database: DatabaseSync, scopeKey: string): StoredMoodPoint | null {
  const row = database.prepare(`
    SELECT recorded_at, valence, arousal, openness, expression, feeling, present_kind, present_intensity
    FROM shannon_mood_history WHERE scope_key = ? ORDER BY recorded_at DESC, point_id DESC LIMIT 1
  `).get(scopeKey) as unknown as MoodHistoryRow | undefined;
  return row ? storedPoint(row) : null;
}

export interface MoodHistoryRow {
  recorded_at: string; valence: number; arousal: number; openness: number;
  expression: string; feeling: string | null; present_kind: string | null; present_intensity: number | null;
}

export function storedPoint(row: MoodHistoryRow): StoredMoodPoint {
  return {
    at: row.recorded_at, valence: Number(row.valence), arousal: Number(row.arousal), openness: Number(row.openness),
    expression: row.expression, feeling: row.feeling ?? null, presentKind: row.present_kind ?? null,
    presentIntensity: row.present_intensity === null || row.present_intensity === undefined ? null : Number(row.present_intensity),
  };
}

/**
 * Inside a transaction someone else opened (a caller of the state store that holds one), a savepoint,
 * so that a failure here undoes only this point. Otherwise a write transaction of its own, after the
 * state's own transaction committed. When SQLite rolled back the caller's whole transaction, that is
 * not this point's failure alone: it is reported as `CallerTransactionLost`.
 */
function ownTransaction(database: DatabaseSync, operation: () => void): void {
  const nested = database.isTransaction;
  database.exec(nested ? 'SAVEPOINT shannon_mood_history' : 'BEGIN IMMEDIATE');
  try {
    operation();
    database.exec(nested ? 'RELEASE shannon_mood_history' : 'COMMIT');
  } catch (error) {
    if (nested && !database.isTransaction) throw new CallerTransactionLost(error);
    if (database.isTransaction) database.exec(nested ? 'ROLLBACK TO shannon_mood_history; RELEASE shannon_mood_history' : 'ROLLBACK');
    throw error;
  }
}

function rounded(value: number, minimum: number): number {
  const finite = Number.isFinite(value) ? value : 0;
  return Math.round(Math.min(1, Math.max(minimum, finite)) * 1000) / 1000;
}
