import { NO_TIMER_BOUNDARY, PROMISE_ON_TIME_BOUNDARY, PROMISE_SLOT_BOUNDARY } from '@shannon/cognition';
import { switchOn } from '@shannon/switches';
import { serverEnvironment } from '../../../infra/config/serverEnvironment.js';
import { extractPromiseCaptures, requestsExactTimeAlert } from '../../memory/memoryPorts.js';
export { DEVICE_REMINDER_BOUNDARY } from '@shannon/cognition';

/**
 * Turn-scoped capability facts for a request that needs a clock. Without promises told at their time Shannon could only speak
 * inside a throttled daily slot, so the reply had to say that plainly instead of sounding like an accepted alarm. With them
 * (`SHANNON_PROMISE_ON_TIME`, on by default) she sends a word at that time, and says so (owner 2026-10-19). A capability boundary,
 * not persona.
 */
export function reminderCapabilityBoundary(message: string, at = new Date().toISOString(),
  onTime = switchOn(serverEnvironment(), 'SHANNON_PROMISE_ON_TIME')): string {
  if (requestsExactTimeAlert(message)) {
    return NO_TIMER_BOUNDARY;
  }
  if (extractPromiseCaptures(message, at).some(capture => capture.note)) {
    return onTime ? PROMISE_ON_TIME_BOUNDARY : PROMISE_SLOT_BOUNDARY;
  }
  return '';
}
