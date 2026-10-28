import type { FcaBodyLifecycle, FcaModelInput, FcaModelOutput } from './fcaPorts.js';
import { noteDecisionOutcome } from '../../../infra/decisionRecords/decisionRecordNotes.js';

/**
 * mb-llmc r8 (run 32, 2026-10-22: the decision after a wither skeleton came in sight took 10.3 s; she was hit three times in 2.3 s,
 * thrown off the bridge, and the answer reached the body 0.1 s after her death): a decision being waited for is thrown away when the
 * body says a hostile she must act on has come since the request was built (`FcaBodyLifecycle.interrupt`, polled every `pollMs`), and
 * asked again at once, on the body's present state and its short urgent live state (`again`).
 *
 * - The thrown-away request is aborted (`ask`'s signal). What the model adapter does with an aborted request is its own: it books what
 *   the request cost (the real usage when it is let finish within its stop grace, else the bound of an unconfirmed request), and its
 *   answer is never read here, whenever it comes.
 * - One interrupt for a decision. The second request is the decision; a hostile that comes after it is the next step's.
 * - Without `interrupt`, or for a request with no live state, the decision is asked as it was.
 */
export const FCA_INTERRUPT = Object.freeze({ pollMs: 200 });

export async function decideInterruptibly(parts: {
  body: Pick<FcaBodyLifecycle, 'interrupt' | 'decided'> | undefined; signal: AbortSignal; request: FcaModelInput;
  /** One decision on a request (the retry policy, the metrics and the model call are the caller's), cancelled by the signal. */
  ask(request: FcaModelInput, signal: AbortSignal): Promise<FcaModelOutput>;
  /** The request for the decision asked again: the body's present state, the live state the urgent one. */
  again(request: FcaModelInput): Promise<FcaModelInput>;
  /** The decision was thrown away after `thrownMs`. */
  interrupted?(info: { thrownMs: number }): void;
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
  const thrownMs = Math.round(now() - began);
  noteDecisionOutcome('discarded', { reason: 'urgent_interrupt', thrownMs });
  controller.abort(new Error('FCA_URGENT_INTERRUPT'));
  parts.interrupted?.({ thrownMs });
  const next = await parts.again(parts.request), asked = now();
  const output = await parts.ask(next, parts.signal);
  body!.decided?.({ ms: Math.round(now() - asked), aborted: true, thrownMs });
  return output;
}
