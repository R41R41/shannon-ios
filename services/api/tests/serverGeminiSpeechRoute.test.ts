import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShannonDevicePrincipal } from '../src/deviceAuth.js';
import {
  SpeechScopeConcurrencyLimiter, createGeminiSpeechRoute, refuseSpeech, streamSpeech,
} from '../src/serverGeminiSpeechRoute.js';
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

describe('a refused sentence leaves a trace', () => {
  function capture() {
    let status = 0;
    let body = '';
    const response = Object.assign(new EventEmitter(), {
      headersSent: false,
      writeHead(code: number) { status = code; this.headersSent = true; return this; },
      setHeader() {}, write(value: string) { body += value; return true; },
      end(value?: string) { body += value ?? ''; },
    }) as unknown as ServerResponse;
    return { response, get status() { return status; }, get body() { return body; } };
  }

  it('logs each refusal once with its code and provider and nothing else', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const busy = capture();
      refuseSpeech(busy.response, 'BUSY', 'eleven');
      expect(busy.status).toBe(429);
      expect(busy.body).toContain('BUSY');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenLastCalledWith('Shannon speech refused', { code: 'BUSY', provider: 'eleven' });

      // Through the route: the device's allowance is spent.
      const limited = capture();
      const request = Readable.from([JSON.stringify({ text: '秘密の文です。', provider: 'gemini' })]) as IncomingMessage;
      request.method = 'POST';
      const route = createGeminiSpeechRoute({ GEMINI_API_KEY: 'test-only' }, { recordLlmUsage() {} } as never, () => false);
      await route(request, limited.response, { deviceId: 'device-secret', scopeKey: 'owner' } as ShannonDevicePrincipal, 'stream');
      expect(limited.status).toBe(429);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenLastCalledWith('Shannon speech refused', { code: 'RATE_LIMITED', provider: 'gemini' });
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/秘密|device-secret/u);
    } finally {
      warn.mockRestore();
    }
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

it('returns provider-labelled Eleven PCM without exposing the private voice ID in headers', async () => {
  const request = new EventEmitter() as IncomingMessage;
  let headers: Record<string, string> = {};
  const response = Object.assign(new EventEmitter(), {
    writeHead: (_status: number, values: Record<string, string>) => { headers = values; },
    write: () => true, end: () => undefined,
  }) as unknown as ServerResponse;
  await streamSpeech(request, response, { stream: async () => ({
    contentType: 'audio/l16', sampleRate: 24_000, channels: 1, bitsPerSample: 16,
    model: 'eleven_v4_turbo', voice: 'private-voice-id', outputUsdPerTenSeconds: 0,
    chunks: (async function* () { yield new Uint8Array([1, 2]); })(),
  }) }, { scopeKey: 'synthetic-owner', text: 'おかえり' }, 'eleven');
  expect(headers['x-shannon-voice-engine']).toBe('eleven');
  expect(headers['x-shannon-voice-model']).toBe('eleven_v4_turbo');
  expect(headers['x-shannon-voice-name']).toBe('Shannon Clone 02');
  expect(headers['x-shannon-gemini-voice']).toBeUndefined();
  expect(JSON.stringify(headers)).not.toContain('private-voice-id');
});
