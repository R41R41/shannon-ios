import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OpenAIResponsesChatModel } from '../src/chatModel.js';
import { extractOutputText } from '../src/chatModelSupport.js';
import type { LlmUsageEvent } from '../src/llmUsage.js';
import { GOLDEN_BASE as base, GOLDEN_REQUESTS, GOLDEN_RESPONSES } from './chatModelGoldenCases.js';

const at = '2026-10-02T03:00:00.000Z';
const recorded = JSON.parse(readFileSync(new URL('./fixtures/chat-model-turn-v1.json', import.meta.url), 'utf8')) as {
  requests: Record<string, { url: string; headers: unknown; body: string }>;
  results: Record<string, { result?: { reply: string }; error?: string; usage: LlmUsageEvent[] }>;
};

function sse(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** The provider's event stream for a completed envelope: its output text in pieces, then the envelope. */
function completedStream(envelope: unknown, pieceLength = 5): string {
  const text = extractOutputText(envelope);
  const status = (envelope as { status?: string }).status === 'incomplete' ? 'response.incomplete' : 'response.completed';
  const events = [sse({ type: 'response.created', response: {} })];
  for (let index = 0; index < text.length; index += pieceLength) {
    events.push(sse({ type: 'response.output_text.delta', delta: text.slice(index, index + pieceLength) }));
  }
  return [...events, sse({ type: 'response.output_text.done', text }), sse({ type: status, response: envelope }), 'data: [DONE]\n\n'].join('');
}

function bytesResponse(chunks: readonly Uint8Array[], status = 200): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
  }), { status });
}

function streamingModel(respond: (init: RequestInit) => Response | Promise<Response>, options: { timeoutMilliseconds?: number; agentHostHint?: string; model?: string } = {}) {
  const usage: LlmUsageEvent[] = [];
  const requests: Array<{ url: string; headers: unknown; body: string }> = [];
  const model = new OpenAIResponsesChatModel({ apiKey: 'test-only', now: () => at, ...options,
    usageStore: { recordLlmUsage: (event: LlmUsageEvent) => { usage.push(event); } } as never,
    fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), headers: init?.headers, body: String(init?.body) });
      return respond(init!);
    }) as typeof fetch });
  return { model, usage, requests };
}

async function streamed(name: string, chunks?: (text: string) => Uint8Array[]) {
  const entry = GOLDEN_RESPONSES[name]!;
  const text = completedStream(entry.envelope);
  const { model, usage } = streamingModel(() => entry.status
    ? new Response(JSON.stringify(entry.envelope), { status: entry.status })
    : bytesResponse(chunks ? chunks(text) : [new TextEncoder().encode(text)]));
  const pieces: string[] = [];
  try {
    return { result: await model.generateStreaming(entry.request ?? base, piece => { pieces.push(piece); }), usage, pieces };
  } catch (error) {
    return { error: (error as Error).message, usage, pieces };
  }
}

describe('text chat provider adapter, streaming', () => {
  it('sends the non-streaming request with stream: true and nothing else changed', async () => {
    for (const [name, entry] of Object.entries(GOLDEN_REQUESTS)) {
      const { model, requests } = streamingModel(() => bytesResponse([new TextEncoder().encode(completedStream(GOLDEN_RESPONSES.plain!.envelope))]),
        { ...(entry.agentHostHint ? { agentHostHint: entry.agentHostHint } : {}), ...(entry.model ? { model: entry.model } : {}) });
      await model.generateStreaming(entry.request, () => {});
      const sent = requests[0]!;
      const plain = recorded.requests[name]!;
      expect(sent.url).toBe(plain.url);
      expect(sent.headers).toEqual(plain.headers);
      // Byte for byte the recorded body, with the one field appended.
      expect(sent.body, name).toBe(`${plain.body.slice(0, -1)},"stream":true}`);
    }
  });

  it('returns the same result and records the same usage as the non-streaming call', async () => {
    for (const name of Object.keys(GOLDEN_RESPONSES)) {
      const outcome = await streamed(name);
      const plain = recorded.results[name]!;
      expect(JSON.parse(JSON.stringify({ result: outcome.result, error: outcome.error, usage: outcome.usage })), name)
        .toEqual({ ...(plain.result ? { result: plain.result } : {}), ...(plain.error ? { error: plain.error } : {}), usage: plain.usage });
      // What was reported while writing is a beginning of the reply that was returned.
      if (plain.result) expect(outcome.pieces.join('')).toBe(plain.result.reply);
    }
    // A turn rejected after its text was written did report that text: the retraction case.
    expect((await streamed('proposeWithoutProposal')).pieces.join('')).toBe('はい、聞こえています。\n次です。');
  });

  it('reads the event stream the same wherever the transport cuts it', async () => {
    const text = completedStream(GOLDEN_RESPONSES.proposal!.envelope, 3);
    const bytes = new TextEncoder().encode(text);
    const whole = await streamed('proposal', () => [bytes]);
    expect(whole.result).toEqual(recorded.results.proposal!.result);
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const outcome = await streamed('proposal', () => [bytes.slice(0, cut), bytes.slice(cut)]);
      expect(outcome.result, `cut at byte ${cut}`).toEqual(whole.result);
      expect(outcome.pieces.join('')).toBe(whole.pieces.join(''));
      expect(outcome.usage).toEqual(whole.usage);
    }
    const single = await streamed('proposal', () => Array.from(bytes, byte => Uint8Array.of(byte)));
    expect(single.result).toEqual(whole.result);
  }, 60_000);

  it('uses the deltas when the completed envelope carries no output', async () => {
    const turn = extractOutputText(GOLDEN_RESPONSES.plain!.envelope);
    const { model, usage } = streamingModel(() => bytesResponse([new TextEncoder().encode([
      sse({ type: 'response.output_text.delta', delta: turn.slice(0, 20) }), sse({ type: 'response.output_text.delta', delta: turn.slice(20) }),
      sse({ type: 'response.completed', response: { usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160, input_tokens_details: { cached_tokens: 100 } } } }),
    ].join(''))]));
    expect(JSON.parse(JSON.stringify(await model.generateStreaming(base, () => {})))).toEqual(recorded.results.plain!.result);
    expect(JSON.parse(JSON.stringify(usage))).toEqual(recorded.results.plain!.usage);
  });

  it('reports no text when reply is not the first field, and still returns the turn', async () => {
    const { reply, ...rest } = JSON.parse(extractOutputText(GOLDEN_RESPONSES.plain!.envelope)) as Record<string, unknown>;
    const envelope = { output_text: JSON.stringify({ ...rest, reply }), usage: { input_tokens: 1, output_tokens: 1 } };
    const { model } = streamingModel(() => bytesResponse([new TextEncoder().encode(completedStream(envelope))]));
    const pieces: string[] = [];
    const result = await model.generateStreaming(base, piece => { pieces.push(piece); });
    expect(pieces).toEqual([]);
    expect(result.reply).toBe(recorded.results.plain!.result!.reply);
  });

  it('reports the first sentence before the provider has finished', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const { model } = streamingModel(() => new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } })));
    const encoder = new TextEncoder();
    const order: string[] = [];
    let heard!: () => void;
    const firstText = new Promise<void>(resolve => { heard = resolve; });
    const pending = model.generateStreaming(base, piece => { order.push(`text:${piece}`); heard(); }).then(result => { order.push('returned'); return result; });
    await new Promise(resolve => setTimeout(resolve, 5));
    controller.enqueue(encoder.encode(sse({ type: 'response.output_text.delta', delta: '{"reply":"最初の文です。次' })));
    await firstText;
    // The provider has not completed, and the caller already has text.
    expect(order).toEqual(['text:最初の文です。次']);
    controller.enqueue(encoder.encode(sse({ type: 'response.output_text.delta', delta: 'の文です。","threadSummary":null,"taskDecision":{"disposition":"none","reason":"雑談"},"taskProposal":null,"intentPlan":null,"artifacts":null}' })));
    controller.enqueue(encoder.encode(sse({ type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 2 } } })));
    controller.close();
    expect((await pending).reply).toBe('最初の文です。次の文です。');
    expect(order).toEqual(['text:最初の文です。次', 'text:の文です。', 'returned']);
  });

  it('fails a stream the provider failed, recording usage only when the provider reported it', async () => {
    const partial = sse({ type: 'response.output_text.delta', delta: '{"reply":"途中まで。' });
    for (const [failure, expected] of [
      [sse({ type: 'response.failed', response: { usage: { input_tokens: 50, output_tokens: 7, total_tokens: 57 } } }), [{ inputTokens: 50, outputTokens: 7, totalTokens: 57 }]],
      [sse({ type: 'response.failed', response: { error: { message: 'x' } } }), []],
      [sse({ type: 'error', message: 'x' }), []],
    ] as const) {
      const { model, usage } = streamingModel(() => bytesResponse([new TextEncoder().encode(partial + failure)]));
      const pieces: string[] = [];
      await expect(model.generateStreaming(base, piece => { pieces.push(piece); })).rejects.toThrow('OPENAI_RESPONSE_STREAM_FAILED');
      expect(pieces).toEqual(['途中まで。']);
      expect(usage).toMatchObject(expected);
      expect(usage).toHaveLength(expected.length);
    }
    // A stream that simply ends is incomplete: nothing is returned and nothing recorded.
    const cut = streamingModel(() => bytesResponse([new TextEncoder().encode(partial)]));
    await expect(cut.model.generateStreaming(base, () => {})).rejects.toThrow('OPENAI_RESPONSE_STREAM_INCOMPLETE');
    expect(cut.usage).toEqual([]);
  });

  it('keeps one time budget for the whole call, as the non-streaming request does', async () => {
    const { model } = streamingModel(init => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse({ type: 'response.output_text.delta', delta: '{"reply":"はい。' })));
        init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason));
      },
    })), { timeoutMilliseconds: 30 });
    const startedAt = Date.now();
    await expect(model.generateStreaming(base, () => {})).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
