import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RetryingElevenSpeech, configuredCallVoices, createConfiguredCallVoiceCast } from '../src/infra/models/callVoiceSpeech.js';
import { ElevenSpeechError } from '../src/infra/models/elevenSpeech.js';
import type { GeminiSpeechRequest } from '../src/infra/models/geminiSpeech.js';
import { handlePlatformVoiceRequest } from '../src/surfaces/platform/platformVoiceRoute.js';

const KEYS = { GEMINI_API_KEY: 'g', ELEVENLABS_API_KEY: 'e' };
const LIST = JSON.stringify([
  { name: 'kid-el', engine: 'eleven', voice: 'kidElevenVoice01' },
  { name: 'kid-gm', engine: 'gemini', voice: 'voice_kid', style: '子供の核。' },
  { name: 'mosaku', engine: 'eleven', voice: 'mosakuVoice0001' },
]);

function sse(...pcm: Buffer[]): Response {
  const body = pcm
    .map(chunk => `data: ${JSON.stringify({ event_type: 'step.delta', delta: { type: 'audio', data: chunk.toString('base64') } })}\n\n`)
    .join('') + `data: ${JSON.stringify({ event_type: 'interaction.completed' })}\n\n`;
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

async function drain(chunks: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const chunk of chunks) void chunk;
}

const ask = (text: string): GeminiSpeechRequest => ({ scopeKey: 'owner', text });

/** Runs `body` with `fetch` answering as `answer` does, and puts the real one back. */
async function withFetch<T>(answer: (init?: RequestInit) => Response, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => answer(init)) as never;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

describe('the named call voices', () => {
  it('with no setting at all is the ElevenLabs voice a call had, and it does not forbid another voice', () => {
    expect(configuredCallVoices({})).toEqual({ candidates: [], defaultName: null, chosen: false });
    const old = configuredCallVoices({ SHANNON_ELEVEN_TTS_VOICE_ID: 'abcdefgh' });
    expect(old).toMatchObject({ defaultName: 'eleven', chosen: false });
    expect(old.candidates).toEqual([{ name: 'eleven', engine: 'eleven', voice: 'abcdefgh' }]);
    expect(createConfiguredCallVoiceCast({ ...KEYS, SHANNON_ELEVEN_TTS_VOICE_ID: 'abcdefgh' })?.chosen).toBe(false);
  });

  it('keeps the earlier Gemini setting as the candidate gemini, the default next to the app voice', () => {
    const both = configuredCallVoices({ SHANNON_CALL_TTS_VOICE: 'voice_x', SHANNON_ELEVEN_TTS_VOICE_ID: 'abcdefgh' });
    expect(both.candidates.map(item => item.name)).toEqual(['gemini', 'eleven']);
    expect(both).toMatchObject({ defaultName: 'gemini', chosen: true });
  });

  it('takes the list and the default name; an unknown default falls back to the first, a broken entry is dropped', () => {
    const named = configuredCallVoices({ SHANNON_CALL_VOICES: LIST, SHANNON_CALL_VOICE_DEFAULT: ' Kid-GM ' });
    expect(named.candidates.map(item => item.name)).toEqual(['kid-el', 'kid-gm', 'mosaku']);
    expect(named).toMatchObject({ defaultName: 'kid-gm', chosen: true });
    expect(configuredCallVoices({ SHANNON_CALL_VOICES: LIST, SHANNON_CALL_VOICE_DEFAULT: 'nope' }).defaultName).toBe('kid-el');
    expect(configuredCallVoices({ SHANNON_CALL_VOICES: LIST }).defaultName).toBe('kid-el');
    const dropped = configuredCallVoices({ SHANNON_CALL_VOICES: JSON.stringify([
      { name: 'Bad Name', engine: 'eleven', voice: 'v' }, { name: 'ok', engine: 'other', voice: 'v' }, { name: 'fine', engine: 'eleven', voice: 'v1234567' },
    ]) });
    expect(dropped.candidates.map(item => item.name)).toEqual(['fine']);
    expect(configuredCallVoices({ SHANNON_CALL_VOICES: '{not json' }).candidates).toEqual([]);
  });

  it('does not repeat a voice the list already names under the earlier setting', () => {
    const result = configuredCallVoices({ SHANNON_CALL_VOICES: LIST, SHANNON_ELEVEN_TTS_VOICE_ID: 'mosakuVoice0001' });
    expect(result.candidates.map(item => item.name)).toEqual(['kid-el', 'kid-gm', 'mosaku']);
  });

  it('reads and changes the voice by name, in memory; the default stays what it was', () => {
    const cast = createConfiguredCallVoiceCast({ ...KEYS, SHANNON_CALL_VOICES: LIST, SHANNON_CALL_VOICE_DEFAULT: 'kid-gm' })!;
    expect(cast.list()).toEqual([
      { name: 'kid-el', engine: 'eleven' }, { name: 'kid-gm', engine: 'gemini' }, { name: 'mosaku', engine: 'eleven' },
    ]);
    expect([cast.current(), cast.defaultName()]).toEqual(['kid-gm', 'kid-gm']);
    expect(cast.select(' MOSAKU ')).toBe(true);
    expect(cast.select('missing')).toBe(false);
    expect([cast.current(), cast.defaultName()]).toEqual(['mosaku', 'kid-gm']);
  });

  it('leaves out a candidate whose key is missing, and has no cast without any', () => {
    const cast = createConfiguredCallVoiceCast({ GEMINI_API_KEY: 'g', SHANNON_CALL_VOICES: LIST })!;
    expect(cast.list().map(item => item.name)).toEqual(['kid-gm']);
    expect(cast.current()).toBe('kid-gm');
    expect(createConfiguredCallVoiceCast({ SHANNON_CALL_VOICES: LIST })).toBeNull();
  });

  it('uses the candidate own core style, else the shared one, for a Gemini voice', async () => {
    const seen: string[] = [];
    await withFetch(init => {
      seen.push(JSON.parse(String(init?.body)).input[0].content[0].annotations[0].style as string);
      return sse(Buffer.alloc(2_400, 1));
    }, async () => {
      const cast = createConfiguredCallVoiceCast({
        GEMINI_API_KEY: 'g', SHANNON_CALL_TTS_STYLE: '共通の核。',
        SHANNON_CALL_VOICES: JSON.stringify([
          { name: 'own', engine: 'gemini', voice: 'voice_a', style: '自分の核。' }, { name: 'plain', engine: 'gemini', voice: 'voice_b' },
        ]),
      })!;
      for (const name of ['own', 'plain']) {
        cast.select(name);
        const result = await cast.stream(ask('こんにちは。'));
        expect(result.callVoiceName).toBe(name);
        await drain(result.chunks);
      }
    });
    expect(seen[0]!.startsWith('自分の核。')).toBe(true);
    expect(seen[1]!.startsWith('共通の核。')).toBe(true);
  });

  it('books the synthesis of a call voice as usage', async () => {
    const events: Array<{ model: string; lane: string }> = [];
    const store = { recordLlmUsage: (event: { model: string; lane: string }) => events.push(event), backgroundLlmCostUsd: () => 0 };
    await withFetch(() => sse(Buffer.alloc(48_000, 1)), async () => {
      const cast = createConfiguredCallVoiceCast({ GEMINI_API_KEY: 'g', SHANNON_CALL_VOICES: LIST }, store as never)!;
      await drain((await cast.stream(ask('はい。'))).chunks);
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ lane: 'voice', model: 'gemini-3.8-flash-tts' });
  });
});

describe('the cast route', () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve())));

  async function post(path: string, body: unknown, routes: Record<string, unknown>): Promise<Response> {
    server = createServer((request, response) => {
      void handlePlatformVoiceRequest(`/v1/platform/voice/${path}`, request, response, { token: 't' }, {
        service: {} as never, mouth: {} as never, scopeKey: 'owner', environment: () => ({ SHANNON_DC_VOICE: 'on' }), ...routes,
      } as never);
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const realFetch = (globalThis as { realFetch?: typeof fetch }).realFetch ?? fetch;
    return realFetch(`http://127.0.0.1:${port}/v1/platform/voice/${path}`, {
      method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  }

  const castOf = () => createConfiguredCallVoiceCast({
    GEMINI_API_KEY: 'g', ELEVENLABS_API_KEY: 'e', SHANNON_CALL_VOICES: JSON.stringify([
      { name: 'kid-gm', engine: 'gemini', voice: 'voice_kid' }, { name: 'mosaku', engine: 'eleven', voice: 'mosakuVoice0001' },
    ]),
  })!;

  it('reads the voices with an empty body and changes the voice with a name', async () => {
    const cast = castOf();
    const read = await post('cast', {}, { cast, speech: cast });
    expect(await read.json()).toEqual({
      current: 'kid-gm', default: 'kid-gm', chosen: true, items: [{ name: 'kid-gm', engine: 'gemini' }, { name: 'mosaku', engine: 'eleven' }],
    });
    const changed = await post('cast', { name: 'mosaku' }, { cast, speech: cast });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ current: 'mosaku', default: 'kid-gm' });
    expect(cast.current()).toBe('mosaku');
  });

  it('answers 404 with the voices for a name it does not have, and 503 without a cast', async () => {
    const cast = castOf();
    const unknown = await post('cast', { name: 'nobody' }, { cast, speech: cast });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: 'UNKNOWN_VOICE', current: 'kid-gm' });
    expect((await post('cast', {}, { cast: null, speech: null })).status).toBe(503);
  });

  it('names the voice of a line; a failure says no other voice may say it when the settings chose the voice', async () => {
    // The gateway keeps the fetch it finds when it is made, so one stand-in answers from a queue; the route's own call is let through.
    const realFetch = globalThis.fetch;
    (globalThis as { realFetch?: typeof fetch }).realFetch = realFetch;
    const queue: Response[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => (
      String(input).startsWith('http://127.0.0.1') ? realFetch(input as never, init) : queue.shift() ?? new Response('{}', { status: 503 })
    )) as never;
    try {
      const cast = castOf();
      queue.push(sse(Buffer.alloc(2_400, 1)));
      const ok = await post('speech', { text: 'おはよう。' }, { cast, speech: cast });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('x-shannon-voice-name')).toBe('kid-gm');
      await ok.arrayBuffer();
      await new Promise<void>(resolve => server!.close(() => resolve()));
      const failed = await post('speech', { text: 'おはよう。' }, { cast, speech: cast });
      expect(failed.status).toBe(502);
      expect(await failed.json()).toMatchObject({ error: 'GEMINI_SPEECH_FAILED', voice: 'kid-gm', noSubstitute: true });
      await new Promise<void>(resolve => server!.close(() => resolve()));
      const unconfigured = await post('speech', { text: 'おはよう。' }, { cast, speech: null });
      expect(unconfigured.status).toBe(503);
      expect(await unconfigured.json()).toMatchObject({ noSubstitute: true });
    } finally {
      globalThis.fetch = realFetch;
      delete (globalThis as { realFetch?: typeof fetch }).realFetch;
    }
  });

  it('does not forbid another voice when the settings did not choose the voice', async () => {
    const none = await post('speech', { text: 'うん。' }, { cast: null, speech: null });
    expect(none.status).toBe(503);
    expect(await none.json()).not.toHaveProperty('noSubstitute');
    const old = createConfiguredCallVoiceCast({ ELEVENLABS_API_KEY: 'e', SHANNON_ELEVEN_TTS_VOICE_ID: 'abcdefgh' })!;
    expect(old.chosen).toBe(false);
  });
});

describe('an ElevenLabs call voice that is busy for a moment', () => {
  const result = (chunks: AsyncIterable<Uint8Array>) => ({
    contentType: 'audio/l16' as const, sampleRate: 24_000, channels: 1, bitsPerSample: 16, model: 'eleven_v4_turbo', voice: 'v', outputUsdPerTenSeconds: 0, chunks,
  }) as never;
  const failing = async function* (): AsyncGenerator<Uint8Array> { throw new ElevenSpeechError('ELEVEN_SPEECH_FAILED'); };
  const good = async function* (): AsyncGenerator<Uint8Array> { yield Buffer.alloc(2_400, 1); yield Buffer.alloc(2_400, 2); };
  const inner = (...plans: Array<() => AsyncGenerator<Uint8Array>>) => {
    const calls: number[] = [];
    return { calls, stream: async () => { calls.push(1); return result(plans[Math.min(calls.length - 1, plans.length - 1)]!()); } };
  };

  it('asks once more after a failure before any audio, and uses the second answer', async () => {
    const voice = inner(failing, good);
    const out = await new RetryingElevenSpeech(voice).stream(ask('おはよう。'));
    let bytes = 0;
    for await (const chunk of out.chunks) bytes += chunk.byteLength;
    expect(bytes).toBe(4_800);
    expect(voice.calls).toHaveLength(2);
  });

  it('gives up after the second failure, and does not ask again for a line the voice cannot take', async () => {
    const twice = inner(failing);
    await expect(new RetryingElevenSpeech(twice).stream(ask('x'))).rejects.toBeInstanceOf(ElevenSpeechError);
    expect(twice.calls).toHaveLength(2);
    const invalid = { calls: 0, stream: async () => { invalid.calls += 1; throw new ElevenSpeechError('ELEVEN_SPEECH_INVALID_STYLE'); } };
    await expect(new RetryingElevenSpeech(invalid).stream(ask('x'))).rejects.toBeInstanceOf(ElevenSpeechError);
    expect(invalid.calls).toBe(1);
  });

  it('does not ask again once audio has started, and not when the caller left', async () => {
    const broken = async function* (): AsyncGenerator<Uint8Array> { yield Buffer.alloc(2_400, 1); throw new ElevenSpeechError('ELEVEN_SPEECH_FAILED'); };
    const voice = inner(broken, good);
    const out = await new RetryingElevenSpeech(voice).stream(ask('x'));
    await expect(drain(out.chunks)).rejects.toBeInstanceOf(ElevenSpeechError);
    expect(voice.calls).toHaveLength(1);
    const controller = new AbortController();
    controller.abort();
    const left = inner(good);
    await expect(new RetryingElevenSpeech(left).stream(ask('x'), controller.signal)).rejects.toBeDefined();
    expect(left.calls).toHaveLength(0);
  });
});
