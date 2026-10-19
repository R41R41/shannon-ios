import type { TaskAuthority, TaskRecord, TaskRuntime } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import { pausedReport, pausedSpoken } from './taskPauseNotice.js';

/**
 * Tells the owner of a pause the Minecraft recovery made (`fcaBodyRecovery.ts`): the report, and the fixed sentence a call says for it.
 * A write that fails never undoes the pause (L-2, L-3): it is kept, one notice per task (the newest pause), and written again at every
 * tick and pass while the task is still paused as the recovery left it. A task the owner resumed meanwhile is let go of.
 */
export function createPauseAnnouncer(parts: { runtime: TaskRuntime; authority: TaskAuthority; scopeKey: string; log(line: string): void }) {
  const { runtime, authority, scopeKey } = parts;
  const pending = new Map<string, { key: string; text: string; spoken: string }>();
  return {
    /** Writes the notice of a pause once (the same key is never written twice); a write that fails is kept for `retry`. */
    announce(task: Pick<TaskRecord, 'id' | 'title'>, key: string, summary: string): void {
      const text = pausedReport(task.title, summary), spoken = pausedSpoken(task.title, text);
      try {
        runtime.recordPauseNotice?.(scopeKey, task.id, key, text, spoken);
        pending.delete(task.id);
      } catch {
        pending.set(task.id, { key, text, spoken });
        parts.log(`Shannon FCA body recovery task=${task.id} code=notice_deferred`);
      }
    },
    /** Writes the notices that could not be written, for the tasks still paused; the others are let go (the owner resumed them). */
    retry(): void {
      for (const [taskId, notice] of [...pending]) {
        try {
          const task = authority.get(scopeKey, taskId);
          if (task?.status === 'paused' && task.pauseReason === 'fca_stopped') {
            runtime.recordPauseNotice?.(scopeKey, taskId, notice.key, notice.text, notice.spoken);
          }
          pending.delete(taskId); // written, or already there, or the task is not paused any more
        } catch { /* kept: the next tick tries again */ }
      }
    },
    pending: () => pending.size,
  };
}
