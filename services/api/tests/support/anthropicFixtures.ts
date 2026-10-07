import { readFileSync } from 'node:fs';

/**
 * Anthropic Messages API responses for model-free tests of the Sonnet tier (Syzygy ADR-0008 stage 2, step 5). The fixtures in
 * `fixtures/anthropic/*.json` follow the response shapes of `@anthropic-ai/sdk` 0.131.0 (`Message`, its content blocks and
 * usage); the live `tier.*` run (`scripts/reach-measures.sh run --live --yes --only tier.`) is what holds them against the API.
 * A streamed request is answered with the same message as server-sent events.
 */
export type AnthropicMessage = Record<string, unknown> & { content: Array<Record<string, unknown>>; stop_reason: string; usage: Record<string, unknown> };

export function anthropicFixture(name: string): AnthropicMessage {
  return JSON.parse(readFileSync(new URL(`../fixtures/anthropic/${name}.json`, import.meta.url), 'utf8')) as AnthropicMessage;
}

export function message(content: Array<Record<string, unknown>>, stop: string, extra: Record<string, unknown> = {}): AnthropicMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 10)}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason: stop,
    stop_sequence: null, stop_details: null, container: null,
    usage: { input_tokens: 120, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 2_000, cache_creation: null,
      server_tool_use: null, service_tier: 'standard', inference_geo: null, output_tokens_details: null },
    ...extra,
  };
}

/** The message as the events of a stream, its text in pieces of a few characters. */
export function sse(value: AnthropicMessage): string {
  const events: Array<[string, unknown]> = [];
  events.push(['message_start', { type: 'message_start', message: { ...value, content: [], stop_reason: null, usage: { ...value.usage, output_tokens: 1 } } }]);
  value.content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } }]);
      for (const piece of String(block.text).match(/[\s\S]{1,7}/gu) ?? []) events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } }]);
    } else if (block.type === 'tool_use') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { ...block, input: {} } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }]);
    } else if (block.type === 'thinking') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: String(block.signature) } }]);
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: block }]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: value.stop_reason, stop_sequence: null, stop_details: value.stop_details ?? null, container: null }, usage: value.usage }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** A fetch that answers each request with the next message (streamed when asked), and keeps every request body. */
export function scriptedAnthropic(script: AnthropicMessage[] | ((body: Record<string, unknown>, index: number) => AnthropicMessage | Response)) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const next = typeof script === 'function' ? script(body, bodies.length - 1) : script[bodies.length - 1];
    if (!next) return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'no more script' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    if (next instanceof Response) return next;
    return body.stream
      ? new Response(sse(next), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
  }) as typeof fetch;
  return { fetcher, bodies };
}
