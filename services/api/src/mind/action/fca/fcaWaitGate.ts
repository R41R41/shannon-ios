import type { TaskRuntime, TaskStep } from '../taskRuntime/taskRuntimePorts.js';

/** Waits turned away before a further wait of a task nobody can answer is accepted and the task is stopped. */
export const FCA_WAIT_REFUSALS = 2;
/** The stop reason when such a task waits again after its refusals. */
export const FCA_WAIT_WITHOUT_COUNTERPART = 'wait_without_counterpart';

/** What the decision is told when nobody can answer the task (closed values only). */
export type FcaWaitFact = { replyPossible: false; refusedWaits: number; refusalLimit: number };
export interface FcaWaitOutcome { disposition: 'continue' | 'wait' | 'complete'; refusedWaits: number; stop: boolean }

/**
 * A wait is a promise that something will arrive: a child's result or a message. A task whose requester cannot send it one
 * (`counterpart` false: an operator's hand-over, Minebot lane run 1, 2026-10-14, where the task waited for 「指示」 nobody could
 * give) and that has no unfinished child would wait for nothing until its time limit. The decision is told so beforehand; a wait
 * is turned away (the step continues) at most `FCA_WAIT_REFUSALS` times; a wait after that is committed with her summary and the
 * task is stopped. Nothing is said for her: the fact is data for her decision, and her summary stays her own.
 * (A Minecraft body task has no `fca_wait`: the task queue's items wait for it, `fcaStretch.ts`.)
 */
export function fcaWaitGate(step: TaskStep, runtime: TaskRuntime, counterpart: (() => boolean) | undefined, prior: Readonly<Record<string, unknown>>) {
  const stored = Number(prior.fcaWaitRefusals ?? 0);
  const refusedWaits = Number.isSafeInteger(stored) && stored > 0 ? Math.min(stored, FCA_WAIT_REFUSALS) : 0;
  const unanswerable = () => {
    if (!counterpart || counterpart()) return false;
    const childIds = runtime.get(step.scopeKey, step.taskId)?.childIds ?? [];
    return !childIds.some(id => !['completed', 'failed', 'stopped'].includes(runtime.get(step.scopeKey, id)?.phase ?? 'completed'));
  };
  return {
    fact(): FcaWaitFact | undefined {
      return unanswerable() ? { replyPossible: false, refusedWaits, refusalLimit: FCA_WAIT_REFUSALS } : undefined;
    },
    apply(disposition: FcaWaitOutcome['disposition']): FcaWaitOutcome {
      if (disposition !== 'wait' || !unanswerable()) return { disposition, refusedWaits, stop: false };
      if (refusedWaits < FCA_WAIT_REFUSALS) return { disposition: 'continue', refusedWaits: refusedWaits + 1, stop: false };
      return { disposition, refusedWaits, stop: true };
    },
  };
}
