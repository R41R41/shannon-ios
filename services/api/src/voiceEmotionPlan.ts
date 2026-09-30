import type { ShannonExpressiveEmotion } from '@shannon/cognition';
import type { VoiceTurnDecision } from './voiceDecision.js';

export function voicePlanResponse(
  decision: VoiceTurnDecision,
  emotion?: ShannonExpressiveEmotion,
): Record<string, unknown> {
  return {
    shouldRespond: decision.shouldRespond,
    replyRequiredProbability: decision.replyRequiredProbability,
    solutionWantedProbability: decision.solutionWantedProbability,
    conversationClass: decision.conversationClass,
    latencyClass: decision.latencyClass,
    affect: emotion?.primary ?? decision.affect,
    affectIntensity: emotion?.intensity ?? decision.affectIntensity,
    delivery: emotion ? deliveryForEmotion(emotion, decision.delivery) : decision.delivery,
    ...(emotion ? { emotion } : {}),
    selectedSkills: decision.selectedSkills,
    skillScores: decision.skillScores,
    waitingPhrase: voiceWaitingPhrase(decision),
    decisionSource: decision.source,
    decisionLatencyMilliseconds: decision.elapsedMilliseconds,
    transcriptReliabilityProbability: decision.transcriptReliabilityProbability ?? null,
  };
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

function voiceWaitingPhrase(decision: VoiceTurnDecision): string | undefined {
  if (decision.latencyClass === 'under_1s' || decision.latencyClass === 'under_3s') return undefined;
  if (decision.latencyClass === 'over_10s') {
    return '少し時間がかかりそうなので、順番に確認しますね。';
  }
  const skills = new Set(decision.selectedSkills);
  if (skills.has('aether_notes') && skills.has('voyager_tasks')) return 'AetherとVoyagerを確認してみますね。';
  if (skills.has('aether_notes')) return 'Aetherを見てみますね。';
  if (skills.has('voyager_tasks')) return 'Voyagerのタスクを確認しますね。';
  if (skills.has('agent_status')) return '作業の進み具合を確認してきますね。';
  if (skills.has('current_web')) return 'ちょっと最新の情報を調べてみますね。';
  return '少し確認してみますね。';
}
