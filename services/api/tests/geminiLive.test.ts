import { describe, expect, it } from 'vitest';
import { GoogleGeminiLiveGateway } from '../src/geminiLive.js';

describe('Gemini Live gateway', () => {
  it('mints a one-use constrained token without returning the permanent key', async () => {
    const gateway = new GoogleGeminiLiveGateway({
      apiKey: 'server-key-only',
      voice: 'Aoede',
      now: () => new Date('2026-09-25T03:00:00.000Z'),
      fetcher: async (input, init) => {
        expect(String(input)).toBe('https://generativelanguage.googleapis.com/v1beta/auth_tokens');
        expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('server-key-only');
        const body = JSON.parse(String(init?.body)) as Record<string, any>;
        expect(body).toMatchObject({
          uses: 1,
          expireTime: '2026-09-25T03:20:00.000Z',
          newSessionExpireTime: '2026-09-25T03:01:00.000Z',
          fieldMask: 'model,generationConfig.responseModalities',
          bidiGenerateContentSetup: {
            model: 'models/gemini-3.8-live',
            generationConfig: {
              responseModalities: ['AUDIO'],
            },
          },
        });
        return new Response(JSON.stringify({ name: 'auth_tokens/ephemeral-test-token' }));
      },
    });

    await expect(gateway.createSession({
      scopeKey: 'owner-a',
      threadId: 'thread-a',
      instructions: 'あなたはシャノン。',
    })).resolves.toEqual({
      token: 'auth_tokens/ephemeral-test-token',
      model: 'gemini-3.8-live',
      voice: 'Aoede',
      threadId: 'thread-a',
      instructions: 'あなたはシャノン。',
      expiresAt: '2026-09-25T03:20:00.000Z',
      inputUsdPerMinute: 0.005,
      outputUsdPerMinute: 0.018,
    });
  });

  it('fails closed on an invalid token response', async () => {
    const gateway = new GoogleGeminiLiveGateway({
      apiKey: 'server-key-only',
      fetcher: async () => new Response(JSON.stringify({ name: '' })),
    });
    await expect(gateway.createSession({ scopeKey: 'a', threadId: 'b', instructions: 'c' }))
      .rejects.toMatchObject({ code: 'GEMINI_LIVE_TOKEN_FAILED' });
  });
});
