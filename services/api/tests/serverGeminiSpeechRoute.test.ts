import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SpeechScopeConcurrencyLimiter, streamSpeech } from '../src/serverGeminiSpeechRoute.js';
import { GeminiSpeechError } from '../src/geminiSpeech.js';

describe('Gemini speech scope concurrency', () => {
  it('allows one current sentence and one prefetched sentence per scope', () => {
    const limiter = new SpeechScopeConcurrencyLimiter(2);

    expect(limiter.acquire('owner-a')).toBe(true);
    expect(limiter.acquire('owner-a')).toBe(true);
    expect(limiter.acquire('owner-a')).toBe(false);
    expect(limiter.acquire('owner-b')).toBe(true);

    limiter.release('owner-a');
    expect(limiter.acquire('owner-a')).toBe(true);
    expect(limiter.acquire('owner-a')).toBe(false);
  });

  it('rejects invalid limits and safely ignores an extra release', () => {
    expect(() => new SpeechScopeConcurrencyLimiter(0)).toThrowError(
      'maximumConcurrentRequests must be a positive integer',
    );
    const limiter = new SpeechScopeConcurrencyLimiter(1);
    limiter.release('owner-a');
    expect(limiter.acquire('owner-a')).toBe(true);
  });
});

describe('Gemini streaming cancellation and cleanup', () => {
  const speech = { scopeKey: 'synthetic-owner', text: '合成テスト。' };
  function transport() {
    const request = new EventEmitter() as IncomingMessage;
    const response = Object.assign(new EventEmitter(), {
      writeHead: () => undefined, write: () => true, end: () => undefined,
    }) as unknown as ServerResponse;
    return { request, response };
  }

  it('does not report caller cancellation as provider failure', async () => {
    const { request, response } = transport();
    const gateway = { stream: async () => {
      request.emit('aborted');
      throw new GeminiSpeechError('GEMINI_SPEECH_FAILED');
    } };
    await expect(streamSpeech(request, response, gateway, speech)).resolves.toBeUndefined();
    expect(request.listenerCount('aborted')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
  });

  it('preserves genuine provider failures including timeouts', async () => {
    const { request, response } = transport();
    const error = new GeminiSpeechError('GEMINI_SPEECH_FAILED');
    await expect(streamSpeech(request, response, { stream: async () => { throw error; } }, speech))
      .rejects.toBe(error);
  });

  it('closes the audio iterator when the caller disconnects between chunks', async () => {
    const { request, response } = transport();
    let closed = false;
    response.write = (() => { request.emit('aborted'); return true; }) as typeof response.write;
    const gateway = { stream: async () => ({
      contentType: 'audio/l16' as const, sampleRate: 24_000 as const,
      channels: 1 as const, bitsPerSample: 16 as const,
      model: 'synthetic', voice: 'synthetic', outputUsdPerTenSeconds: 0,
      chunks: (async function* () {
        try { yield new Uint8Array(4); yield new Uint8Array(4); }
        finally { closed = true; }
      })(),
    }) };
    await streamSpeech(request, response, gateway, speech);
    expect(closed).toBe(true);
  });
});
