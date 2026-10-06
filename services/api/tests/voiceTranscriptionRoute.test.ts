import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createVoiceTranscriptionRoute } from '../src/surfaces/voice/transcriptionRoute.js';
import { VoiceTranscriptionError, type VoiceTranscriber } from '../src/infra/models/voiceTranscription.js';

/** The transcription route as `server.ts` serves it, moved to `surfaces/voice` unchanged. */
let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

async function serve(transcriber: VoiceTranscriber | null, options: { allowed?: boolean; paired?: boolean } = {}) {
  const route = createVoiceTranscriptionRoute({ transcriber, allowances: { consumeControl: () => options.allowed ?? true } });
  server = createServer((request, response) => { void route(request, response, options.paired === false ? null : { scopeKey: 'owner', deviceId: 'device-1' } as never); });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return (method: string) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: '/v1/voice/transcriptions', method, headers: { 'content-type': 'audio/m4a', 'x-shannon-audio-duration-ms': '1200' } }, response => {
      let text = '';
      response.on('data', chunk => { text += String(chunk); });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }));
    });
    request.on('error', reject);
    request.end(method === 'POST' ? Buffer.from([1, 2, 3]) : undefined);
  });
}

const transcriber = (result: () => Promise<{ text: string }>): VoiceTranscriber => ({ transcribe: result } as unknown as VoiceTranscriber);

describe('the voice transcription route', () => {
  it('answers as it did inside server.ts', async () => {
    expect((await (await serve(transcriber(async () => ({ text: 'こんにちは' }))))('POST'))).toEqual({ status: 200, body: { text: 'こんにちは' } });
    server?.close();
    expect((await (await serve(null))('POST')).status).toBe(503);
    server?.close();
    expect((await (await serve(null, { paired: false }))('POST')).body).toEqual({ error: 'PAIRED_DEVICE_REQUIRED' });
    server?.close();
    expect((await (await serve(null))('GET')).body).toEqual({ error: 'METHOD_NOT_ALLOWED' });
    server?.close();
    expect((await (await serve(transcriber(async () => ({ text: 'x' })), { allowed: false }))('POST')).status).toBe(429);
    server?.close();
    const capped = await (await serve(transcriber(async () => { throw new VoiceTranscriptionError('VOICE_DAILY_BUDGET_EXHAUSTED'); })))('POST');
    expect(capped).toEqual({ status: 429, body: { error: 'VOICE_DAILY_BUDGET_EXHAUSTED', message: '今日は音声入力を十分使いました。テキスト入力は引き続き使えます。' } });
  });
});
