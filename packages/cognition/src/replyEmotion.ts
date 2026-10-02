import { projectEmotionReaction } from './affect.js';
import { presentShannonFeeling } from './emotionContinuity.js';
import { SHANNON_EMOTION_CUE_STRENGTH, isShannonEmotionKind, resolveShannonEmotionState } from './emotionState.js';
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
  /** `decided` came from the writer of the reply itself (a text turn): its kind stands against a cue word of another kind. */
  decidedKindWins?: boolean;
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
    ...(decided && input.decidedKindWins ? { decidedKindWins: true } : {}),
    provisionalPrimary: decided?.primary ?? 'neutral',
    provisionalIntensity: decided?.intensity ?? 0.15,
    transcript: input.userMessage,
    reply: input.reply,
    now: input.now,
  });
  const mood = projectEmotionReaction(input.snapshot, input.userMessage, timing);
  return { messageEmotion: createShannonMessageEmotion(mood, expressiveEmotion), expressiveEmotion };
}

/**
 * Her feeling for a completed reply whose writer also decided its feeling (a text turn of the chat model). One place for
 * the server and the evaluation, so they cannot differ. The decided feeling is used when the reply's feeling is that kind:
 * - It wins over a cue word of another kind only when it was decided more strongly than a cue is; a fainter one does not
 *   hide what she plainly voiced, and the cue names the kind.
 * - When another feeling she already has simply goes on, nothing of the decided one would be stored: the turn is the one
 *   without a decided feeling, so her concern or apology in her own words still shows over a mood. When it is the decided
 *   feeling itself that goes on, it stands: a cue word does not rename it.
 * - When an override took the reply (grief, an emergency, accuracy), or her words named another kind, likewise.
 * Without a usable `decided` it is `resolveReplyEmotion`.
 */
export function resolveWrittenReplyEmotion(input: ReplyEmotionInput): ReplyEmotion {
  const { decided: given, decidedKindWins: _wins, ...plain } = input;
  const decided = given && isShannonEmotionKind(given.primary) && given.primary !== 'neutral' ? given : undefined;
  if (!decided) return resolveReplyEmotion(plain);
  const resolved = resolveReplyEmotion({ ...plain, decided, ...(decided.intensity > SHANNON_EMOTION_CUE_STRENGTH ? { decidedKindWins: true } : {}) });
  const feeling = resolved.expressiveEmotion;
  return feeling.primary === decided.primary && !feeling.overrideReason ? resolved : resolveReplyEmotion(plain);
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
