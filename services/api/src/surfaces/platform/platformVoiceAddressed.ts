import { askedHer, type AddressedInput, type AddressedJudge, type AddressedLine, type AddressedWork } from '../../mind/perception/addressed.js';
import { endsAsQuestion } from '../../mind/perception/spokenQuestion.js';
import { isAcknowledgement, isNoiseOnly, voiceFragment } from '../../mind/perception/voiceChannelAddress.js';
import type { VoiceMinecraftState } from './voiceMinecraftPort.js';
import type { VoiceAddress } from '../../mind/perception/voiceChannelAddress.js';
import type { VoiceRooms } from './voiceRoom.js';
import type { VoiceTurnRequest } from './platformVoiceRequest.js';

/** If the body does not say, and the head has no record of her last words, a turn that follows hers was this long after she finished. */
const FOLLOWS_WITHOUT_RECORD_MILLISECONDS = 8_000;

/**
 * How long before this utterance she last finished speaking in the room (0: she is speaking), or null when not lately: the body's own count when
 * it sends one (`shannonSpokeMsAgo`, from the end of her speech), else the head's record of her last words plus the time it takes to say
 * them, else the body's `followsShannonTurn`.
 */
export function shannonSpokeAgoMs(rooms: VoiceRooms, request: VoiceTurnRequest): number | null {
  if (request.speakingNow) return 0;
  if (request.shannonSpokeMsAgo !== undefined) return request.shannonSpokeMsAgo;
  const last = rooms.lastShannon(request.conversationId);
  if (last) return Math.max(0, Date.parse(request.observedAt) - Date.parse(last.at) - (last.speechMs ?? 0));
  return request.followsShannonTurn ? FOLLOWS_WITHOUT_RECORD_MILLISECONDS : null;
}

/** `directed` words that come while a question of hers still waits (the 45 seconds the judged path counts) answer it: the mark to put on the address. */
export function answersHerQuestion(rooms: VoiceRooms, request: VoiceTurnRequest, windowMilliseconds = 45_000): { answersQuestion?: true } {
  const last = rooms.lastShannon(request.conversationId);
  return last && endsAsQuestion(last.text) && Date.parse(request.observedAt) - Date.parse(last.at) <= windowMilliseconds ? { answersQuestion: true } : {};
}

/** Words the channel took as said to her: the talk key held, or the answer to a question of hers (the router's silence does not overrule it). */
export const saidToHer = (address: VoiceAddress): boolean => address.reason === 'directed' || address.reason === 'answer_to_question';

/** The words answer a question of hers (the judged path's `answer_to_question`, or `directed` words that came while one waited). */
export const answersAsk = (address: VoiceAddress): boolean => address.reason === 'answer_to_question' || address.answersQuestion === true;

/**
 * Whether she is at work in the game for the people on the call: a request running, or any waiting on the list (a held or stopped one counts:
 * 「再開して」 and 「続けて」 are about the work too). What `AddressedJudge` is shown of it; null when the body is off, not connected or idle.
 */
export function workOf(state: VoiceMinecraftState | undefined): AddressedWork | null {
  if (!state?.connected) return null;
  const list = state.queue ?? [];
  const goal = state.running?.goal ?? null;
  return goal !== null || list.length > 0 ? { goal, list } : null;
}

/**
 * What the judge is shown when her question no longer waits (it counts only for 45 seconds and for this speaker: after that it is no longer told to
 * the judge as a question either), whether these words take a question that still waits, and whether they are a fragment: a breath, a key press or a
 * lone 「うん」 nobody waits on (the follow-up window lets a bare answer through; so does a waiting question of hers, but only for a real answer: a
 * thinking sound (「うーん」) takes neither the question nor its turn).
 */
export function questionJudged(built: AddressedInput, judge: AddressedJudge, transcript: string): { shown: AddressedInput; waiting: boolean; fragment: boolean } {
  const waiting = askedHer(built, judge.questionWindowMilliseconds);
  const shown: AddressedInput = built.shannon?.asked && !waiting ? { ...built, shannon: { ...built.shannon, asked: false } } : built;
  const spokeAgo = shown.shannon?.spokeAgoMs ?? null;
  const thinkingSound = waiting && isNoiseOnly(transcript) && !isAcknowledgement(transcript);
  const follows = (spokeAgo !== null && spokeAgo <= judge.windowMilliseconds) || (waiting && isAcknowledgement(transcript));
  return { shown, waiting, fragment: thinkingSound || voiceFragment({ transcript, followsShannonTurn: follows }) };
}

/** What the judge is shown of this turn: the words, who is there, the talk of the last minutes, and her last words and whom they were for. */
export function addressedInputOf(
  rooms: VoiceRooms, request: VoiceTurnRequest,
  input: { scopeKey: string; humans: number; owner: boolean; bodyRunning: boolean; guestsMayStop?: boolean; work?: AddressedWork | null },
): AddressedInput {
  const room = request.conversationId;
  const observed = Date.parse(request.observedAt);
  const last = rooms.lastShannon(room);
  const recent: AddressedLine[] = rooms.exchange(room).map(line => ({
    who: line.role === 'shannon' ? 'シャノン' : line.name,
    ...(line.role === 'shannon' ? { shannon: true as const } : {}),
    text: line.text,
    secondsAgo: Math.max(0, (observed - Date.parse(line.at)) / 1000),
  }));
  return {
    scopeKey: input.scopeKey, transcript: request.userMessage, speaker: { id: request.sourceUserId, name: request.sourceDisplayName },
    humans: input.humans, recent, owner: input.owner, bodyRunning: input.bodyRunning, ...(input.guestsMayStop ? { guestsMayStop: true } : {}),
    ...(input.work ? { work: input.work } : {}),
    shannonSpeaking: request.speakingNow || request.shannonSpokeMsAgo === 0,
    shannon: {
      spokeAgoMs: shannonSpokeAgoMs(rooms, request),
      // Her words to the room (a line from her mouth) were for nobody in particular: unknown, not "someone else".
      toSpeaker: last && last.userId ? last.userId === request.sourceUserId : null,
      ...(last ? { line: last.text } : {}),
      // A question of hers nobody has taken yet (`VoiceRooms.closeQuestion`, told when the next person's words were judged).
      ...(last?.asked ? { asked: true } : {}),
    },
  };
}
