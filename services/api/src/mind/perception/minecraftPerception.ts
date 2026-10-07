import type { MemoryAudience } from '@shannon/cognition';
import type { MindEvent } from '@shannon/mind';
import { closedId, heldText, namesHer, perceived, perceivedId } from './perceptionCommon.js';

/**
 * The normalizer of her Minecraft body's game chat (`minecraftBody.ts`, through the kernel's text turn). The bridge decided who
 * is present (`PlatformAudiencePolicy.present`, turned into the turn's audience by `platformAudienceTurn`) and whether the owner
 * wrote (an online-mode server and his uuid); both are copied. Someone else's words are text from outside: `untrusted`.
 */
export interface MinecraftPerceptionInput {
  /** The game-chat request's id. */
  requestId: string;
  message: string;
  /** The turn's audience as the surface decided it (`ChatAudienceTurn.present`), copied as it is. */
  present: MemoryAudience;
  alone: boolean;
  /** The verified owner wrote (online mode, his uuid): `PlatformAudiencePolicy.ownerWrote`. */
  ownerWrote: boolean;
  /** Her Minecraft body's device. */
  deviceId: string | null;
  at: string;
}

export function minecraftPerception(input: MinecraftPerceptionInput): MindEvent | null {
  return perceived({
    id: perceivedId('minecraft'), kind: 'game', surface: 'minecraft', time: input.at, body: input.deviceId ? closedId(input.deviceId, 80) : null,
    audience: input.present, presence: { openOnly: input.alone, othersMayHear: !input.alone },
    speaker: input.ownerWrote ? { kind: 'owner', verified: true, tier: 1 } : { kind: 'person' },
    salienceInputs: input.ownerWrote ? { ownerSpeech: true, addressed: namesHer(input.message) } : { othersSpeech: true, addressed: namesHer(input.message) },
    provenance: { source: 'minecraft', sourceId: closedId(input.requestId), trust: input.ownerWrote ? 'owner' : 'untrusted' },
    content: heldText(input.message),
  });
}
