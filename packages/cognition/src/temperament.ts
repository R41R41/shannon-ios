import { filterMeaningfulInterests } from './interests.js';
import { memoryIdentifier, visibleMemoryText } from './memory.js';
import type { CompanionStateSnapshot, ShannonTemperament } from './types.js';

/**
 * Slow traits as a pure function of stored evidence. No model, no hidden
 * counter: the same evidence always gives the same value, and the value moves
 * back when the evidence leaves the window or is forgotten.
 *
 * - closeness            0.15 + 0.50 × (days talked in the last 30 ÷ 30) + 0.20 × min(1, promises kept in the last 90 days ÷ 5)
 * - curiosity            0.50 + 0.025 × min(12, living interests)
 * - confidenceAboutUser  min(0.85, 0.05 + 0.03 × Σ confidence of remembered facts and relationships)
 *
 * initiative, calmness and needForContinuity are fixed dispositions: nothing
 * observed today is honest evidence for them, so they are not shown as state.
 * Evidence comes only from recorded owner turns and owner memory; a guest's
 * speech is never recorded and therefore cannot reach these rules.
 */
export const SHARED_DAY_WINDOW = 30;
const KEPT_PROMISE_WINDOW = 90;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

export interface ShannonTemperamentEvidence {
  /** Owner-local days with a conversation inside the last 30 days. */
  sharedDays: number;
  /** Promises marked done inside the last 90 days. */
  keptPromises: number;
  /** Interests currently alive and not forgotten. */
  interests: number;
  /** Remembered facts and relationships that are not forgotten. */
  knownItems: number;
  /** Sum of their confidence. */
  knownConfidence: number;
}

export interface ShannonTemperamentReasons {
  closeness: string;
  curiosity: string;
  confidenceAboutUser: string;
}

export function shiftDay(day: string, offset: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, date! + offset)).toISOString().slice(0, 10);
}

export function restoreSharedDays(value: readonly unknown[]): readonly string[] {
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && DAY.test(item)))]
    .sort().slice(-SHARED_DAY_WINDOW);
}

/** Adds observed days and drops everything outside the 30-day window ending at `today`. */
export function mergeSharedDays(
  existing: readonly string[],
  observed: readonly string[],
  today: string,
): readonly string[] {
  if (!DAY.test(today)) return existing;
  const oldest = shiftDay(today, -(SHARED_DAY_WINDOW - 1));
  return restoreSharedDays([...existing, ...observed]).filter(day => day >= oldest && day <= today);
}

export function temperamentEvidence(snapshot: CompanionStateSnapshot, today: string): ShannonTemperamentEvidence {
  const oldest = DAY.test(today) ? shiftDay(today, -(SHARED_DAY_WINDOW - 1)) : '';
  const keptSince = DAY.test(today) ? shiftDay(today, -(KEPT_PROMISE_WINDOW - 1)) : '';
  const known = [...snapshot.userFacts, ...snapshot.relationships]
    .filter(item => visibleMemoryText(snapshot, item.id, item.statement));
  return {
    sharedDays: (snapshot.sharedDays ?? []).filter(day => day >= oldest && day <= today).length,
    keptPromises: snapshot.prospectiveMemories.filter(memory => memory.status === 'completed'
      && memory.updatedAt.slice(0, 10) >= keptSince
      && visibleMemoryText(snapshot, memory.id, memory.summary)).length,
    interests: filterMeaningfulInterests(snapshot.interests)
      .filter(interest => visibleMemoryText(snapshot, memoryIdentifier('interest', interest), interest)).length,
    knownItems: known.length,
    knownConfidence: known.reduce((sum, item) => sum + Math.min(1, Math.max(0, item.confidence)), 0),
  };
}

export function calibrateTemperament(snapshot: CompanionStateSnapshot, today: string): ShannonTemperament {
  const evidence = temperamentEvidence(snapshot, today);
  return {
    ...snapshot.temperament,
    closeness: round(0.15 + 0.50 * Math.min(1, evidence.sharedDays / SHARED_DAY_WINDOW)
      + 0.20 * Math.min(1, evidence.keptPromises / 5)),
    curiosity: round(0.50 + 0.025 * Math.min(12, evidence.interests)),
    confidenceAboutUser: round(Math.min(0.85, 0.05 + 0.03 * evidence.knownConfidence)),
  };
}

/** Neutral status text for the state sheet: what the shown value is made of. */
export function explainTemperament(snapshot: CompanionStateSnapshot, today: string): ShannonTemperamentReasons {
  const evidence = temperamentEvidence(snapshot, today);
  return {
    closeness: [
      evidence.sharedDays ? `この30日で${evidence.sharedDays}日話した` : 'この30日はまだ話していない',
      evidence.keptPromises ? `守れた約束${evidence.keptPromises}件（90日以内）` : '',
    ].filter(Boolean).join('・'),
    curiosity: evidence.interests ? `いま育っている関心${evidence.interests}件` : '育っている関心はまだない',
    confidenceAboutUser: evidence.knownItems ? `覚えていること${evidence.knownItems}件から` : '覚えていることはまだない',
  };
}

export function sameTemperament(left: ShannonTemperament, right: ShannonTemperament): boolean {
  return left.curiosity === right.curiosity && left.initiative === right.initiative
    && left.closeness === right.closeness && left.calmness === right.calmness
    && left.needForContinuity === right.needForContinuity
    && left.confidenceAboutUser === right.confidenceAboutUser;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
