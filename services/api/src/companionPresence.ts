import {
  calibrateTemperament,
  explainTemperament,
  lingeringFeelingLine,
  presentShannonFeeling,
  presentShannonMood,
  resolveReplyEmotion as resolveReplyEmotionWith,
  type ReplyEmotion,
  type ReplyEmotionInput,
  type CompanionStateEvent,
  type CompanionStateSnapshot,
  type CompanionStateStore,
  type ShannonExpressiveEmotion,
  type ShannonPresentMood,
  type ShannonTemperamentReasons,
} from '@shannon/cognition';
import { emotionTiming } from './emotionTiming.js';

export { emotionTiming };
import { decidedReplyFeeling, usesDecidedFeeling, type ChatReplyFeeling } from './chatReplyFeeling.js';
export { replyFeelingOffer } from './chatReplyFeeling.js';

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
  /** 「いま」: the feeling at read time on her awake clock, through the one reading shared by text, voice and the body. */
  mood: ShannonPresentMood;
  /** What the shown trait values are made of. Neutral status text, not Shannon speaking. */
  temperamentReasons: ShannonTemperamentReasons;
}

export type PresentedCompanionState = CompanionStateSnapshot & { presence: CompanionPresence };

/**
 * The state as a client should show it now. Traits are recomputed for today so
 * an absence is visible without waiting for the next turn, and the mood is the
 * decayed conversational feeling rather than a stored one. Nothing is written.
 * A reply passes the feeling it just resolved, which is stored only afterwards,
 * so the state returned with that reply already agrees with its face.
 */
export function presentCompanionState(
  snapshot: CompanionStateSnapshot,
  now: string,
  feeling?: ShannonExpressiveEmotion,
  timing = emotionTiming(),
): PresentedCompanionState {
  // An unreadable clock keeps the last calibrated day instead of pretending a month has passed.
  const today = Number.isFinite(Date.parse(now)) ? ownerDay(now) : snapshot.sharedDays?.at(-1) ?? ownerDay(now);
  return {
    ...snapshot,
    temperament: snapshot.sharedDays ? calibrateTemperament(snapshot, today) : snapshot.temperament,
    presence: {
      mood: presentShannonMood(feeling ? { ...snapshot, expressiveEmotion: feeling } : snapshot, now, timing),
      temperamentReasons: explainTemperament(snapshot, today),
    },
  };
}

/**
 * The feeling a turn starts from. On her awake clock it is what she feels now (the reaction of the
 * moment or what lies underneath), which the resolver uses as it stands; under `clock: 'wall'` it
 * is the stored feeling, which the resolver carries by the wall-clock rule as before.
 */
export function feelingBeforeTurn(snapshot: CompanionStateSnapshot, now: string, timing = emotionTiming()): ShannonExpressiveEmotion | undefined {
  return timing.clock === 'awake' ? presentShannonFeeling(snapshot, now, timing) : snapshot.expressiveEmotion;
}

/**
 * What she still feels from before, in meaning, for a turn of the owner alone whose prompt carries
 * no companion-state block (the slim voice path). Empty when nothing is left and under the kill switch.
 */
export function stillFeltLine(snapshot: CompanionStateSnapshot, now: string): string {
  return lingeringFeelingLine(snapshot, now, emotionTiming());
}

/** Her feeling for one completed reply, with this process's emotion timing. Callers on the server use this, not the pure function. */
export function resolveReplyEmotion(input: ReplyEmotionInput): ReplyEmotion {
  return resolveReplyEmotionWith({ timing: emotionTiming(), ...input });
}

/**
 * Her feeling for a completed text reply of the chat model. The feeling the model decided for it (`chatReplyFeeling.ts`)
 * enters through the same resolver input as a voice turn's, and is used only when the resolver's result is that feeling.
 * Otherwise, and whenever none was decided or may be used, the turn is resolved as before the field existed.
 */
export function resolveTextReplyEmotion(
  input: ReplyEmotionInput, completion: { replyFeeling?: ChatReplyFeeling }, alone: boolean,
): ReplyEmotion {
  const { decided } = decidedReplyFeeling(completion, alone);
  if (!decided) return resolveReplyEmotion(input);
  // The chat model wrote the reply and chose its feeling: a cue word of another kind does not rename it (owner decision 2026-10-03).
  const resolved = resolveReplyEmotion({ ...input, decided, decidedKindWins: true });
  return usesDecidedFeeling(decided, resolved.expressiveEmotion) ? resolved : resolveReplyEmotion(input);
}

/**
 * Stores the feeling of a text reply on a later tick, after the response has
 * been returned, so the reply never waits for it. A failure only loses carry-over.
 * A neutral reply stores no feeling; it still was a moment she was awake.
 */
export function commitReplyEmotionLater(
  stateStore: CompanionStateStore,
  scopeKey: string,
  emotion: ShannonExpressiveEmotion,
): void {
  // A neutral reply adds no feeling: a stored one settles by itself at read time. On her awake clock it still was a moment awake.
  const neutral = emotion.primary === 'neutral';
  if (neutral && emotionTiming().clock !== 'awake') return;
  setImmediate(() => {
    try {
      stateStore.apply(scopeKey, neutral ? { type: 'awake-observed' } : { type: 'expressive-emotion-updated', emotion });
    } catch (error) {
      console.error('Shannon reply emotion commit failed', error);
    }
  });
}
