import type { MinecraftQueue } from './fcaMinecraftQueue.js';
import { queueEnded } from '../surfaces/minecraft/minecraftRequestQueue.js';

/** Whether the list has something that keeps a new request waiting: a request running or waiting its turn, or a body that is busy. */
export const queueBusy = (queue: MinecraftQueue, busy: boolean): boolean => busy || queue.snapshot().entries.some(entry => !queueEnded(entry.state));

/** The entry of the list that a task belongs to, while it is not ended. */
export const queueEntryOfTask = (queue: MinecraftQueue, taskId: string) => queue.snapshot().entries
  .find(entry => entry.taskId === taskId && !queueEnded(entry.state)) ?? null;

/** The app's status read: the tasks' own lines, then the list when it has anything. */
export function queueStatusLines(queue: MinecraftQueue, lines: readonly string[]): string[] {
  const listed = queue.promptLines();
  return listed.length ? [...lines, `依頼の列:\n${listed.join('\n')}`] : [...lines];
}
