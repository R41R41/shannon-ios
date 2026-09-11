import { describe, expect, it } from 'vitest';
import {
  configuredRealtimeDailyAllowanceSeconds,
  OpenAIRealtimeVoiceGateway,
  realtimeVoiceJapanDayKey,
  RealtimeVoiceError,
  SHANNON_REALTIME_DEFAULT_DAILY_ALLOWANCE_SECONDS,
} from '../src/realtimeVoice.js';

const offer = [
  'v=0',
  'o=- 46117327 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
].join('\r\n') + '\r\n';

const answer = [
  'v=0',
  'o=- 46117328 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
].join('\r\n') + '\r\n';

describe('OpenAI realtime voice gateway', () => {
  it('uses a bounded server-authoritative daily allowance in Japan time', () => {
    expect(configuredRealtimeDailyAllowanceSeconds({})).toBe(
      SHANNON_REALTIME_DEFAULT_DAILY_ALLOWANCE_SECONDS,
    );
    expect(configuredRealtimeDailyAllowanceSeconds({
      SHANNON_VOICE_REALTIME_DAILY_MINUTES: '90',
    })).toBe(90 * 60);
    expect(configuredRealtimeDailyAllowanceSeconds({
      SHANNON_VOICE_REALTIME_DAILY_MINUTES: '9',
    })).toBe(SHANNON_REALTIME_DEFAULT_DAILY_ALLOWANCE_SECONDS);
    expect(configuredRealtimeDailyAllowanceSeconds({
      SHANNON_VOICE_REALTIME_DAILY_MINUTES: 'not-a-number',
    })).toBe(SHANNON_REALTIME_DEFAULT_DAILY_ALLOWANCE_SECONDS);
    expect(realtimeVoiceJapanDayKey(new Date('2026-09-10T15:01:00.000Z'))).toBe('2026-09-11');
  });

  it('keeps the standard API key server-side and creates a bounded live session', async () => {
    const gateway = new OpenAIRealtimeVoiceGateway({
      apiKey: 'server-key-only',
      model: 'gpt-realtime-2.1-mini',
      fetcher: async (input, init) => {
        expect(String(input)).toBe('https://api.openai.com/v1/realtime/calls');
        expect(init?.method).toBe('POST');
        const headers = new Headers(init?.headers);
        expect(headers.get('accept')).toBe('application/sdp');
        expect(headers.get('authorization')).toBe('Bearer server-key-only');
        expect(headers.get('content-type')).toBeNull();
        expect(init?.body).toBeInstanceOf(FormData);
        const multipart = init?.body as FormData;
        expect(multipart.get('sdp')).toBe(offer);
        const session = JSON.parse(String(multipart.get('session'))) as Record<string, any>;
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
            output: { voice: 'cedar' },
          },
        });
        expect(session.instructions).toContain('シャノン');
        return new Response(answer, {
          status: 201,
          headers: { location: '/v1/realtime/calls/call_test_123' },
        });
      },
    });

    await expect(gateway.createCall({ sdp: offer, instructions: 'あなたはシャノン。', voice: 'cedar' }))
      .resolves.toEqual({
        answerSdp: answer,
        callId: 'call_test_123',
        model: 'gpt-realtime-2.1-mini',
      });
  });

  it('preserves the final SDP line ending sent by the WebRTC client', async () => {
    const gateway = new OpenAIRealtimeVoiceGateway({
      apiKey: 'server-key-only',
      fetcher: async (_input, init) => {
        const multipart = init?.body as FormData;
        expect(multipart.get('sdp')).toBe(offer);
        return new Response(answer, { status: 201 });
      },
    });

    await expect(gateway.createCall({ sdp: offer, instructions: 'test' })).resolves.toEqual({
      answerSdp: answer,
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
        error: {
          code: 'invalid_offer',
          message: 'Invalid candidate at 192.0.2.10; a=ice-pwd:secret-value',
        },
      }), { status: 400, headers: { 'x-request-id': 'req_safe-123' } }),
    });

    await expect(gateway.createCall({ sdp: offer, instructions: 'test' }))
      .rejects.toEqual(expect.objectContaining<Partial<RealtimeVoiceError>>({
        code: 'VOICE_REALTIME_UPSTREAM_FAILED',
        upstreamStatus: 400,
        upstreamCode: 'invalid_offer',
        upstreamRequestId: 'req_safe-123',
        upstreamDetail: 'Invalid candidate at [redacted-ip]; [redacted-sdp-line]',
      }));
  });
});
