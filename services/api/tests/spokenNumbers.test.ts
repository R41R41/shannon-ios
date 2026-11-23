import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spokenNumbers } from '../src/infra/models/spokenNumbers.js';
import { ElevenSpeechGateway } from '../src/infra/models/elevenSpeech.js';
import { GoogleGeminiSpeechGateway } from '../src/infra/models/geminiSpeech.js';
import { CallVoiceSpeechGateway } from '../src/infra/models/callVoiceSpeech.js';
import { createGeminiSpeechRoute } from '../src/surfaces/voice/serverGeminiSpeechRoute.js';
import type { ShannonDevicePrincipal } from '../src/infra/auth/deviceAuth.js';

describe('spokenNumbers', () => {
  it.each([
    ['体力5/20', '体力、20のうち5'],
    ['体力が5/20まで減っちゃった', '体力が、20のうち5まで減っちゃった'],
    ['体力 4/20、やばい', '体力、20のうち4、やばい'],
    ['満腹度が14/20まで下がった', '満腹度が、20のうち14まで下がった'],
    ['HP 7/20', 'HP、20のうち7'],
    ['体力 4.5/20', '体力、20のうち4.5'],
    ['体力 0/20', '体力、20のうち0'],
    ['体力は 20/20', '体力は、全部'],
    ['体力 5 / 20', '体力、20のうち5'],
    ['体力5/20、満腹度12/20', '体力、20のうち5、満腹度、20のうち12'],
    ['[whispers] 体力5/20', '[whispers] 体力、20のうち5'],
    ['羊毛 3/3個', '羊毛 3個とも'],
    ['骨粉 12/64個', '骨粉、64個のうち12個'],
  ])('reads %s as %s', (written, spoken) => {
    expect(spokenNumbers(written)).toBe(spoken);
  });

  it.each([
    '5/20',
    '10/20 に集合',
    '12:30に会おう',
    '(-58, 85)',
    '座標は 120, 64, -300',
    '11/24の夜',
    '今日は11/24だよ',
    '2026/11/24 に撮影',
    '2026/11/24 体力満タン',
    'https://example.com/5/20',
    '/usr/local/5/20/bin',
    '体力が減った',
    '1/2個',
    '1/3本',
    '体力5/20/3',
    '[whispers] ふふ',
    '',
  ])('leaves %s alone', text => {
    expect(spokenNumbers(text)).toBe(text);
  });

  it('is idempotent', () => {
    const once = spokenNumbers('体力が5/20まで減った。骨粉 12/64個');
    expect(spokenNumbers(once)).toBe(once);
  });
});

function sse(): Response {
  const body = `data: ${JSON.stringify({ event_type: 'step.delta', delta: { type: 'audio', data: Buffer.alloc(2_400, 1).toString('base64') } })}\n\n`
    + `data: ${JSON.stringify({ event_type: 'interaction.completed' })}\n\n`;
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

async function drain(chunks: AsyncIterable<Uint8Array>): Promise<void> { for await (const chunk of chunks) void chunk; }

describe('every route to a voice reads the count', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const written = '体力が5/20まで減っちゃった';
  const spoken = '体力が、20のうち5まで減っちゃった';

  it('ElevenLabs stream', async () => {
    const sent: string[] = [];
    const handlers = new Map<string, Array<(event: Event) => void>>();
    const socket = {
      send: (value: string) => { sent.push(value); }, close: () => undefined,
      addEventListener: (type: string, listener: (event: Event) => void) => { handlers.set(type, [...handlers.get(type) ?? [], listener]); },
      removeEventListener: () => undefined,
    };
    const gateway = new ElevenSpeechGateway('test-secret', 'testvoice123', { socketFactory: () => socket as never });
    const speech = await gateway.stream({ scopeKey: 'owner', text: written });
    const next = speech.chunks[Symbol.asyncIterator]().next();
    for (const handler of handlers.get('open') ?? []) handler(new Event('open'));
    await Promise.resolve();
    for (const handler of handlers.get('message') ?? []) handler(Object.assign(new Event('message'), { data: JSON.stringify({ is_final: true }) }));
    await next.catch(() => undefined);
    expect(JSON.parse(sent[1] ?? '{}').inputs[0].text).toBe(spoken);
  });

  it('Gemini direct (synthesize and stream)', async () => {
    const texts: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      texts.push((JSON.parse(String(init?.body)) as { input: Array<{ content: Array<{ text: string }> }> }).input[0]!.content[0]!.text);
      return sse();
    };
    const gateway = new GoogleGeminiSpeechGateway({ apiKey: 'test-only', voice: 'voice_test', model: 'gemini-3.8-flash-tts', fetcher });
    await drain((await gateway.stream({ scopeKey: 'owner', text: written })).chunks);
    await gateway.synthesize({ scopeKey: 'owner', text: written }).catch(() => undefined);
    expect(texts).toEqual([spoken, spoken]);
  });

  it('the Gemini side of the call voice', async () => {
    let text = '';
    const fetcher: typeof fetch = async (_input, init) => {
      text = (JSON.parse(String(init?.body)) as { input: Array<{ content: Array<{ text: string }> }> }).input[0]!.content[0]!.text;
      return sse();
    };
    const inner = new GoogleGeminiSpeechGateway({ apiKey: 'test-only', voice: 'voice_test', model: 'gemini-3.8-flash-tts', fetcher });
    const gateway = new CallVoiceSpeechGateway(inner, '核の演技');
    await drain((await gateway.stream({ scopeKey: 'owner', text: `[whispers] ${written}` })).chunks);
    expect(text).toBe(spoken);
  });

  it('the server read-aloud route used by the desktop and the phone', async () => {
    let text = '';
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      text = (JSON.parse(String(init?.body)) as { input: Array<{ content: Array<{ text: string }> }> }).input[0]!.content[0]!.text;
      return sse();
    });
    const route = createGeminiSpeechRoute({ GEMINI_API_KEY: 'test-only' }, { recordLlmUsage() {} } as never, () => true);
    const request = Readable.from([JSON.stringify({ text: written, provider: 'gemini' })]) as IncomingMessage;
    request.method = 'POST';
    const response = Object.assign(new EventEmitter(), {
      headersSent: false, writeHead() { return this; }, setHeader() {}, write: () => true, end: () => undefined,
    }) as unknown as ServerResponse;
    await route(request, response, { deviceId: 'device', scopeKey: 'owner' } as ShannonDevicePrincipal, 'stream');
    expect(text).toBe(spoken);
  });
});
