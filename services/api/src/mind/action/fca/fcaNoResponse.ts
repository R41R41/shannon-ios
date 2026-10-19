/**
 * A decision request that failed on the wire before any byte of an answer came back (connection refused, reset or timed out; Minebot
 * runs 12 and 13, 2026-10-16/17: APIConnectionError / ETIMEDOUT left the step unknown for three minutes and failed the task), or that
 * ran into this process's own deadline.
 *
 * No answer means no decision was parsed, so nothing was executed and nothing can be applied twice; only the request's spend is in
 * doubt (`possiblyBilled`: the adapter has already recorded it as an unknown upper bound, sized by the request, when the provider may
 * have processed it). Its message stays `FCA_MODEL_RESPONSE_UNKNOWN` (`FCA_MODEL_ABORTED` for our own deadline), so a caller that does
 * not retry sees exactly what it saw before. The retry itself is `decideWithRetry` (`fcaProviderRetry.ts`).
 */
export type FcaNoResponseReason = 'no_response' | 'timeout';

export class FcaNoResponseError extends Error {
  readonly beforeResponse = true;
  readonly reason: FcaNoResponseReason;
  /** The provider may have processed (and charged) the request: a timeout, or a connection lost after the send. */
  readonly possiblyBilled: boolean;
  constructor(options: { reason?: FcaNoResponseReason; possiblyBilled?: boolean; message?: string } = {}) {
    super(options.message ?? 'FCA_MODEL_RESPONSE_UNKNOWN');
    this.name = 'FcaNoResponseError';
    this.reason = options.reason ?? 'no_response';
    this.possiblyBilled = options.possiblyBilled ?? true;
  }
}

/** 2-5 s: one short wait with jitter before a decision that got no answer is asked once more. Kept for callers of the old single retry. */
export const FCA_NO_RESPONSE_RETRY_DELAY = () => 2_000 + Math.floor(Math.random() * 3_000);
