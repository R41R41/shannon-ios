import type { TaskRuntime } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import { forgetBodyAbsent, tasksWithoutBody } from '../surfaces/minecraft/minecraftBodyAbsent.js';

/** A task is woken for its body at most this often (a body that comes and goes would otherwise start a decision at each coming). */
export const BODY_WAKE_MINIMUM_MILLISECONDS = 30_000;
/** What the woken task is told (an external event of the common task tree, as the in-game words are). */
export const BODY_WAKE_TEXT = '体がつながった（新しい観測が届いている）。待ちをやめて、いまの live を読み直して続ける。';

/**
 * Wakes a Minecraft task that went to sleep for a body that was not there (mc-chat-stale-frame, 2026-10-26, task 31789a13: the
 * decision read `connected: false` and called `fca_wait`; his chat request could be answered, so the wait was accepted and the task
 * slept until his next words, four of which met the same picture). A decision that finds no body is noted
 * (`minecraftBodyAbsent.ts`); when such a task is waiting and a current frame of its body is there, it gets one message through
 * `observeExternal` (the shape of the in-game intent), on the origin the task already had. The note goes with the message, so a wait
 * is woken once; a body that is not there wakes nothing and costs no decision. Called from the one-second wake tick.
 */
export function fcaMinecraftBodyWake(parts: { control: MinecraftControl; runtime: TaskRuntime; ownerScope: string; now?: () => number;
  log?(line: string): void }) {
  const now = parts.now ?? Date.now, log = parts.log ?? ((line: string) => console.info(line));
  const woken = new Map<string, number>();
  /** The experience the task was made from (its earliest source): an external event needs a source, and this one is the task's own. */
  const origin = (taskId: string): string | null => {
    for (const source of parts.runtime.taskSources(parts.ownerScope, taskId)) {
      const id = source.experienceId ?? source.recalledMemoryIds[0];
      if (id) return id;
    }
    return null;
  };
  return {
    /** Wakes the tasks that wait for a body that is now there; how many. */
    tick(): number {
      let count = 0;
      for (const taskId of tasksWithoutBody()) {
        try {
          const task = parts.runtime.get(parts.ownerScope, taskId);
          if (!task || ['stopped', 'completed', 'failed'].includes(task.phase) || ['completed', 'failed', 'cancelled'].includes(task.status)) {
            forgetBodyAbsent(taskId);
            continue;
          }
          if (task.phase !== 'waiting' || task.status === 'paused') continue;
          const bodyId = parts.control.store.body(taskId);
          if (!bodyId || !parts.control.frame(bodyId)) continue;
          if (now() - (woken.get(taskId) ?? -Infinity) < BODY_WAKE_MINIMUM_MILLISECONDS) continue;
          const experienceId = origin(taskId);
          forgetBodyAbsent(taskId);
          if (!experienceId) {
            log(`Shannon Minecraft body wake skipped task=${taskId} reason=no_origin`);
            continue;
          }
          parts.runtime.observeExternal(parts.ownerScope, taskId, { eventId: `mc-body:${taskId}:${task.revision}`, experienceIds: [experienceId],
            observedAt: new Date(now()).toISOString(), text: BODY_WAKE_TEXT });
          woken.set(taskId, now());
          if (woken.size > 32) woken.delete(woken.keys().next().value as string);
          count += 1;
          log(`Shannon Minecraft body wake task=${taskId}`);
        } catch (error) {
          // The task ended meanwhile, or the event conflicts: nothing is retried every second (the note is gone).
          forgetBodyAbsent(taskId);
          log(`Shannon Minecraft body wake failed task=${taskId} reason=${error instanceof Error ? error.message.slice(0, 60) : 'error'}`);
        }
      }
      return count;
    },
  };
}
