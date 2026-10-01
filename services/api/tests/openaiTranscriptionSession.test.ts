import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createConfiguredOpenAITranscriptionGateway,
  OpenAITranscriptionGateway,
} from '../src/openaiTranscriptionSession.js';
import { createGeminiLiveRoute } from '../src/serverGeminiLiveRoute.js';

const secret = 'ek_synthetic_client_secret_value';

describe('OpenAI transcription gateway', () => {
  it('mints a Japanese transcription client secret without returning the permanent key', async () => {
    const gateway = new OpenAITranscriptionGateway({
      apiKey: 'server-key-only',
      now: () => new Date('2026-10-01T00:00:00.000Z'),
      fetcher: async (input, init) => {
        expect(String(input)).toBe('https://api.openai.com/v1/realtime/client_secrets');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer server-key-only');
        const body = JSON.parse(String(init?.body)) as Record<string, any>;
        expect(body.expires_after).toEqual({ anchor: 'created_at', seconds: 300 });
        expect(body.session).toMatchObject({
          type: 'transcription',
          audio: { input: {
            format: { type: 'audio/pcm', rate: 24_000 },
            transcription: { model: 'gpt-4o-mini-transcribe', language: 'ja' },
            turn_detection: { type: 'server_vad', silence_duration_ms: 360 },
          } },
        });
        expect(body.session.audio.input.transcription.prompt).toContain('Aether');
        return new Response(JSON.stringify({ value: secret, expires_at: 1_790_816_000 }));
      },
    });

    await expect(gateway.createSession()).resolves.toEqual({
      token: secret,
      model: 'gpt-4o-mini-transcribe',
      expiresAt: new Date(1_790_816_000 * 1_000).toISOString(),
      inputUsdPerMinute: 0.003,
    });
  });

  it('applies the configured model, silence window and bounded price', async () => {
    let silence = 0;
    const gateway = createConfiguredOpenAITranscriptionGateway({
      OPENAI_API_KEY: 'k',
      SHANNON_VOICE_CALL_TRANSCRIPTION_MODEL: 'gpt-4o-transcribe',
      SHANNON_VOICE_CALL_SILENCE_MS: '500',
      SHANNON_VOICE_CALL_USD_PER_MINUTE: '99',
    });
    expect(gateway?.model).toBe('gpt-4o-transcribe');
    expect(gateway?.inputUsdPerMinute).toBe(0.006);
    const direct = new OpenAITranscriptionGateway({
      apiKey: 'k',
      silenceDurationMilliseconds: 500,
      fetcher: async (_input, init) => {
        silence = JSON.parse(String(init?.body)).session.audio.input.turn_detection.silence_duration_ms;
        return new Response(JSON.stringify({ value: secret }));
      },
    });
    await direct.createSession();
    expect(silence).toBe(500);
  });

  it('is unconfigured without a key and rejects unsupported models', () => {
    expect(createConfiguredOpenAITranscriptionGateway({})).toBeNull();
    expect(() => new OpenAITranscriptionGateway({ apiKey: 'k', model: 'whisper-1' })).toThrowError(
      'SHANNON_VOICE_CALL_TRANSCRIPTION_MODEL is invalid',
    );
    expect(() => new OpenAITranscriptionGateway({ apiKey: ' ' })).toThrowError();
  });

  it('fails closed on a malformed secret or upstream error without leaking the body', async () => {
    const malformed = new OpenAITranscriptionGateway({
      apiKey: 'k', fetcher: async () => new Response(JSON.stringify({ value: 'sk-not-a-client-secret' })),
    });
    await expect(malformed.createSession()).rejects.toMatchObject({ code: 'OPENAI_TRANSCRIPTION_TOKEN_FAILED' });

    const rejected = new OpenAITranscriptionGateway({
      apiKey: 'k',
      fetcher: async () => new Response(JSON.stringify({ error: { code: 'invalid_api_key', message: 'secret detail' } }), { status: 401 }),
    });
    await expect(rejected.createSession()).rejects.toMatchObject({
      code: 'OPENAI_TRANSCRIPTION_TOKEN_FAILED', upstreamStatus: 401, upstreamCode: 'invalid_api_key',
    });

    const offline = new OpenAITranscriptionGateway({ apiKey: 'k', fetcher: async () => { throw new Error('offline'); } });
    await expect(offline.createSession()).rejects.toMatchObject({ code: 'OPENAI_TRANSCRIPTION_TOKEN_FAILED' });
  });
});

describe('session route transcription provider', () => {
  afterEach(() => vi.unstubAllGlobals());

  const kernel = {
    realtimeVoiceSession: () => ({ threadId: 'thread-a', instructions: 'あなたはシャノン。' }),
  } as never;
  const principal = { deviceId: 'device-a', scopeKey: 'owner-a' } as never;

  async function call(environment: Record<string, string>, body: unknown) {
    const handler = createGeminiLiveRoute(environment, kernel, () => true);
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST' }) as unknown as IncomingMessage;
    let status = 0;
    let payload = '';
    const response = {
      setHeader: () => undefined,
      writeHead: (code: number) => { status = code; },
      end: (text: string) => { payload = text; },
    } as unknown as ServerResponse;
    await handler(request, response, principal);
    return { status, body: JSON.parse(payload) as Record<string, any> };
  }

  it('returns an OpenAI session carrying the same cascade fields for provider openai', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ value: secret, expires_at: 1_790_816_000 }))));
    const { status, body } = await call(
      { OPENAI_API_KEY: 'k', SHANNON_GEMINI_TTS_VOICE: 'Kore' },
      { transcriptionProvider: 'openai', participantMode: 'owner' },
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      token: secret,
      model: 'gpt-4o-mini-transcribe',
      voice: 'Kore',
      threadId: 'thread-a',
      instructions: 'あなたはシャノン。',
      inputUsdPerMinute: 0.003,
      outputUsdPerMinute: 0.018,
      transcriptionProvider: 'openai',
    });
    expect(JSON.stringify(body)).not.toContain('"k"');
  });

  it('keeps the Gemini session for clients that omit the provider', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ name: 'auth_tokens/ephemeral-test-token' }))));
    const { status, body } = await call({ GEMINI_API_KEY: 'g' }, { participantMode: 'owner' });
    expect(status).toBe(200);
    expect(body.token).toBe('auth_tokens/ephemeral-test-token');
    expect(body.model).toBe('gemini-3.5-transcribe-live');
    expect(body.transcriptionProvider).toBeUndefined();
  });

  it('reports each provider as unavailable independently and rejects unknown providers', async () => {
    expect((await call({ GEMINI_API_KEY: 'g' }, { transcriptionProvider: 'openai' })).status).toBe(503);
    expect((await call({ OPENAI_API_KEY: 'o' }, {})).status).toBe(503);
    expect((await call({ OPENAI_API_KEY: 'o' }, { transcriptionProvider: 'other' })).status).toBe(400);
  });

  it('maps an OpenAI token failure to a content-free 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"server_error"}}', { status: 500 })));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { status, body } = await call({ OPENAI_API_KEY: 'k' }, { transcriptionProvider: 'openai' });
    expect(status).toBe(502);
    expect(body.error).toBe('OPENAI_TRANSCRIPTION_TOKEN_FAILED');
  });
});
