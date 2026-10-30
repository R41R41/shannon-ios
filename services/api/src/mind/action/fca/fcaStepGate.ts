import type { FcaStepPorts } from './fcaStepPorts.js';
import type { TaskStep } from '../taskRuntime/taskRuntimePorts.js';
import { observeAsync } from '../../../infra/observer/observerContext.js';
import { fcaDecisionMetrics } from './fcaDecisionMetrics.js';
import { permitDue } from './fcaStepCost.js';
/** ステップの許可確認と再利用窓。元の照合順序とキャッシュを保持する。 */
export function createFcaStepGate(
  step: TaskStep,
  ports: FcaStepPorts,
  signal: AbortSignal,
  metrics: ReturnType<typeof fcaDecisionMetrics>,
  runtime: FcaStepPorts['runtime'],
  maintenance: boolean,
  ownTime: boolean,
) {
  /** Why the step may not go on now, as a closed reason, or null. */
  const heldReason = (): 'owner_not_alone' | 'execution_disallowed' | null => {
    if (maintenance || ownTime) return ports.executionAllowed?.() === true ? null : 'execution_disallowed';
    if (!(ports.audienceAllowed?.() ?? ports.ownerAlone())) return 'owner_not_alone';
    return (ports.executionAllowed?.() ?? true) ? null : 'execution_disallowed';
  };

  // Minecraft run 8 (2026-10-14): a step was held right after a compaction and nothing said which check held it. Content-free.
  const held = (reason: string) => {
    console.warn(`Shannon FCA execution held task=${step.taskId} reason=${reason}`);
    return new Error('FCA_EXECUTION_HELD');
  };

  // Minecraft run 18: the lease was asked of the mind at every check, about ten a decision at about 0.12 s each
  // (1.27 s a decision).
  // Now `fresh` asks it just before an outside call that needs it (the summarizer, the model, a retry, a tool that does not ask it
  // itself); `reuse` (between steps of the decision's own preparation) asks only when the last grant is
  // `FCA_PERMIT_REUSE_MS` old, so a
  // selector or a recall that took longer is followed by an ask; `local` asks nothing where the next outside call
  // asks for itself (a
  // body tool, the completion's verification) or the commit checks the lease in its own transaction. The local checks (who is
  // present, the sources, the task's phase, a stop) run at every check, and once more after an ask (the event loop ran meanwhile);
  // with no ask nothing ran between, so they are not repeated (each sources check can walk the task's provenance: run 18 named 323
  // walks of 100 ms or more, 73 s in all).
  let permittedAt = Number.NEGATIVE_INFINITY;

  const local = () => {
    signal.throwIfAborted();
    const reason = heldReason();
    if (reason) throw held(reason);
    if (ports.sourcesVisible && !ports.sourcesVisible()) throw new Error('FCA_SOURCE_WITHHELD');
  };

  const checked = (mode: 'fresh' | 'reuse' | 'local' = 'reuse') =>
    metrics.timed('permitMs', () =>
      observeAsync(
        'gate',
        { phase: 'step_permit' },
        async () => {
          local();
          if (permitDue(mode, performance.now() - permittedAt, ports.permitWindowMs)) {
            metrics.asked();
            if (!(await ports.permit())) throw held('permit_denied');
            permittedAt = performance.now();
            local();
          }
          if (runtime.get(step.scopeKey, step.taskId)?.phase !== 'executing') throw new Error('FCA_TASK_STOPPING');
        },
        () => ({ allowed: true }),
      ),
    );
  return { heldReason, held, local, checked };
}
