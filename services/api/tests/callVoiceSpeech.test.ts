import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CallVoiceSpeechGateway,
  callVoiceChosen,
  createConfiguredCallVoiceCast,
} from '../src/infra/models/callVoiceSpeech.js';
import { GoogleGeminiSpeechGateway, type GeminiSpeechRequest } from '../src/infra/models/geminiSpeech.js';
import { handlePlatformVoiceRequest } from '../src/surfaces/platform/platformVoiceRoute.js';

const CORE = '核の演技：少年役、地声寄り。';
const PITCH = '地声の高さのまま、声を高くしない。';

function sse(...pcm: Buffer[]): Response {
  const body = pcm
    .map(chunk => `data: ${JSON.stringify({ event_type: 'step.delta', delta: { type: 'audio', data: chunk.toString('base64') } })}\n\n`)
    .join('') + `data: ${JSON.stringify({ event_type: 'interaction.completed' })}\n\n`;
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function gatewayWith(fetcher: typeof fetch, options: { budget?: number; attempts?: number } = {}) {
  const inner = new GoogleGeminiSpeechGateway({ apiKey: 'test-only', voice: 'voice_test', model: 'gemini-3.8-flash-tts', fetcher });
  return new CallVoiceSpeechGateway(inner, CORE, {
    ...(options.budget ? { firstChunkBudgetMilliseconds: options.budget } : {}),
    ...(options.attempts ? { attempts: options.attempts } : {}),
  });
}

async function drain(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

const ask = (text: string, style?: string): GeminiSpeechRequest => ({ scopeKey: 'owner', text, ...(style ? { style } : {}) });

describe('the call voice (Gemini)', () => {
  it('never reads an acting tag aloud, even one that is not a listed tag', async () => {
    let body: Record<string, any> | null = null;
    const gateway = gatewayWith(async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, any>;
      return sse(Buffer.alloc(2_400, 1));
    });
    const result = await gateway.stream(ask('ほら、見て。', '[Smiles] [whispers]'));
    await drain(result.chunks);
    const content = body!.input[0].content[0];
    expect(content.text).toBe('ほら、見て。');
    expect(content.annotations[0].style).toContain('ささやき声');
  });

  it('is chosen only by its own voice setting, and the app voice settings do not choose it', () => {
    expect(callVoiceChosen({})).toBe(false);
    expect(callVoiceChosen({ SHANNON_GEMINI_TTS_VOICE: 'Leda', SHANNON_ELEVEN_TTS_VOICE_ID: 'abcdefgh' })).toBe(false);
    expect(callVoiceChosen({ SHANNON_CALL_TTS_VOICE: ' voice_x ' })).toBe(true);
    expect(createConfiguredCallVoiceCast({ SHANNON_CALL_TTS_VOICE: "voice_x" })).toBeNull();
    expect(createConfiguredCallVoiceCast({ SHANNON_CALL_TTS_VOICE: "voice_x", GEMINI_API_KEY: "k" })?.current()).toBe("gemini");
  });

  it('asks for the voice, model and core style, with the acting tags as a direction and no tag in the text', async () => {
    let body: Record<string, any> | null = null;
    const gateway = gatewayWith(async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, any>;
      return sse(Buffer.alloc(2_400, 1), Buffer.alloc(2_400, 2));
    });
    const result = await gateway.stream(ask('あ、[laughs]見つけた！[smiles]ほら。', '[whispers]'));
    expect(Buffer.concat([Buffer.from(await drain(result.chunks))]).length).toBe(4_800);
    expect(body!.model).toBe('gemini-3.8-flash-tts');
    expect(body!.generation_config.speech_config).toEqual([{ voice: 'voice_test' }]);
    expect(body!.stream).toBe(true);
    const content = body!.input[0].content[0];
    expect(content.text).toBe('あ、見つけた！ほら。');
    expect(content.text).not.toMatch(/[\[\]]|laughs|whispers|smiles/);
    const style = content.annotations[0].style as string;
    expect(style.startsWith(CORE)).toBe(true);
    expect(style).toContain('途中からささやき声で');
    expect(style).toContain('途中で小さく笑う。');
    expect(style.endsWith(PITCH)).toBe(true);
  });

  it('keeps the core style and the pitch when no tag is given, and stays within 500 characters with many', async () => {
    const styles: string[] = [];
    const inner = new GoogleGeminiSpeechGateway({
      apiKey: 'test-only', voice: 'v', model: 'gemini-3.8-flash-tts',
      fetcher: async (_input, init) => {
        styles.push((JSON.parse(String(init?.body)) as any).input[0].content[0].annotations[0].style);
        return sse(Buffer.alloc(2_400, 1));
      },
    });
    const gateway = new CallVoiceSpeechGateway(inner, 'あ'.repeat(330));
    await drain((await gateway.stream(ask('こんにちは。'))).chunks);
    expect(styles[0]).toBe(`${'あ'.repeat(330)} ${PITCH}`);
    await drain((await gateway.stream(ask('[whispers][sighs][gasps][yawns]いやだなあ。'))).chunks);
    expect(styles[1]!.length).toBeLessThanOrEqual(500);
    expect(styles[1]!.startsWith('あ'.repeat(330))).toBe(true);
    expect(styles[1]!.endsWith(PITCH)).toBe(true);
  });

  it('asks once more after a failure before any audio, and the second answer is used', async () => {
    let calls = 0;
    const gateway = gatewayWith(async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ error: { code: 'content_blocked' } }), { status: 400 })
        : sse(Buffer.alloc(2_400, 7));
    });
    const result = await gateway.stream(ask('ただいま。'));
    expect((await drain(result.chunks)).length).toBe(2_400);
    expect(calls).toBe(2);
  });

  it('gives up after the second failure (the route then answers 502; no other voice says it)', async () => {
    let calls = 0;
    const gateway = gatewayWith(async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { code: 'content_blocked' } }), { status: 400 });
    });
    await expect(gateway.stream(ask('ただいま。'))).rejects.toMatchObject({
      code: 'GEMINI_SPEECH_FAILED', upstreamStatus: 400, upstreamCode: 'content_blocked',
    });
    expect(calls).toBe(2);
  });

  it('does not ask again for a refusal that cannot change, or for a sentence of only tags', async () => {
    let calls = 0;
    const gateway = gatewayWith(async () => {
      calls += 1;
      return new Response('{}', { status: 401 });
    });
    await expect(gateway.stream(ask('ただいま。'))).rejects.toMatchObject({ upstreamStatus: 401 });
    expect(calls).toBe(1);
    await expect(gateway.stream(ask('[laughs]'))).rejects.toMatchObject({ code: 'GEMINI_SPEECH_INVALID_TEXT' });
    expect(calls).toBe(1);
  });

  it('gives up on a first sound that is too late, without a second try', async () => {
    let calls = 0;
    const gateway = gatewayWith((_input, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }, { budget: 40 });
    await expect(gateway.stream(ask('ただいま。'))).rejects.toMatchObject({ code: 'GEMINI_SPEECH_FAILED', upstreamCode: 'first_chunk_timeout' });
    expect(calls).toBe(1);
  });

  it('stops the request when the caller leaves', async () => {
    let seen: AbortSignal | undefined;
    const gateway = gatewayWith((_input, init) => {
      seen = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const caller = new AbortController();
    const pending = gateway.stream(ask('ただいま。'), caller.signal);
    const outcome = expect(pending).rejects.toBeDefined();
    caller.abort();
    await outcome;
    expect(seen?.aborted).toBe(true);
  });

  it('stops the request when the consumer stops reading after the first audio', async () => {
    let seen: AbortSignal | undefined;
    const gateway = gatewayWith(async (_input, init) => {
      seen = init?.signal ?? undefined;
      return sse(Buffer.alloc(2_400, 1), Buffer.alloc(2_400, 2));
    });
    const result = await gateway.stream(ask('ただいま。'));
    const iterator = result.chunks[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    await iterator.return?.();
    expect(seen?.aborted).toBe(true);
  });
});

describe('the call voice on the speech route', () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve())));

  async function call(speech: unknown, body: unknown): Promise<Response> {
    server = createServer((request, response) => {
      void handlePlatformVoiceRequest('/v1/platform/voice/speech', request, response, { token: 't' }, {
        service: {} as never, mouth: {} as never, speech: speech as never, scopeKey: 'owner',
        environment: () => ({ SHANNON_DC_VOICE: 'on' }),
      });
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return fetch(`http://127.0.0.1:${port}/v1/platform/voice/speech`, {
      method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  }

  it('streams PCM and says which engine made it', async () => {
    const gateway = gatewayWith(async () => sse(Buffer.alloc(2_400, 1)));
    const ok = await call(gateway, { text: 'おはよう。', style: '[softly]' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('audio/l16;rate=24000;channels=1');
    expect(ok.headers.get('x-shannon-voice-engine')).toBe('gemini');
    expect((await ok.arrayBuffer()).byteLength).toBe(2_400);
  });

  it('answers 502 (not a crash) when the call voice fails twice', async () => {
    const gateway = gatewayWith(async () => new Response('{}', { status: 503 }));
    const failed = await call(gateway, { text: 'おはよう。' });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: 'GEMINI_SPEECH_FAILED' });
  });
});
