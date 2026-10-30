import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { FcaBodyLifecycle } from '../../mind/action/fca/fcaPorts.js';
import type { LlmcQueue } from './minecraftLlmcQueue.js';

export type { LlmcQueue };
import { surpriseFrame, type SurpriseFrame } from './minecraftLlmcProbe.js';

/** The surprises a frame shows against the one the last decision read: health lost 5 or more (or under 10), a
 * fall of 5 or more, air under 10. */
function alertKinds(before: SurpriseFrame | null, now: SurpriseFrame): Set<string> {
  const kinds = new Set<string>();
  const same = before !== null && before.arrival === now.arrival && before.dimension === now.dimension;
  if (same && healthAlert(before, now)) kinds.add('health');
  if (same && before.feet && now.feet && before.feet.y - now.feet.y >= 5) kinds.add('fall');
  if (now.oxygen !== null && now.oxygen < 10) kinds.add('oxygen');
  return kinds;
}
/** Health lost 5 or more since the frame the last decision read, or under 10 now when it was not. */
function healthAlert(before: SurpriseFrame, now: SurpriseFrame): boolean {
  if (before.health === null || now.health === null) return false;
  return before.health - now.health >= 5 || (before.health >= 10 && now.health < 10);
}

/**
 * What the mode's body lifecycle adds for the task queue (design minebot-task-queue, `fcaStretch.ts`): the queue's port, a call
 * chosen before the queue
 * lost an item is stale, a stopped step stops its items, the step closes only after they answered, the words of
 * items that ended with no tool result
 * to carry them, and a surprise of the body told while items run.
 */
export function queueLifecycle(parts: { queue: LlmcQueue | undefined; observe(): BodyObservation | null; arrival(): number | null;
  /** The frame the last decision read (the surprise watch's), or null. */
  peek(): SurpriseFrame | null;
  /** Shown to the next decision once, with the results the history keeps short. */
  keep(text: string): void }, body: FcaBodyLifecycle): Partial<FcaBodyLifecycle> {
  const { queue } = parts;
  let alerted = new Set<string>();
  return {
    ...(queue ? { queue } : {}),
    noteNews: (text: string) => parts.keep(text),
    // A stopped step stops its items at once (the body lifecycle cancels the task's pending commands as well).
    start(signal: AbortSignal) {
      body.start(signal);
      signal.addEventListener('abort', () => queue?.cancelAll(), { once: true });
    },
    // The step is closed after its items have answered (a stop cancels them: the body's answer comes within a
// moment), then nothing may be unsettled.
    async close() {
      await queue?.settled();
      queue?.stop();
      await body.close();
    },
    /**
     * A call chosen before an item ended badly (or was taken off) is stale: it followed a queue that is gone.
 * Otherwise the body's own rule (only
     * a cut of her own tool makes a call of the mode stale).
     */
    guardFor: async (version: number, call: Parameters<NonNullable<FcaBodyLifecycle['guardFor']>>[1]) =>
      queue?.stale() ? false : body.guardFor ? body.guardFor(version, call) : body.guard(version),
    /**
     * A surprise of the body while items run, told without using up the investigation's own count (`peek`): health
 * lost 5 or more or under 10, a fall
     * of 5 or more, air under 10, since the frame the last decision read. Each kind once until it clears; the next
 * `investigate` finds and probes it.
     */
    alert: (): boolean => {
      const kinds = alertKinds(parts.peek(), surpriseFrame(parts.observe(), parts.arrival()));
      const fresh = [...kinds].some(kind => !alerted.has(kind));
      alerted = kinds;
      // A furnace that came due (the body's `furnace.done`) is told to the next decision once, and is a reason to
// decide now: its take-out is an item.
      const furnaces = queue?.furnaceNews() ?? [];
      for (const line of furnaces) parts.keep(line);
      // Continue contract 1: a result that came after an item was told (the release proved, the cleanup that failed, a
// correction) is told
// to the next decision once too.
      const notes = queue?.notes() ?? [];
      for (const line of notes) parts.keep(line);
      return fresh || furnaces.length > 0 || notes.length > 0;
    },
  };
}
