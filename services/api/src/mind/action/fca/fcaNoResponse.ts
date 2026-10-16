import type { FcaModelOutput } from './fcaPorts.js';

/**
 * A decision request that failed on the wire before any byte of an answer came back (connection refused, reset or timed out; Minebot
 * runs 12 and 13, 2026-10-16/17: APIConnectionError / ETIMEDOUT left the step unknown for three minutes and failed the task).
 *
 * No answer means no decision was parsed, so nothing was executed and nothing can be applied twice; only the first request's spend is
 * in doubt (the adapter has already recorded it as an unknown upper bound). Its message stays `FCA_MODEL_RESPONSE_UNKNOWN`, so a caller
 * that does not retry sees exactly what it saw before.
 */
export class FcaNoResponseError extends Error {
  readonly beforeResponse = true;
  constructor() {
    super('FCA_MODEL_RESPONSE_UNKNOWN');
    this.name = 'FcaNoResponseError';
  }
}

/** 2-5 s: one short wait with jitter before a decision that got no answer is asked once more. */
export const FCA_NO_RESPONSE_RETRY_DELAY = () => 2_000 + Math.floor(Math.random() * 3_000);

/**
 * THE ONE BOUNDED RETRY (the "no hidden resend" rule stays: this is visible, logged, and happens at most once per decision, only after
 * `FcaNoResponseError`). After the wait the caller's own gate (`recheck`: audience, sources, lease permit) runs again, exactly as it ran
 * before the first request, and the same input is sent. A stop during the wait, a failed recheck, or a second failure of any kind
 * ends as it did before this retry existed. The body monitor lives on throughout: the step is still in flight under its own lease.
 */
export async function decideWithOneRetry(attempt: () => Promise<FcaModelOutput>, parts: {
  signal: AbortSignal; recheck(): Promise<void>; delay?(): number; log?(line: string): void;
}): Promise<FcaModelOutput> {
  try { return await attempt(); } catch (error) {
    if (!(error instanceof FcaNoResponseError) || parts.signal.aborted) throw error;
    const waited = await new Promise<boolean>(resolve => {
      const stop = () => {
        clearTimeout(timer);
        resolve(false);
      };
      const timer = setTimeout(() => {
        parts.signal.removeEventListener('abort', stop);
        resolve(true);
      }, parts.delay?.() ?? FCA_NO_RESPONSE_RETRY_DELAY());
      timer.unref?.();
      parts.signal.addEventListener('abort', stop, { once: true });
    });
    if (!waited) throw new Error('FCA_MODEL_ABORTED');
    await parts.recheck();
    parts.log?.('Shannon FCA decision retried after no response');
    return attempt();
  }
}
