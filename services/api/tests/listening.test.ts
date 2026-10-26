import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ShannonDevicePrincipal } from '../src/infra/auth/deviceAuth.js';
import { durationSeconds, GroqTranscriber, GroqTranscriptionError, retryAfterOf, wavDurationMs, type ListenTranscriber } from '../src/infra/models/groqTranscription.js';
import { ListenUsage } from '../src/infra/models/listenUsage.js';
import { OpenAITranscriptionGateway } from '../src/infra/models/openaiTranscriptionSession.js';
import { createListenRoute, LISTEN_PATH } from '../src/surfaces/voice/listenRoute.js';
import { Listening } from '../src/infra/models/listening.js';

/** Listening (owner 2026-10-26, docs/listening-contract.md). No provider is called: Groq and OpenAI are fakes. */
function wav(ms: number): Uint8Array {
  const bytes = Math.round(ms * 32);
  const out = new Uint8Array(44 + bytes);
  const view = new DataView(out.buffer);
  const text = (offset: number, value: string) => { for (let index = 0; index < 4; index += 1) out[offset + index] = value.charCodeAt(index); };
  text(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, bytes, true);
  return out;
}

function transcriber(answers: Array<string | GroqTranscriptionError>): ListenTranscriber & { calls: number } {
  const fake = {
    model: 'fake', calls: 0,
    async transcribe() {
      fake.calls += 1;
      const answer = answers.shift() ?? 'はい';
      if (answer instanceof GroqTranscriptionError) throw answer;
      return { status: 'ok' as const, text: answer, ms: 5 };
    },
  };
  return fake;
}

describe('Groq transcription', () => {
  it('reads a WAV length and Groq\'s durations, and when it may be asked again', () => {
    expect(wavDurationMs(wav(1_500))).toBe(1_500);
    expect(wavDurationMs(new Uint8Array(10))).toBeNull();
    expect(durationSeconds('2m59.56s')).toBeCloseTo(179.56);
    expect(durationSeconds('30')).toBe(30);
    expect(durationSeconds('1h')).toBe(3_600);
    expect(durationSeconds('soon')).toBeNull();
    expect(retryAfterOf(new Headers({ 'retry-after': '12', 'x-ratelimit-reset-requests': '1m0s' }))).toBe(60);
    expect(retryAfterOf(new Headers())).toBeUndefined();
  });

  it('tells a limit, a used-up quota and no answer apart from a refused request', async () => {
    const answer = (status: number, body = '', headers: Record<string, string> = {}) =>
      new GroqTranscriber('key', { fetcher: (async () => new Response(body, { status, headers })) as typeof fetch });
    const code = async (groq: GroqTranscriber) => groq.transcribe(wav(1_000)).then(() => 'ok', (error: GroqTranscriptionError) => `${error.code}:${error.retryAfterSeconds ?? '-'}`);
    expect(await code(answer(429, '', { 'retry-after': '7' }))).toBe('GROQ_RATE_LIMITED:7');
    expect(await code(answer(402))).toBe('GROQ_QUOTA:-');
    expect(await code(answer(400, '{"error":{"message":"You exceeded your current quota"}}'))).toBe('GROQ_QUOTA:-');
    expect(await code(answer(503))).toBe('GROQ_UNREACHABLE:-');
    expect(await code(answer(400, '{"error":{"message":"file is invalid"}}'))).toBe('GROQ_FAILED:-');
    const unreachable = new GroqTranscriber('key', { fetcher: (async () => { throw new Error('offline'); }) as typeof fetch });
    expect(await code(unreachable)).toBe('GROQ_UNREACHABLE:-');
    const heard = new GroqTranscriber('key', { fetcher: (async () => Response.json({ text: ' ご視聴ありがとうございました ' })) as typeof fetch });
    expect(await heard.transcribe(wav(1_000))).toMatchObject({ status: 'hallucination' });
  });
});

describe('Listening: Groq while it answers, the way it was when it does not', () => {
  it('pauses Groq for as long as it asks, then asks again and logs each change of way once', async () => {
    let clock = 1_000_000;
    const lines: string[] = [];
    const groq = transcriber([new GroqTranscriptionError('GROQ_RATE_LIMITED', 429, 30), 'ただいま']);
    const listening = new Listening(groq, new ListenUsage(undefined, null, () => clock), () => clock, line => lines.push(line));
    expect(await listening.transcribe(wav(1_000), 1_000, 'windows')).toMatchObject({ status: 'unavailable', reason: 'GROQ_RATE_LIMITED', retryAfterSeconds: 30 });
    clock += 10_000;
    expect(await listening.transcribe(wav(1_000), 1_000, 'discord')).toMatchObject({ status: 'unavailable', retryAfterSeconds: 20 });
    expect(groq.calls).toBe(1);
    clock += 21_000;
    expect(await listening.transcribe(wav(1_000), 1_000, 'windows')).toMatchObject({ status: 'ok', text: 'ただいま' });
    expect(groq.calls).toBe(2);
    expect(lines).toEqual([expect.stringContaining('way=fallback reason=GROQ_RATE_LIMITED retryAfter=30s'), expect.stringContaining('way=groq')]);
  });

  it('grows the pause when Groq says nothing of when, and fails one utterance only for a refused request', async () => {
    let clock = 0;
    const groq = transcriber([new GroqTranscriptionError('GROQ_UNREACHABLE'), new GroqTranscriptionError('GROQ_QUOTA', 402), new GroqTranscriptionError('GROQ_FAILED', 400), 'うん']);
    const listening = new Listening(groq, new ListenUsage(undefined, null, () => clock), () => clock, () => undefined);
    expect(await listening.transcribe(wav(1_000), 1_000, 'windows')).toMatchObject({ status: 'unavailable', retryAfterSeconds: 60 });
    clock += 61_000;
    expect(await listening.transcribe(wav(1_000), 1_000, 'windows')).toMatchObject({ status: 'unavailable', reason: 'GROQ_QUOTA', retryAfterSeconds: 300 });
    clock += 301_000;
    expect(await listening.transcribe(wav(1_000), 1_000, 'windows')).toMatchObject({ status: 'error' });
    expect(await listening.transcribe(wav(1_000), 1_000, 'windows')).toMatchObject({ status: 'ok' });
  });

  it('keeps to the shared allowance and says when it opens again, without asking Groq', async () => {
    const clock = Date.UTC(2026, 9, 26, 3, 0, 0);
    const groq = transcriber([]);
    const usage = new ListenUsage({ perMinute: 2, perDay: 100, audioSecondsPerHour: 1_000, audioSecondsPerDay: 1_000 }, null, () => clock);
    const listening = new Listening(groq, usage, () => clock, () => undefined);
    await listening.transcribe(wav(1_000), 1_000, 'windows');
    await listening.transcribe(wav(1_000), 1_000, 'discord');
    expect(await listening.transcribe(wav(1_000), 1_000, 'windows')).toMatchObject({ status: 'limited', limited: 'minute', retryAfterSeconds: 60 });
    expect(groq.calls).toBe(2);
    expect(usage.today()).toMatchObject({ requests: 2, billedSeconds: 20, bySource: { windows: 1, discord: 1 }, limited: 'minute' });
    expect(await listening.transcribe(wav(200), 200, 'windows')).toMatchObject({ status: 'empty' });
  });
});

describe('POST /v1/voice/listen', () => {
  const servers: Server[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
  const principal = { deviceId: 'desk-1', scopeKey: 'owner' } as unknown as ShannonDevicePrincipal;

  async function serve(listening: Listening | null) {
    const route = createListenRoute({ listening, judge: null });
    const server = createServer((request, response) => { void route(request, response, principal); });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${LISTEN_PATH}`;
    return async (body: unknown) => {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
  }
  const audio = (ms: number) => Buffer.from(wav(ms)).toString('base64');

  it('answers with the words only when she answers, and says when Groq is away', async () => {
    expect((await (await serve(null))({ audio: audio(1_000) })).status).toBe(503);
    const groq = transcriber(['シャノン、ただいま', '今日は疲れた', new GroqTranscriptionError('GROQ_RATE_LIMITED', 429, 45)]);
    const call = await serve(new Listening(groq, new ListenUsage(undefined, null), Date.now, () => undefined));
    expect(await call({ audio: audio(1_000) })).toMatchObject({ status: 200, body: { heard: true, respond: true, text: 'シャノン、ただいま' } });
    const quiet = await call({ audio: audio(1_000) });
    expect(quiet.body).toMatchObject({ heard: true, respond: false });
    expect(quiet.body.text).toBeUndefined();
    expect(await call({ audio: audio(1_000) })).toMatchObject({ body: { respond: false, degraded: 'groq_unavailable', reason: 'GROQ_RATE_LIMITED', retryAfterSeconds: 45 } });
    expect((await call({ audio: 'not base64!' })).status).toBe(400);
    expect((await call({ audio: audio(31_000) })).status).toBe(400);
  });
});

describe('gpt-live-transcribe for a client that ends its own turns', () => {
  function gateway(statuses: number[]) {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const status = statuses.shift() ?? 200;
      return status === 200 ? new Response(JSON.stringify({ value: 'ek_synthetic_client_secret_value' })) : new Response('{"error":{"message":"no"}}', { status });
    }) as unknown as typeof fetch;
    return { bodies, gateway: new OpenAITranscriptionGateway({ apiKey: 'sk-test', fetcher }) };
  }
  const input = (body: Record<string, unknown>) => ((body.session as Record<string, unknown>).audio as Record<string, Record<string, unknown>>).input!;

  it('mints the live model without turn detection, and the detected model for everyone else or when it is refused', async () => {
    const { bodies, gateway: live } = gateway([200, 200]);
    expect(await live.createSession({ platform: 'windows', manualTurns: true })).toMatchObject({ model: 'gpt-live-transcribe', turnDetection: 'manual', inputUsdPerMinute: 0.017 });
    expect(input(bodies[0]!)).toMatchObject({ turn_detection: null, transcription: { model: 'gpt-live-transcribe' } });
    expect(await live.createSession({ platform: 'ios' })).toMatchObject({ model: 'gpt-4o-mini-transcribe', turnDetection: 'server' });
    const refused = gateway([400, 200, 200]);
    expect(await refused.gateway.createSession({ platform: 'windows', manualTurns: true })).toMatchObject({ model: 'gpt-4o-mini-transcribe', turnDetection: 'semantic' });
    expect(await refused.gateway.createSession({ platform: 'windows', manualTurns: true })).toMatchObject({ turnDetection: 'semantic' });
    expect(refused.bodies).toHaveLength(3);
  });
});
