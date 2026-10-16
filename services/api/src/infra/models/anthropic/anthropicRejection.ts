import Anthropic from '@anthropic-ai/sdk';
import { switchOn } from '@shannon/switches';
import { serverEnvironment } from '../../config/serverEnvironment.js';
import { strictRequestUsage } from './anthropicToolCapacity.js';

/**
 * The provider's 4xx refusals of a request (Syzygy ADR-0009 stage 1, quick fix 2, in its canary form).
 *
 * Every 4xx is counted and logged by status, the provider's error type, a closed message class and whether the request carried
 * tools or schemas. Which 4xx earns the one tool-less answer depends on `SHANNON_ANTHROPIC_STRICT_REJECTIONS`:
 * - off (default, as before): any 4xx except 401, 403, 408, 409 and 429;
 * - on: only a 400 whose message names the offered tools or schemas (an offer refusal below).
 * The switch is flipped once the counts in `GET /v1/ops` show which 400s really occur. Provider text is read only to classify;
 * it is never stored, logged or returned.
 */
export type OfferRefusal = 'strict_grammar_capacity' | 'strict_tool_capacity' | 'tool_schema_invalid' | 'inline_tools_unsupported';

const OFFER_PATTERNS: ReadonlyArray<readonly [OfferRefusal, RegExp]> = [
  ['strict_grammar_capacity', /compiled grammar is too large/iu],
  ['strict_tool_capacity', /strict tools?|strict: ?true|optional parameters|union types|schema is too complex|too many tools/iu],
  ['inline_tools_unsupported', /tool_addition|tool_definition|inline[ _-]tools?/iu],
  ['tool_schema_invalid', /input_schema|json schema|output_config\.format|\btools?\.\d+\b|tool schema/iu],
];

const EXCLUDED_STATUSES: readonly number[] = [401, 403, 408, 409, 429];
const ERROR_TYPE = /^[a-z_]{1,40}$/u;

const counts = new Map<string, number>();

type ApiError = InstanceType<typeof Anthropic.APIError>;

function clientError(error: unknown): error is ApiError & { status: number } {
  return error instanceof Anthropic.APIError && error.status !== undefined && error.status >= 400 && error.status < 500;
}

/** Which offer refusal a provider error is, or null when it is not a 400 about the offered tools or schemas. */
export function offerRefusal(error: unknown): OfferRefusal | null {
  if (!(error instanceof Anthropic.APIError) || error.status !== 400) return null;
  const found = OFFER_PATTERNS.find(([, pattern]) => pattern.test(error.message));
  return found ? found[0] : null;
}

/** Whether the strict reading is switched on (`SHANNON_ANTHROPIC_STRICT_REJECTIONS`, off by default). */
export function strictRejections(environment: Readonly<Record<string, string | undefined>> = serverEnvironment()): boolean {
  return switchOn(environment, 'SHANNON_ANTHROPIC_STRICT_REJECTIONS');
}

/** Whether a provider error earns the one tool-less answer under the current switch. */
export function recoverableRefusal(error: unknown, environment?: Readonly<Record<string, string | undefined>>): boolean {
  if (strictRejections(environment)) return offerRefusal(error) !== null;
  return clientError(error) && !EXCLUDED_STATUSES.includes(error.status);
}

/** Whether a request offered tools or an output schema. */
export function carriesOffer(body: Anthropic.MessageCreateParamsNonStreaming): boolean {
  const format = (body.output_config as { format?: unknown } | undefined)?.format;
  return Boolean(body.tools?.length) || format !== undefined;
}

function providerErrorType(error: ApiError): string {
  const payload = error.error as { type?: unknown; error?: { type?: unknown } } | undefined;
  const type = payload?.error?.type ?? payload?.type;
  return typeof type === 'string' && ERROR_TYPE.test(type) ? type : 'other';
}

/** Counts and logs one 4xx: status, provider error type, closed message class and whether tools were offered. */
export function reportRejection(error: unknown, hadTools: boolean): void {
  if (!clientError(error)) return;
  const messageClass = offerRefusal(error) ?? 'unclassified';
  const key = `${error.status}:${messageClass}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  const line = { event: 'anthropic_request_rejected', status: error.status, type: providerErrorType(error), class: messageClass, hadTools };
  console.warn(JSON.stringify(line));
}

/** Logs a tool-less recovery: numeric status, closed category and schema counts only, never provider text or request content. */
export function reportOfferRefusal(error: unknown, body: Anthropic.MessageCreateParamsNonStreaming, category: string): void {
  if (!(error instanceof Anthropic.APIError)) return;
  const line = { event: 'anthropic_tool_offer_refused', status: error.status, category, schemaUsage: strictRequestUsage(body) };
  console.warn(JSON.stringify(line));
}

/** Rejections counted since this process started, by `status:class` (`GET /v1/ops`). */
export function rejectionCounts(): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(counts));
}

const CAUSE_CODE = /^[A-Za-z][A-Za-z0-9_]{1,40}$/u;

/**
 * What a request that was dispatched failed with, in closed values only (2026-10-13: an FCA step's request failed in under a
 * second with neither a 4xx nor an abort, and nothing said whether the provider answered 5xx or the connection broke):
 * the SDK error class, the HTTP status when a response arrived, the provider's error type, and a network cause code.
 */
export function providerFailureFacts(error: unknown): { errorClass: string; status: number | null; type: string | null; cause: string | null } {
  const errorClass = error instanceof Error && CAUSE_CODE.test(error.constructor?.name ?? '') ? error.constructor.name : 'unknown';
  const api = error instanceof Anthropic.APIError ? error : null;
  const nested = (error as { cause?: { code?: unknown; name?: unknown; cause?: { code?: unknown } } } | null)?.cause;
  const rawCause = nested?.code ?? nested?.cause?.code ?? nested?.name;
  return { errorClass, status: typeof api?.status === 'number' ? api.status : null, type: api ? providerErrorType(api) : null,
    cause: typeof rawCause === 'string' && CAUSE_CODE.test(rawCause) ? rawCause : null };
}

/** Whether the provider answered the request with a server error (5xx, 529 overloaded): a received answer with no decision. */
export function providerServerError(error: unknown): error is ApiError & { status: number } {
  return error instanceof Anthropic.APIError && typeof error.status === 'number' && error.status >= 500 && error.status < 600;
}

/** Network causes that mean no byte of an answer arrived: the connection was refused, lost, unresolved or timed out at the OS. */
const NO_RESPONSE_CAUSES: ReadonlySet<string> = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

/**
 * Whether a dispatched request failed on the wire with no answer at all: an SDK connection error (never an HTTP status, our own or the
 * SDK's deadline, or an abort) whose network cause is a known connect/transport code. Such a request produced no decision, so a second
 * one cannot apply anything twice; whether the first was processed (and billed) stays unknown. An unclassified failure is not this.
 */
export function connectionFailedBeforeResponse(error: unknown): boolean {
  // The SDK turns an error whose text says "timed out" into APIConnectionTimeoutError and drops its cause: that class is not
  // identified (a deadline of ours or the SDK's looks the same) and is not retried. Node's ETIMEDOUT arrives as a code on the cause.
  if (!(error instanceof Anthropic.APIConnectionError)) return false;
  const { status, cause } = providerFailureFacts(error);
  return status === null && cause !== null && NO_RESPONSE_CAUSES.has(cause);
}

/** Logs one failed dispatched request by its closed facts; never provider text or request content. */
export function reportDispatchFailure(lane: string, error: unknown): void {
  console.warn(JSON.stringify({ event: 'anthropic_request_failed', lane, ...providerFailureFacts(error) }));
}
