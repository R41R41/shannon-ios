import {
  VOICE_SECOND_PHRASE, VOICE_SECOND_PHRASE_AFTER_MILLISECONDS, TURN_OUT_OF_TIME_LINE, isOutOfTime, outOfTimeEnvelope, voiceWaitingPhrase,
  withToolRounds, type ShannonModelToolSession,
} from './chatModelTools.js';
import { streamedVoiceReply, type VoiceStreamBounds } from './chatModelVoiceStream.js';
import { completeSpokenSentences } from '../../surfaces/voice/spokenSentences.js';
import { PartialAnswerError, RoundTimer } from '../../mind/action/respond/turnDeadline.js';

/**
 * A streamed voice turn that offers her tools. Nothing reaches the phone while she writes a call's arguments or a
 * tool runs, so:
 * - when a round begins a call before she has said anything, she first says a fixed waiting phrase;
 * - when a call began and nothing has been heard for `VOICE_SECOND_PHRASE_AFTER_MILLISECONDS` (after the first phrase or
 *   her own lead-in), she says a second one, never into an answer already being spoken;
 * - a round that speaks her own words is the answer: it gets the answer's time, and if it fails after all, what she
 *   said stands and the fixed line follows (never said twice);
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
  let callStarted = false;
  let answering = false;
  /** Whether the round that just ended spoke words of hers. */
  let roundOver = false;
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
  // After a call began, a long silence brings the second phrase; never into an answer that is already being spoken.
  const silence = setInterval(() => {
    if (callStarted && !answering && !secondSaid && clock() - spokenAt >= VOICE_SECOND_PHRASE_AFTER_MILLISECONDS) {
      secondSaid = true;
      void speak(VOICE_SECOND_PHRASE).catch(() => {});
    }
  }, turn.tickMilliseconds ?? 500);
  let last: { envelope: unknown; truncated: boolean } = { envelope: null, truncated: false };
  let outOfTime = false;
  let standing = '';
  try {
    const envelope = await withToolRounds(turn.body, turn.tools, async (body, time) => {
      const timer = time ? new RoundTimer(time) : undefined;
      const signals = [turn.signal, timer?.signal].filter((value): value is AbortSignal => Boolean(value));
      let phrase: string | null = null;
      let roundSaid = '';
      answering = false;
      try {
        const outcome = await streamedVoiceReply({
          fetcher: turn.fetcher, endpoint: turn.endpoint, apiKey: turn.apiKey, body, bounds: turn.bounds,
          ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
          allowToolCalls: true,
          onCallStarting: name => {
            callStarted = true;
            if (spoken) return null;
            phrase = voiceWaitingPhrase(name);
            return phrase;
          },
          onSpentWithoutReply: turn.onSpentWithoutReply,
        }, text => {
          // Her own words are the answer under way: from now the round has the answer's time.
          if (text === phrase) phrase = null;
          else { answering = true; roundSaid += text; timer?.answering(); }
          return speak(text);
        });
        last = { envelope: outcome.envelope, truncated: outcome.truncated };
        return outcome.envelope;
      } catch (error) {
        if (roundSaid && !turn.signal?.aborted) throw new PartialAnswerError(roundSaid);
        throw error;
      } finally {
        timer?.clear();
        // The round is over: what follows (a tool running, the next round) is silence again, not an answer under way.
        roundOver = answering;
        answering = false;
      }
    }, {
      isAnswer: () => false, ...(turn.signal ? { signal: turn.signal } : {}), plainBody: turn.plainBody, onSpent: turn.onSpent,
      // After a tool ran, an answer with no words is the fixed line.
      isUsable: () => roundOver,
      outOfTime: () => outOfTimeEnvelope(TURN_OUT_OF_TIME_LINE),
    });
    if (isOutOfTime(envelope)) {
      await queue;
      // What she already said stands, cut at its last complete sentence; the line follows and nothing is said twice.
      standing = completeSpokenSentences(spoken.trim()) || '';
      outOfTime = true;
      await speak(TURN_OUT_OF_TIME_LINE);
      last = { envelope, truncated: false };
    }
    await queue;
  } finally {
    clearInterval(silence);
  }
  const said = spoken.trim();
  const reply = outOfTime ? `${standing}${TURN_OUT_OF_TIME_LINE}` : last.truncated ? completeSpokenSentences(said) || said : said;
  if (!reply) throw new Error('OPENAI_RESPONSE_STREAM_INCOMPLETE');
  return { reply, ...last };
}
