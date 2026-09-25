#!/usr/bin/env node

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  audioBlockFromResponse,
  buildTTSRequest,
  buildVoiceDesignRequest,
  voiceSampleFromResponse,
  wavMetadata,
} from './gemini-tts-lab-core.mjs';
import {
  buildLiveTokenRequest,
  createRequestToken,
  GEMINI_LIVE_MODEL,
  InputError,
  isAllowedBrowserRequest,
  requestTokenMatches,
  safeUpstreamError,
  validateDeleteInput,
  validateDesignInput,
  validateLiveTokenInput,
  validateSampleInput,
} from './gemini-voice-lab-core.mjs';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const STATIC_ROOT = fileURLToPath(new URL('../tools/gemini-voice-lab/', import.meta.url));
const HOST = '127.0.0.1';
const PORT = boundedPort(process.env.SHANNON_GEMINI_VOICE_LAB_PORT, 4322);
const API_KEY = String(process.env.GEMINI_API_KEY ?? '').trim();
const REQUEST_TOKEN = createRequestToken();
const MAX_JSON_BYTES = 24_000;
const active = new Set();

if (!API_KEY) {
  process.stderr.write('Gemini voice lab: GEMINI_API_KEY is not configured\n');
  process.exit(1);
}

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/capture-worklet.js', ['capture-worklet.js', 'text/javascript; charset=utf-8']],
]);

const server = createServer(async (request, response) => {
  securityHeaders(response);
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (!isAllowedBrowserRequest({
      host: request.headers.host,
      origin: request.headers.origin,
      secFetchSite: request.headers['sec-fetch-site'],
    })) return json(response, 403, { error: 'This private lab is available only through its loopback SSH tunnel.' });

    if (request.method === 'GET' && staticFiles.has(url.pathname)) {
      const [file, contentType] = staticFiles.get(url.pathname);
      const body = await readFile(path.join(STATIC_ROOT, file));
      response.writeHead(200, { 'content-type': contentType, 'content-length': body.length });
      return response.end(body);
    }
    if (request.method === 'GET' && url.pathname === '/api/config') {
      return json(response, 200, {
        requestToken: REQUEST_TOKEN,
        liveModel: GEMINI_LIVE_MODEL,
        prices: {
          flashTTSUsdPer10Seconds: 0.00225,
          flashLiteTTSUsdPer10Seconds: 0.0015,
          liveInputUsdPerMinute: 0.005,
          liveOutputUsdPerMinute: 0.018,
          validThrough: '2026-12-31',
        },
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/voices') {
      return await withOperation(response, 'voices', async () => {
        const parameters = new URLSearchParams();
        parameters.append('language_code', 'ja-JP');
        parameters.set('page_size', '200');
        const upstream = await geminiJSON(`/voices?${parameters}`);
        const voices = Array.isArray(upstream.voices) ? upstream.voices : [];
        json(response, 200, { voices });
      });
    }

    if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (!requestTokenMatches(REQUEST_TOKEN, request.headers['x-shannon-request-token'])) {
        return json(response, 403, { error: 'The lab page is stale. Reload it and try again.' });
      }
      const body = await readJSON(request);
      if (url.pathname === '/api/sample') {
        return await withOperation(response, 'sample', async () => {
          const input = validateSampleInput(body);
          const started = performance.now();
          const upstream = await geminiJSON('/interactions', {
            method: 'POST',
            body: buildTTSRequest(input),
          });
          const { audio, mimeType } = audioBlockFromResponse(upstream);
          const wav = wavMetadata(audio);
          const elapsedMilliseconds = Math.round(performance.now() - started);
          response.writeHead(200, {
            'content-type': mimeType,
            'content-length': audio.length,
            'cache-control': 'no-store',
            'x-shannon-model': input.model,
            'x-shannon-voice': input.voice,
            'x-shannon-elapsed-ms': String(elapsedMilliseconds),
            'x-shannon-duration-ms': String(wav.durationMilliseconds),
          });
          response.end(audio);
          audit('sample.completed', { model: input.model, voice: input.voice, elapsedMilliseconds });
        });
      }
      if (url.pathname === '/api/design') {
        return await withOperation(response, 'design', async () => {
          const input = validateDesignInput(body);
          const upstream = await geminiJSON('/voices', {
            method: 'POST',
            body: buildVoiceDesignRequest(input),
          });
          const id = typeof upstream.id === 'string' ? upstream.id : '';
          if (!/^voice_[A-Za-z0-9_-]+$/u.test(id)) throw new Error('Gemini did not return a valid voice ID');
          const { audio, mimeType } = voiceSampleFromResponse(upstream);
          const wav = wavMetadata(audio);
          audit('design.completed', { model: upstream.model ?? 'default', voice: id });
          json(response, 200, {
            id,
            name: input.name,
            creationModel: typeof upstream.model === 'string' ? upstream.model : null,
            mimeType,
            durationMilliseconds: wav.durationMilliseconds,
            audioBase64: audio.toString('base64'),
          });
        });
      }
      if (url.pathname === '/api/delete') {
        return await withOperation(response, 'delete', async () => {
          const { id } = validateDeleteInput(body);
          await geminiJSON(`/voices/${encodeURIComponent(id)}`, { method: 'DELETE', allowEmpty: true });
          audit('design.deleted', { voice: id });
          json(response, 200, { deleted: id });
        });
      }
      if (url.pathname === '/api/live-token') {
        return await withOperation(response, 'live-token', async () => {
          const { voice } = validateLiveTokenInput(body);
          const now = Date.now();
          const expiresAt = new Date(now + 20 * 60_000).toISOString();
          const newSessionExpiresAt = new Date(now + 60_000).toISOString();
          const upstream = await geminiJSON('/auth_tokens', {
            method: 'POST',
            body: buildLiveTokenRequest({ expiresAt, newSessionExpiresAt }),
          });
          if (typeof upstream.name !== 'string' || upstream.name.length < 12) {
            throw new Error('Gemini did not return a valid ephemeral token');
          }
          audit('live-token.created', { model: GEMINI_LIVE_MODEL, voice });
          json(response, 200, { token: upstream.name, model: GEMINI_LIVE_MODEL, voice, expiresAt });
        });
      }
    }
    json(response, 404, { error: 'Not found' });
  } catch (error) {
    if (error instanceof InputError || error instanceof SyntaxError) {
      return json(response, 400, { error: safeMessage(error) });
    }
    audit('request.failed', { error: safeMessage(error) });
    if (!response.headersSent) json(response, 502, { error: safeMessage(error) });
    else response.destroy();
  }
});

server.listen(PORT, HOST, () => {
  audit('server.ready', { host: HOST, port: PORT });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

async function withOperation(response, name, work) {
  if (active.has(name)) return json(response, 429, { error: `${name} is already running` });
  active.add(name);
  try { return await work(); }
  finally { active.delete(name); }
}

async function geminiJSON(resource, { method = 'GET', body, allowEmpty = false } = {}) {
  const upstream = await fetch(`${API_ROOT}${resource}`, {
    method,
    headers: {
      'x-goog-api-key': API_KEY,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await upstream.text();
  if (!upstream.ok) throw new Error(`Gemini ${upstream.status}: ${safeUpstreamError(text)}`);
  if (!text.trim()) {
    if (allowEmpty) return {};
    throw new Error('Gemini returned an empty response');
  }
  try { return JSON.parse(text); }
  catch { throw new Error('Gemini returned a non-JSON response'); }
}

async function readJSON(request) {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new InputError('content-type must be application/json');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_JSON_BYTES) throw new InputError('request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
}

function securityHeaders(response) {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-security-policy', "default-src 'self'; connect-src 'self' wss://generativelanguage.googleapis.com; media-src 'self' blob: data:; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  response.setHeader('permissions-policy', 'camera=(), geolocation=(), microphone=(self)');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
}

function boundedPort(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1_024 && number <= 65_535 ? number : fallback;
}

function safeMessage(error) {
  return (error instanceof Error ? error.message : 'unknown failure')
    .replace(/AIza[A-Za-z0-9_-]+/gu, '[redacted-key]')
    .replace(/access_token=[^&\s]+/gu, 'access_token=[redacted]')
    .slice(0, 600);
}

function audit(event, fields = {}) {
  const safeFields = Object.entries(fields).map(([key, value]) => `${key}=${String(value).replace(/\s+/gu, '_').slice(0, 160)}`);
  process.stdout.write(`${new Date().toISOString()} gemini.voice_lab.${event}${safeFields.length ? ` ${safeFields.join(' ')}` : ''}\n`);
}
