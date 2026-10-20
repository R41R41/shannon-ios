import type { AddressedInput, AddressedLine } from '../../mind/perception/addressed.js';
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

/** What the judge is shown of this turn: the words, who is there, the talk of the last minutes, and her last words and whom they were for. */
export function addressedInputOf(rooms: VoiceRooms, request: VoiceTurnRequest, input: { scopeKey: string; humans: number }): AddressedInput {
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
    humans: input.humans, recent,
    shannon: {
      spokeAgoMs: shannonSpokeAgoMs(rooms, request),
      // Her words to the room (a line from her mouth) were for nobody in particular: unknown, not "someone else".
      toSpeaker: last && last.userId ? last.userId === request.sourceUserId : null,
      ...(last ? { line: last.text } : {}),
    },
  };
}
