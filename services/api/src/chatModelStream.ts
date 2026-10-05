import { errorDetail, extractOutputText, parseJson } from './chatModelSupport.js';
import { ChatReplyStreamDecoder } from './chatReplyStreamDecoder.js';

/** One Responses API call answered as server-sent events. */
export interface ResponsesStreamCall {
  fetcher: typeof fetch;
  endpoint: string;
  apiKey: string;
  /** The whole call, from the request to the last event: the budget of the non-streaming call. */
  timeoutMilliseconds: number;
  /** The non-streaming request body. `stream: true` is added here and nothing else is changed. */
  body: Record<string, unknown>;
}

/**
 * Sends the text-chat request with `stream: true` and reports the `reply` field of the
 * structured output as it is written. `onReplyText` receives pieces whose concatenation is
 * a prefix of the reply the completed turn will carry (never leading whitespace, never
 * trailing whitespace that the turn might still trim, never another field). When `reply`
 * is not the first field nothing is reported and the caller sees only the completed turn.
 *
 * Returns the completed response envelope, read by the caller exactly like a non-streaming
 * response. `onFailed` receives the envelope of a failed response, when the provider sent
 * one, so its usage can still be recorded.
 */
export async function streamedChatTurnEnvelope(
  call: ResponsesStreamCall,
  onReplyText: (text: string) => void | Promise<void>,
  onFailed: (envelope: unknown) => void,
): Promise<unknown> {
  const response = await call.fetcher(call.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${call.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ...call.body, stream: true }),
    signal: AbortSignal.timeout(call.timeoutMilliseconds),
  });
  if (!response.ok || !response.body) {
    const raw = await response.text();
    throw new Error(`OPENAI_RESPONSE_${response.status}: ${errorDetail(parseJson(raw))}`);
  }
  const decoder = new ChatReplyStreamDecoder();
  let written = '';
  let envelope: unknown;
  for await (const event of responseSSEEvents(response.body)) {
    const value = event && typeof event === 'object' && !Array.isArray(event)
      ? event as Record<string, unknown>
      : {};
    if (value.type === 'response.output_text.delta' && typeof value.delta === 'string') {
      written += value.delta;
      const text = decoder.push(value.delta);
      if (text) await onReplyText(text);
    } else if (value.type === 'response.completed' || value.type === 'response.incomplete') {
      // An incomplete response is read like the truncated non-streaming one: its text fails to parse.
      envelope = value.response;
    } else if (value.type === 'error' || value.type === 'response.failed') {
      if (value.response) onFailed(value.response);
      throw new Error('OPENAI_RESPONSE_STREAM_FAILED');
    }
  }
  if (!envelope || typeof envelope !== 'object') throw new Error('OPENAI_RESPONSE_STREAM_INCOMPLETE');
  // The completed envelope carries the whole output; the deltas are the fallback when it does not.
  return extractOutputText(envelope) ? envelope : { ...envelope, output_text: written };
}

/**
 * The events of a Responses stream. With `signal`, an abort ends a pending read at once and
 * throws the signal's reason, also for a body that does not watch the request's signal itself.
 */
export async function* responseSSEEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const cancel = () => { reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      pending += decoder.decode(value, { stream: !done });
      const blocks = pending.split(/\r?\n\r?\n/u);
      pending = blocks.pop() ?? '';
      for (const block of blocks) {
        const data = block.split(/\r?\n/u)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') continue;
        yield parseJson(data);
      }
      if (done) break;
    }
    const data = pending.split(/\r?\n/u)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');
    if (data && data !== '[DONE]') yield parseJson(data);
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
