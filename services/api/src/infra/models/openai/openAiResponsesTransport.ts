import { retryAfterMilliseconds } from '../anthropic/anthropicFcaFailure.js';

export const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';

/** The provider answered with a status other than 2xx. Content-free: the status, the provider's error `code` and `type` (closed words), `retry-after`. */
export class OpenAiHttpError extends Error {
  constructor(readonly status: number, readonly code: string | null, readonly type: string | null, readonly retryAfterMs: number | null) {
    super(`OPENAI_HTTP_${status}`);
    this.name = 'OpenAiHttpError';
  }
}

/** A refusal for the account's credit (`insufficient_quota`, `credit_balance_exhausted`, a hard limit): nothing is wrong with the request. */
const BILLING_CODES: ReadonlySet<string> = new Set(['insufficient_quota', 'credit_balance_exhausted', 'billing_hard_limit_reached', 'billing_not_active']);
export function billingRefusal(code: string | null | undefined, type?: string | null): boolean {
  return (code !== null && code !== undefined && BILLING_CODES.has(code)) || (type !== null && type !== undefined && BILLING_CODES.has(type));
}

const word = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/u.test(value) ? value : null;

/** One POST of the Responses API. A status other than 2xx throws `OpenAiHttpError`; a network failure throws what `fetch` threw. */
export async function postResponses(call: { apiKey: string; body: unknown; signal: AbortSignal; fetcher?: typeof fetch; endpoint?: string }): Promise<unknown> {
  const response = await (call.fetcher ?? fetch)(call.endpoint ?? OPENAI_RESPONSES_ENDPOINT, {
    method: 'POST', signal: call.signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${call.apiKey}` },
    body: JSON.stringify(call.body),
  });
  if (!response.ok) {
    let error: Record<string, unknown> = {};
    try {
      const parsed = await response.json() as { error?: unknown };
      if (parsed.error && typeof parsed.error === 'object') error = parsed.error as Record<string, unknown>;
    } catch { /* the status alone says it */ }
    throw new OpenAiHttpError(response.status, word(error.code), word(error.type), retryAfterMilliseconds(response));
  }
  return response.json() as Promise<unknown>;
}
