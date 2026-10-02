import type { ShannonEmotionClock } from './types.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** `awake`: feelings fade only while she is awake. `wall`: the timing rules as they were before the awake clock. */
export type ShannonEmotionClockMode = 'awake' | 'wall';

/**
 * How long her feelings last. This is the one table of time constants for emotion; the server may
 * override single values from its environment and passes the result in, this package reads none.
 *
 * Every half-life is measured on her awake clock: time she spends in a conversation or in an
 * activity session of her own. While she is dormant the clock stands still and nothing fades.
 *
 * | layer                 | value                 | lasts about                         |
 * | the moment's reaction | `reactionHalfLifeMs`  | a few minutes (startled, flustered) |
 * |                       | `passingHalfLifeMs`   | about ten minutes (any other feeling of one reply); gone by the time she is dormant |
 * | mood                  | `moodHalfLifeMs`      | a few hours (a feeling held as her mood: glad after praise, sulking) |
 * |                       | `moodValueHalfLifeMs` | a few hours (valence and openness returning to their baseline) |
 * |                       | `arousalHalfLifeMs`   | about an hour (activation returning to its baseline) |
 * | what lingers          | `lingeringHalfLifeMs` | one to two awake days of 16 hours (a strong feeling) |
 * |                       | `lingeringMaxWallMs`  | and never more than four days on the wall clock |
 */
export interface ShannonEmotionTiming {
  clock: ShannonEmotionClockMode;
  /** The gap after which she counts as dormant: one event advances the awake clock by at most this much. */
  idleCapMs: number;
  reactionHalfLifeMs: number;
  passingHalfLifeMs: number;
  moodHalfLifeMs: number;
  moodValueHalfLifeMs: number;
  arousalHalfLifeMs: number;
  lingeringHalfLifeMs: number;
  /**
   * The one wall-clock bound: however rarely she is awake, nothing stays underneath longer than this
   * after it began. It only ends a feeling; it never makes one fade faster.
   */
  lingeringMaxWallMs: number;
  /**
   * An apology stays: for this long (awake) after a feeling was eased, the same kind of feeling is not
   * brought back up by anything that is not above the height it had before. For the same time a feeling
   * that was eased (by him, or by a strong feeling of the opposite sign) is not eased again by a contrary feeling.
   */
  easedHoldMs: number;
}

export const SHANNON_EMOTION_TIME: Readonly<ShannonEmotionTiming> = Object.freeze({
  clock: 'awake',
  idleCapMs: 12 * MINUTE,
  reactionHalfLifeMs: 2 * MINUTE,
  passingHalfLifeMs: 5 * MINUTE,
  moodHalfLifeMs: 90 * MINUTE,
  moodValueHalfLifeMs: 2 * HOUR,
  arousalHalfLifeMs: 30 * MINUTE,
  lingeringHalfLifeMs: 8 * HOUR,
  lingeringMaxWallMs: 4 * 24 * HOUR,
  easedHoldMs: 30 * MINUTE,
});

/** Strengths, not times: when a feeling counts as settled, held, noted underneath, or eased. */
export const SHANNON_EMOTION_CONTINUITY = Object.freeze({
  /** Below this present strength a feeling has settled. */
  settledBelow: 0.15,
  /** Below this a feeling does not show. A mood of which less is left no longer bars a new feeling of its kind, nor holds its place against one. */
  visibleFrom: 0.3,
  /** A mood-like feeling toward the owner expressed at least this strongly stays underneath as her mood. */
  moodFrom: 0.5,
  /** At least this strong, it lingers for one to two awake days. */
  lingersFrom: 0.72,
  /** How many feelings are kept underneath at most; the weakest gives way. */
  maximumLingering: 4,
  /** A stimulus of the opposite sign at least this strong replaces a stronger feeling and eases what lies underneath. */
  contraryFrom: 0.7,
  /** The share of an opposite feeling underneath that such a stimulus takes away. */
  contraryEase: 0.5,
  /** The share of a hurt toward the owner that his apology, or his kind word, takes away. */
  apologyEase: 0.6,
  kindnessEase: 0.3,
  /** How far what lies underneath colours the baseline of valence, and the most it may. Kept below the 0.24 at which the quiet face changes. */
  /** Inside the hold after an easing, a same-kind reaction is stored at most this far above the eased strength. */
  easedMargin: 0.05,
  moodColour: 0.3,
  moodColourLimit: 0.2,
});

/** The share that remains after `elapsedMs` of a quantity with this half-life. */
export function remainingShare(elapsedMs: number, halfLifeMs: number): number {
  if (!(halfLifeMs > 0)) return 0;
  if (!(elapsedMs > 0)) return 1;
  return 0.5 ** (elapsedMs / halfLifeMs);
}

/**
 * The awake clock after an event at `now`: it advances by the wall time since her last event, at
 * most the idle cap. An instant that is not later than the last event advances nothing, so two
 * processes that apply events to the same state in any order never count a stretch twice.
 */
export function advanceEmotionClock(
  clock: ShannonEmotionClock | undefined,
  now: string,
  timing: ShannonEmotionTiming,
): { clock: ShannonEmotionClock | undefined; elapsedMs: number } {
  const time = Date.parse(now);
  if (!Number.isFinite(time)) return { clock, elapsedMs: 0 };
  if (!clock) return { clock: Object.freeze({ awakeMs: 0, at: now }), elapsedMs: 0 };
  const gap = time - Date.parse(clock.at);
  // A last event far in the future is a machine clock that was wrong for a while: the clock is brought back to
  // now, and stored that way, so the next event advances it again. A small step back is two writers out of order.
  if (gap < -Math.max(0, timing.idleCapMs)) return { clock: Object.freeze({ awakeMs: clock.awakeMs, at: now }), elapsedMs: 0 };
  if (!(gap > 0)) return { clock, elapsedMs: 0 };
  const elapsedMs = Math.min(gap, Math.max(0, timing.idleCapMs));
  return { clock: Object.freeze({ awakeMs: clock.awakeMs + elapsedMs, at: now }), elapsedMs };
}

/** Her awake time at `now` without writing anything: the stored clock plus the stretch since its last event, capped. */
export function awakeTimeAt(clock: ShannonEmotionClock | undefined, now: string, timing: ShannonEmotionTiming): number {
  return advanceEmotionClock(clock, now, timing).clock?.awakeMs ?? 0;
}

/** A stored clock that cannot be read is dropped; the next event starts a new one at zero. */
export function restoreEmotionClock(value: unknown): ShannonEmotionClock | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.awakeMs !== 'number' || !Number.isFinite(row.awakeMs) || row.awakeMs < 0) return undefined;
  if (typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at))) return undefined;
  return Object.freeze({ awakeMs: row.awakeMs, at: row.at });
}
