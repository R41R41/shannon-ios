import {
  deriveShannonFace, faceForEmotionKind, isShannonEmotionKind, normalizeShannonExpressiveEmotion,
  type ReplyEmotion, type ShannonEmotion, type ShannonExpressiveEmotion, type ShannonMessageEmotion,
} from '@shannon/cognition';
import type { VoiceTurnDecision } from './voiceDecision.js';
import { waitingDirectionFor, waitingPhraseFor } from './voiceWaitingCue.js';

/** The quiet face of a call with no owner state (友人も一緒): the baseline mood. */
const BASELINE_MOOD: ShannonEmotion = { valence: 0, arousal: 0.3, openness: 0.35 };

/**
 * `expression` and `feeling` are the face of the same per-turn emotion the
 * voice acts with, so the call Eye and the voice cannot disagree. `mood` is the
 * owner's continuous mood; a guest call passes none and nothing is stored.
 */
export function voicePlanResponse(
  decision: VoiceTurnDecision,
  emotion?: ShannonExpressiveEmotion,
  mood: ShannonEmotion = BASELINE_MOOD,
): Record<string, unknown> {
  const selectedWaitingDirection = waitingDirectionFor(decision);
  const waitingDirection = emotion?.overrideReason === 'grief'
    ? { ...selectedWaitingDirection, scenario: 'support' as const, variant: 'warm' as const }
    : emotion?.overrideReason === 'safety' && selectedWaitingDirection.variant === 'lively'
      ? { ...selectedWaitingDirection, variant: 'steady' as const }
      : selectedWaitingDirection;
  const waitingPhrase = emotion?.overrideReason === 'emergency'
    ? undefined : waitingPhraseFor(decision, waitingDirection);
  const waitingPerformance = waitingPhrase
    ? waitingPerformanceFor(waitingDirection, emotion) : undefined;
  return {
    shouldRespond: decision.shouldRespond,
    replyRequiredProbability: decision.replyRequiredProbability,
    solutionWantedProbability: decision.solutionWantedProbability,
    conversationClass: decision.conversationClass,
    latencyClass: decision.latencyClass,
    affect: emotion?.primary ?? decision.affect,
    affectIntensity: emotion?.intensity ?? decision.affectIntensity,
    delivery: emotion ? deliveryForEmotion(emotion, decision.delivery) : decision.delivery,
    ...(emotion ? { emotion: planEmotion(emotion), ...deriveShannonFace(mood, emotion) } : {}),
    selectedSkills: decision.selectedSkills,
    skillScores: decision.skillScores,
    waitingPhrase,
    ...(waitingPerformance ? { waitingPerformance } : {}),
    decisionSource: decision.source,
    decisionLatencyMilliseconds: decision.elapsedMilliseconds,
    transcriptReliabilityProbability: decision.transcriptReliabilityProbability ?? null,
    // The trace of an unanswered turn: which category decided it. Absent on a turn she answers.
    ...(decision.silence && !decision.shouldRespond ? { silenceCategory: decision.silence } : {}),
  };
}

/**
 * The feeling as the plan may carry it to a device. No client reads its cause, and the device may be heard by
 * others: the cause, her clock stamp and the resolver's notes to the reducer stay on the server.
 */
function planEmotion(emotion: ShannonExpressiveEmotion): Omit<ShannonExpressiveEmotion, 'cause' | 'awakeAt' | 'presentAt' | 'continued' | 'decided' | 'underneath' | 'easedPeak' | 'heights' | 'strengths' | 'placeAbove'> {
  const { cause: _cause, awakeAt: _awakeAt, ...shown } = normalizeShannonExpressiveEmotion(emotion);
  return shown;
}

function waitingPerformanceFor(
  direction: NonNullable<VoiceTurnDecision['waitingDirection']>,
  emotion?: ShannonExpressiveEmotion,
): { affect: string; intensity: number; delivery: string } {
  if (emotion?.overrideReason === 'grief') {
    return { affect: 'caring', intensity: 0.5, delivery: 'gentle' };
  }
  if (emotion?.overrideReason === 'safety') {
    return { affect: 'focused', intensity: 0.45, delivery: 'focused' };
  }
  return { affect: direction.affect, intensity: direction.intensity, delivery: direction.delivery };
}

function deliveryForEmotion(
  emotion: ShannonExpressiveEmotion,
  fallback: VoiceTurnDecision['delivery'],
): VoiceTurnDecision['delivery'] {
  if (['caring', 'gentle', 'tender', 'affectionate', 'quietCompanion', 'sad', 'hurt', 'apologetic'].includes(emotion.primary)) {
    return 'gentle';
  }
  if (['protective', 'reassurance'].includes(emotion.primary)) return 'focused';
  if (['excited', 'ecstatic', 'giggle', 'mischievous', 'triumphant', 'scream'].includes(emotion.primary)) {
    return 'energetic';
  }
  if (['focused', 'determined', 'cautious', 'urgent', 'serious', 'seriousAnger', 'protectiveAnger'].includes(emotion.primary)) {
    return 'focused';
  }
  return fallback;
}

/**
 * The face a voice turn is stored with. The turn route resolves the reply again with the emotion the plan carried; when
 * that only says "what she feels goes on" under another kind (the plan showed a mood that came up from underneath for
 * this reply), the stored face is the one the voice acted with, so the Talk and the call cannot disagree. Nothing is stored
 * in her state from here.
 */
export function storedVoiceFace(resolved: ReplyEmotion, voiced: { primary: string; intensity: number } | undefined): ShannonMessageEmotion {
  const feeling = resolved.expressiveEmotion;
  if (!voiced || !isShannonEmotionKind(voiced.primary) || voiced.primary === 'neutral' || voiced.intensity < 0.3
    || feeling.continued !== true || feeling.primary === voiced.primary || feeling.overrideReason) return resolved.messageEmotion;
  const { valence, arousal, openness } = resolved.messageEmotion;
  return Object.freeze({ valence, arousal, openness, ...faceForEmotionKind(voiced.primary) });
}
