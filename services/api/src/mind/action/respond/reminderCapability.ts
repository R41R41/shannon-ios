import { extractPromiseCaptures, requestsExactTimeAlert } from '../../memory/memoryPorts.js';

/**
 * Turn-scoped capability facts for a request that needs a clock. Shannon can
 * only speak inside a throttled daily slot (one message a day, quiet hours, a
 * cooldown after conversation), so the reply must say that plainly instead of
 * sounding like an accepted alarm. This is a capability boundary, not persona.
 */
export function reminderCapabilityBoundary(message: string, at = new Date().toISOString(), deviceActions = false): string {
  // With her device tools (the owner alone, his app paired, `SHANNON_DEVICE_ACTIONS`) the device does the timer or the reminder
  // (2026-10-13 daily evals D1: this boundary still said 「no timer」 beside the timer tool, and she refused 「1時間後に起こして」).
  if (deviceActions) {
    return requestsExactTimeAlert(message) || extractPromiseCaptures(message, at).some(capture => capture.note)
      ? DEVICE_REMINDER_BOUNDARY : '';
  }
  if (requestsExactTimeAlert(message)) {
    return '[Reminder capability] The owner asked to be alerted after an exact interval or by a timer/alarm. '
      + 'Shannon has no timer or clock alarm and cannot speak at an exact time; nothing was stored for this request. '
      + 'Say plainly, in です・ます, that she cannot notify at that exact time, and suggest the Clock app timer. Do not say she will tell them later.';
  }
  if (extractPromiseCaptures(message, at).some(capture => capture.note)) {
    return '[Reminder capability] The owner asked for something at a clock time. Shannon cannot speak at an exact time. '
      + 'The request is kept as a promise and she mentions it inside her once-a-day message slot, which may be later than the requested time. '
      + 'Say this limit plainly, in です・ます. Do not promise to wake, call or notify them at that time.';
  }
  return '';
}

/** The boundary while her device tools are offered: what to call, and when it is done. */
export const DEVICE_REMINDER_BOUNDARY = '[Reminder capability] The owner asked to be alerted after an interval or at a clock time. '
  + 'Do it on his device now: timer_start for an interval (「1時間後に起こして」 is 3600 seconds), reminder_create for a clock time or a named reminder. '
  + 'Do not ask whether to do it, and do not suggest the Clock app unless the device refused. '
  + 'Confirm the time in one short sentence once the tool accepted it; '
  + 'the device reports when it is done.';
