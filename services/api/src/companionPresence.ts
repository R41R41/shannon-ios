import {
  calibrateTemperament,
  explainTemperament,
  presentShannonMood,
  type CompanionStateEvent,
  type CompanionStateSnapshot,
  type CompanionStateStore,
  type ShannonExpressiveEmotion,
  type ShannonPresentMood,
  type ShannonTemperamentReasons,
} from '@shannon/cognition';

const DEFAULT_TIME_ZONE = 'Asia/Tokyo';
const SHARED_TIME_LOOKBACK_MILLISECONDS = 31 * 24 * 60 * 60_000;
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** The owner-local calendar day (YYYY-MM-DD) of an instant. */
export function ownerDay(at: string, timeZone?: string): string {
  const zone = timeZone || DEFAULT_TIME_ZONE;
  let formatter = dayFormatters.get(zone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      return ownerDay(at, DEFAULT_TIME_ZONE);
    }
    dayFormatters.set(zone, formatter);
  }
  const time = Date.parse(at);
  return formatter.format(new Date(Number.isFinite(time) ? time : 0));
}

/**
 * Evidence that the owner and Shannon talked: the days of recorded owner turns
 * in the last month. Guest speech is never recorded, so it cannot appear here.
 */
export function sharedTimeEvent(
  turns: readonly { observedAt: string; timeZone?: string }[],
  observedAt: string,
  timeZone?: string,
): Extract<CompanionStateEvent, { type: 'shared-time-observed' }> {
  const today = ownerDay(observedAt, timeZone);
  const oldest = Date.parse(observedAt) - SHARED_TIME_LOOKBACK_MILLISECONDS;
  const days = new Set([today]);
  for (const turn of turns) {
    if (Date.parse(turn.observedAt) >= oldest) days.add(ownerDay(turn.observedAt, turn.timeZone ?? timeZone));
  }
  return { type: 'shared-time-observed', days: [...days].filter(day => day <= today).sort(), today };
}

export interface CompanionPresence {
  /** 「いま」: the feeling at read time, through the carry-over rule shared by text and voice. */
  mood: ShannonPresentMood;
  /** What the shown trait values are made of. Neutral status text, not Shannon speaking. */
  temperamentReasons: ShannonTemperamentReasons;
}

export type PresentedCompanionState = CompanionStateSnapshot & { presence: CompanionPresence };

/**
 * The state as a client should show it now. Traits are recomputed for today so
 * an absence is visible without waiting for the next turn, and the mood is the
 * decayed conversational feeling rather than a stored one. Nothing is written.
 */
export function presentCompanionState(snapshot: CompanionStateSnapshot, now: string): PresentedCompanionState {
  // An unreadable clock keeps the last calibrated day instead of pretending a month has passed.
  const today = Number.isFinite(Date.parse(now)) ? ownerDay(now) : snapshot.sharedDays?.at(-1) ?? ownerDay(now);
  return {
    ...snapshot,
    temperament: snapshot.sharedDays ? calibrateTemperament(snapshot, today) : snapshot.temperament,
    presence: { mood: presentShannonMood(snapshot, now), temperamentReasons: explainTemperament(snapshot, today) },
  };
}

/**
 * Stores the feeling of a text reply on a later tick, after the response has
 * been returned, so the reply never waits for it. A failure only loses carry-over.
 */
export function commitReplyEmotionLater(
  stateStore: CompanionStateStore,
  scopeKey: string,
  emotion: ShannonExpressiveEmotion,
): void {
  // A neutral reply adds nothing: a stored feeling already settles by itself at read time.
  if (emotion.primary === 'neutral') return;
  setImmediate(() => {
    try {
      stateStore.apply(scopeKey, { type: 'expressive-emotion-updated', emotion });
    } catch (error) {
      console.error('Shannon reply emotion commit failed', error);
    }
  });
}
