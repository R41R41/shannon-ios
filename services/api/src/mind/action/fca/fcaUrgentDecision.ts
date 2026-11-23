import type { FcaBodyLifecycle, FcaModelInput, FcaModelOutput } from './fcaPorts.js';
import type { MadeIn } from '../../../contracts/continueContract.js';
import { noteDecisionOutcome } from '../../../infra/decisionRecords/decisionRecordNotes.js';

/**
 * mb-llmc r8 (run 32, 2026-10-22: the decision after a wither skeleton came in sight took 10.3 s; she was hit three times in 2.3 s,
 * thrown off the bridge, and the answer reached the body 0.1 s after her death): a decision being waited for is thrown away when the
 * body says a hostile she must act on has come since the request was built (`FcaBodyLifecycle.interrupt`, polled every `pollMs`), and
 * asked again at once, on the body's present state and its short urgent live state (`again`).
 *
 * - 11/24 (the night deaths of 11/23: in 10 of 11 interrupts the answer thrown away came back before the second one, by 1.3 to 3.6 s, and the
 *   second was waited for from its start, so 8 of 31 decisions reached the body): the first request is no longer aborted when the second is
 *   asked. They run side by side and the first to come back that the caller says can be used (`usable`: not drifted from the frame it was made on,
 *   and not held at the first hand by the guards before send) is the decision; the other is aborted. The second is used as before when it comes
 *   back first, or when the first cannot be used. The reason of 10/22 stands: an answer that has not seen the hostile and is held at once, or that
 *   follows a life that is gone, is never used.
 * - The request that loses is aborted (`ask`'s signal). What the model adapter does with an aborted request is its own: it books what
 *   the request cost (the real usage when it is let finish within its stop grace, else the bound of an unconfirmed request), and its
 *   answer is never read here, whenever it comes.
 * - One interrupt for a decision. The second request is the decision; a hostile that comes after it is the next step's.
 * - Without `interrupt`, or for a request with no live state, the decision is asked as it was.
 */
/**
 * `keepMs`: the first request's answer is kept only when it comes back within this long of the interrupt (the 11 interrupts of 11/23 came back in
 * 1.3 to 3.6 s; run 32's answer of 10/22 came 10 s late).
 */
export const FCA_INTERRUPT = Object.freeze({ pollMs: 200, keepMs: 4_000 });

/**
 * Whether the first request's answer, come back after an interrupt, is the decision: it is tools, it follows the frame it was made on (checked against
 * the frame `read` named when it was asked, since the request asked again moves it), and an act of it can go to the body (`FcaBodyLifecycle.reaches`).
 */
export const keptFirst = (body: Pick<FcaBodyLifecycle, 'drifted' | 'reaches'> | undefined, read: MadeIn | null) => (output: FcaModelOutput): boolean =>
  output.decision.kind === 'tools' && !(read && body?.drifted?.(read)) && body?.reaches?.(output.decision.calls) === true;

export async function decideInterruptibly(parts: {
  body: Pick<FcaBodyLifecycle, 'interrupt' | 'decided'> | undefined; signal: AbortSignal; request: FcaModelInput;
  /** One decision on a request (the retry policy, the metrics and the model call are the caller's), cancelled by the signal. */
  ask(request: FcaModelInput, signal: AbortSignal): Promise<FcaModelOutput>;
  /** The request for the decision asked again: the body's present state, the live state the urgent one. */
  again(request: FcaModelInput): Promise<FcaModelInput>;
  /** The decision was thrown away after `thrownMs`. */
  interrupted?(info: { thrownMs: number }): void;
  /** Whether the first request's answer, come back after the interrupt, can be used as the decision (see above). Absent: it cannot. */
  usable?(output: FcaModelOutput): boolean;
  now?: () => number; pollMs?: number;
}): Promise<FcaModelOutput> {
  const { body } = parts, now = parts.now ?? (() => performance.now());
  const watched = typeof body?.interrupt === 'function' && parts.request.transient !== undefined;
  const began = now();
  if (!watched) {
    const output = await parts.ask(parts.request, parts.signal);
    body?.decided?.({ ms: Math.round(now() - began), aborted: false, thrownMs: 0 });
    return output;
  }
  const controller = new AbortController(), signal = AbortSignal.any([parts.signal, controller.signal]);
  const first = parts.ask(parts.request, signal).then(output => ({ output }), (error: unknown) => ({ error }));
  let timer: ReturnType<typeof setInterval> | undefined;
  const fired = new Promise<'interrupt'>(resolve => {
    timer = setInterval(() => {
      let reason: string | null = null;
      try { reason = body!.interrupt!(); } catch { reason = null; }
      if (reason && !parts.signal.aborted) resolve('interrupt');
    }, parts.pollMs ?? FCA_INTERRUPT.pollMs);
    timer.unref?.();
  });
  const winner = await Promise.race([first, fired]);
  clearInterval(timer);
  if (winner !== 'interrupt') {
    if ('error' in winner) throw winner.error;
    body!.decided?.({ ms: Math.round(now() - began), aborted: false, thrownMs: 0 });
    return winner.output;
  }
  const thrownMs = Math.round(now() - began), interruptedAt = now();
  const parallel = new AbortController(), parallelSignal = AbortSignal.any([parts.signal, parallel.signal]);
  let asked = now();
  const again = parts.again(parts.request).then(next => {
    parallelSignal.throwIfAborted();
    asked = now();
    return parts.ask(next, parallelSignal);
  }).then(output => ({ output }), (error: unknown) => ({ error }));
  const firstTagged = first.then(result => ({ which: 'first' as const, result }));
  const againTagged = again.then(result => ({ which: 'again' as const, result }));
  const early = await Promise.race([firstTagged, againTagged]);
  const inTime = now() - interruptedAt <= FCA_INTERRUPT.keepMs;
  if (early.which === 'first' && 'output' in early.result && inTime && parts.usable?.(early.result.output) === true) {
    parallel.abort(new Error('FCA_URGENT_FIRST_KEPT'));
    body!.decided?.({ ms: Math.round(now() - began), aborted: false, thrownMs: 0 });
    return early.result.output;
  }
  noteDecisionOutcome('discarded', { reason: 'urgent_interrupt', thrownMs });
  controller.abort(new Error('FCA_URGENT_INTERRUPT'));
  parts.interrupted?.({ thrownMs });
  const second = await again;
  if ('error' in second) throw second.error;
  body!.decided?.({ ms: Math.round(now() - asked), aborted: true, thrownMs });
  return second.output;
}
