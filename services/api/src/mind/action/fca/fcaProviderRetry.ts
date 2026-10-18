import { FcaNoResponseError } from './fcaNoResponse.js';
import type { FcaModelOutput } from './fcaPorts.js';

/**
 * The retry policy of one FCA decision (Minebot parity audit C-20, 2026-10-19). A provider that answered 429, 408, 409, 5xx or 529,
 * or a request that got no answer (reset, timed out), produced no decision: nothing was executed, so the same request is asked again,
 * visibly, a bounded number of times with exponential backoff and jitter, and the provider's `retry-after` is honoured. The history
 * is never touched by a failed attempt: only a complete answer adds a round, so a retry cannot duplicate one.
 */
export interface FcaRetryPolicy {
  /** Requests for one decision, the first included. */
  maxAttempts: number;
  /** No attempt starts after this long since the first one began (the wait that would pass it is not taken). */
  maxElapsedMs: number;
  baseMs: number;
  capMs: number;
  /** The longest `retry-after` that is waited for; a longer one ends the retries (the step-level cooldown takes over). */
  maxRetryAfterMs: number;
  /** Failures after which the provider may have charged the request (a timeout, a reset): more of them end the retries. */
  maxPossiblyBilled: number;
}
export const FCA_RETRY_POLICY: FcaRetryPolicy = Object.freeze({
  maxAttempts: 5, maxElapsedMs: 120_000, baseMs: 2_000, capMs: 30_000, maxRetryAfterMs: 60_000, maxPossiblyBilled: 2,
});

/** The statuses that carry no decision and may pass: request timeout, conflict, throttling, and every server error. */
export const retryableStatus = (status: number): boolean => status === 408 || status === 409 || status === 429 || (status >= 500 && status < 600);

/** A provider answer worth asking again. The message stays `FCA_MODEL_HTTP_<status>`, so every closed-code check sees what it saw. */
export class FcaProviderError extends Error {
  readonly retryAfterMs: number | null;
  constructor(readonly status: number, retryAfterMs: number | null = null) {
    super(`FCA_MODEL_HTTP_${status}`);
    this.name = 'FcaProviderError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The retries ended without a decision. Nothing was executed (the step ran no tool), so the step may run again from a fresh
 * observation; the closed code is the last failure's (`FCA_MODEL_HTTP_503`, `FCA_MODEL_RESPONSE_UNKNOWN`, ...).
 */
export class FcaDecisionUnavailableError extends Error {
  constructor(code: string, readonly reason: string, readonly attempts: number, readonly possiblyBilled: boolean) {
    super(code);
    this.name = 'FcaDecisionUnavailableError';
  }
}

export interface RetryVerdict { reason: string; possiblyBilled: boolean; retryAfterMs: number | null }

/** Whether a failed attempt may be asked again, and why (a closed reason for the log). */
export function retryVerdict(error: unknown): RetryVerdict | null {
  if (error instanceof FcaProviderError) {
    return retryableStatus(error.status) ? { reason: `http_${error.status}`, possiblyBilled: false, retryAfterMs: error.retryAfterMs } : null;
  }
  if (error instanceof FcaNoResponseError) return { reason: error.reason, possiblyBilled: error.possiblyBilled, retryAfterMs: null };
  return null;
}

/** The wait before attempt `failed + 1`: exponential from `baseMs` to `capMs`, jittered by +-25%, never shorter than `retry-after`. */
export function retryWaitMs(failed: number, retryAfterMs: number | null, policy: FcaRetryPolicy = FCA_RETRY_POLICY,
  random: () => number = Math.random): number {
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** (failed - 1));
  const jittered = Math.round(ceiling * (0.75 + random() * 0.5));
  return retryAfterMs === null ? jittered : Math.max(jittered, Math.min(retryAfterMs, policy.maxRetryAfterMs));
}

export interface FcaRetryParts {
  signal: AbortSignal;
  /** The caller's own gate (audience, sources, lease permit), run again before every further request exactly as before the first. */
  recheck(): Promise<void>;
  /** The wait to take instead of the suggested one (tests: 0); `suggestedMs` already honours `retry-after`. */
  delay?(suggestedMs: number, failed: number): number;
  /** False ends the retries: the task's budget has no room for another request that may be charged. */
  afford?(): boolean;
  /** A failed attempt that carried no decision: its outcome is known (nothing to apply), its spend is recorded by the adapter. */
  failed?(verdict: RetryVerdict): void;
  log?(line: string): void;
  policy?: FcaRetryPolicy;
  now?(): number;
  random?(): number;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const stop = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve(true);
    }, milliseconds);
    timer.unref?.();
    signal.addEventListener('abort', stop, { once: true });
  });
}

/** Whether another attempt may follow failure number `failed`, and after how long; null ends the retries. */
function nextWait(verdict: RetryVerdict, state: { failed: number; billed: number; elapsed: number }, parts: FcaRetryParts): number | null {
  const policy = parts.policy ?? FCA_RETRY_POLICY;
  if (state.failed >= policy.maxAttempts || state.billed > policy.maxPossiblyBilled) return null;
  if (verdict.retryAfterMs !== null && verdict.retryAfterMs > policy.maxRetryAfterMs) return null;
  if (parts.afford && !parts.afford()) return null;
  const suggested = retryWaitMs(state.failed, verdict.retryAfterMs, policy, parts.random);
  const taken = parts.delay ? parts.delay(suggested, state.failed) : suggested;
  return state.elapsed + taken > policy.maxElapsedMs ? null : taken;
}

/**
 * Asks for one decision, again after a failure that carried none (`retryVerdict`). Every other failure, and a stop, passes through
 * unchanged. When the attempts or the time run out it throws `FcaDecisionUnavailableError` with the last failure's closed code.
 */
export async function decideWithRetry(attempt: () => Promise<FcaModelOutput>, parts: FcaRetryParts): Promise<FcaModelOutput> {
  const policy = parts.policy ?? FCA_RETRY_POLICY, now = parts.now ?? Date.now, started = now();
  const state = { failed: 0, billed: 0, elapsed: 0 };
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      const verdict = retryVerdict(error);
      if (!verdict || parts.signal.aborted) throw error;
      state.failed += 1;
      state.billed += verdict.possiblyBilled ? 1 : 0;
      state.elapsed = now() - started;
      parts.failed?.(verdict);
      const taken = nextWait(verdict, state, parts);
      if (taken === null) {
        parts.log?.(`Shannon FCA decision unavailable reason=${verdict.reason} attempts=${state.failed}`);
        throw new FcaDecisionUnavailableError((error as Error).message, verdict.reason, state.failed, state.billed > 0);
      }
      parts.log?.(`Shannon FCA decision retry reason=${verdict.reason} attempt=${state.failed + 1}/${policy.maxAttempts} waitMs=${taken}`);
      if (!await wait(taken, parts.signal)) throw new Error('FCA_MODEL_ABORTED');
      await parts.recheck();
    }
  }
}
