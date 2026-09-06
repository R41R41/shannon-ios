import { describe, expect, it } from 'vitest';
import {
  OpenAIRealtimeVoiceGateway,
  RealtimeVoiceError,
} from '../src/realtimeVoice.js';

const offer = [
  'v=0',
  'o=- 46117327 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
].join('\r\n');

const answer = [
  'v=0',
  'o=- 46117328 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
].join('\r\n');

describe('OpenAI realtime voice gateway', () => {
  it('keeps the standard API key server-side and creates a bounded live session', async () => {
    const gateway = new OpenAIRealtimeVoiceGateway({
      apiKey: 'server-key-only',
      model: 'gpt-realtime-2.1-mini',
      fetcher: async (input, init) => {
        expect(String(input)).toBe('https://api.openai.com/v1/realtime/calls');
        expect(init?.method).toBe('POST');
        expect(init?.headers).toEqual({ authorization: 'Bearer server-key-only' });
        const form = init?.body as FormData;
        expect(await (form.get('sdp') as Blob).text()).toBe(offer);
        const session = JSON.parse(String(form.get('session'))) as Record<string, any>;
        expect(session).toMatchObject({
          type: 'realtime',
          model: 'gpt-realtime-2.1-mini',
          output_modalities: ['audio'],
          audio: {
            input: {
              transcription: { model: 'gpt-live-transcribe', language: 'ja' },
              turn_detection: {
                type: 'semantic_vad', create_response: true, interrupt_response: true,
              },
            },
            output: { voice: 'marin' },
          },
        });
        expect(session.instructions).toContain('シャノン');
        return new Response(answer, {
          status: 201,
          headers: { location: '/v1/realtime/calls/call_test_123' },
        });
      },
    });

    await expect(gateway.createCall({ sdp: offer, instructions: 'あなたはシャノン。' }))
      .resolves.toEqual({
        answerSdp: answer,
        callId: 'call_test_123',
        model: 'gpt-realtime-2.1-mini',
      });
  });

  it('rejects malformed SDP without contacting OpenAI', async () => {
    let called = false;
    const gateway = new OpenAIRealtimeVoiceGateway({
      apiKey: 'server-key-only',
      fetcher: async () => {
        called = true;
        return new Response(answer);
      },
    });

    await expect(gateway.createCall({ sdp: 'not-sdp', instructions: 'test' }))
      .rejects.toEqual(expect.objectContaining<Partial<RealtimeVoiceError>>({
        code: 'VOICE_REALTIME_INVALID_SDP',
      }));
    expect(called).toBe(false);
  });

  it('exposes only safe upstream diagnostics when call creation fails', async () => {
    const gateway = new OpenAIRealtimeVoiceGateway({
      apiKey: 'server-key-only',
      fetcher: async () => new Response(JSON.stringify({
        error: { code: 'model_not_found', message: 'sensitive upstream detail' },
      }), { status: 404 }),
    });

    await expect(gateway.createCall({ sdp: offer, instructions: 'test' }))
      .rejects.toEqual(expect.objectContaining<Partial<RealtimeVoiceError>>({
        code: 'VOICE_REALTIME_UPSTREAM_FAILED',
        upstreamStatus: 404,
        upstreamCode: 'model_not_found',
      }));
  });
});
