#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DemoError, validateInput, geminiAudio, elevenAudio, streamComparison, writeFrame, MODELS } from './tts-compare-core.mjs';

const STATIC_ROOT = new URL('../tools/tts-compare/', import.meta.url);
const STATIC = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']], ['/metrics.js', ['metrics.js', 'text/javascript']]]);

export function allowedBrowser(request) {
  const host = String(request.headers.host ?? '');
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(host)) return false;
  if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) return false;
  if (request.headers.origin && request.headers.origin !== `http://${host}`) return false;
  return true;
}

export function createDemoServer({ environment = process.env, fetcher = fetch, socketFactory, audioFactory } = {}) {
  const sessions = new Map();
  const ttl = 30 * 60 * 1000;
  const geminiKey = environment.GEMINI_API_KEY?.trim();
  const defaultElevenKey = environment.ELEVENLABS_API_KEY?.trim();
  const geminiModel = MODELS.gemini.includes(environment.SHANNON_GEMINI_TTS_MODEL)
    ? environment.SHANNON_GEMINI_TTS_MODEL : MODELS.gemini[0];
  const defaultVoice = environment.SHANNON_GEMINI_TTS_VOICE ?? 'Leda';
  const defaultStyle = environment.SHANNON_GEMINI_TTS_STYLE ?? 'warm, naturally cute, intimate, and conversational Japanese without sounding childish or theatrical';
  function sessionFor(request, response) {
    // Some browser contexts partition loopback cookies. The random per-page
    // request token is also a session capability; require it on every operation.
    const token = request.headers['x-shannon-request-token'];
    if (typeof token === 'string') {
      const owned = [...sessions.values()].find(value => value.token === token && performance.now() - value.touched < ttl);
      if (owned) { owned.touched = performance.now(); return owned; }
    }
    const id = /(?:^|;\s*)tts_demo=([A-Za-z0-9_-]+)/.exec(request.headers.cookie ?? '')?.[1];
    const saved = sessions.get(id);
    if (saved && performance.now() - saved.touched < ttl) { saved.touched = performance.now(); return saved; }
    const newID = randomBytes(24).toString('base64url');
    const session = { token: randomBytes(24).toString('base64url'), touched: performance.now(), active: false, elevenKey: defaultElevenKey };
    sessions.set(newID, session);
    response.setHeader('set-cookie', `tts_demo=${newID}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`);
    return session;
  }
  const prune = setInterval(() => {
    for (const [id, value] of sessions) if (!value.active && performance.now() - value.touched > ttl) sessions.delete(id);
  }, 60000).unref();
  async function upstreamJSON(url, apiKey, provider, signal = AbortSignal.timeout(12000)) {
    const response = await fetcher(url, { headers: provider === 'eleven' ? { 'xi-api-key': apiKey } : { 'x-goog-api-key': apiKey }, signal });
    if (!response.ok) { await response.body?.cancel(); throw new DemoError(`${provider.toUpperCase()}_HTTP_${response.status}`); }
    return await response.json();
  }
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const controller = new AbortController();
    const aborted = () => { if (!response.writableEnded) controller.abort(); };
    request.once('aborted', aborted);
    response.once('close', aborted);
    try {
      if (!allowedBrowser(request)) throw new DemoError('LOOPBACK_ONLY', 403);
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (request.method === 'GET' && STATIC.has(url.pathname)) {
        const [file, type] = STATIC.get(url.pathname);
        response.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
        return response.end(await readFile(new URL(file, STATIC_ROOT)));
      }
      const session = sessionFor(request, response);
      if (request.method === 'GET' && url.pathname === '/api/config') {
        return json(response, 200, { demo: 'shannon-tts-compare', requestToken: session.token, geminiReady: Boolean(geminiKey), elevenReady: Boolean(session.elevenKey),
          geminiModel, geminiVoice: defaultVoice, geminiStyle: defaultStyle,
          location: environment.SHANNON_TTS_COMPARE_LOCATION ?? 'ローカル', models: MODELS });
      }
      const received = Buffer.from(String(request.headers['x-shannon-request-token'] ?? ''));
      const expected = Buffer.from(session.token);
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new DemoError('RELOAD_PAGE', 403);
      if (request.method === 'GET' && url.pathname === '/api/voices') {
        const provider = url.searchParams.get('provider');
        if (provider === 'gemini') {
          if (!geminiKey) throw new DemoError('GEMINI_NOT_CONFIGURED', 503);
          const result = await upstreamJSON('https://generativelanguage.googleapis.com/v1beta/voices?language_code=ja-JP&page_size=200', geminiKey, provider);
          const voices = (result.voices ?? []).map(v => ({ id: v.id ?? v.name, name: v.display_name ?? v.displayName ?? v.name ?? v.id }));
          return json(response, 200, { voices });
        }
        if (provider !== 'eleven') throw new DemoError('INVALID_INPUT', 400);
        if (!session.elevenKey) throw new DemoError('ELEVEN_NOT_CONFIGURED', 503);
        const result = await upstreamJSON('https://api.elevenlabs.io/v2/voices?page_size=100', session.elevenKey, provider);
        return json(response, 200, { voices: (result.voices ?? []).map(v => ({ id: v.voice_id, name: v.name })) });
      }
      if (request.method !== 'POST') throw new DemoError('NOT_FOUND', 404);
      const body = await readJSON(request);
      if (url.pathname === '/api/eleven/connect') {
        if (session.active) throw new DemoError('BUSY', 409);
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
        if (apiKey.length < 12 || apiKey.length > 300 || /\s/.test(apiKey)) throw new DemoError('INVALID_KEY', 400);
        const result = await upstreamJSON('https://api.elevenlabs.io/v2/voices?page_size=100', apiKey, 'eleven');
        session.elevenKey = apiKey;
        return json(response, 200, { connected: true, voices: (result.voices ?? []).map(v => ({ id: v.voice_id, name: v.name })) });
      }
      if (url.pathname === '/api/eleven/disconnect') {
        if (session.active) throw new DemoError('BUSY', 409);
        session.elevenKey = undefined;
        return json(response, 200, { connected: false });
      }
      if (url.pathname !== '/api/stream') throw new DemoError('NOT_FOUND', 404);
      const input = validateInput(body);
      if (session.active) throw new DemoError('BUSY', 409);
      if (!audioFactory && !(input.provider === 'gemini' ? geminiKey : session.elevenKey)) {
        throw new DemoError(`${input.provider.toUpperCase()}_NOT_CONFIGURED`, 503);
      }
      session.active = true;
      response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'x-accel-buffering': 'no' });
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]);
      try {
        const audio = audioFactory ? audioFactory(input, signal) : input.provider === 'gemini'
          ? geminiAudio(input, { apiKey: geminiKey, endpoint: environment.SHANNON_GEMINI_TTS_ENDPOINT, fetcher, signal })
          : elevenAudio(input, { apiKey: session.elevenKey, socketFactory, signal });
        await streamComparison(response, input, audio, signal);
      } finally { session.active = false; session.touched = performance.now(); }
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error instanceof DemoError ? error.code : error.name === 'TimeoutError' ? 'TIMEOUT' : 'REQUEST_FAILED';
      if (response.headersSent) {
        if (!response.writableEnded && !response.destroyed) { await writeFrame(response, { type: 'error', code }).catch(() => {}); response.end(); }
      } else json(response, error instanceof DemoError ? error.status : 502, { error: code });
    } finally { request.off('aborted', aborted); response.off('close', aborted); }
  });
  server.on('close', () => { clearInterval(prune); sessions.clear(); });
  server.requestTimeout = 95000;
  return server;
}

async function readJSON(request) {
  if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) throw new DemoError('INVALID_INPUT', 400);
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 16000) throw new DemoError('INVALID_INPUT', 400);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new DemoError('INVALID_INPUT', 400); }
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.SHANNON_TTS_COMPARE_PORT ?? 4323);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid demo port');
  const server = createDemoServer();
  server.listen(port, '127.0.0.1', () => process.stdout.write(`TTS comparison demo: http://127.0.0.1:${port}\n`));
  const stop = () => { clearInterval(parentGuard); server.close(); server.closeAllConnections(); };
  const parentPID = process.ppid;
  const parentGuard = process.env.SHANNON_TTS_COMPARE_PARENT_GUARD === '1' ? setInterval(() => {
    try { process.kill(parentPID, 0); } catch { stop(); }
  }, 1000).unref() : undefined;
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(name, stop);
}
