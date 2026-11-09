import { createHash } from 'node:crypto';
import type { TaskStep } from '../../mind/action/taskRuntime/taskRuntimePorts.js';
import { logMilestoneOnce, milestoneLine } from './minecraftMilestoneLog.js';

type Task = Pick<TaskStep, 'taskId' | 'scopeKey' | 'snapshot'>;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Measurement of the final late milestone, whose proof is a native read rather than a frame predicate. */
export function createDragonDefeatLog(step: Task, log: (line: string) => void = line => console.info(line), now = Date.now) {
  const checkpoint = record(step.snapshot.checkpoint);
  let reached = checkpoint?.minecraftDragonDefeatLogged === true;
  const task = step.snapshot.task;
  const began = Date.parse(task.createdAt);
  const d = record(checkpoint?.minecraftMetrics)?.d;
  const decision = typeof d === 'number' && Number.isSafeInteger(d) ? d + 1 : 1;
  return {
    /** Only a completed goal-evidence call is handed here, including the final verifier's own reads. */
    note(bodyId: string, result: string | undefined): void {
      if (reached || !result) return;
      try {
        const evidence = record(JSON.parse(result));
        const contextKey = createHash('sha256')
          .update(JSON.stringify([step.scopeKey, step.taskId, bodyId, task.goal, task.completionCriteria])).digest('hex');
        if (evidence?.contextKey !== contextKey || evidence.connected !== true || record(evidence.boss)?.verified !== true) return;
        reached = true;
        const at = now(), elapsed = Number.isFinite(began) ? Math.max(0, at - began) : 0;
        // ChatGPT's review of 11/10, M1: the time the body saw her fall beside the time the head checked it, for the filming's clock. The
        // judgement of the win is unchanged (boss.verified).
        const seen = record(record(evidence.boss)?.witness)?.observedAt;
        const witnessed = typeof seen === 'string' && Number.isFinite(Date.parse(seen)) ? seen : '-';
        if (logMilestoneOnce(step.taskId, 'dragon_defeated')) {
          log(`${milestoneLine(step.taskId, 'dragon_defeated', elapsed, null, decision)} verifiedAt=${new Date(at).toISOString()} witnessedAt=${witnessed}`);
        }
      } catch {
        // A missing or malformed proof, or a journal failure, never changes the task's verification or execution.
      }
    },
    checkpoint: () => ({ minecraftDragonDefeatLogged: reached }),
  };
}
