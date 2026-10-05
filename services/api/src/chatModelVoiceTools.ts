import {
  VOICE_SECOND_PHRASE, VOICE_SECOND_PHRASE_AFTER_MILLISECONDS, TURN_OUT_OF_TIME_LINE, isOutOfTime, outOfTimeEnvelope, voiceWaitingPhrase,
  withToolRounds, type ShannonModelToolSession,
} from './chatModelTools.js';
import { streamedVoiceReply, type VoiceStreamBounds } from './chatModelVoiceStream.js';
import { completeSpokenSentences } from './spokenSentences.js';

/**
 * A streamed voice turn that offers her tools. Nothing reaches the phone while she writes a call's arguments or a
 * tool runs, so:
 * - when a round begins a call before she has said anything, she first says a fixed waiting phrase;
 * - when nothing has been heard for `VOICE_SECOND_PHRASE_AFTER_MILLISECONDS` after it, she says a second one;
 * - every round and call takes its time from the turn's deadline (`turnDeadline.ts`), and when the answer cannot be
 *   had in time she says the fixed out-of-time line. Once a tool ran the turn is never failed by time: it ends with
 *   her answer or that line, and is saved.
 * All of these are ordinary words to the listener (no new line type). The reply is everything she said.
 */
export interface VoiceToolTurn {
  fetcher: typeof fetch;
  endpoint: string;
  apiKey: string;
  body: Record<string, unknown>;
  plainBody: Record<string, unknown>;
  tools: ShannonModelToolSession;
  bounds: VoiceStreamBounds;
  signal?: AbortSignal;
  onTextDelta: (delta: string) => void | Promise<void>;
  onSpent: (envelope: unknown) => void;
  onSpentWithoutReply: (envelope: unknown) => void;
  /** Milliseconds, for the second phrase; a test's clock. */
  clock?: () => number;
  /** How often silence is looked at. */
  tickMilliseconds?: number;
}

export async function streamedVoiceToolTurn(turn: VoiceToolTurn): Promise<{ reply: string; envelope: unknown; truncated: boolean }> {
  const clock = turn.clock ?? Date.now;
  let spoken = '';
  let spokenAt = clock();
  let waited = false;
  let secondSaid = false;
  let queue = Promise.resolve();
  // Every word goes out in order, whoever says it (a round, the waiting phrases, the fixed line).
  const speak = (text: string): Promise<void> => {
    queue = queue.then(async () => {
      spoken += text;
      spokenAt = clock();
      await turn.onTextDelta(text);
    });
    return queue;
  };
  const silence = setInterval(() => {
    if (waited && !secondSaid && clock() - spokenAt >= VOICE_SECOND_PHRASE_AFTER_MILLISECONDS) {
      secondSaid = true;
      void speak(VOICE_SECOND_PHRASE).catch(() => {});
    }
  }, turn.tickMilliseconds ?? 500);
  let last: { envelope: unknown; truncated: boolean } = { envelope: null, truncated: false };
  try {
    const envelope = await withToolRounds(turn.body, turn.tools, async (body, timeoutMilliseconds) => {
      const signals = [turn.signal, timeoutMilliseconds !== undefined ? AbortSignal.timeout(Math.max(1, timeoutMilliseconds)) : undefined].filter((value): value is AbortSignal => Boolean(value));
      const outcome = await streamedVoiceReply({
        fetcher: turn.fetcher, endpoint: turn.endpoint, apiKey: turn.apiKey, body, bounds: turn.bounds,
        ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
        allowToolCalls: true,
        onCallStarting: name => {
          if (spoken) return null;
          waited = true;
          return voiceWaitingPhrase(name);
        },
        onSpentWithoutReply: turn.onSpentWithoutReply,
      }, speak);
      last = { envelope: outcome.envelope, truncated: outcome.truncated };
      return outcome.envelope;
    }, {
      isAnswer: () => false, ...(turn.signal ? { signal: turn.signal } : {}), plainBody: turn.plainBody, onSpent: turn.onSpent,
      outOfTime: () => outOfTimeEnvelope(TURN_OUT_OF_TIME_LINE),
    });
    if (isOutOfTime(envelope)) {
      await speak(TURN_OUT_OF_TIME_LINE);
      last = { envelope, truncated: false };
    }
    await queue;
  } finally {
    clearInterval(silence);
  }
  const said = spoken.trim();
  const reply = last.truncated ? completeSpokenSentences(said) || said : said;
  if (!reply) throw new Error('OPENAI_RESPONSE_STREAM_INCOMPLETE');
  return { reply, ...last };
}
