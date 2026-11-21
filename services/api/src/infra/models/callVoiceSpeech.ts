import {
  GeminiSpeechError,
  GoogleGeminiSpeechGateway,
  normalizedSpeechText,
  type GeminiSpeechGateway,
  type GeminiSpeechRequest,
  type GeminiSpeechStreamResult,
} from './geminiSpeech.js';
import { ElevenSpeechError, ElevenSpeechGateway, validatedElevenTags } from './elevenSpeech.js';
import { geminiVoiceRequest } from './voiceAudioTags.js';
import type { LlmUsageStore } from './llmUsage.js';

/**
 * Her voice in a call (Discord voice channel, a game's voice room): a named candidate of `CallVoiceCast` (below) is the voice of the whole
 * server, changed from the body's `voice_cast` command. `CallVoiceSpeechGateway` is the Gemini kind of candidate.
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

export type CallVoiceEngine = 'eleven' | 'gemini';

/** One voice a call may use. `style` is its core: Gemini's whole core style (the tags are added after it), ElevenLabs' default acting tags. */
export interface CallVoiceCandidate {
  name: string;
  engine: CallVoiceEngine;
  voice: string;
  style?: string;
  model?: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;
const MAXIMUM_CANDIDATES = 12;
/** What the settings called the two voices before candidates existed: they stay as candidates under these names. */
export const LEGACY_ELEVEN_NAME = 'eleven';
export const LEGACY_GEMINI_NAME = 'gemini';

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** `SHANNON_CALL_VOICES`: a JSON list of `{name, engine, voice, style?, model?}`. A broken entry is dropped with a warning. */
function listedCandidates(environment: Environment): CallVoiceCandidate[] {
  const raw = environment.SHANNON_CALL_VOICES?.trim();
  if (!raw) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    console.warn('SHANNON_CALL_VOICES is not valid JSON; it is ignored');
    return [];
  }
  if (!Array.isArray(decoded)) {
    console.warn('SHANNON_CALL_VOICES must be a JSON list; it is ignored');
    return [];
  }
  const result: CallVoiceCandidate[] = [];
  for (const entry of decoded.slice(0, MAXIMUM_CANDIDATES)) {
    const row = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
    const name = text(row.name)?.toLowerCase();
    const engine = text(row.engine)?.toLowerCase();
    const voice = text(row.voice);
    if (!name || !NAME_PATTERN.test(name) || (engine !== 'eleven' && engine !== 'gemini') || !voice || result.some(item => item.name === name)) {
      console.warn('A SHANNON_CALL_VOICES entry is dropped', { name: name ?? null });
      continue;
    }
    const style = text(row.style);
    const model = text(row.model);
    result.push({ name, engine, voice, ...(style ? { style } : {}), ...(model ? { model } : {}) });
  }
  return result;
}

/**
 * The voices a call may use, and which is the default.
 *
 * - `SHANNON_CALL_VOICES`: the named list. `SHANNON_CALL_VOICE_DEFAULT`: the name used at start (else see below).
 * - `SHANNON_CALL_TTS_STYLE`: the core style of every Gemini candidate that has none of its own; `SHANNON_CALL_TTS_MODEL`: its model.
 * - What was there before stays: `SHANNON_CALL_TTS_VOICE` (a Gemini voice) is the candidate `gemini`, and `SHANNON_ELEVEN_TTS_VOICE_ID`
 *   (the app's ElevenLabs voice) is the candidate `eleven`, unless the list already names the same voice. Without a default name, the
 *   default is `gemini` when `SHANNON_CALL_TTS_VOICE` is set, else `eleven` when there is no list, else the first one listed:
 *   with nothing new set, exactly the voice a call had.
 * - `chosen`: the list, the default name or `SHANNON_CALL_TTS_VOICE` is set. Then no other voice says a line this one could not
 *   (the route says so in its answer, and the body drops the line); with none of them set the body may say it in VOICEPEAK as before.
 */
export function configuredCallVoices(environment: Environment): { candidates: CallVoiceCandidate[]; defaultName: string | null; chosen: boolean } {
  const candidates = listedCandidates(environment);
  const named = (name: string) => candidates.some(item => item.name === name);
  const has = (engine: CallVoiceEngine, voice: string) => candidates.some(item => item.engine === engine && item.voice === voice);
  const geminiVoice = environment.SHANNON_CALL_TTS_VOICE?.trim();
  const elevenVoice = environment.SHANNON_ELEVEN_TTS_VOICE_ID?.trim();
  // A list that gave no usable candidate (broken JSON, every entry dropped) is as good as none: it must not make the voice 'chosen'.
  const listed = candidates.length > 0;
  if (geminiVoice && !has('gemini', geminiVoice) && !named(LEGACY_GEMINI_NAME)) {
    candidates.push({ name: LEGACY_GEMINI_NAME, engine: 'gemini', voice: geminiVoice });
  }
  if (elevenVoice && !has('eleven', elevenVoice) && !named(LEGACY_ELEVEN_NAME)) {
    candidates.push({ name: LEGACY_ELEVEN_NAME, engine: 'eleven', voice: elevenVoice });
  }
  const wanted = environment.SHANNON_CALL_VOICE_DEFAULT?.trim().toLowerCase() || undefined;
  const byVoice = (engine: CallVoiceEngine, voice: string | undefined) =>
    voice ? candidates.find(item => item.engine === engine && item.voice === voice)?.name : undefined;
  const implied = byVoice('gemini', geminiVoice) ?? (listed ? undefined : byVoice('eleven', elevenVoice)) ?? candidates[0]?.name;
  if (wanted && !named(wanted)) console.warn('SHANNON_CALL_VOICE_DEFAULT names no candidate; another is used', { wanted });
  return { candidates, defaultName: (wanted && named(wanted) ? wanted : implied) ?? null, chosen: listed || Boolean(wanted) || Boolean(geminiVoice) };
}

/** True when the settings choose the call voice: the body then drops a line this voice cannot say instead of saying it in VOICEPEAK. */
export function callVoiceChosen(environment: Environment): boolean {
  return configuredCallVoices(environment).chosen;
}

/** What the route needs of the voice selection. */
export interface CallVoiceCastPort {
  readonly chosen: boolean;
  current(): string;
  defaultName(): string;
  list(): Array<{ name: string; engine: CallVoiceEngine }>;
  /** False when no candidate has this name. */
  select(name: string): boolean;
}

export type CallVoiceStreamResult = GeminiSpeechStreamResult & { callVoiceName: string };

interface CastEntry {
  candidate: CallVoiceCandidate;
  gateway: Pick<GeminiSpeechGateway, 'stream'>;
}

/**
 * The call voice is one of the named candidates; which one is held in memory (a restart is the default again). A line is made by
 * the voice that was current when it was asked for, and the answer says its name so the body can count first sounds per voice.
 */
export class CallVoiceCast implements CallVoiceCastPort {
  private selected: string;
  private readonly start: string;

  constructor(
    private readonly entries: readonly CastEntry[],
    defaultName: string,
    readonly chosen: boolean,
    private readonly usage?: { store: LlmUsageStore; elevenUsdPerTenSeconds: number },
  ) {
    if (!entries.some(entry => entry.candidate.name === defaultName)) throw new Error('call voice default is not a candidate');
    this.selected = defaultName;
    this.start = defaultName;
  }

  current(): string { return this.selected; }
  defaultName(): string { return this.start; }
  list(): Array<{ name: string; engine: CallVoiceEngine }> {
    return this.entries.map(({ candidate }) => ({ name: candidate.name, engine: candidate.engine }));
  }

  select(name: string): boolean {
    const found = this.entries.find(entry => entry.candidate.name === name.trim().toLowerCase());
    if (!found) return false;
    this.selected = found.candidate.name;
    return true;
  }

  async stream(request: GeminiSpeechRequest, signal?: AbortSignal): Promise<CallVoiceStreamResult> {
    const entry = this.entries.find(item => item.candidate.name === this.selected)!;
    const result = await entry.gateway.stream(request, signal);
    const chunks = entry.candidate.engine === 'eleven' ? this.recorded(result, request) : result.chunks;
    return { ...result, chunks, callVoiceName: entry.candidate.name };
  }

  /** ElevenLabs' gateway keeps no usage record of its own: the call, the characters and the audio's length are booked here when a line ends or is stopped. */
  private async *recorded(result: GeminiSpeechStreamResult, request: GeminiSpeechRequest): AsyncGenerator<Uint8Array> {
    let bytes = 0;
    try {
      for await (const chunk of result.chunks) {
        bytes += chunk.byteLength;
        yield chunk;
      }
    } finally {
      // A line a person talked over was asked of ElevenLabs all the same: what was read is booked too. A failed booking never cuts the audio.
      if (this.usage && bytes > 0) {
        try {
          const seconds = bytes / 48_000;
          const input = Math.max(1, Math.ceil(request.text.length / 4));
          const output = Math.max(1, Math.round(seconds * 25));
          this.usage.store.recordLlmUsage({
            scopeKey: request.scopeKey, lane: 'voice', model: result.model, inputTokens: input, cachedInputTokens: 0, outputTokens: output,
            totalTokens: input + output, estimatedCostUsd: Math.round(seconds / 10 * this.usage.elevenUsdPerTenSeconds * 1e6) / 1e6,
            occurredAt: new Date().toISOString(),
          });
        } catch {
          console.warn('A call voice usage record could not be written');
        }
      }
    }
  }
}

/**
 * An ElevenLabs voice in a call: a busy answer (`system_busy`) or a dropped connection before any audio is asked once more, the same
 * way as the Gemini voice. A first sound later than the budget is given up (the caller has stopped waiting), and audio that has
 * started is never asked again. The app's own ElevenLabs voice (`ElevenSpeechGateway` alone) is not changed.
 */
export class RetryingElevenSpeech {
  private readonly budget: number;
  private readonly attempts: number;

  constructor(private readonly inner: Pick<GeminiSpeechGateway, 'stream'>, options: CallVoiceOptions = {}) {
    this.budget = options.firstChunkBudgetMilliseconds ?? CALL_VOICE_FIRST_CHUNK_BUDGET_MS;
    this.attempts = Math.max(1, options.attempts ?? 2);
  }

  async stream(request: GeminiSpeechRequest, signal?: AbortSignal): Promise<GeminiSpeechStreamResult> {
    const startedAt = performance.now();
    let lastError: unknown = new ElevenSpeechError('ELEVEN_SPEECH_FAILED');
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
        const stream = await this.inner.stream(request, controller.signal);
        const iterator = stream.chunks[Symbol.asyncIterator]();
        const first = await iterator.next();
        if (first.done) {
          await iterator.return?.().catch(() => undefined);
          throw new ElevenSpeechError('ELEVEN_SPEECH_FAILED');
        }
        clearTimeout(timer);
        return { ...stream, chunks: firstThenRest(first.value, iterator, () => { cleanup(); controller.abort(); }) };
      } catch (error) {
        cleanup();
        controller.abort();
        if (signal?.aborted) throw error;
        lastError = timedOut ? new ElevenSpeechError('ELEVEN_SPEECH_FAILED') : error;
        // A line the voice cannot take (a bad tag) will not change; a first sound that came too late is not asked again.
        if (timedOut || !(error instanceof ElevenSpeechError) || error.code !== 'ELEVEN_SPEECH_FAILED') break;
      }
    }
    throw lastError;
  }
}

/** An ElevenLabs candidate: the line's own tags are used, else the candidate's default tags. */
function elevenEntry(candidate: CallVoiceCandidate, apiKey: string): CastEntry {
  const inner = new ElevenSpeechGateway(apiKey, candidate.voice);
  const retrying = new RetryingElevenSpeech(inner);
  const defaults = candidate.style;
  return {
    candidate,
    gateway: { stream: (request, signal) => retrying.stream(defaults && !request.style ? { ...request, style: defaults } : request, signal) },
  };
}

/**
 * The voice selection of a call, or null when no candidate can be made (no key for any of them). A candidate whose key or voice is
 * missing is left out. `SHANNON_CALL_TTS_ELEVEN_USD_PER_10_SECONDS` is the price booked for ElevenLabs audio (unset: counted, not priced).
 */
export function createConfiguredCallVoiceCast(environment: Environment, usageStore?: LlmUsageStore): CallVoiceCast | null {
  const { candidates, defaultName, chosen } = configuredCallVoices(environment);
  const geminiKey = environment.GEMINI_API_KEY?.trim();
  const elevenKey = environment.ELEVENLABS_API_KEY?.trim();
  const sharedCore = environment.SHANNON_CALL_TTS_STYLE?.trim() ?? '';
  const entries: CastEntry[] = [];
  for (const candidate of candidates) {
    try {
      if (candidate.engine === 'gemini' && geminiKey) {
        const core = candidate.style ?? sharedCore;
        const inner = new GoogleGeminiSpeechGateway({
          apiKey: geminiKey, voice: candidate.voice, style: core || undefined, usageStore,
          model: candidate.model ?? (environment.SHANNON_CALL_TTS_MODEL?.trim() || 'gemini-3.8-flash-tts'),
        });
        entries.push({ candidate, gateway: new CallVoiceSpeechGateway(inner, core) });
      } else if (candidate.engine === 'eleven' && elevenKey) {
        if (candidate.style) validatedElevenTags(candidate.style);
        entries.push(elevenEntry(candidate, elevenKey));
      } else {
        console.warn('A call voice candidate is left out: its key is not set', { name: candidate.name, engine: candidate.engine });
      }
    } catch (error) {
      if (!(error instanceof ElevenSpeechError || error instanceof GeminiSpeechError)) throw error;
      console.warn('A call voice candidate is left out', { name: candidate.name });
    }
  }
  const first = entries.find(entry => entry.candidate.name === defaultName) ?? entries[0];
  if (!first) return null;
  const price = Number(environment.SHANNON_CALL_TTS_ELEVEN_USD_PER_10_SECONDS);
  return new CallVoiceCast(entries, first.candidate.name, chosen,
    usageStore ? { store: usageStore, elevenUsdPerTenSeconds: Number.isFinite(price) && price > 0 ? Math.min(1, price) : 0 } : undefined);
}
