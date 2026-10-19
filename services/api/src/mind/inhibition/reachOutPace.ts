/**
 * How often she starts a conversation herself (owner 2026-10-19, after a week of eight or nine messages a day, many of them at night
 * and while he had a cold): about three a day, one at most through the night, and fewer while he is unwell. The caps are the
 * system's, beside the reach-out's own day count (`maximumReachOutsPerDay`); what she says, and whether she speaks at all, stays hers.
 *
 * Pure: the callers (`momentBlocked` in the worker, `reachOutsRemaining` in her loop) hand in what they read.
 */
export const REACH_OUT_PACE_V1 = Object.freeze({
  /** The day's messages while he is unwell (the configured cap stands when it is lower). */
  unwellPerDay: 2,
  /** Owner-local hours of the night [23, 7): at most `nightMessages` of hers in one night, none while he is unwell. */
  night: Object.freeze({ start: 23, end: 7 }),
  nightMessages: 1,
  /** How far back his own words are read for a cold or feeling unwell. */
  unwellLookbackHours: 36,
});

/** His own words that say he is unwell (a cold, a fever, feeling bad). A word read in his message, never a diagnosis. */
export const OWNER_UNWELL_WORDS = /風邪|かぜ(?:を|ひ|気味)|熱が(?:ある|出|下が)|発熱|体調(?:が悪|を崩|崩|不良|がよくな)|具合(?:が)?(?:悪|わる)|寝込|頭痛|腹痛|吐き気|しんどい|病院(?:に|へ)行|インフル|咳が/u;

export function ownerSaysUnwell(texts: readonly string[]): boolean {
  return texts.some(text => OWNER_UNWELL_WORDS.test(text));
}

const HOUR = 3_600_000;

function localHour(at: string, timeZone: string): number {
  try {
    const hour = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(at));
    return Number(hour) % 24;
  } catch {
    return new Date(at).getUTCHours();
  }
}

/** The instant the night `at` is in began (23:00 local), or null when `at` is not at night. */
export function nightStartedAt(at: string, timeZone: string): string | null {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return null;
  const { start, end } = REACH_OUT_PACE_V1.night;
  const hour = localHour(at, timeZone);
  if (!(hour >= start || hour < end)) return null;
  const hoursIn = hour >= start ? hour - start : hour + 24 - start;
  // Whole hours back to 23:00, then down to the hour (minutes and seconds dropped).
  const startTime = time - hoursIn * HOUR;
  return new Date(startTime - (startTime % HOUR)).toISOString();
}

export interface ReachOutPaceFacts {
  at: string;
  timeZone: string;
  /** Her messages of the owner-local day, and the configured cap of them. */
  sentToday: number;
  maximumPerDay: number;
  /** When her newest message was written, or null. */
  lastSentAt: string | null;
  /** He said lately that he is unwell (`ownerSaysUnwell`). */
  unwell: boolean;
}

/** Why she should not start a message now, as a closed code, or null. */
export function reachOutPaceHold(facts: ReachOutPaceFacts): 'daily_limit' | 'night_quiet' | 'owner_unwell' | null {
  const cap = facts.unwell ? Math.min(facts.maximumPerDay, REACH_OUT_PACE_V1.unwellPerDay) : facts.maximumPerDay;
  if (facts.sentToday >= cap) return facts.unwell && facts.sentToday < facts.maximumPerDay ? 'owner_unwell' : 'daily_limit';
  const night = nightStartedAt(facts.at, facts.timeZone);
  if (night === null) return null;
  if (facts.unwell) return 'owner_unwell';
  const sentTonight = facts.lastSentAt !== null && facts.lastSentAt >= night ? 1 : 0;
  return sentTonight >= REACH_OUT_PACE_V1.nightMessages ? 'night_quiet' : null;
}
