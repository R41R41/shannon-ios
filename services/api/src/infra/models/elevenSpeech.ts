import { normalizedSpeechText } from './geminiSpeech.js';
import type { GeminiSpeechRequest, GeminiSpeechStreamResult } from './geminiSpeech.js';

const maximumAudioBytes = 8 * 1024 * 1024;
const endpoint = 'wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input';

interface SpeechSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: Event) => void): void;
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: Event) => void): void;
}

type SocketFactory = (url: string) => SpeechSocket;

export class ElevenSpeechError extends Error {
  constructor(readonly code: 'ELEVEN_SPEECH_NOT_CONFIGURED' | 'ELEVEN_SPEECH_INVALID_STYLE' | 'ELEVEN_SPEECH_FAILED') {
    super(code);
  }
}

export function validatedElevenTags(value: string | undefined): string {
  if (!value) return '';
  const tags = value.trim();
  if (tags.length > 160 || !/^(?:\[[A-Za-z ,_-]+\]\s*){1,3}$/.test(tags)) {
    throw new ElevenSpeechError('ELEVEN_SPEECH_INVALID_STYLE');
  }
  return `${tags} `;
}

function decodeAudio(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0 ||
      value.length > maximumAudioBytes * 1.4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new ElevenSpeechError('ELEVEN_SPEECH_FAILED');
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length % 2 !== 0 || bytes.length > maximumAudioBytes ||
      bytes.subarray(0, 4).toString() === 'RIFF') {
    throw new ElevenSpeechError('ELEVEN_SPEECH_FAILED');
  }
  return bytes;
}

export class ElevenSpeechGateway {
  readonly model = 'eleven_v4_turbo';
  readonly voice: string;
  private readonly socketFactory: SocketFactory;
  private readonly timeoutMilliseconds: number;

  constructor(
    private readonly apiKey: string,
    voiceId: string,
    options: { socketFactory?: SocketFactory; timeoutMilliseconds?: number } = {},
  ) {
    if (!apiKey.trim() || !/^[A-Za-z0-9_-]{8,100}$/.test(voiceId)) {
      throw new ElevenSpeechError('ELEVEN_SPEECH_NOT_CONFIGURED');
    }
    this.voice = voiceId;
    this.socketFactory = options.socketFactory ?? (url => new WebSocket(url));
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 60_000;
  }

  async stream(request: GeminiSpeechRequest, signal?: AbortSignal): Promise<GeminiSpeechStreamResult> {
    const text = normalizedSpeechText(request.text);
    const tags = validatedElevenTags(request.style);
    const params = new URLSearchParams({
      model_id: this.model, output_format: 'pcm_24000', language_code: 'ja',
    });
    let socket: SpeechSocket;
    try { socket = this.socketFactory(`${endpoint}?${params}`); }
    catch { throw new ElevenSpeechError('ELEVEN_SPEECH_FAILED'); }
    return {
      contentType: 'audio/l16', sampleRate: 24_000, channels: 1, bitsPerSample: 16,
      model: this.model, voice: this.voice, outputUsdPerTenSeconds: 0,
      chunks: this.audioChunks(socket, `${tags}${text}`, signal),
    };
  }

  private async *audioChunks(socket: SpeechSocket, text: string, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    type EventItem = { type: 'open' | 'message' | 'error' | 'close' | 'abort' | 'timeout'; data?: unknown; size?: number };
    const queue: EventItem[] = [];
    let queuedBytes = 0;
    let wake: (() => void) | undefined;
    const push = (item: EventItem) => {
      if (item.type === 'message') {
        item.size = typeof item.data === 'string' ? item.data.length : 0;
        queuedBytes += item.size;
        if (queuedBytes > maximumAudioBytes * 1.4) {
          queue.length = 0;
          queue.push({ type: 'error' });
          try { socket.close(); } catch { /* already closed */ }
          wake?.(); wake = undefined;
          return;
        }
      }
      queue.push(item); wake?.(); wake = undefined;
    };
    const listeners = {
      open: () => push({ type: 'open' }),
      message: (event: Event) => push({ type: 'message', data: (event as MessageEvent).data }),
      error: () => push({ type: 'error' }),
      close: () => push({ type: 'close' }),
    };
    for (const [type, listener] of Object.entries(listeners)) {
      socket.addEventListener(type as keyof typeof listeners, listener);
    }
    const abort = () => { push({ type: 'abort' }); try { socket.close(); } catch { /* already closed */ } };
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => { push({ type: 'timeout' }); socket.close(); }, this.timeoutMilliseconds);
    if (signal?.aborted) abort();
    let totalBytes = 0;
    let complete = false;
    try {
      while (!complete) {
        if (!queue.length) await new Promise<void>(resolve => { wake = resolve; });
        const event = queue.shift();
        queuedBytes -= event?.size ?? 0;
        if (signal?.aborted) throw new ElevenSpeechError('ELEVEN_SPEECH_FAILED');
        if (event?.type === 'open') {
          try {
            socket.send(JSON.stringify({ voices: [this.voice], xi_api_key: this.apiKey }));
            socket.send(JSON.stringify({ inputs: [{ text, voice_id: this.voice, new_turn: false }] }));
            socket.send(JSON.stringify({ close_socket: true }));
          } catch { throw new ElevenSpeechError('ELEVEN_SPEECH_FAILED'); }
        } else if (event?.type === 'message') {
          if (typeof event.data !== 'string' || event.data.length > maximumAudioBytes * 1.4) {
            throw new ElevenSpeechError('ELEVEN_SPEECH_FAILED');
          }
          let payload: { audio?: unknown; is_final?: unknown; error?: unknown };
          try { payload = JSON.parse(event.data) as typeof payload; }
          catch { throw new ElevenSpeechError('ELEVEN_SPEECH_FAILED'); }
          if (payload.error) throw new ElevenSpeechError('ELEVEN_SPEECH_FAILED');
          if (payload.audio) {
            const chunk = decodeAudio(payload.audio);
            totalBytes += chunk.byteLength;
            if (totalBytes > maximumAudioBytes) throw new ElevenSpeechError('ELEVEN_SPEECH_FAILED');
            yield chunk;
          }
          if (payload.is_final === true) complete = true;
        } else {
          throw new ElevenSpeechError('ELEVEN_SPEECH_FAILED');
        }
      }
      if (!totalBytes) throw new ElevenSpeechError('ELEVEN_SPEECH_FAILED');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      for (const [type, listener] of Object.entries(listeners)) {
        socket.removeEventListener(type as keyof typeof listeners, listener);
      }
      try { socket.close(); } catch { /* already closed */ }
    }
  }
}

export function createConfiguredElevenSpeechGateway(
  environment: Readonly<Record<string, string | undefined>>,
): ElevenSpeechGateway | null {
  const key = environment.ELEVENLABS_API_KEY?.trim();
  const voice = environment.SHANNON_ELEVEN_TTS_VOICE_ID?.trim();
  if (!key || !voice) return null;
  return new ElevenSpeechGateway(key, voice);
}
