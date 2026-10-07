import type { MemoryAudience } from '@shannon/cognition';
import type { MindEvent } from '@shannon/mind';
import { closedId, heldText, namesHer, perceived, perceivedId } from './perceptionCommon.js';

/**
 * The normalizer of a voice delegation (`apiLiveVoice.ts`). It is handed `present` as the delegation decided it (the owner's
 * call: the owner alone, or an unknown guest while a companion is there; 「友人も一緒」: the people the call resolved) and copies
 * it; the same value goes to `visibleConversationHistory`, `prepareTurnCognitiveContext` and semantic recall. Who spoke is the
 * call's own mode: the owner's paired app in his own call, otherwise someone not proven.
 */
export interface VoicePerceptionInput {
  threadId: string;
  transcript: string;
  /** The audience the delegation decided, copied as it is. */
  present: MemoryAudience;
  /** Only the owner hears the reply (`isOwnerOnly(present)`, as the delegation computed it). */
  alone: boolean;
  /** 「友人も一緒」: a temporary guest call. */
  guest: boolean;
  /**
   * The words may not be his to her as heard (an uncertain transcript, an echo, overheard talk, a fragment: stage 3 review): then
   * the speaker is not proven and the item is someone's words, at a lower salience, without 「ライ氏が話した」.
   */
  unverified?: boolean;
  /** The device that heard it, when the request named one. */
  deviceId?: string | null;
  at: string;
}

/**
 * The words are held only for the owner alone in his own call (stage 3 review, HIGH): a 「友人も一緒」 call and a call with someone
 * else present enter the workspace without any text, and render only as a closed line (`promptLayout.ts`).
 */
export function voicePerception(input: VoicePerceptionInput): MindEvent | null {
  const owner = !input.guest && input.alone && !input.unverified;
  const ownersCall = !input.guest && input.alone;
  return perceived({
    id: perceivedId('voice'), kind: 'utterance', surface: 'voice', time: input.at,
    body: input.deviceId ? closedId(input.deviceId, 80) : null,
    audience: input.present, presence: { ownerOnlyHears: input.alone, othersMayHear: !input.alone },
    speaker: owner ? { kind: 'owner', verified: true, tier: 1 } : { kind: input.guest ? 'person' : 'unknown' },
    salienceInputs: owner ? { ownerSpeech: true, addressed: namesHer(input.transcript) } : { othersSpeech: true, addressed: namesHer(input.transcript) },
    provenance: { source: 'voice', sourceId: closedId(input.threadId), trust: owner ? 'owner' : 'untrusted' },
    content: ownersCall ? heldText(input.transcript) : null,
  });
}
