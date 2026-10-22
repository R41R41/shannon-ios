import { currentActionExecution, inActionExecution } from '../../../infra/context/actionExecution.js';

/**
 * A decision asked ahead runs beside the step, not as its model request: under the step's lease and permit, with its own bookkeeping, so
 * the step's model outcome, usage and metrics stay the step's (a stop during a long call is still a confirmed stop).
 */
export function isolatedModelCall<T>(work: () => Promise<T>): Promise<T> {
  const step = currentActionExecution();
  if (!step) return work();
  return inActionExecution({ lease: step.lease, signal: step.signal, permit: (resources, signal) => step.permit(resources, signal),
    ...(step.telemetry ? { telemetry: { taskId: step.telemetry.taskId, kind: 'lookahead' as const } } : {}) }, work);
}

/** The longest a summary asked beside the steps may take. */
export const DETACHED_SUMMARY_MS = 120_000;
/**
 * A history summary asked beside the step (mb-llmc r3, `prepareFcaHistory`'s `ahead`): under the step's lease and permit with its own
 * bookkeeping, as a lookahead is, but with its own signal: the step may end (and its signal with it) before the summary comes back.
 */
export function detachedModelCall<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(DETACHED_SUMMARY_MS), step = currentActionExecution();
  if (!step) return work(signal);
  return inActionExecution({ lease: step.lease, signal, permit: (resources, permitSignal) => step.permit(resources, permitSignal),
    ...(step.telemetry ? { telemetry: { taskId: step.telemetry.taskId, kind: 'summary' as const } } : {}) }, () => work(signal));
}
