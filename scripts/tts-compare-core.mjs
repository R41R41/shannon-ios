import { once } from 'node:events';

export const MODELS = Object.freeze({
  gemini: ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'],
  eleven: ['eleven_v4_turbo', 'eleven_v4'],
});
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export class DemoError extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}

export function validateInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DemoError('INVALID_INPUT', 400);
  const provider = value.provider;
  if (!Object.hasOwn(MODELS, provider) || !MODELS[provider].includes(value.model)) {
    throw new DemoError('INVALID_MODEL', 400);
  }
  const text = bounded(value.text, 1, 1000);
  const voice = bounded(value.voice, 1, 200);
  if (!/^[A-Za-z0-9_.-]+$/.test(voice)) throw new DemoError('INVALID_VOICE', 400);
  const style = bounded(value.style ?? '', 0, 500);
  const tag = bounded(value.tag ?? '', 0, 80);
  if (tag && !/^(?:\[[A-Za-z _-]+\]\s*){1,3}$/.test(tag)) throw new DemoError('INVALID_TAG', 400);
  return { provider, model: value.model, text, voice, style, tag };
}

function bounded(value, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new DemoError('INVALID_INPUT', 400);
  }
  return value.trim();
}

export function decodePCM(encoded) {
  if (typeof encoded !== 'string' || !encoded || encoded.length % 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length > MAX_AUDIO_BYTES * 1.4) {
    throw new DemoError('INVALID_AUDIO');
  }
  const pcm = Buffer.from(encoded, 'base64');
  if (!pcm.length || pcm.length % 2 || pcm.length > MAX_AUDIO_BYTES) throw new DemoError('INVALID_AUDIO');
  if (pcm.subarray(0, 4).toString() === 'RIFF') throw new DemoError('INVALID_AUDIO');
  return pcm;
}

export function buildGeminiRequest(input) {
  return {
    model: input.model,
    input: [{ type: 'user_input', content: [{ type: 'text', text: input.text,
      annotations: [{ type: 'speech_metadata', style: input.style }] }] }],
    response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 },
    generation_config: { speech_config: [{ voice: input.voice }] },
    stream: true,
  };
}

export async function* readSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  function parse(block) {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return null;
    try { return JSON.parse(data); } catch { throw new DemoError('INVALID_UPSTREAM'); }
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      pending = pending.replace(/\r\n/g, '\n');
      if (pending.length > MAX_AUDIO_BYTES * 1.4) throw new DemoError('INVALID_UPSTREAM');
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const item = parse(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
        if (item) yield item;
      }
      if (done) break;
    }
    if (pending.trim()) { const item = parse(pending); if (item) yield item; }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function* geminiAudio(input, { apiKey, endpoint, fetcher = fetch, signal }) {
  if (!apiKey) throw new DemoError('GEMINI_NOT_CONFIGURED', 503);
  const upstream = await fetcher(endpoint ?? 'https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST', headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(buildGeminiRequest(input)), signal,
  });
  if (!upstream.ok) throw new DemoError(`GEMINI_HTTP_${upstream.status}`);
  if (!upstream.body) throw new DemoError('EMPTY_AUDIO');
  let completed = false;
  for await (const event of readSSE(upstream.body)) {
    if (event.event_type === 'error') throw new DemoError('GEMINI_GENERATION_FAILED');
    if (event.event_type === 'interaction.completed') {
      if (event.interaction?.status !== 'completed') throw new DemoError('GEMINI_STREAM_INCOMPLETE');
      completed = true;
    }
    if (event.event_type === 'step.delta' && event.delta?.type === 'audio') {
      yield { type: 'audio', pcm: decodePCM(event.delta.data) };
    }
  }
  if (!completed) throw new DemoError('GEMINI_STREAM_INCOMPLETE');
}

// A fresh connection per sample is deliberate: report its cost separately rather
// than labelling a subtracted handshake as a measured warm connection.
export async function* elevenAudio(input, { apiKey, socketFactory = url => new WebSocket(url), signal }) {
  if (!apiKey) throw new DemoError('ELEVEN_NOT_CONFIGURED', 503);
  signal?.throwIfAborted();
  const query = new URLSearchParams({ model_id: input.model, output_format: 'pcm_24000', language_code: 'ja' });
  const started = performance.now();
  const socket = socketFactory(`wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?${query}`);
  const queue = [];
  let wake;
  const push = event => { queue.push(event); wake?.(); wake = undefined; };
  const listeners = {
    open: () => push({ type: 'open' }),
    message: event => push({ type: 'message', data: event.data }),
    error: () => push({ type: 'error' }),
    close: () => push({ type: 'close' }),
  };
  for (const [name, listener] of Object.entries(listeners)) socket.addEventListener(name, listener);
  const abort = () => { push({ type: 'abort' }); try { socket.close(); } catch {} };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let final = false;
  try {
    while (!final) {
      if (!queue.length) await new Promise(resolve => { wake = resolve; });
      const event = queue.shift();
      signal?.throwIfAborted();
      if (event.type === 'open') {
        const connectionMs = performance.now() - started;
        socket.send(JSON.stringify({ voices: [input.voice], xi_api_key: apiKey }));
        socket.send(JSON.stringify({ inputs: [{ text: `${input.tag}${input.text}`, voice_id: input.voice, new_turn: false }] }));
        // close_socket flushes even a one-word answer without the 40-char buffer.
        socket.send(JSON.stringify({ close_socket: true }));
        yield { type: 'connected', connectionMs };
      } else if (event.type === 'message') {
        let message;
        if (typeof event.data !== 'string' || event.data.length > MAX_AUDIO_BYTES * 1.4) throw new DemoError('INVALID_UPSTREAM');
        try { message = JSON.parse(event.data); } catch { throw new DemoError('INVALID_UPSTREAM'); }
        if (message.error) throw new DemoError('ELEVEN_GENERATION_FAILED');
        if (message.audio) yield { type: 'audio', pcm: decodePCM(message.audio) };
        if (message.is_final === true) final = true;
      } else if (event.type === 'abort') {
        throw new DOMException('Cancelled', 'AbortError');
      } else if (event.type === 'close') {
        throw new DemoError('ELEVEN_STREAM_INCOMPLETE');
      } else throw new DemoError('ELEVEN_CONNECTION_FAILED');
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    for (const [name, listener] of Object.entries(listeners)) socket.removeEventListener(name, listener);
    try { socket.close(); } catch {}
  }
}

export async function writeFrame(response, frame, signal) {
  signal?.throwIfAborted();
  if (!response.write(`${JSON.stringify(frame)}\n`)) {
    await once(response, 'drain', { signal });
  }
}

export async function streamComparison(response, input, audio, signal) {
  const started = performance.now();
  let firstByteMs = null;
  let connectionMs = null;
  let submittedAt = started;
  let synthesisFirstByteMs = null;
  let bytes = 0;
  let chunks = 0;
  await writeFrame(response, { type: 'meta', provider: input.provider, model: input.model, voice: input.voice,
    sampleRate: 24000, bitsPerSample: 16, channels: 1, connection: input.provider === 'eleven' ? 'fresh-websocket' : 'http-request' }, signal);
  for await (const event of audio) {
    signal.throwIfAborted();
    if (event.type === 'connected') {
      connectionMs = event.connectionMs;
      submittedAt = performance.now();
      await writeFrame(response, { type: 'connected', connectionMs }, signal);
      continue;
    }
    bytes += event.pcm.length;
    if (bytes > MAX_AUDIO_BYTES) throw new DemoError('AUDIO_LIMIT');
    if (firstByteMs === null) {
      firstByteMs = performance.now() - started;
      synthesisFirstByteMs = performance.now() - submittedAt;
      await writeFrame(response, { type: 'first_audio', firstByteMs, synthesisFirstByteMs, connectionMs }, signal);
    }
    chunks++;
    await writeFrame(response, { type: 'audio', audio: event.pcm.toString('base64') }, signal);
  }
  if (!bytes || bytes % 2) throw new DemoError('EMPTY_AUDIO');
  await writeFrame(response, { type: 'complete', firstByteMs, synthesisFirstByteMs, connectionMs,
    elapsedMs: performance.now() - started, bytes, chunks, durationMs: bytes / 48 }, signal);
  response.end();
}
