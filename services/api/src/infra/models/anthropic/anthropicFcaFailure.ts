import Anthropic from '@anthropic-ai/sdk';
import { FcaNoResponseError } from '../../../mind/action/fca/fcaNoResponse.js';
import { FcaProviderError, retryableStatus } from '../../../mind/action/fca/fcaProviderRetry.js';
import { connectionFailedBeforeResponse, providerFailureFacts, providerServerError } from './anthropicRejection.js';

/**
 * How a dispatched FCA decision request failed, and what that means for the caller (Minebot parity audit C-20, 2026-10-19).
 * Closed facts only; provider text is never read beyond a status, a header number and a network cause code.
 */
export type DispatchFailure =
  | { kind: 'server'; status: number; retryAfterMs: number | null }
  | { kind: 'stopped' }
  | { kind: 'deadline' }
  | { kind: 'sdk_timeout' }
  | { kind: 'no_response'; possiblyBilled: boolean }
  | { kind: 'unclassified' };

/** Causes that mean the request never reached the provider: nothing can have been processed or charged. */
const NEVER_SENT_CAUSES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

export function classifyDispatchFailure(error: unknown, signals: { stopped: boolean; deadline: boolean }): DispatchFailure {
  if (signals.stopped) return { kind: 'stopped' };
  if (signals.deadline) return { kind: 'deadline' };
  if (providerServerError(error)) return { kind: 'server', status: error.status, retryAfterMs: retryAfterMilliseconds(error) };
  if (error instanceof Anthropic.APIConnectionTimeoutError) return { kind: 'sdk_timeout' };
  if (!connectionFailedBeforeResponse(error)) return { kind: 'unclassified' };
  const cause = providerFailureFacts(error).cause;
  return { kind: 'no_response', possiblyBilled: !(cause !== null && NEVER_SENT_CAUSES.has(cause)) };
}

/** Whether the provider may have processed (and charged) a request that failed this way: its unknown upper bound is then booked. */
export function failureMayHaveBeenCharged(failure: DispatchFailure): boolean {
  if (failure.kind === 'server') return false;
  return failure.kind === 'no_response' ? failure.possiblyBilled : true;
}

/**
 * The error the adapter throws for a dispatched request that failed: a typed one for a failure that carried no decision and is asked
 * again by the runner (`retryVerdict`), the closed code it always threw for a stop or an unclassified failure.
 */
export function failureError(failure: DispatchFailure): Error {
  if (failure.kind === 'server') return new FcaProviderError(failure.status, failure.retryAfterMs);
  if (failure.kind === 'deadline') return new FcaNoResponseError({ reason: 'timeout', possiblyBilled: true, message: 'FCA_MODEL_ABORTED' });
  if (failure.kind === 'sdk_timeout') return new FcaNoResponseError({ reason: 'timeout', possiblyBilled: true });
  if (failure.kind === 'no_response') return new FcaNoResponseError({ reason: 'no_response', possiblyBilled: failure.possiblyBilled });
  return new Error(failure.kind === 'stopped' ? 'FCA_MODEL_ABORTED' : 'FCA_MODEL_RESPONSE_UNKNOWN');
}

/** The error for a provider refusal (4xx): the statuses worth asking again carry `retry-after`, the others stay a plain closed code. */
export function refusalError(status: number, error: { headers?: unknown }): Error {
  return retryableStatus(status) ? new FcaProviderError(status, retryAfterMilliseconds(error)) : new Error(`FCA_MODEL_HTTP_${status}`);
}

const MAXIMUM_RETRY_AFTER_MS = 600_000;

/** `retry-after-ms` or `retry-after` (seconds, or an HTTP date) of an API error, in milliseconds, or null. */
export function retryAfterMilliseconds(error: { headers?: unknown }, now: number = Date.now()): number | null {
  const headers = error.headers as { get?: (name: string) => string | null } | Record<string, string> | undefined;
  if (!headers) return null;
  const read = (name: string): string | null => {
    if (typeof (headers as { get?: unknown }).get === 'function') return (headers as { get(name: string): string | null }).get(name);
    const value = (headers as Record<string, string>)[name];
    return typeof value === 'string' ? value : null;
  };
  const milliseconds = headerNumber(read('retry-after-ms'));
  if (milliseconds !== null) return Math.min(Math.round(milliseconds), MAXIMUM_RETRY_AFTER_MS);
  const raw = read('retry-after');
  const seconds = headerNumber(raw);
  if (seconds !== null) return Math.min(Math.round(seconds * 1000), MAXIMUM_RETRY_AFTER_MS);
  const date = raw === null ? Number.NaN : Date.parse(raw);
  return Number.isFinite(date) ? Math.min(Math.max(0, date - now), MAXIMUM_RETRY_AFTER_MS) : null;
}

/** A header's nonnegative number, or null when it is absent, empty or not one. */
function headerNumber(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
