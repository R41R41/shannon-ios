import type { SettledEvent } from './minecraftControlState.js';

/**
 * The eyes' record kept on the receipts themselves (the skill-port plan, item 2: the observation of the flight goes on when a reflex cuts the hand
 * and when the head has taken the item off). The queue tells its listeners only of items that count as run; a receipt of an item the head dropped,
 * cancelled or settled late carries the body's `eye` all the same. This listens on the control's settled receipts, one per task (a new step of the
 * task replaces the earlier one), and hands each to `note` (which keeps a flight once: the same receipt noted twice is one throw).
 */
export interface EyeTapControl { settledListeners: Set<(event: SettledEvent) => void> }
const taps = new Map<string, { control: EyeTapControl; listener: (event: SettledEvent) => void }>();

export function tapEyes(control: EyeTapControl, taskId: string, note: (id: string, result: string | undefined) => void): void {
  const earlier = taps.get(taskId);
  earlier?.control.settledListeners.delete(earlier.listener);
  const listener = (event: SettledEvent): void => {
    if (event.command.context.taskId === taskId && event.receipt.result?.includes('"eye"')) note(event.receipt.id, event.receipt.result);
  };
  control.settledListeners.add(listener);
  taps.set(taskId, { control, listener });
}
