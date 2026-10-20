import type { CompanionStateSnapshot, MemoryAudience } from '@shannon/cognition';
import type { VoiceSeat } from '../../contracts/oneHeadContract.js';
import { withoutGuardedEntries } from '../../mind/action/respond/apiTextTurn.js';
import { heardByEveryoneHere } from '../../mind/memory/platformPeoplePorts.js';
import { resolveReplyEmotion } from '../../mind/emotion/emotionPorts.js';
import type { ShannonChatModelResult } from '../../infra/models/chatModel.js';

/**
 * A platform's seat in the one voice turn (one head, `SHANNON_ONE_HEAD`): the few places where the voice turn of the apps reads who is
 * there from the paired device, read instead from the bridge's policy the platform handed it (`VoiceSeat`), by the rules a platform's
 * typed turn follows in `apiTextTurn.ts` (so that a Discord voice channel and its text channel are one conversation of one mind).
 */
export type { VoiceSeat } from '../../contracts/oneHeadContract.js';

/** Where nobody may release a protected line of the owner (someone else's turn), none is given: memory text without 【機微 entries. */
export function seatMemory(seat: VoiceSeat | null): (text: string | undefined) => string {
  return text => (seat && !seat.ownerPresent ? withoutGuardedEntries(text ?? '') : text ?? '');
}

type Disclosure = Parameters<typeof heardByEveryoneHere>[2];

/** With others there, only what everyone here already heard of the people she remembers (as a platform's typed turn). */
export function seatPeople<C extends { id: string; disclosure?: Disclosure }, T extends { candidates: readonly C[] }>(
  seat: VoiceSeat | null, recalled: T | undefined, snapshot: CompanionStateSnapshot, present: MemoryAudience,
): T | undefined {
  if (!seat || seat.ownerAlone || !recalled) return recalled;
  const heard = recalled.candidates.filter(candidate => heardByEveryoneHere(snapshot, candidate.id, candidate.disclosure, present));
  return { ...recalled, candidates: heard };
}

/** Her tools' audience on a platform: the owner alone as in the apps; his turn before others her folder reading; anyone else's as guests. */
export function seatToolAudience(seat: VoiceSeat): true | 'shared' | 'guests' {
  return seat.ownerAlone ? true : seat.ownerSpeaking ? 'shared' : 'guests';
}

/** A platform's channel asks her Minecraft body through the turn's intent, never through her tools, unless the owner is alone in his own. */
export function seatToolOptions(seat: VoiceSeat | null): { withoutDomains?: readonly string[]; openOnly?: boolean } {
  if (!seat || seat.ownerAlone) return {};
  return { withoutDomains: ['minecraft_body'], ...(seat.ownerPresent ? {} : { openOnly: true }) };
}

/**
 * The finished turn kept where the platform keeps it (the owner's in his platform thread, anyone else's as person memory: `seat.keep`),
 * without the voice's audio tags; the experience's id, when it was kept in his conversation.
 */
export function keepSeatTurn(seat: VoiceSeat, turn: {
  scopeKey: string; threadId: string; captured: CompanionStateSnapshot; reply: string; at: string; recalledMemoryIds: readonly string[];
}): string | undefined {
  if (!turn.reply.trim()) return undefined;
  const { messageEmotion } = resolveReplyEmotion({ snapshot: turn.captured, userMessage: seat.message, reply: turn.reply, now: turn.at });
  const experience = seat.keep({
    scopeKey: turn.scopeKey, threadId: turn.threadId, capturedState: turn.captured, userMessage: seat.message, shannonReply: turn.reply,
    threadTitle: seat.threadTitle, messageEmotion, completedAt: turn.at, recalledMemoryIds: [...turn.recalledMemoryIds], ...seat.turnLabel,
  });
  return experience?.id;
}

/** What a platform's voice turn adds to its answer: the body's intent, and where the turn was kept. */
export function seatAnswer(completion: Pick<ShannonChatModelResult, 'minecraftIntent'>, experienceId: string | undefined): Record<string, unknown> {
  return { ...(completion.minecraftIntent ? { minecraftIntent: completion.minecraftIntent } : {}), ...(experienceId ? { experienceId } : {}) };
}
