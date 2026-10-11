import Anthropic from '@anthropic-ai/sdk';
import { strictRequestUsage } from './anthropicToolCapacity.js';

/**
 * The closed classification of a provider's 4xx refusal of a request (Syzygy ADR-0009 stage 1, quick fix 2). Only a 400 that
 * names the offered tools or schemas is an offer refusal, which the native rounds may answer once without tools. Any other
 * 4xx is an error: counted here, logged by status and closed category, and the turn fails as with any other error.
 * Provider text is read only to classify; it is never stored, logged or returned.
 */
export type OfferRefusal = 'strict_grammar_capacity' | 'strict_tool_capacity' | 'tool_schema_invalid' | 'inline_tools_unsupported';

const OFFER_PATTERNS: ReadonlyArray<readonly [OfferRefusal, RegExp]> = [
  ['strict_grammar_capacity', /compiled grammar is too large/iu],
  ['strict_tool_capacity', /strict tools?|too many tools|optional parameters|union types|schema is too complex/iu],
  ['inline_tools_unsupported', /tool_addition|tool_definition|inline[ _-]tools?/iu],
  ['tool_schema_invalid', /input_schema|json schema|output_config\.format|\btools?\.\d+\b|tool schema/iu],
];

const counts = new Map<string, number>();

/** Which offer refusal a provider error is, or null when it is not a 400 about the offered tools or schemas. */
export function offerRefusal(error: unknown): OfferRefusal | null {
  if (!(error instanceof Anthropic.APIError) || error.status !== 400) return null;
  const found = OFFER_PATTERNS.find(([, pattern]) => pattern.test(error.message));
  return found ? found[0] : null;
}

/** A 4xx the rounds do not recover from (not an offer refusal and not 401/403/408/409/429, which keep their own handling). */
export function unrecoveredRejection(error: unknown): error is InstanceType<typeof Anthropic.APIError> {
  if (!(error instanceof Anthropic.APIError) || error.status === undefined) return false;
  if (error.status < 400 || error.status >= 500 || [401, 403, 408, 409, 429].includes(error.status)) return false;
  return offerRefusal(error) === null;
}

/** Counts and logs a 4xx the rounds did not recover from, by numeric status only. */
export function reportRejection(error: unknown): void {
  if (!unrecoveredRejection(error)) return;
  const key = String(error.status);
  counts.set(key, (counts.get(key) ?? 0) + 1);
  console.warn(JSON.stringify({ event: 'anthropic_request_rejected', status: error.status, category: 'unclassified' }));
}

/** Logs an offer refusal: numeric status, closed category and schema counts only, never provider text or request content. */
export function reportOfferRefusal(error: unknown, body: Anthropic.MessageCreateParamsNonStreaming, category: OfferRefusal): void {
  if (!(error instanceof Anthropic.APIError)) return;
  console.warn(JSON.stringify({ event: 'anthropic_tool_offer_refused', status: error.status, category, schemaUsage: strictRequestUsage(body) }));
}

/** Rejections counted since this process started, by status (`GET /v1/ops`). */
export function rejectionCounts(): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(counts));
}
