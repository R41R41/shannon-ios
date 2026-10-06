import { describe, expect, it } from 'vitest';
import {
  OpenAIVoiceTranscriber,
  normalizedVoiceMimeType,
  parsedVoiceDurationSeconds,
  VoiceTranscriptionError,
} from '../src/infra/models/voiceTranscription.js';
import type { LlmUsageEvent, LlmUsageStore } from '../src/infra/models/llmUsage.js';

describe('server voice transcription', () => {
  it('accepts the iPhone M4A content types and bounds duration', () => {
    expect(normalizedVoiceMimeType('audio/mp4')).toBe('audio/mp4');
    expect(normalizedVoiceMimeType('audio/x-m4a; charset=binary')).toBe('audio/mp4');
    expect(parsedVoiceDurationSeconds('1250')).toBe(1.25);
    expect(() => normalizedVoiceMimeType('audio/wav')).toThrowError('VOICE_INVALID_AUDIO');
    expect(() => parsedVoiceDurationSeconds('60001')).toThrowError('VOICE_DURATION_INVALID');
  });

  it('sends audio only to the transcription endpoint and records the voice cost lane', async () => {
    const usageStore = new RecordingUsageStore();
    const transcriber = new OpenAIVoiceTranscriber({
      apiKey: 'test-only',
      now: () => new Date('2026-09-06T04:00:00.000Z'),
      usageStore,
      fetcher: async (input, init) => {
        expect(String(input)).toBe('https://api.openai.com/v1/audio/transcriptions');
        expect(init?.headers).toEqual({ authorization: 'Bearer test-only' });
        const form = init?.body as FormData;
        expect(form.get('model')).toBe('gpt-transcribe');
        expect(form.get('language')).toBe('ja');
        const file = form.get('file');
        expect(file).toBeInstanceOf(Blob);
        expect((file as Blob).size).toBe(4);
        return new Response(JSON.stringify({
          text: '今日は散歩に行きたい',
          usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const result = await transcriber.transcribe({
      scopeKey: 'owner-a',
      audio: Uint8Array.from([1, 2, 3, 4]),
      mimeType: 'audio/mp4',
      durationSeconds: 10,
    });

    expect(result).toEqual({
      transcript: '今日は散歩に行きたい',
      model: 'gpt-transcribe',
      durationSeconds: 10,
      estimatedCostUsd: 0.00075,
    });
    expect(usageStore.events).toEqual([
      expect.objectContaining({
        scopeKey: 'owner-a', lane: 'voice', model: 'gpt-transcribe', totalTokens: 19,
        estimatedCostUsd: 0.00075,
      }),
    ]);
  });

  it('stops before an API call when the daily voice budget is exhausted', async () => {
    let called = false;
    const usageStore = new RecordingUsageStore(0.10);
    const transcriber = new OpenAIVoiceTranscriber({
      apiKey: 'test-only',
      usageStore,
      fetcher: async () => {
        called = true;
        return new Response('{}');
      },
    });

    await expect(transcriber.transcribe({
      scopeKey: 'owner-a', audio: Uint8Array.from([1]), mimeType: 'audio/mp4', durationSeconds: 1,
    })).rejects.toEqual(expect.objectContaining<Partial<VoiceTranscriptionError>>({
      code: 'VOICE_DAILY_BUDGET_EXHAUSTED',
    }));
    expect(called).toBe(false);
  });

  it('does not start a transcription that would cross the daily voice budget', async () => {
    let called = false;
    const usageStore = new RecordingUsageStore(0.09999);
    const transcriber = new OpenAIVoiceTranscriber({
      apiKey: 'test-only',
      usageStore,
      fetcher: async () => {
        called = true;
        return new Response('{}');
      },
    });

    await expect(transcriber.transcribe({
      scopeKey: 'owner-a', audio: Uint8Array.from([1]), mimeType: 'audio/mp4', durationSeconds: 1,
    })).rejects.toEqual(expect.objectContaining<Partial<VoiceTranscriptionError>>({
      code: 'VOICE_DAILY_BUDGET_EXHAUSTED',
    }));
    expect(called).toBe(false);
  });

  it('does not record a transcript or cost when the upstream request fails', async () => {
    const usageStore = new RecordingUsageStore();
    const transcriber = new OpenAIVoiceTranscriber({
      apiKey: 'test-only', usageStore,
      fetcher: async () => new Response('{"error":"unavailable"}', { status: 503 }),
    });

    await expect(transcriber.transcribe({
      scopeKey: 'owner-a', audio: Uint8Array.from([1]), mimeType: 'audio/mp4', durationSeconds: 1,
    })).rejects.toEqual(expect.objectContaining<Partial<VoiceTranscriptionError>>({
      code: 'VOICE_TRANSCRIPTION_FAILED',
    }));
    expect(usageStore.events).toEqual([]);
  });
});

class RecordingUsageStore implements LlmUsageStore {
  readonly events: LlmUsageEvent[] = [];

  constructor(private readonly spent = 0) {}

  recordLlmUsage(event: LlmUsageEvent): void { this.events.push(event); }
  backgroundLlmCostUsd(): number { return 0; }
  voiceLlmCostUsdForDay(): number { return this.spent; }
}
