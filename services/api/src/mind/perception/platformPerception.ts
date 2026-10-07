import type { MemoryAudience } from '@shannon/cognition';
import type { MindEvent } from '@shannon/mind';
import { closedId, heldText, namesHer, perceived, perceivedId } from './perceptionCommon.js';

/**
 * The normalizer of a platform reply (Discord and the like, `platformReply.ts`, through the kernel's text turn). The bridge
 * decided who can read the reply (`PlatformAudiencePolicy.present`, the turn's audience) and whether the verified owner wrote;
 * both are copied. Someone else's words are text from outside: `untrusted`.
 */
export interface PlatformPerceptionInput {
  /** The conversation the bridge keeps the turn in (its platform thread): the item's source, so the thread's own turns are not repeated. */
  threadId: string;
  message: string;
  /** The turn's audience as the surface decided it (`ChatAudienceTurn.present`), copied as it is. */
  present: MemoryAudience;
  alone: boolean;
  /** `PlatformAudiencePolicy.ownerWrote`. */
  ownerWrote: boolean;
  at: string;
}

export function platformPerception(input: PlatformPerceptionInput): MindEvent | null {
  return perceived({
    id: perceivedId('platform'), kind: 'platform_message', surface: 'platform', time: input.at,
    audience: input.present, presence: { ownerOnlyHears: input.alone, othersMayHear: !input.alone },
    speaker: input.ownerWrote ? { kind: 'owner', verified: true, tier: 1 } : { kind: 'person' },
    salienceInputs: input.ownerWrote ? { ownerSpeech: true, addressed: namesHer(input.message) } : { othersSpeech: true, addressed: namesHer(input.message) },
    provenance: { source: 'platform', sourceId: closedId(input.threadId), trust: input.ownerWrote ? 'owner' : 'untrusted' },
    content: heldText(input.message),
  });
}
