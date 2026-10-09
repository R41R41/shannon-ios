import type { ActionLease } from '@shannon/mind';
import { acquireReflexControl, actualBodyStop, reflexStopRequest, returnReflexControl } from './reflexHandoff.js';
import { bindReflexCandidates, freshBodyObservation, reflexCandidateCurrent, reflexSnapshot, validReflexLimits } from './reflexCandidates.js';
import type {
  BodyActionReceipt, BodyObservation, BodyOperation, BodyStopAcknowledgement, BodyStopRequest, ReflexEndReason,
  ReflexEntryInput, ReflexEntrySelector, ReflexPorts, ReflexSessionReceipt, ReflexSessionRequest,
} from './reflexPorts.js';

const instant = (ports: ReflexPorts) => new Date(ports.now()).toISOString();
const sessionEvent = (request: ReflexSessionRequest, suffix: string) => `${request.context.sessionId}:${request.context.generation}:${suffix}`;

/** Task-owned observation monitoring may call this while its ordinary model/skill is still waiting. */
export async function evaluateReflexEntry(request: ReflexSessionRequest, input: ReflexEntryInput,
  selector: ReflexEntrySelector, ports: Pick<ReflexPorts, 'current' | 'now'>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || !await ports.current(request.context)
    || !freshBodyObservation(input.observation, request.context, ports.now(), request.limits, request.requiresImage)) return false;
  const decision = input.trigger === 'explicit' ? { sessionId: request.context.sessionId, generation: request.context.generation, decision: 'enter' }
    : await selector.evaluate(reflexSnapshot(input), signal);
  return !signal.aborted && await ports.current(request.context) && decision?.decision === 'enter'
    && decision.sessionId === request.context.sessionId && decision.generation === request.context.generation;
}

/** One bounded observation/choice/action loop. This never resumes the operation interrupted at entry. */
export async function runReflexSession(request: ReflexSessionRequest, ports: ReflexPorts, signal?: AbortSignal): Promise<ReflexSessionReceipt> {
  if (!validReflexLimits(request.limits)) throw new Error('REFLEX_LIMITS_INVALID');
  request = reflexSnapshot(request);
  const { context, limits } = request, startedAt = instant(ports), deadline = ports.now() + limits.maxDurationMs;
  const abort = new AbortController();
  let timedOut = false, existing = false, stoppedBeforeAcquisition = false, decisions = 0, latest: BodyObservation | null = null, previous: BodyObservation | undefined;
  let reason: ReflexEndReason = 'returned', lease: ActionLease | null = null, afterActionSequence: number | null = null;
  const actions: BodyActionReceipt[] = [];
  let releasePromise: Promise<BodyStopAcknowledgement | null> | null = null, releaseRequest: BodyStopRequest | null = null;
  const release = () => {
    if (!lease) return Promise.resolve(null);
    if (!releasePromise) {
      releaseRequest = reflexStopRequest(context, timedOut ? 'deadline' : abort.signal.aborted ? 'cancel' : 'return');
      releasePromise = ports.body.releaseInputs(releaseRequest, lease).catch(() => null);
    }
    return releasePromise;
  };
  const cancel = () => { abort.abort(); void release(); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; cancel(); }, limits.maxDurationMs);
  const current = async () => !abort.signal.aborted && ports.now() < deadline && await ports.current(context)
    && Boolean(lease && await ports.handoff.valid(context, lease, abort.signal));
  const interrupted = (): ReflexEndReason => timedOut || ports.now() >= deadline ? 'deadline' : abort.signal.aborted ? 'cancelled' : 'stale_generation';
  const unknownReceipt = (operation: BodyOperation): BodyActionReceipt => ({ schemaVersion: 1, operationId: operation.operationId,
    bodyId: context.bodyId, sessionId: context.sessionId, generation: context.generation, outcome: 'unknown',
    observedAt: instant(ports), inputsReleased: false, evidenceId: `${operation.operationId}:unknown` });
  try {
    const acquired = await acquireReflexControl(context, ports, abort.signal);
    existing = acquired.existing === true;
    stoppedBeforeAcquisition = acquired.stopped === true;
    lease = acquired.lease;
    if (!lease) reason = acquired.reason === 'cancelled' ? interrupted() : acquired.reason ?? 'unknown';
    else {
      if (abort.signal.aborted) void release();
      await ports.event({ id: sessionEvent(request, 'entered'), context, kind: 'entered', observedAt: instant(ports) });
      while (true) {
        if (!await current()) { reason = interrupted(); break; }
        const observation = await ports.body.observe(context, abort.signal);
        if (observation?.bodyId === context.bodyId) latest = reflexSnapshot(observation);
        if (!freshBodyObservation(observation, context, ports.now(), limits, request.requiresImage)
          || (afterActionSequence !== null && observation.sequence <= afterActionSequence)) { reason = 'observation_unavailable'; break; }
        afterActionSequence = null;
        const terminal = ports.body.termination?.(context, observation, actions.slice(-8));
        if (terminal) {
          reason = terminal.reason === 'completed' && !terminal.evidenceIds.length ? 'unknown' : terminal.reason; break;
        }
        if (decisions >= limits.maxDecisions) { reason = 'decision_limit'; break; }
        if (actions.length >= limits.maxActions) { reason = 'action_limit'; break; }
        const drafts = ports.body.candidates(context, observation);
        if (!drafts.length) { reason = 'no_candidates'; break; }
        const candidates = bindReflexCandidates(context, observation, drafts, ports.now(), limits);
        if (!await current()) { reason = interrupted(); break; }
        decisions += 1;
        const choice = await ports.selector.choose(reflexSnapshot({ context, observation, candidates, recent: actions.slice(-8),
          ...(previous ? { previousObservation: previous } : {}) }), abort.signal);
        if (!await current()) { reason = interrupted(); break; }
        if (!choice || choice.sessionId !== context.sessionId || choice.generation !== context.generation) { reason = 'stale_generation'; break; }
        const candidate = candidates.find(item => item.id === choice.candidateId);
        if (!candidate) { reason = 'no_candidates'; break; }
        if (candidate.kind === 'return' || candidate.kind === 'stop') { reason = candidate.kind === 'stop' ? 'stopped' : 'returned'; break; }
        previous = reflexSnapshot(observation);
        if (candidate.kind === 'observe') continue;
        const fresh = await ports.body.observe(context, abort.signal);
        if (fresh?.bodyId === context.bodyId) latest = reflexSnapshot(fresh);
        if (!freshBodyObservation(fresh, context, ports.now(), limits, request.requiresImage)) { reason = 'observation_unavailable'; break; }
        // Only the candidate's relevant conditions must stay true. A newer unrelated observation is allowed.
        if (!reflexCandidateCurrent(candidate, context, fresh, ports.now(), limits) || !ports.body.validate(context, candidate, fresh)) continue;
        if (!await current()) { reason = interrupted(); break; }
        const operation: BodyOperation = { schemaVersion: 1, operationId: sessionEvent(request, `operation:${actions.length + 1}`),
          context, candidate, observationSequence: fresh.sequence,
          deadlineAt: new Date(Math.min(deadline, ports.now() + candidate.maxDurationMs)).toISOString() };
        let outcome: BodyActionReceipt;
        const operationTimer = setTimeout(() => { timedOut = true; cancel(); }, candidate.maxDurationMs);
        try {
          const answer = await ports.body.execute(reflexSnapshot(operation), lease, abort.signal);
          outcome = answer.operationId === operation.operationId && answer.bodyId === context.bodyId
            && answer.sessionId === context.sessionId && answer.generation === context.generation
            && ['completed', 'failed', 'cancelled', 'unknown'].includes(answer.outcome) && Boolean(answer.evidenceId)
            && Number.isFinite(Date.parse(answer.observedAt)) ? reflexSnapshot(answer) : unknownReceipt(operation);
        } catch { outcome = unknownReceipt(operation); }
        finally { clearTimeout(operationTimer); }
        actions.push(outcome);
        if (outcome.observation?.bodyId === context.bodyId) latest = reflexSnapshot(outcome.observation);
        await ports.event({ id: sessionEvent(request, `action:${actions.length}`), context, kind: 'action', observedAt: outcome.observedAt,
          operationId: outcome.operationId, evidenceId: outcome.evidenceId, outcome: outcome.outcome });
        if (outcome.outcome === 'unknown' || !outcome.inputsReleased) { reason = 'unknown'; break; }
        if (outcome.outcome === 'cancelled') { reason = abort.signal.aborted ? interrupted() : 'cancelled'; break; }
        afterActionSequence = fresh.sequence;
      }
    }
  } catch { reason = !lease || actions.some(action => action.outcome === 'unknown') ? 'unknown' : abort.signal.aborted ? interrupted() : 'failed'; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }

  if (lease) {
    const stopped = await release();
    // Latest state is returned for a new FCA decision; the old physical operation is never restarted.
    if (actualBodyStop(releaseRequest!, stopped)) {
      const cleanup = new AbortController(), cleanupTimer = setTimeout(() => cleanup.abort(), Math.min(2_000, limits.maxStateAgeMs));
      try {
        const observation = await ports.body.observe(context, cleanup.signal);
        if (observation?.bodyId === context.bodyId && (!latest || observation.sequence >= latest.sequence)) latest = reflexSnapshot(observation);
      } catch { /* Retain the last timestamped observation; no observation is invented. */ }
      finally { clearTimeout(cleanupTimer); }
    }
  }
  let receipt: ReflexSessionReceipt = { schemaVersion: 1, eventId: sessionEvent(request, 'returned'), context, reason,
    control: reason === 'unknown' ? 'held' : 'not_acquired', startedAt, endedAt: instant(ports), decisions, actions, latestObservation: latest };
  if (lease) receipt = await returnReflexControl(ports, lease, receipt, releasePromise!, releaseRequest!);
  else if (stoppedBeforeAcquisition) {
    const request = reflexStopRequest(context, timedOut ? 'deadline' : abort.signal.aborted ? 'cancel' : 'return');
    try { receipt = await ports.handoff.returnStopped(request, receipt); }
    catch { receipt = { ...receipt, reason: 'unknown', control: 'held' }; }
  }
  if (!existing) await ports.event({ id: receipt.eventId, context, kind: 'returned', observedAt: receipt.endedAt, reason: receipt.reason });
  return reflexSnapshot(receipt);
}

/** In-process request coalescing only; every physical write still needs the existing lease authority. */
export function createReflexController(ports: ReflexPorts) {
  const pending = new Map<string, { request: ReflexSessionRequest; abort: AbortController; done: Promise<ReflexSessionReceipt | null> }>();
  const key = (request: ReflexSessionRequest) => JSON.stringify([request.context.scopeKey, request.context.bodyId]);
  const start = (request: ReflexSessionRequest, work: (signal: AbortSignal) => Promise<ReflexSessionReceipt | null>, signal?: AbortSignal) => {
    const id = key(request); if (pending.has(id)) return Promise.resolve(null);
    const abort = new AbortController(), cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    const done = Promise.resolve().then(() => work(abort.signal)).finally(() => { pending.delete(id); signal?.removeEventListener('abort', cancel); });
    pending.set(id, { request, abort, done }); return done;
  };
  return {
    run: (request: ReflexSessionRequest, signal?: AbortSignal) => start(request, inner => runReflexSession(request, ports, inner), signal),
    monitor: (request: ReflexSessionRequest, input: ReflexEntryInput, entry: ReflexEntrySelector, signal?: AbortSignal) =>
      start(request, async inner => await evaluateReflexEntry(request, input, entry, ports, inner) ? runReflexSession(request, ports, inner) : null, signal),
    cancel(scopeKey: string, bodyId: string) { pending.get(JSON.stringify([scopeKey, bodyId]))?.abort.abort(); },
    async close() { const all = [...pending.values()]; all.forEach(item => item.abort.abort()); await Promise.allSettled(all.map(item => item.done)); },
  };
}
