import { projectEmotionReaction } from './affect.js';
import { presentShannonFeeling } from './emotionContinuity.js';
import { isShannonEmotionKind, resolveShannonEmotionState } from './emotionState.js';
import { SHANNON_EMOTION_TIME, type ShannonEmotionTiming } from './emotionTime.js';
import { createShannonMessageEmotion, deriveShannonFace, type ShannonFace, type ShannonMessageEmotion } from './expression.js';
import type { CompanionStateSnapshot, ShannonExpressiveEmotion } from './types.js';

export interface ReplyEmotionInput {
  snapshot: CompanionStateSnapshot;
  userMessage: string;
  reply: string;
  now: string;
  /**
   * A feeling already decided for this reply (a voice turn's reconciled
   * emotion). Text has none and starts from neutral.
   */
  decided?: { primary: string; intensity: number };
  /** The server's emotion timing; the table's defaults when absent. */
  timing?: ShannonEmotionTiming;
  /** The reply is her line about a touch that already went through the shared rule: its feeling is not held back again. */
  replaces?: boolean;
}

export interface ReplyEmotion {
  /** Stored with the message and shown beside Shannon's name. */
  messageEmotion: ShannonMessageEmotion;
  /** The conversational feeling for this reply; the caller commits it after responding. */
  expressiveEmotion: ShannonExpressiveEmotion;
}

/**
 * Shannon's feeling for one completed reply, from state already in hand: the
 * stored conversational feeling (through the shared carry-over rule), cues in
 * her own reply, and the support overrides. It is pure, calls no model, and
 * never reads the owner's words as her feeling. The owner's message reaches the
 * face only through the support overrides and the continuous mood reaction.
 */
export function resolveReplyEmotion(input: ReplyEmotionInput): ReplyEmotion {
  const decided = input.decided && isShannonEmotionKind(input.decided.primary) ? input.decided : undefined;
  const timing = input.timing ?? SHANNON_EMOTION_TIME;
  const expressiveEmotion = resolveShannonEmotionState({
    ...(timing.clock === 'awake' ? { previous: presentShannonFeeling(input.snapshot, input.now, timing) }
      : input.snapshot.expressiveEmotion ? { previous: input.snapshot.expressiveEmotion } : {}),
    ...(input.replaces ? { replaces: true } : {}),
    provisionalPrimary: decided?.primary ?? 'neutral',
    provisionalIntensity: decided?.intensity ?? 0.15,
    transcript: input.userMessage,
    reply: input.reply,
    now: input.now,
  });
  const mood = projectEmotionReaction(input.snapshot, input.userMessage, timing);
  return { messageEmotion: createShannonMessageEmotion(mood, expressiveEmotion), expressiveEmotion };
}

export interface ShannonPresentMood extends ShannonFace {
  /** Why she feels this way, in the stored state's own words. */
  cause: string;
  /** False once the last conversational feeling has settled and the quiet mood is shown. */
  fromConversation: boolean;
}

/** 「いま」: the feeling at `now` with no new stimulus, for the state sheet and Memory. */
export function presentShannonMood(
  snapshot: CompanionStateSnapshot,
  now: string,
  timing: ShannonEmotionTiming = SHANNON_EMOTION_TIME,
): ShannonPresentMood {
  const current = presentShannonFeeling(snapshot, now, timing);
  const fromConversation = current.primary !== 'neutral' && current.visibility !== 'hidden';
  return Object.freeze({
    ...deriveShannonFace(snapshot.emotion, current),
    cause: fromConversation ? current.cause : '特に強い気持ちは続いていない',
    fromConversation,
  });
}
