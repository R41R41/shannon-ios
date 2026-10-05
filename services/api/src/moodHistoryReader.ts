import { DatabaseSync } from 'node:sqlite';
import { faceChanged, storedPoint, type MoodHistoryRow, type StoredMoodPoint } from './moodHistory.js';
import { MOOD_HISTORY_LIMITS, type MoodHistoryPoint } from './moodHistoryContract.js';

/**
 * Reads her mood history for `GET /v1/shannon/mood-history`. The connection is `query_only`: it
 * creates no table and writes nothing. A server on which no point was ever written (or the table
 * does not exist yet) answers an empty list.
 */
export class SQLiteMoodHistoryReader {
  private readonly database: DatabaseSync;

  constructor(path: string, private readonly maximumRows = MAXIMUM_ROWS_READ) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;');
  }

  /** The stored points of the scope since `since`, oldest first. At most 14 days of coalesced points are kept. */
  points(scopeKey: string, since: string): StoredMoodPoint[] {
    try {
      if (!this.database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'shannon_mood_history'`).get()) return [];
      const rows = this.database.prepare(`
        SELECT recorded_at, valence, arousal, openness, expression, feeling, present_kind, present_intensity
        FROM shannon_mood_history WHERE scope_key = ? AND recorded_at >= ? ORDER BY recorded_at DESC, point_id DESC LIMIT ?
      `).all(scopeKey, since, this.maximumRows) as unknown as MoodHistoryRow[];
      // Newest first, so that a bound reached drops the oldest; returned oldest first.
      return rows.reverse().map(storedPoint);
    } catch {
      // A table in a shape this reader does not know is an empty history, not a failed page.
      return [];
    }
  }

  /**
   * The newest stored point before `since`: the state that holds when a window starts (a point stands
   * until the next one). `null` when there is none, or the table is absent or of an unknown shape.
   */
  carryIn(scopeKey: string, since: string): StoredMoodPoint | null {
    try {
      if (!this.database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'shannon_mood_history'`).get()) return null;
      const row = this.database.prepare(`
        SELECT recorded_at, valence, arousal, openness, expression, feeling, present_kind, present_intensity
        FROM shannon_mood_history WHERE scope_key = ? AND recorded_at < ? ORDER BY recorded_at DESC, point_id DESC LIMIT 1
      `).get(scopeKey, since) as unknown as MoodHistoryRow | undefined;
      return row ? storedPoint(row) : null;
    } catch {
      return null;
    }
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}

/** A bound on what one read loads, far above what the coalescing rule writes in 14 days of ordinary use. */
const MAXIMUM_ROWS_READ = 50_000;

/**
 * At most `maximum` points, oldest first. Kept first: the first and the last point, and every point
 * at which the quiet face of her mood or the kind she feels changed. The rest of the budget is
 * spread evenly over the points between. Only when the changes alone exceed the budget are they
 * thinned evenly too.
 */
export function downsampleMoodPoints(points: readonly StoredMoodPoint[], maximum = MOOD_HISTORY_LIMITS.maxPoints): StoredMoodPoint[] {
  if (points.length <= maximum) return [...points];
  const changes = points.flatMap((point, index) => index === 0 || index === points.length - 1 || faceChanged(points[index - 1]!, point) ? [index] : []);
  if (changes.length >= maximum) return evenly(changes, maximum).map(index => points[index]!);
  const kept = new Set(changes);
  const rest = points.flatMap((_, index) => kept.has(index) ? [] : [index]);
  for (const index of evenly(rest, maximum - changes.length)) kept.add(index);
  return [...kept].sort((left, right) => left - right).map(index => points[index]!);
}

/** `count` items of `items` spread evenly, keeping the first and the last when `count` is at least 2. */
function evenly(items: readonly number[], count: number): number[] {
  if (count <= 0) return [];
  if (count >= items.length) return [...items];
  if (count === 1) return [items[0]!];
  const chosen = new Set<number>();
  for (let step = 0; step < count; step += 1) chosen.add(items[Math.round(step * (items.length - 1) / (count - 1))]!);
  return [...chosen];
}

/** A stored point as the contract names it: values to 0.01, the face, and what she felt. */
export function moodHistoryPoint(point: StoredMoodPoint): MoodHistoryPoint {
  return {
    at: point.at,
    valence: hundredths(point.valence),
    arousal: hundredths(point.arousal),
    openness: hundredths(point.openness),
    mood: { expression: point.expression, ...(point.feeling ? { feeling: point.feeling } : {}) },
    present: point.presentKind ? { kind: point.presentKind, intensity: hundredths(point.presentIntensity ?? 0) } : null,
  };
}

function hundredths(value: number): number {
  return Math.round(value * 100) / 100;
}
