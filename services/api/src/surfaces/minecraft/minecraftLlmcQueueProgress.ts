import { counters, verticalSpeeds, keep } from './minecraftLlmcQueueState.js';
import type { QueueItem, QueueDeps, RanListener } from './minecraftLlmcQueueState.js';
import { actRemainingMilliseconds } from '../../contracts/minecraftActContract.js';
import { dependStateOf, unitView, type DependState } from '../../contracts/continueContract.js';
import type { MinecraftControlReceipt, MinecraftQueueProgress } from '../../contracts/minecraftControlContract.js';
import type { FcaQueueWake } from '../../mind/action/fca/fcaPorts.js';
import type { ToolResult } from '../../mind/tools/toolRegistryPorts.js';

export function createQueueProgress(deps: QueueDeps, shared: { items: QueueItem[]; open(): QueueItem[]; now(): number }) {
  const { items, open, now } = shared;

  /** The body's progress of an item, when it is the one running. */
  const progressOf = (item: QueueItem): MinecraftQueueProgress | null => {
    const progress = deps.control.progress(deps.bodyId());
    return progress && progress.id === item.id ? progress : null;
  };

  /** The time an item likely has left: the hands from the one the body runs, less what that hand has run; without the progress, the
   * whole less what has run. */
  const remainingMs = (item: QueueItem): number => {
    const mine = progressOf(item);
    const key = mine ? `${mine.iteration}/${mine.hand}` : null;
    if (key !== item.handKey) {
      item.handKey = key;
      item.handSince = now();
    }
    const tune = verticalSpeeds.get(deps.taskId) ?? {};
    if (!mine) return actRemainingMilliseconds(item.input, item.from, null, item.startedAt === null ? 0 : now() - item.startedAt, tune);
    return Math.max(
      0,
      actRemainingMilliseconds(item.input, item.from, { hand: mine.hand, iteration: mine.iteration }, 0, tune) - (now() - item.handSince),
    );
  };

  /** What the item `ref` is to one that relies on it, by the contract's order (`dependStateOf`): a mark this queue
   * does not remember is unknown. */
  const dependStateOfRef = (ref: string): DependState => {
    const found = items.find((entry) => entry.item === ref);
    return dependStateOf(found ? unitView(found.ended ? (found.unit ?? undefined) : undefined) : { remembered: false, ended: true });
  };

  /** Her feelings read each result; they never fail a step. */
  function tell(listener: RanListener, item: QueueItem, result: ToolResult, receipt: MinecraftControlReceipt): void {
    try {
      listener({ call: item.call, why: item.why }, result, receipt);
    } catch {
      /* feelings never fail a step */
    }
  }

  const aheadMs = (): number => open().reduce((sum, item) => sum + item.maxMs, 0);

  const nextNumber = (): number => {
    const number = (counters.get(deps.taskId) ?? 0) + 1;
    keep(counters, deps.taskId, number);
    return number;
  };

  /** Why the queue has no more to wait for: the step wakes for it (a message, a surprise) or the running one is nearly done. */
  function wakeNow(queue: readonly QueueItem[], options: { messages?(): boolean; alert?(): boolean }, wake: number): FcaQueueWake | null {
    if (options.messages?.()) return 'message';
    if (options.alert?.()) return 'alert';
    return queue.length === 1 && remainingMs(queue[0]!) <= wake ? 'remaining' : null;
  }
  return { progressOf, remainingMs, dependStateOfRef, tell, aheadMs, nextNumber, wakeNow };
}
