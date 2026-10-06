/**
 * Her mood over time for the owner's own apps (`GET /v1/shannon/mood-history`, `docs/mood-history-contract.md`).
 *
 * A point is her continuous mood values, the quiet face of that mood, and what she feels at that
 * instant as a kind and a strength. There is no field for a cause, for a target, or for anything
 * anyone said: the history is written from the stored companion state and holds only what that
 * state already holds as numbers and names from closed lists.
 *
 * Owner-only and paired-device-only, like 「シャノンのいま」; nothing here is in a prompt.
 */
import { shannonNowOwnerScope } from './shannonNowContract.js';

export const MOOD_HISTORY_PATH = '/v1/shannon/mood-history';
export const MOOD_HISTORY_SCHEMA_VERSION = 1;

export const MOOD_HISTORY_LIMITS = Object.freeze({
  /** The window read when `hours` is absent. */
  defaultHours: 24,
  /** The longest window a read may ask for; a longer one is read as this. */
  maxHours: 336,
  /** At most this many points in one answer; a longer history is thinned, keeping every change of face. */
  maxPoints: 300,
  /** Points older than this are deleted when a new point is written. */
  keepDays: 14,
  /** While writes happen and nothing changed, a point at most this often. */
  everyMinutes: 10,
  /** A mood value that moved at least this far since the last point makes a new point. */
  moodStep: 0.05,
  readsPerMinute: 60,
});

/**
 * `SHANNON_MOOD_HISTORY`, default on. `off`, `false`, `0` or `disabled` records nothing (in the API
 * and its workers and in the activity loop's process) and refuses the read with
 * `403 MOOD_HISTORY_DISABLED`. Points already written age out after `keepDays`. A restart applies it.
 */
export function moodHistoryEnabled(environment: Readonly<Record<string, string | undefined>>): boolean {
  const value = environment.SHANNON_MOOD_HISTORY?.trim().toLowerCase();
  return !(value === 'off' || value === 'false' || value === '0' || value === 'disabled');
}

/** Whose mood is recorded: the owner's scope only. A device paired into another scope reads nothing either. */
export interface MoodHistoryRecording {
  ownerScopeKey: string;
}

/** The recording a process applies, or `null` when the switch is off. */
export function moodHistoryRecording(environment: Readonly<Record<string, string | undefined>>): MoodHistoryRecording | null {
  return moodHistoryEnabled(environment) ? { ownerScopeKey: shannonNowOwnerScope(environment) } : null;
}

export interface MoodHistoryPoint {
  at: string;
  /** Unpleasant (-1) to pleasant (1). */
  valence: number;
  /** Quiet (0) to activated (1). */
  arousal: number;
  /** Guarded (0) to open (1). */
  openness: number;
  /** The quiet face of her mood: one of the 22 faces, and `feeling` for a borrowed face. */
  mood: { expression: string; feeling?: string };
  /** What she felt at that instant (`kind`: one of the feeling kinds; `intensity` 0–1), or `null` when no feeling was showing. */
  present: { kind: string; intensity: number } | null;
}

export interface MoodHistoryResponse {
  schemaVersion: number;
  generatedAt: string;
  /** The window this answer covers, ending at `generatedAt`. */
  hours: number;
  /** Oldest first. */
  points: MoodHistoryPoint[];
  /** The newest point before the window, which still holds at its start. Absent when there is none. */
  carryIn?: MoodHistoryPoint;
  /** More points were stored in the window than `limits.maxPoints`; the answer was thinned. */
  downsampled: boolean;
  limits: {
    defaultHours: number; maxHours: number; maxPoints: number; keepDays: number; everyMinutes: number; moodStep: number;
  };
}
