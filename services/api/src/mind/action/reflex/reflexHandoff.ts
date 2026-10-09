import type { ActionLease } from '@shannon/mind';
import type { BodyStopAcknowledgement, BodyStopRequest, BodyTaskContext, ReflexPorts, ReflexSessionReceipt } from './reflexPorts.js';

/** Only an adapter with durable proof that no stop command was inserted may use this result. */
export class ReflexHandoffNotSent extends Error { constructor() { super('REFLEX_HANDOFF_NOT_SENT'); } }

export const reflexStopRequest = (context: BodyTaskContext, reason: BodyStopRequest['reason']): BodyStopRequest => ({
  context, reason, requestId: `${context.sessionId}:${context.generation}:${reason === 'handoff' ? 'handoff' : 'release'}`,
});
export function actualBodyStop(request: BodyStopRequest, acknowledgement: BodyStopAcknowledgement | null): boolean {
  return Boolean(acknowledgement && acknowledgement.state === 'stopped' && acknowledgement.inputsReleased
    && acknowledgement.bodyId === request.context.bodyId && acknowledgement.sessionId === request.context.sessionId
    && acknowledgement.generation === request.context.generation && acknowledgement.requestId === request.requestId
    && Number.isFinite(Date.parse(acknowledgement.observedAt)));
}
export async function acquireReflexControl(context: BodyTaskContext, ports: ReflexPorts, signal: AbortSignal): Promise<
  { lease: ActionLease; reason?: never; existing?: never; stopped?: never } | { lease: null; existing?: boolean; stopped?: true; reason: 'duplicate' | 'unknown' | 'cancelled' | 'stale_generation' | 'handoff_denied' }> {
  const existing = await ports.handoff.inspect(context);
  if (existing !== 'new') return { lease: null, reason: existing, existing: true };
  if (signal.aborted) return { lease: null, reason: 'cancelled' };
  if (!await ports.current(context)) return { lease: null, reason: 'stale_generation' };
  if (ports.handoff.prepare && !await ports.handoff.prepare(context, signal)) return { lease: null, reason: signal.aborted ? 'cancelled' : 'handoff_denied' };
  if (signal.aborted) return { lease: null, reason: 'cancelled' };
  const request = reflexStopRequest(context, 'handoff');
  let stopped: BodyStopAcknowledgement | null;
  try { stopped = await ports.handoff.stopNormal(request, signal); }
  catch (error) {
    if (error instanceof ReflexHandoffNotSent) return { lease: null, reason: signal.aborted ? 'cancelled' : 'handoff_denied' };
    stopped = null;
  }
  if (!actualBodyStop(request, stopped)) return { lease: null, reason: 'unknown' };
  // The normal executor has now released its inputs, and its native session may already be bound.
  // Preserve that fact even if permission/current checks throw or acquisition cannot proceed.
  try {
    if (signal.aborted) return { lease: null, reason: 'cancelled', stopped: true };
    if (!await ports.current(context)) return { lease: null, reason: 'stale_generation', stopped: true };
    const lease = await ports.handoff.acquire(context, stopped!, signal);
    return lease ? { lease } : { lease: null, reason: 'handoff_denied', stopped: true };
  } catch { return { lease: null, reason: 'unknown', stopped: true }; }
}

/** A real input-release ACK is necessary even when a command was cancelled locally or the lease expired. */
export async function returnReflexControl(ports: ReflexPorts, lease: ActionLease, receipt: ReflexSessionReceipt,
  release: Promise<BodyStopAcknowledgement | null>, request: BodyStopRequest): Promise<ReflexSessionReceipt> {
  const stopped = await release.catch(() => null);
  const unknown = receipt.reason === 'unknown' || receipt.actions.some(action => action.outcome === 'unknown' || !action.inputsReleased)
    || !actualBodyStop(request, stopped);
  const result: ReflexSessionReceipt = { ...receipt, ...(unknown ? { reason: 'unknown' as const } : {}), control: unknown ? 'held' : 'returned' };
  try { await ports.handoff.finish(lease, result); }
  catch { return { ...result, reason: 'unknown', control: 'held' }; }
  return result;
}
