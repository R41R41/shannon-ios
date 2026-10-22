import type { TaskRuntime, TaskStep } from '../taskRuntime/taskRuntimePorts.js';

/** Waits turned away before a further wait of a task nobody can answer is accepted and the task is stopped. */
export const FCA_WAIT_REFUSALS = 2;
/** The stop reason when such a task waits again after its refusals. */
export const FCA_WAIT_WITHOUT_COUNTERPART = 'wait_without_counterpart';

/**
 * What the decision is told when nobody can answer the task (closed values only). mb-llmc r6: `waits: 'answered'` where a wait is
 * answered with what there is to wait for and never stops the task (`FcaWaitAnswer`).
 */
export type FcaWaitFact = { replyPossible: false; refusedWaits: number; refusalLimit: number } | { replyPossible: false; waits: 'answered' };
export interface FcaWaitOutcome { disposition: 'continue' | 'wait' | 'complete'; refusedWaits: number; stop: boolean;
  /** r6: the wait was answered in its receipt's place (`FcaWaitAnswer`): no refusal counted, the task goes on. */
  answered?: boolean }

/**
 * mb-llmc r6 (run 29: an operator's request, nobody to answer; Sonnet called fca_wait three times for 「食料の補給が要る」 and the third
 * stopped the task with 47 of its 60 minutes left): in the mode a wait nobody can answer is no step toward a stop. It is answered in one
 * line in place of its receipt (`line()`: what there is to wait for in the world, a furnace or health coming back, or that there is
 * nothing), and the step goes on. A task without it: as before.
 */
export interface FcaWaitAnswer {
  line(): string;
  /** The native message that answered the wait, with `text` in place of its receipt; null when it is not one. */
  amend?(turn: unknown, text: string): unknown | null;
}

/**
 * A wait is a promise that something will arrive: a child's result or a message. A task whose requester cannot send it one
 * (`counterpart` false: an operator's hand-over, Minebot lane run 1, 2026-10-14, where the task waited for 「指示」 nobody could
 * give) and that has no unfinished child would wait for nothing until its time limit. The decision is told so beforehand; a wait
 * is turned away (the step continues) at most `FCA_WAIT_REFUSALS` times; a wait after that is committed with her summary and the
 * task is stopped. Nothing is said for her: the fact is data for her decision, and her summary stays her own.
 */
export function fcaWaitGate(step: TaskStep, runtime: TaskRuntime, counterpart: (() => boolean) | undefined,
  prior: Readonly<Record<string, unknown>>, answer?: FcaWaitAnswer) {
  const stored = Number(prior.fcaWaitRefusals ?? 0);
  const refusedWaits = Number.isSafeInteger(stored) && stored > 0 ? Math.min(stored, FCA_WAIT_REFUSALS) : 0;
  const unanswerable = () => {
    if (!counterpart || counterpart()) return false;
    const childIds = runtime.get(step.scopeKey, step.taskId)?.childIds ?? [];
    return !childIds.some(id => !['completed', 'failed', 'stopped'].includes(runtime.get(step.scopeKey, id)?.phase ?? 'completed'));
  };
  return {
    fact(): FcaWaitFact | undefined {
      if (!unanswerable()) return undefined;
      return answer ? { replyPossible: false, waits: 'answered' } : { replyPossible: false, refusedWaits, refusalLimit: FCA_WAIT_REFUSALS };
    },
    /** r6: `history`, the step's history: with an answer, the wait's receipt in it is replaced by the answer's line (in place). */
    apply(disposition: FcaWaitOutcome['disposition'], history?: unknown[]): FcaWaitOutcome {
      if (disposition !== 'wait' || !unanswerable()) return { disposition, refusedWaits, stop: false };
      if (answer) {
        if (history?.length) {
          let amended: unknown = null;
          try { amended = answer.amend?.(history.at(-1), answer.line()) ?? null; } catch { amended = null; }
          if (amended) history[history.length - 1] = amended;
        }
        return { disposition: 'continue', refusedWaits, stop: false, answered: true };
      }
      if (refusedWaits < FCA_WAIT_REFUSALS) return { disposition: 'continue', refusedWaits: refusedWaits + 1, stop: false };
      return { disposition, refusedWaits, stop: true };
    },
  };
}
