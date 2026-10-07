/** The voice router without a model: the local rules every router falls back to (Syzygy ADR-0008 stage 3, S3: moved unchanged out of `voiceDecision.ts`, which re-exports it). */
import { emptySkillScores, type VoiceAffect, type VoiceConversationClass, type VoiceDecisionGateway, type VoiceDecisionInput, type VoiceDelivery, type VoiceLatencyClass, type VoiceTurnDecision } from '../../contracts/voiceDecisionContract.js';
import { applyMandatorySkillFloors, selectedSkills } from './voiceDecisionValues.js';
import { localTurnSilence } from '../attention/silencePorts.js';
import { fallbackWaitingDirection } from '../../surfaces/voice/voiceWaitingCue.js';

export class LocalVoiceDecisionGateway implements VoiceDecisionGateway {
  readonly mode = 'fallback' as const;
  readonly model = 'local-rules';

  constructor(private readonly skillThreshold = 0.85) {}

  async decide(input: VoiceDecisionInput): Promise<VoiceTurnDecision> {
    return localDecision(input, this.skillThreshold, 0);
  }
}

export function localDecision(
  input: VoiceDecisionInput,
  skillThreshold: number,
  elapsedMilliseconds: number,
): VoiceTurnDecision {
  const text = input.transcript.trim();
  const skillScores = emptySkillScores();
  applyMandatorySkillFloors(skillScores, input);
  // The local rules of silence (`voiceSilence.ts`); without turn facts, a bare acknowledgement as before.
  const { quiet: acknowledgementOnly, silence } = localTurnSilence(input);
  const greeting = /^(?:おはよう|こんにちは|こんばんは|ただいま|おやすみ|またね|ありがとう|ありがと)[。！!…]*$/u.test(text);
  const selected = selectedSkills(skillScores, skillThreshold, input.participantMode);
  const complex = selected.length > 2 || text.length > 140
    || /(?:比較|分析|設計|計画|詳しく|順番|整理して|考えて)/u.test(text);
  const conversationClass: VoiceConversationClass = acknowledgementOnly ? 'no_response'
    : greeting ? 'greeting'
      : selected.length === 0 ? 'direct'
        : complex ? 'skill_complex' : 'skill_simple';
  const affect: VoiceAffect = /(?:ごめん|申し訳|残念)/u.test(text) ? 'apologetic'
    : /(?:大丈夫|心配|つら|怖|寂し|疲れ)/u.test(text) ? 'caring'
      : /(?:やった|最高|嬉し|！|!)/u.test(text) ? 'excited'
        : greeting ? 'bright' : 'neutral';
  const delivery: VoiceDelivery = affect === 'caring' || affect === 'apologetic' ? 'gentle'
    : affect === 'excited' ? 'energetic'
      : selected.length > 0 ? 'focused'
        : greeting ? 'quick' : 'conversational';
  const solutionWanted = /(?:どうすれば|方法|教えて|調べて|実装|作って|直して|お願い|してほしい|できますか)/u.test(text);
  const latencyClass: VoiceLatencyClass = acknowledgementOnly || greeting ? 'under_1s'
    : conversationClass === 'direct' ? 'under_3s'
      : conversationClass === 'skill_simple' ? 'under_10s' : 'over_10s';
  const affectIntensity = affect === 'neutral' ? 0.2 : affect === 'excited' ? 0.85 : 0.55;
  return {
    source: 'fallback', shouldRespond: !acknowledgementOnly, ...(silence ? { silence } : {}),
    replyRequiredProbability: acknowledgementOnly ? 0.1 : 0.9,
    solutionWantedProbability: solutionWanted ? 0.9 : 0.25,
    conversationClass, latencyClass, affect, affectIntensity, delivery,
    waitingDirection: fallbackWaitingDirection(input, selected, affect, affectIntensity, delivery),
    selectedSkills: selected, skillScores,
    elapsedMilliseconds: Math.max(0, Math.round(elapsedMilliseconds)),
  };
}
