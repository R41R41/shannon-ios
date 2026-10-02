import { deriveShannonFace, normalizeShannonExpressiveEmotion, type ShannonEmotion, type ShannonExpressiveEmotion } from '@shannon/cognition';
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
    // The plan carries the feeling as it is stored: the resolver's notes to the reducer stay on the server.
    ...(emotion ? { emotion: normalizeShannonExpressiveEmotion(emotion), ...deriveShannonFace(mood, emotion) } : {}),
    selectedSkills: decision.selectedSkills,
    skillScores: decision.skillScores,
    waitingPhrase,
    ...(waitingPerformance ? { waitingPerformance } : {}),
    decisionSource: decision.source,
    decisionLatencyMilliseconds: decision.elapsedMilliseconds,
    transcriptReliabilityProbability: decision.transcriptReliabilityProbability ?? null,
  };
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
