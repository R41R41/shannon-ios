import { NO_TIMER_BOUNDARY, PROMISE_SLOT_BOUNDARY } from '@shannon/cognition';
import { extractPromiseCaptures, requestsExactTimeAlert } from '../../memory/memoryPorts.js';
export { DEVICE_REMINDER_BOUNDARY } from '@shannon/cognition';

/**
 * Turn-scoped capability facts for a request that needs a clock. Shannon can
 * only speak inside a throttled daily slot (one message a day, quiet hours, a
 * cooldown after conversation), so the reply must say that plainly instead of
 * sounding like an accepted alarm. This is a capability boundary, not persona.
 */
export function reminderCapabilityBoundary(message: string, at = new Date().toISOString()): string {
  if (requestsExactTimeAlert(message)) {
    return NO_TIMER_BOUNDARY;
  }
  if (extractPromiseCaptures(message, at).some(capture => capture.note)) {
    return PROMISE_SLOT_BOUNDARY;
  }
  return '';
}

