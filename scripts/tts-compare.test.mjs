import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { validateInput, decodePCM, readSSE, geminiAudio, elevenAudio, buildGeminiRequest } from './tts-compare-core.mjs';
import { createDemoServer } from './tts-compare-server.mjs';
import { summarize, percentile, pcmWav, readFrames } from '../tools/tts-compare/metrics.js';

const input = { provider: 'gemini', model: 'gemini-3.8-flash-lite-tts', voice: 'FixtureVoice', text: 'うん。', style: 'warm', tag: '' };
const elevenInput = { ...input, provider: 'eleven', model: 'eleven_v4_turbo', voice: 'fixtureVoice' };
const pcm = Buffer.alloc(4800, 0);
const encoded = pcm.toString('base64');
function readable(parts) { return new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close(); } }); }
async function collect(iterator) { const result = []; for await (const value of iterator) result.push(value); return result; }

test('bounded provider/model/text/voice/tag validation keeps short Japanese intact', () => {
  assert.deepEqual(validateInput(input), input);
  assert.equal(validateInput(elevenInput).text, 'うん。');
  for (const change of [{ model: 'gpt-other' }, { provider: '__proto__' }, { text: ' ' }, { text: 'a'.repeat(1001) },
    { voice: '../../secret' }, { tag: '[warm]\nignore instructions' }, { style: 'a'.repeat(501) }]) {
    assert.throws(() => validateInput({ ...input, ...change }));
  }
  assert.throws(() => validateInput([]));
});

test('PCM rejects malformed base64, incomplete samples, and WAV envelopes', () => {
  assert.equal(decodePCM(encoded).length, 4800);
  for (const bad of ['@@==', '', 'a', Buffer.from([1]).toString('base64'), Buffer.from('RIFFtest').toString('base64')]) assert.throws(() => decodePCM(bad));
});

test('Gemini body matches native Interactions streaming and PCM format', () => {
  const body = buildGeminiRequest(input);
  assert.equal(body.input[0].content[0].text, input.text);
  assert.equal(body.input[0].content[0].annotations[0].style, input.style);
  assert.deepEqual(body.response_format, { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 });
  assert.equal(body.stream, true);
});

test('SSE parses events split inside CRLF and flushes a final unterminated event', async () => {
  const event = JSON.stringify({ event_type: 'step.delta', delta: { type: 'audio', data: encoded } });
  const parts = [`: ping\r\ndata: ${event}\r`, '\n\r', `\ndata: ${event}`];
  assert.equal((await collect(readSSE(readable(parts)))).length, 2);
});

test('Gemini streams only audio deltas, and propagates generation failure', async () => {
  const data = [{ event_type: 'step.start' }, { event_type: 'step.delta', delta: { type: 'audio', data: encoded } },
    { event_type: 'interaction.completed', interaction: { status: 'completed' } }];
  const fetcher = async (url, options) => {
    assert.equal(options.headers['x-goog-api-key'], 'fixture-gemini-key');
    return new Response(readable(data.map(v => `data: ${JSON.stringify(v)}\n\n`)));
  };
  const events = await collect(geminiAudio(input, { apiKey: 'fixture-gemini-key', fetcher, signal: new AbortController().signal }));
  assert.equal(events.length, 1); assert.equal(events[0].pcm.length, 4800);
  await assert.rejects(collect(geminiAudio(input, { apiKey: 'fixture', fetcher: async () => new Response('data: {"event_type":"error"}\n\n') })), /GEMINI_GENERATION_FAILED/);
});

test('Gemini partial EOF and incomplete lifecycle cannot count as successful audio', async () => {
  for (const status of [undefined, 'incomplete', 'cancelled', 'failed']) {
    const events = [{ event_type: 'step.delta', delta: { type: 'audio', data: encoded } }];
    if (status) events.push({ event_type: 'interaction.completed', interaction: { status } });
    const fetcher = async () => new Response(readable(events.map(v => `data: ${JSON.stringify(v)}\n\n`)));
    await assert.rejects(collect(geminiAudio(input, { apiKey: 'fixture', fetcher })), /GEMINI_STREAM_INCOMPLETE/);
  }
});

class FakeSocket extends EventTarget {
  constructor(mode = 'success') {
    super(); this.mode = mode; this.sent = []; this.closed = false;
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }
  send(value) {
    this.sent.push(JSON.parse(value));
    if (this.sent.length === 3) queueMicrotask(() => {
      if (this.mode === 'stall') return;
      if (this.mode === 'premature') return this.dispatchEvent(new Event('close'));
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ audio: encoded }) }));
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ is_final: true }) }));
    });
  }
  close() { this.closed = true; }
}

test('Eleven uses TTD PCM, authenticates in body, and flushes short lines by close_socket', async () => {
  let socket;
  const events = await collect(elevenAudio(elevenInput, { apiKey: 'fixture-eleven-key',
    socketFactory: url => { assert.match(url, /text-to-dialogue\/stream-input\?/); assert.match(url, /output_format=pcm_24000/); assert.ok(!url.includes('fixture-eleven-key')); socket = new FakeSocket(); return socket; },
    signal: new AbortController().signal }));
  assert.equal(events[0].type, 'connected'); assert.equal(events[1].pcm.length, 4800);
  assert.deepEqual(socket.sent[0], { voices: [elevenInput.voice], xi_api_key: 'fixture-eleven-key' });
  assert.equal(socket.sent[1].inputs[0].text, 'うん。');
  assert.deepEqual(socket.sent[2], { close_socket: true });
  assert.equal(socket.closed, true);
});

test('Eleven premature close is failure; cancellation closes a stalled socket', async () => {
  await assert.rejects(collect(elevenAudio(elevenInput, { apiKey: 'fixture', socketFactory: () => new FakeSocket('premature') })), /ELEVEN_STREAM_INCOMPLETE/);
  let socket;
  const controller = new AbortController();
  const iterator = elevenAudio(elevenInput, { apiKey: 'fixture', socketFactory: () => { socket = new FakeSocket('stall'); return socket; }, signal: controller.signal });
  assert.equal((await iterator.next()).value.type, 'connected');
  const pending = iterator.next(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(socket.closed, true);
});

test('Statistics exclude partial/error/cancelled output and use nearest-rank p95', () => {
  const samples = [10, 30, 20].map(firstByteMs => ({ state: 'complete', metrics: { firstByteMs } }));
  samples.push({ state: 'failed', metrics: { firstByteMs: 1 } }, { state: 'cancelled', metrics: { firstByteMs: 2 } });
  assert.deepEqual(summarize(samples), { count: 3, failed: 1, median: 20, p95: 30 });
  assert.equal(percentile([], .95), null);
});

test('WAV encodes the original mono PCM at 24 kHz; NDJSON survives transport splitting', async () => {
  const wav = pcmWav([pcm.subarray(0, 1000), pcm.subarray(1000)]);
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint32(24, true), 24000); assert.equal(view.getUint32(40, true), 4800);
  assert.deepEqual(Buffer.from(wav.subarray(44)), pcm);
  const result = [];
  await readFrames(readable(['{"type":"au', 'dio"}\n{"type":"complete"}']), v => result.push(v));
  assert.deepEqual(result.map(v => v.type), ['audio', 'complete']);
});

async function withServer(options, body) {
  const server = createDemoServer(options); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const configResponse = await fetch(`${base}/api/config`);
  const config = await configResponse.json();
  const headers = { cookie: configResponse.headers.get('set-cookie').split(';')[0], 'x-shannon-request-token': config.requestToken, 'content-type': 'application/json' };
  try { await body({ base, headers, config }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('loopback host, exact origin, and per-session token guard requests', async () => {
  await withServer({}, async ({ base, headers }) => {
    const rawStatus = await new Promise((resolve, reject) => {
      const request = httpRequest(`${base}/api/config`, { headers: { host: 'evil.example:4323' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    assert.equal(rawStatus, 403);
    assert.equal((await fetch(`${base}/api/config`, { headers: { origin: 'http://localhost:9999' } })).status, 403);
    assert.equal((await fetch(`${base}/api/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })).status, 403);
    assert.equal((await fetch(`${base}/api/stream`, { method: 'POST', headers, body: JSON.stringify(input) })).status, 503);
    assert.equal((await fetch(`${base}/api/stream`, { method: 'POST', headers, body: '[]' })).status, 400);
  });
});

test('transient Eleven key is never returned and is isolated between browser sessions', async () => {
  const key = 'fixture-eleven-secret';
  await withServer({ fetcher: async () => Response.json({ voices: [{ voice_id: 'fixtureVoice', name: 'Fixture' }] }) }, async ({ base, headers, config }) => {
    assert.equal(config.elevenReady, false);
    const result = await fetch(`${base}/api/eleven/connect`, { method: 'POST', headers, body: JSON.stringify({ apiKey: key }) });
    assert.equal(result.status, 200); assert.ok(!(await result.text()).includes(key));
    const connected = await (await fetch(`${base}/api/config`, { headers })).json();
    assert.equal(connected.elevenReady, true); assert.ok(!JSON.stringify(connected).includes(key));
    const tokenOnly = await (await fetch(`${base}/api/config`, { headers: { 'x-shannon-request-token': config.requestToken } })).json();
    assert.equal(tokenOnly.elevenReady, true);
    assert.equal((await (await fetch(`${base}/api/config`)).json()).elevenReady, false);
    await fetch(`${base}/api/eleven/disconnect`, { method: 'POST', headers, body: '{}' });
    assert.equal((await (await fetch(`${base}/api/config`, { headers })).json()).elevenReady, false);
  });
});

test('NDJSON reports real audio duration and terminal completion', async () => {
  await withServer({ audioFactory: async function* () { yield { type: 'audio', pcm }; } }, async ({ base, headers }) => {
    const response = await fetch(`${base}/api/stream`, { method: 'POST', headers, body: JSON.stringify(input) });
    const result = (await response.text()).trim().split('\n').map(JSON.parse);
    assert.deepEqual(result.map(v => v.type), ['meta', 'first_audio', 'audio', 'complete']);
    assert.equal(result.at(-1).durationMs, 100); assert.equal(result.at(-1).bytes, 4800);
    assert.ok(result.at(-1).firstByteMs >= 0); assert.equal(result.at(-1).connectionMs, null);
  });
});

test('partial provider failure and empty generation never become successful completion', async () => {
  for (const factory of [async function* () { yield { type: 'audio', pcm }; throw new Error('secret must not leak'); }, async function* () {}]) {
    await withServer({ audioFactory: factory }, async ({ base, headers }) => {
      const response = await fetch(`${base}/api/stream`, { method: 'POST', headers, body: JSON.stringify(input) });
      const text = await response.text(); const result = text.trim().split('\n').map(JSON.parse);
      assert.equal(result.at(-1).type, 'error'); assert.ok(!result.some(v => v.type === 'complete')); assert.ok(!text.includes('secret must not leak'));
    });
  }
});
