import { describe, expect, it } from 'vitest';
import {
  OpenAIResponsesChatModel,
  VOICE_MAX_OUTPUT_TOKENS,
  VOICE_REPLY_INSTRUCTIONS,
  type ShannonVoiceModelRequest,
} from '../src/infra/models/chatModel.js';
import { VOICE_RESPONSE_TIMEOUT_MILLISECONDS, type VoiceStreamBounds } from '../src/infra/models/chatModelVoiceStream.js';
import type { LlmUsageEvent } from '../src/infra/models/llmUsage.js';
import { completeSpokenSentences } from '../src/surfaces/voice/spokenSentences.js';

const encoder = new TextEncoder();
const request: ShannonVoiceModelRequest = {
  scopeKey: 'owner', systemPrompt: 'system', history: [], message: '一分以上のセリフを言って',
  useWebSearch: false, conversationClass: 'direct',
};
const usage = { input_tokens: 40, output_tokens: 1_200 };

function sse(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

function delta(text: string): string {
  return sse({ type: 'response.output_text.delta', delta: text });
}

const sleep = (milliseconds: number) => new Promise<void>(resolve => { setTimeout(resolve, milliseconds); });

/** A provider stream whose pieces arrive after the given delays; it stays open unless `close`. */
function timedStream(pieces: ReadonlyArray<readonly [number, string]>, close = true): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        for (const [wait, text] of pieces) {
          await sleep(wait);
          try { controller.enqueue(encoder.encode(text)); } catch { return; }
        }
        if (close) controller.close();
      })();
    },
  });
}

function voiceModel(
  respond: (init: RequestInit) => Response,
  voiceStreamBounds?: Partial<VoiceStreamBounds>,
) {
  const recorded: LlmUsageEvent[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const model = new OpenAIResponsesChatModel({
    apiKey: 'test-only', now: () => '2026-10-05T03:00:00.000Z',
    ...(voiceStreamBounds ? { voiceStreamBounds } : {}),
    usageStore: { recordLlmUsage: (event: LlmUsageEvent) => { recorded.push(event); } } as never,
    fetcher: (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return respond(init!);
    }) as typeof fetch,
  });
  return { model, recorded, bodies };
}

describe('voice reply length', () => {
  it('leaves room for a long talk in every class but a greeting', async () => {
    expect(VOICE_MAX_OUTPUT_TOKENS).toEqual({ greeting: 180, direct: 1_200, skill_simple: 1_200, skill_complex: 1_600 });
    const { model, bodies } = voiceModel(() => new Response(JSON.stringify({ output_text: 'はい。' })));
    for (const conversationClass of ['greeting', 'direct', 'skill_simple', 'skill_complex'] as const) {
      await model.generateVoice({ ...request, conversationClass });
    }
    expect(bodies.map(body => body.max_output_tokens)).toEqual([180, 1_200, 1_200, 1_600]);
    // Everyday brevity stays; a long talk asked for in so many words is allowed.
    expect(VOICE_REPLY_INSTRUCTIONS).toContain('挨拶と通常会話は1〜2文');
    expect(VOICE_REPLY_INSTRUCTIONS).toContain('長い話・物語・長めのセリフ');
    expect(String(bodies[1]!.instructions)).toContain(VOICE_REPLY_INSTRUCTIONS);
  });

  it('cuts a reply at its last complete sentence by the rule of the spoken segments', () => {
    expect(completeSpokenSentences('一つ目。「二つ目！」三つ')).toBe('一つ目。「二つ目！」');
    expect(completeSpokenSentences('前置き\n続きの途中')).toBe('前置き');
    expect(completeSpokenSentences('まだ文が終わらない')).toBe('');
  });
});

describe('a streamed voice reply that reaches its output limit', () => {
  const incomplete = (reason: string) => sse({
    type: 'response.incomplete',
    response: { status: 'incomplete', incomplete_details: { reason }, usage },
  });

  it('is a finished reply ending at its last complete sentence, accounted and marked truncated', async () => {
    const { model, recorded } = voiceModel(() => new Response(timedStream([
      [0, delta('むかしむかし、')], [0, delta('ある港町に。')], [0, delta('小さな灯台が')],
      [0, delta('ありました。そして')], [0, incomplete('max_output_tokens')],
    ])));
    const deltas: string[] = [];
    const result = await model.generateVoiceStreaming(request, piece => { deltas.push(piece); });
    expect(result).toMatchObject({ reply: 'むかしむかし、ある港町に。小さな灯台がありました。', truncated: true });
    // Everything written was handed on; the route drops the unfinished tail.
    expect(deltas.join('')).toBe('むかしむかし、ある港町に。小さな灯台がありました。そして');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ lane: 'chat', outputTokens: 1_200 });
  });

  it('keeps the words when not one sentence was finished', async () => {
    const { model } = voiceModel(() => new Response(timedStream([
      [0, delta('とても長い一文がまだ続いていて')], [0, incomplete('max_output_tokens')],
    ])));
    const result = await model.generateVoiceStreaming(request, () => {});
    expect(result).toMatchObject({ reply: 'とても長い一文がまだ続いていて', truncated: true });
  });

  it('stays a failure for any other reason, or with no words at all, and still accounts what was used', async () => {
    const filtered = voiceModel(() => new Response(timedStream([[0, delta('途中まで。')], [0, incomplete('content_filter')]])));
    await expect(filtered.model.generateVoiceStreaming(request, () => {})).rejects.toThrow('OPENAI_RESPONSE_CONTENT_FILTERED');
    expect(filtered.recorded).toHaveLength(1);
    const other = voiceModel(() => new Response(timedStream([[0, delta('途中まで。')], [0, incomplete('something_else')]])));
    await expect(other.model.generateVoiceStreaming(request, () => {})).rejects.toThrow('OPENAI_RESPONSE_STREAM_INCOMPLETE');
    // The whole output limit spent on reasoning: no words, but the tokens are counted before the failure.
    const empty = voiceModel(() => new Response(timedStream([[0, incomplete('max_output_tokens')]])));
    await expect(empty.model.generateVoiceStreaming(request, () => {})).rejects.toThrow('OPENAI_RESPONSE_STREAM_INCOMPLETE');
    expect(empty.recorded).toMatchObject([{ lane: 'chat', outputTokens: 1_200 }]);
    const emptyWhole = voiceModel(() => new Response(JSON.stringify({
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage, output: [],
    })));
    await expect(emptyWhole.model.generateVoice(request)).rejects.toThrow('OPENAI_RESPONSE_EMPTY');
    expect(emptyWhole.recorded).toHaveLength(1);
    // A withheld non-streaming reply is an error too, not its partial words.
    const withheldWhole = voiceModel(() => new Response(JSON.stringify({
      status: 'incomplete', incomplete_details: { reason: 'content_filter' }, usage,
      output: [{ type: 'message', content: [{ type: 'output_text', text: '途中まで。' }] }],
    })));
    await expect(withheldWhole.model.generateVoice(request)).rejects.toThrow('OPENAI_RESPONSE_CONTENT_FILTERED');
    expect(withheldWhole.recorded).toHaveLength(1);
    const failed = voiceModel(() => new Response(timedStream([[0, delta('途中まで。')], [0, sse({ type: 'response.failed', response: {} })]])));
    await expect(failed.model.generateVoiceStreaming(request, () => {})).rejects.toThrow('OPENAI_RESPONSE_STREAM_FAILED');
  });

  it('is cut the same way when it arrives as one non-streaming response', async () => {
    const { model } = voiceModel(() => new Response(JSON.stringify({
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage,
      output: [{ type: 'message', content: [{ type: 'output_text', text: '一つ目です。二つ目の途中' }] }],
    })));
    expect(await model.generateVoice(request)).toMatchObject({ reply: '一つ目です。', truncated: true });
  });

  it('is not marked when the reply completed', async () => {
    const { model } = voiceModel(() => new Response(timedStream([
      [0, delta('終わりです。')], [0, sse({ type: 'response.completed', response: { usage } })],
    ])));
    const result = await model.generateVoiceStreaming(request, () => {});
    expect(result.reply).toBe('終わりです。');
    expect(result.truncated).toBeUndefined();
  });
});

describe('voice stream time bounds', () => {
  const completed = sse({ type: 'response.completed', response: { usage } });

  it('has no total limit: a long reply that keeps arriving is spoken to the end', async () => {
    const pieces: Array<[number, string]> = Array.from({ length: 12 }, (_, index) => [25, delta(`${index}番目の文です。`)]);
    const { model } = voiceModel(() => new Response(timedStream([...pieces, [0, completed]])),
      { firstOutputMilliseconds: 120, idleMilliseconds: 120 });
    const startedAt = Date.now();
    const result = await model.generateVoiceStreaming(request, () => {});
    expect(Date.now() - startedAt).toBeGreaterThan(240);
    expect(result.reply).toContain('11番目の文です。');
  });

  it('gives up when the first word does not come in time', async () => {
    const { model } = voiceModel(() => new Response(timedStream([[0, sse({ type: 'response.created', response: {} })]], false)),
      { firstOutputMilliseconds: 40, idleMilliseconds: 1_000 });
    const startedAt = Date.now();
    await expect(model.generateVoiceStreaming(request, () => {})).rejects.toThrow('OPENAI_RESPONSE_FIRST_OUTPUT_TIMEOUT');
    expect(Date.now() - startedAt).toBeLessThan(900);
  });

  it('gives up when nothing arrives for the idle bound after the first word', async () => {
    const { model } = voiceModel(() => new Response(timedStream([[0, delta('話し始めて。')]], false)),
      { firstOutputMilliseconds: 1_000, idleMilliseconds: 40 });
    const deltas: string[] = [];
    await expect(model.generateVoiceStreaming(request, piece => { deltas.push(piece); })).rejects.toThrow('OPENAI_RESPONSE_IDLE_TIMEOUT');
    expect(deltas).toEqual(['話し始めて。']);
  });

  it('does not count time spent by the listener as provider silence', async () => {
    const { model } = voiceModel(() => new Response(timedStream([[0, delta('一つ目。')], [0, delta('二つ目。')], [0, completed]])),
      { firstOutputMilliseconds: 1_000, idleMilliseconds: 40 });
    const result = await model.generateVoiceStreaming(request, () => sleep(80));
    expect(result.reply).toBe('一つ目。二つ目。');
  });

  it('waits longer for the first word of a web-searching turn', async () => {
    const { model } = voiceModel(() => new Response(timedStream([[80, delta('調べました。')], [0, completed]])),
      { firstOutputMilliseconds: 20, idleMilliseconds: 1_000 });
    const result = await model.generateVoiceStreaming({ ...request, useWebSearch: true }, () => {});
    expect(result.reply).toBe('調べました。');
  });

  it('gives a non-streaming voice reply one total long enough for the longest reply', async () => {
    let signal: AbortSignal | undefined;
    const { model } = voiceModel(init => { signal = init.signal ?? undefined; return new Response(JSON.stringify({ output_text: 'はい。' })); });
    await model.generateVoice(request);
    expect(VOICE_RESPONSE_TIMEOUT_MILLISECONDS).toBe(90_000);
    expect(signal?.aborted).toBe(false);
    const slow = new OpenAIResponsesChatModel({
      apiKey: 'test-only', voiceResponseTimeoutMilliseconds: 30,
      fetcher: (async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
      })) as typeof fetch,
    });
    await expect(slow.generateVoice(request)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it("reports the caller's own cancellation, not a timeout", async () => {
    const { model } = voiceModel(() => new Response(timedStream([[0, delta('話し始めて。')]], false)),
      { firstOutputMilliseconds: 1_000, idleMilliseconds: 1_000 });
    const caller = new AbortController();
    const reason = new Error('CALLER_LEFT');
    const run = model.generateVoiceStreaming(request, () => { setTimeout(() => caller.abort(reason), 10); }, caller.signal);
    await expect(run).rejects.toBe(reason);
  });
});
