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
