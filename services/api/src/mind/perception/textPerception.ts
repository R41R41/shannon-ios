import type { MemoryAudience } from '@shannon/cognition';
import type { MindEvent } from '@shannon/mind';
import { closedId, heldText, namesHer, perceived, perceivedId } from './perceptionCommon.js';

/**
 * The normalizer of the app's text chat (`POST /v1/chat`, `apiTextTurn.ts`). It is handed the turn's audience exactly as
 * `chatAudienceTurn` decided it (`present`, the value `prepareTurnCognitiveContext`, the replay and semantic recall receive) and
 * copies it; who wrote is the turn's own label (`turnLabel.speaker`: absent is the owner on his paired app, `unknown` with
 * others present). `perceptionAudienceMatrix.test.ts` holds the copy equal to what the legacy paths were given.
 */
export interface TextPerceptionInput {
  threadId: string;
  message: string;
  /** The audience the surface decided (`ChatAudienceTurn.present`), copied as it is. */
  present: MemoryAudience;
  /** Only the owner reads the reply (`ChatAudienceTurn.alone`). */
  alone: boolean;
  /** The turn's label (`ChatAudienceTurn.turnLabel.speaker`); absent means the owner on his own app. */
  speaker?: 'owner' | 'unknown';
  at: string;
}

export function textPerception(input: TextPerceptionInput): MindEvent | null {
  const owner = (input.speaker ?? 'owner') === 'owner';
  return perceived({
    id: perceivedId('text'), kind: 'utterance', surface: 'text', time: input.at,
    audience: input.present, presence: { openOnly: input.alone, othersMayHear: !input.alone },
    // The paired app proves the owner only while he alone reads it; with others present the words may not be his.
    speaker: owner && input.alone ? { kind: 'owner', verified: true, tier: 1 } : { kind: 'unknown' },
    salienceInputs: owner && input.alone ? { ownerSpeech: true, addressed: namesHer(input.message) } : { othersSpeech: true, addressed: namesHer(input.message) },
    provenance: { source: 'text', sourceId: closedId(input.threadId), trust: owner && input.alone ? 'owner' : 'untrusted' },
    content: heldText(input.message),
  });
}
