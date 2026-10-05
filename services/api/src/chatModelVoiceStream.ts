import { errorDetail, parseJson } from './chatModelSupport.js';
import { responseSSEEvents } from './chatModelStream.js';
import { completeSpokenSentences } from './spokenSentences.js';
import { functionCallsOf } from './chatModelTools.js';

/** Bounds of one streamed voice reply. A long reply has no total limit, only these. */
export interface VoiceStreamBounds {
  /** From the request to the first written word of the reply. */
  firstOutputMilliseconds: number;
  /** After the first word: longest time with nothing arriving from the provider. */
  idleMilliseconds: number;
}

export const DEFAULT_VOICE_STREAM_BOUNDS: Readonly<VoiceStreamBounds> = Object.freeze({
  firstOutputMilliseconds: 20_000,
  idleMilliseconds: 30_000,
});

/**
 * A web-searching turn writes its first word only after its searches; the whole turn used to
 * have 30 seconds, so its first word keeps at least that.
 */
export const VOICE_WEB_FIRST_OUTPUT_MILLISECONDS = 30_000;

/**
 * A non-streaming voice reply sends nothing before it is complete, so it has one total: room
 * for 1,600 output tokens with searches, inside the proxy's 120-second read timeout.
 */
export const VOICE_RESPONSE_TIMEOUT_MILLISECONDS = 90_000;

/** The provider withheld the reply for its content; the client drops what it was saying. */
export const VOICE_CONTENT_FILTERED = 'OPENAI_RESPONSE_CONTENT_FILTERED';

export interface VoiceStreamCall {
  fetcher: typeof fetch;
  endpoint: string;
  apiKey: string;
  /** The non-streaming voice request body; `stream: true` is added here. */
  body: Record<string, unknown>;
  bounds: VoiceStreamBounds;
  /** The caller's own cancellation (the owner hung up or spoke over her). */
  signal?: AbortSignal;
  /** An incomplete response that is still a failure, with the usage it reported. */
  onSpentWithoutReply?: (envelope: unknown) => void;
  /** A response that asks for her tools may end without a word, or with only a short waiting phrase. */
  allowToolCalls?: boolean;
}

export interface VoiceStreamOutcome {
  reply: string;
  /** The completed (or length-limited) response envelope, for usage and sources. */
  envelope: unknown;
  /** The reply reached `max_output_tokens` and ends at its last complete sentence. */
  truncated: boolean;
}

/**
 * Streams one voice reply. A response that stops at `max_output_tokens` is a finished reply
 * cut at its last complete sentence, not a failure; every other incomplete or failed response
 * still fails. Timeouts bound the wait for the first word and each silence afterwards, never
 * the length of what she says.
 */
export async function streamedVoiceReply(
  call: VoiceStreamCall,
  onTextDelta: (delta: string) => void | Promise<void>,
): Promise<VoiceStreamOutcome> {
  const deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (milliseconds: number, code: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => deadline.abort(new Error(code)), milliseconds);
  };
  const signal = call.signal ? AbortSignal.any([call.signal, deadline.signal]) : deadline.signal;
  let firstOutput = false;
  arm(call.bounds.firstOutputMilliseconds, 'OPENAI_RESPONSE_FIRST_OUTPUT_TIMEOUT');
  try {
    const response = await call.fetcher(call.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${call.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...call.body, stream: true }),
      signal,
    });
    if (!response.ok || !response.body) {
      const raw = await response.text();
      throw new Error(`OPENAI_RESPONSE_${response.status}: ${errorDetail(parseJson(raw))}`);
    }

    let reply = '';
    let envelope: unknown;
    let truncated = false;
    const deliver = async (text: string) => {
      // Waiting for the listener is not provider silence: the idle bound restarts afterwards.
      clearTimeout(timer);
      firstOutput = true;
      await onTextDelta(text);
      signal.throwIfAborted();
      arm(call.bounds.idleMilliseconds, 'OPENAI_RESPONSE_IDLE_TIMEOUT');
    };
    for await (const event of responseSSEEvents(response.body, signal)) {
      if (firstOutput) arm(call.bounds.idleMilliseconds, 'OPENAI_RESPONSE_IDLE_TIMEOUT');
      const value = record(event) ?? {};
      if (value.type === 'response.output_text.delta' && typeof value.delta === 'string') {
        reply += value.delta;
        await deliver(value.delta);
      } else if (value.type === 'response.output_text.done' && !reply && typeof value.text === 'string') {
        reply = value.text;
        await deliver(value.text);
      } else if (value.type === 'response.completed') {
        envelope = value.response;
      } else if (value.type === 'response.incomplete') {
        const reason = record(record(value.response)?.incomplete_details)?.reason;
        if (reason !== 'max_output_tokens') {
          call.onSpentWithoutReply?.(value.response);
          throw new Error(reason === 'content_filter' ? VOICE_CONTENT_FILTERED : 'OPENAI_RESPONSE_STREAM_INCOMPLETE');
        }
        envelope = value.response;
        truncated = true;
      } else if (value.type === 'error' || value.type === 'response.failed') {
        throw new Error('OPENAI_RESPONSE_STREAM_FAILED');
      }
    }
    reply = reply.trim();
    if (truncated) reply = completeSpokenSentences(reply) || reply;
    if (envelope && call.allowToolCalls && !truncated && functionCallsOf(envelope).length) return { reply, envelope, truncated };
    if (!reply || !envelope) {
      // The output limit was spent before any word (for example on reasoning): accounted, then failed.
      if (truncated) call.onSpentWithoutReply?.(envelope);
      throw new Error('OPENAI_RESPONSE_STREAM_INCOMPLETE');
    }
    return { reply, envelope, truncated };
  } catch (error) {
    // A bound that ran out names itself; the caller's own cancellation stays what it was.
    if (deadline.signal.aborted && !call.signal?.aborted) throw deadline.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** A non-streaming voice response that stopped at `max_output_tokens`. */
export function reachedVoiceLengthLimit(envelope: unknown): boolean {
  const value = record(envelope);
  return value?.status === 'incomplete'
    && record(value.incomplete_details)?.reason === 'max_output_tokens';
}

/** A non-streaming voice response the provider withheld for its content. */
export function voiceContentWithheld(envelope: unknown): boolean {
  const value = record(envelope);
  return value?.status === 'incomplete' && record(value.incomplete_details)?.reason === 'content_filter';
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
