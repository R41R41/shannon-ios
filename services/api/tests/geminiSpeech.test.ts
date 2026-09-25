import { describe, expect, it } from 'vitest';
import {
  GoogleGeminiSpeechGateway,
  normalizedSpeechText,
} from '../src/geminiSpeech.js';
import type { LlmUsageEvent, LlmUsageStore } from '../src/llmUsage.js';

describe('Gemini speech gateway', () => {
  it('keeps the key server-side and requests Shannon Japanese WAV speech', async () => {
    const usage = new RecordingUsageStore();
    const wav = oneSecondWav();
    const gateway = new GoogleGeminiSpeechGateway({
      apiKey: 'server-key-only',
      usageStore: usage,
      now: () => new Date('2026-09-25T01:00:00.000Z'),
      fetcher: async (input, init) => {
        expect(String(input)).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
        const headers = new Headers(init?.headers);
        expect(headers.get('x-goog-api-key')).toBe('server-key-only');
        const body = JSON.parse(String(init?.body)) as Record<string, any>;
        expect(body.model).toBe('gemini-3.8-flash-lite-tts');
        expect(body.input[0].content[0].text).toBe('おかえりなさい。');
        expect(body.generation_config.speech_config).toEqual([{ voice: 'Leda' }]);
        expect(body.input[0].content[0].annotations).toEqual([
          { type: 'speech_metadata', style: '明るく弾む' },
        ]);
        expect(body.response_format).toMatchObject({ mime_type: 'audio/wav', sample_rate: 24_000 });
        return new Response(JSON.stringify({
          status: 'completed',
          steps: [{
            type: 'model_output',
            content: [{ type: 'audio', mime_type: 'audio/wav', data: wav.toString('base64') }],
          }],
        }));
      },
    });

    const result = await gateway.synthesize({
      scopeKey: 'owner-a', text: ' おかえりなさい。 ', style: '明るく弾む',
    });

    expect(result).toMatchObject({
      contentType: 'audio/wav',
      model: 'gemini-3.8-flash-lite-tts',
      voice: 'Leda',
      durationSeconds: 1,
      estimatedCostUsd: 0.00015,
    });
    expect(Buffer.from(result.audio)).toEqual(wav);
    expect(usage.events).toEqual([
      expect.objectContaining({
        scopeKey: 'owner-a', lane: 'voice', model: 'gemini-3.8-flash-lite-tts',
        outputTokens: 25, estimatedCostUsd: 0.00015,
      }),
    ]);
  });

  it('rejects empty, oversized, and non-WAV responses', async () => {
    expect(() => normalizedSpeechText('   ')).toThrowError('GEMINI_SPEECH_INVALID_TEXT');
    expect(() => normalizedSpeechText('a'.repeat(8_001))).toThrowError('GEMINI_SPEECH_INVALID_TEXT');
    const gateway = new GoogleGeminiSpeechGateway({
      apiKey: 'test-only',
      fetcher: async () => new Response(JSON.stringify({
        output_audio: { data: Buffer.from('not audio').toString('base64') },
      })),
    });
    await expect(gateway.synthesize({ scopeKey: 'owner-a', text: 'こんにちは' }))
      .rejects.toMatchObject({ code: 'GEMINI_SPEECH_FAILED' });
  });
});

class RecordingUsageStore implements LlmUsageStore {
  readonly events: LlmUsageEvent[] = [];
  recordLlmUsage(event: LlmUsageEvent): void { this.events.push(event); }
  backgroundLlmCostUsd(): number { return 0; }
  voiceLlmCostUsdForDay(): number { return 0; }
}

function oneSecondWav(): Buffer {
  const dataBytes = 48_000;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(24_000, 24);
  buffer.writeUInt32LE(48_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}
