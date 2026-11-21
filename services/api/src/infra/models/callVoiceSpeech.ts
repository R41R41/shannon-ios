import {
  GeminiSpeechError,
  GoogleGeminiSpeechGateway,
  normalizedSpeechText,
  type GeminiSpeechGateway,
  type GeminiSpeechRequest,
  type GeminiSpeechStreamResult,
} from './geminiSpeech.js';
import { geminiVoiceRequest } from './voiceAudioTags.js';
import type { LlmUsageStore } from './llmUsage.js';

/**
 * Her voice in a call (Discord voice channel, a game's voice room) when it is a Gemini voice (`SHANNON_CALL_TTS_VOICE`).
 *
 * The call route asks a gateway for `stream({ text, style })`, where `style` is the acting tags (`[whispers]`) and `text` may carry
 * tags of its own: this gateway has the same `stream`, and turns them into what Gemini reads. Gemini reads no tag, so each becomes a
 * short Japanese direction after the voice's core style (`SHANNON_CALL_TTS_STYLE`, which the tags would otherwise replace).
 *
 * A line that fails before any audio (a refusal, an upstream error) is asked once more. If that fails too, the error goes up and the
 * route answers 502: the line is not given to another voice. A line is not asked again once audio has started.
 */

/** Said at the end of every style: the voice's own pitch, not a raised one. */
const PITCH_DIRECTION = '地声の高さのまま、声を高くしない。';
const DIRECTION_LABEL = 'この台詞の演技：';
const STYLE_MAXIMUM_CHARACTERS = 500;

/** The caller (the body) waits 6 s for the first byte; a first sound later than this is given up so the route can answer in time. */
export const CALL_VOICE_FIRST_CHUNK_BUDGET_MS = 5_500;

interface CallVoiceOptions {
  firstChunkBudgetMilliseconds?: number;
  attempts?: number;
}

function retryable(error: unknown): boolean {
  if (!(error instanceof GeminiSpeechError) || error.code !== 'GEMINI_SPEECH_FAILED') return false;
  const status = error.upstreamStatus;
  return status === undefined || status === 400 || status === 429 || status >= 500;
}

async function* firstThenRest(
  first: Uint8Array, iterator: AsyncIterator<Uint8Array>, done: () => void,
): AsyncGenerator<Uint8Array> {
  try {
    yield first;
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) yield next.value;
  } finally {
    done();
    await iterator.return?.().catch(() => undefined);
  }
}

export class CallVoiceSpeechGateway {
  private readonly budget: number;
  private readonly attempts: number;

  constructor(
    private readonly inner: Pick<GeminiSpeechGateway, 'stream'>,
    /** The voice's core style: who she is and how her voice sits; the line's own direction is added after it. */
    private readonly coreStyle: string,
    options: CallVoiceOptions = {},
  ) {
    this.budget = options.firstChunkBudgetMilliseconds ?? CALL_VOICE_FIRST_CHUNK_BUDGET_MS;
    this.attempts = Math.max(1, options.attempts ?? 2);
  }

  /** The style for a line: the core, the direction its tags asked for (cut to fit), the pitch. */
  private styleFor(directions: string | undefined): string {
    const fixed = [this.coreStyle, PITCH_DIRECTION].filter(Boolean);
    if (!directions) return fixed.join(' ');
    const room = STYLE_MAXIMUM_CHARACTERS - fixed.join(' ').length - DIRECTION_LABEL.length - 2;
    if (room <= 0) return fixed.join(' ');
    return [this.coreStyle, `${DIRECTION_LABEL}${directions.slice(0, room)}`, PITCH_DIRECTION].filter(Boolean).join(' ');
  }

  async stream(request: GeminiSpeechRequest, signal?: AbortSignal): Promise<GeminiSpeechStreamResult> {
    // The acting tags come first, so the directions of `style` and of the sentence are made together.
    // The directions come from the acting tags and the sentence's own tags together; what is spoken comes from the sentence alone
    // (a capitalised bracketed word among the acting tags would otherwise be read aloud as text).
    const sentence = normalizedSpeechText(request.text);
    const directions = geminiVoiceRequest(`${request.style ?? ''} ${sentence}`.trim(), undefined).style;
    const text = normalizedSpeechText(geminiVoiceRequest(sentence, undefined).text);
    const style = this.styleFor(directions);
    const startedAt = performance.now();
    let lastError: unknown = new GeminiSpeechError('GEMINI_SPEECH_FAILED');
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      const remaining = this.budget - (performance.now() - startedAt);
      if (remaining <= 0 || signal?.aborted) break;
      const controller = new AbortController();
      const relay = () => controller.abort();
      signal?.addEventListener('abort', relay, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, remaining);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', relay); };
      try {
        const stream = await this.inner.stream({ scopeKey: request.scopeKey, text, style }, controller.signal);
        const iterator = stream.chunks[Symbol.asyncIterator]();
        const first = await iterator.next();
        if (first.done) {
          await iterator.return?.().catch(() => undefined);
          throw new GeminiSpeechError('GEMINI_SPEECH_FAILED');
        }
        clearTimeout(timer);
        // When the reader stops early (a person talked over her), the request to Gemini is dropped with it.
        return { ...stream, chunks: firstThenRest(first.value, iterator, () => { cleanup(); controller.abort(); }) };
      } catch (error) {
        cleanup();
        controller.abort();
        if (signal?.aborted) throw error;
        lastError = timedOut ? new GeminiSpeechError('GEMINI_SPEECH_FAILED', undefined, 'first_chunk_timeout') : error;
        // A first sound that came too late is not asked again: a second try would end after the caller stopped waiting.
        if (timedOut || !retryable(error)) break;
      }
    }
    throw lastError;
  }
}

/** True when a call voice is chosen: the route then uses it in place of the ElevenLabs voice. */
export function callVoiceChosen(environment: Readonly<Record<string, string | undefined>>): boolean {
  return Boolean(environment.SHANNON_CALL_TTS_VOICE?.trim());
}

/**
 * The call voice, or null when it cannot be made (no `GEMINI_API_KEY`). The model defaults to the one voice-designed voices need;
 * `SHANNON_CALL_TTS_STYLE` is the core style (`SHANNON_GEMINI_TTS_*`, the app's voice, are not read).
 */
export function createConfiguredCallSpeechGateway(
  environment: Readonly<Record<string, string | undefined>>,
  usageStore?: LlmUsageStore,
): CallVoiceSpeechGateway | null {
  const apiKey = environment.GEMINI_API_KEY?.trim();
  const voice = environment.SHANNON_CALL_TTS_VOICE?.trim();
  if (!apiKey || !voice) return null;
  const core = environment.SHANNON_CALL_TTS_STYLE?.trim() ?? '';
  const inner = new GoogleGeminiSpeechGateway({
    apiKey,
    voice,
    model: environment.SHANNON_CALL_TTS_MODEL?.trim() || 'gemini-3.8-flash-tts',
    style: core || undefined,
    usageStore,
  });
  return new CallVoiceSpeechGateway(inner, core);
}
