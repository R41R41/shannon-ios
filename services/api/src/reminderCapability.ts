import { extractPromiseCaptures, requestsExactTimeAlert } from './prospectiveMemory.js';

/**
 * Turn-scoped capability facts for a request that needs a clock. Shannon can
 * only speak inside a throttled daily slot (one message a day, quiet hours, a
 * cooldown after conversation), so the reply must say that plainly instead of
 * sounding like an accepted alarm. This is a capability boundary, not persona.
 */
export function reminderCapabilityBoundary(message: string, at = new Date().toISOString()): string {
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
