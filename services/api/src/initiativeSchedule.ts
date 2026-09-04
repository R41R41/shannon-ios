import type { InitiativeLoopResult } from './initiativeStore.js';

const MINUTE_MILLISECONDS = 60_000;
const STANDARD_RECHECK_MILLISECONDS = 15 * MINUTE_MILLISECONDS;

/**
 * Keep push delivery responsive while avoiding a database write every minute
 * for initiative decisions that cannot change yet.
 */
export function nextInitiativeDelayMilliseconds(
  result: InitiativeLoopResult,
  at = new Date().toISOString(),
  timeZone = 'Asia/Tokyo',
): number {
  if (result.sent > 0 || result.stopped === 'today-is-enough') {
    return millisecondsUntilNextLocalHour(at, 7, timeZone);
  }
  if (result.stopped === 'quiet-hours') {
    return millisecondsUntilNextLocalHour(at, 7, timeZone);
  }
  if (result.stopped === 'no-owner') return 5 * MINUTE_MILLISECONDS;
  return STANDARD_RECHECK_MILLISECONDS;
}

function millisecondsUntilNextLocalHour(at: string, targetHour: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find(part => part.type === type)?.value ?? 0);
  const localSeconds = value('hour') * 3_600 + value('minute') * 60 + value('second');
  const targetSeconds = targetHour * 3_600;
  const seconds = localSeconds < targetSeconds
    ? targetSeconds - localSeconds
    : 24 * 3_600 - localSeconds + targetSeconds;
  return Math.max(MINUTE_MILLISECONDS, seconds * 1_000);
}
