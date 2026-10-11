import Anthropic from '@anthropic-ai/sdk';
import { setTimeout as wait } from 'node:timers/promises';

export const TRANSIENT_RETRY = Object.freeze({ defaultWaitMs: 1_000, maximumWaitMs: 3_000 });

/**
 * A provider refusal that says "try again shortly" and proves nothing ran: 429, 529, any 5xx, or an overloaded/api error
 * delivered before the response began. Connection failures and aborts are not included: whether such a request was
 * processed is unknown, and an unknown paid call is never retried.
 */
export function transientProviderFailure(error: unknown): string | null {
  if (!(error instanceof Anthropic.APIError) || error instanceof Anthropic.APIConnectionError || error instanceof Anthropic.APIUserAbortError) return null;
  const status = error.status;
  if (status === 429 || status === 529 || (status !== undefined && status >= 500 && status < 600)) return String(status);
  if (status === undefined && (error.type === 'overloaded_error' || error.type === 'api_error')) return error.type;
  return null;
}

/** The provider's `retry-after-ms` / `retry-after` (seconds or a date), else one second; never more than three seconds. */
export function transientRetryWaitMs(error: unknown, now = Date.now()): number {
  const headers = error instanceof Anthropic.APIError ? error.headers : undefined;
  const raw = headers?.get('retry-after-ms');
  let wait = raw ? Number(raw) : Number.NaN;
  const after = headers?.get('retry-after');
  if (Number.isNaN(wait) && after) {
    const seconds = Number(after);
    wait = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(after) - now;
  }
  if (!Number.isFinite(wait)) wait = TRANSIENT_RETRY.defaultWaitMs;
  return Math.min(TRANSIENT_RETRY.maximumWaitMs, Math.max(0, wait));
}

export function defaultRetryWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return wait(milliseconds, undefined, signal ? { signal } : {});
}
