import { cacheReceiptsView, resetCacheReceipts } from '../../src/infra/models/anthropic/cacheReceipts.js';
import type { LlmUsageEvent, LlmUsageStore } from '../../src/infra/models/llmUsage.js';
import { sse, type AnthropicMessage } from './anthropicFixtures.js';

/**
 * The provider boundary of the request goldens (Syzygy ADR-0009 stage 1, M2). A fetch handed to the official SDK as its own
 * `fetch`: every request the SDK would send is kept exactly as it left (method, URL, headers, the body's bytes), and answered
 * from a script of recorded provider responses (streamed as server-sent events when the request asks for a stream). Nothing
 * reaches a network. Only synthetic data passes through it.
 *
 * Headers that name the machine running the test (its OS, CPU and Node version) are left out; every other header is kept.
 */
const MACHINE_HEADERS = new Set(['x-stainless-arch', 'x-stainless-os', 'x-stainless-runtime-version']);

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** The body as JSON, its key order preserved; `raw` is what was sent. */
  body: unknown;
  raw: string;
}

export type ScriptedReply = AnthropicMessage | Response | (() => Response | Promise<Response>);

function reply(next: ScriptedReply | undefined, streamed: boolean): Response | Promise<Response> {
  if (!next) {
    const error = { type: 'error', error: { type: 'invalid_request_error', message: 'no scripted reply' } };
    return new Response(JSON.stringify(error), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  if (typeof next === 'function') return next();
  if (next instanceof Response) return next;
  if (streamed) return new Response(sse(next), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_synthetic' } });
}

async function requestText(input: string | URL | Request, init?: RequestInit): Promise<string> {
  if (typeof init?.body === 'string') return init.body;
  if (input instanceof Request) return input.clone().text();
  return String(init?.body ?? '');
}

function keptHeaders(init?: RequestInit): Record<string, string> {
  const headers = new Headers(init?.headers);
  return Object.fromEntries([...headers].filter(([name]) => !MACHINE_HEADERS.has(name)).sort(([a], [b]) => a.localeCompare(b)));
}

/** A fetch that records each request and answers it with the next scripted reply. */
export function recordingFetch(script: readonly ScriptedReply[]) {
  const requests: RecordedRequest[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = await requestText(input, init);
    const body = raw ? JSON.parse(raw) as unknown : null;
    const url = input instanceof Request ? input.url : String(input);
    requests.push({ method: init?.method ?? 'GET', url, headers: keptHeaders(init), body, raw });
    const streamed = Boolean(body && typeof body === 'object' && (body as { stream?: unknown }).stream);
    return reply(script[requests.length - 1], streamed);
  }) as typeof fetch;
  return { fetcher, requests };
}

/** A usage ledger that keeps what was booked. */
export function usageLedger() {
  const rows: LlmUsageEvent[] = [];
  const store: LlmUsageStore = { recordLlmUsage: row => { rows.push(row); }, backgroundLlmCostUsd: () => 0 };
  return { rows, store };
}

/** The cache receipts the requests left, without their wall-clock time. */
export function cacheReceiptsTaken(): unknown[] {
  return cacheReceiptsView(1_000).recent.map(({ at: _at, ...rest }) => rest);
}

export function forgetCacheReceipts(): void {
  resetCacheReceipts();
}

/** A response with the provider's error envelope. */
export function providerError(status: number, type: string, headers: Record<string, string> = {}): () => Response {
  const body = JSON.stringify({ type: 'error', error: { type, message: 'synthetic provider error' } });
  return () => new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
}
