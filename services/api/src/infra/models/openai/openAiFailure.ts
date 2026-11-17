import type { DispatchFailure } from '../anthropic/anthropicFcaFailure.js';

/** Causes that mean the request never reached the provider: nothing can have been processed or charged (as for Anthropic's `classifyDispatchFailure`). */
const NEVER_SENT_CAUSES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * How a Responses request failed without an HTTP answer (a stop, the deadline, a connection that broke). Closed facts only; a thrown
 * error's own text is never read beyond a network cause code.
 */
export function classifyOpenAiTransport(error: unknown, signals: { stopped: boolean; deadline: boolean }): DispatchFailure {
  if (signals.stopped) return { kind: 'stopped' };
  if (signals.deadline) return { kind: 'deadline' };
  const failure = error as { name?: unknown; cause?: { code?: unknown } } | null;
  const cause = typeof failure?.cause?.code === 'string' ? failure.cause.code : null;
  if (failure?.name === 'TimeoutError') return { kind: 'sdk_timeout' };
  if (error instanceof TypeError || cause !== null) return { kind: 'no_response', possiblyBilled: !(cause !== null && NEVER_SENT_CAUSES.has(cause)) };
  return { kind: 'unclassified' };
}
