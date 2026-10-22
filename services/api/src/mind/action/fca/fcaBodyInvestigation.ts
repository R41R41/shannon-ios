import type { FcaBodyLifecycle } from './fcaPorts.js';
import type { FcaObservationLifecycle } from './fcaObservation.js';
import type { FcaLookahead } from './fcaLookahead.js';
import type { fcaDecisionMetrics } from './fcaDecisionMetrics.js';

/**
 * mb-llmc r4 (owner 2026-10-22, shared note r4-contract.md 2): before a body task's decision, the body's own check for a surprise since the
 * last one and its fixed probes (`FcaBodyLifecycle.investigate`, bounded in time by the body). With a surprise, what it did goes into the
 * metrics line (`probe`) and a decision asked ahead is dropped (it was asked without what the probes found). True when there was one.
 * Never throws: a failing investigation is no surprise, and the step goes on as before.
 */
export async function investigateFcaBody(ports: { body?: FcaBodyLifecycle; lookahead?: FcaLookahead }, taskId: string,
  metrics: ReturnType<typeof fcaDecisionMetrics>, signal: AbortSignal): Promise<boolean> {
  const body = ports.body;
  if (!body?.investigate) return false;
  const found = await metrics.timed('probeMs', () => body.investigate!(signal)).catch(() => null);
  if (!found) return false;
  metrics.investigated(found);
  ports.lookahead?.drop?.(taskId, 'surprise');
  return true;
}

/** Closes the body's lifecycle and the observations' (a step's monitors); the first failure is thrown after all have been closed. */
export async function closeFcaMonitors(ports: { body?: FcaBodyLifecycle; observations?: readonly FcaObservationLifecycle[] }): Promise<void> {
  const results = await Promise.allSettled([ports.body?.close(), ...(ports.observations ?? []).map(observation => observation.close())]);
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
