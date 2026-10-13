import { observeAsync } from '../../infra/observer/observerContext.js';
import { configuredResponseModel } from '../../infra/models/anthropic/haikuConfig.js';
import { type LlmUsageStore } from '../../infra/models/llmUsage.js';
import { VOICE_AFFECTS, VOICE_SKILLS, type VoiceAffect, type VoiceConversationClass, type VoiceDecisionGateway, type VoiceDecisionInput, type VoiceDelivery, type VoiceLatencyClass, type VoiceSkill, type VoiceTurnDecision } from '../../contracts/voiceDecisionContract.js';
import { optionalPositiveInteger, optionalProbability } from './voiceDecisionValues.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';
import { LocalVoiceDecisionGateway, localDecision } from './localVoiceDecision.js';
import { JevVoiceDecisionGateway } from './jevVoiceDecision.js';
import { OpenAIVoiceDecisionGateway } from './openAIVoiceDecision.js';
export { type OpenAIVoiceDecisionOptions, OpenAIVoiceDecisionGateway } from './openAIVoiceDecision.js';
export { type JevVoiceDecisionOptions, JevVoiceDecisionGateway } from './jevVoiceDecision.js';
export { LocalVoiceDecisionGateway } from './localVoiceDecision.js';

export {
  VOICE_AFFECTS, VOICE_SKILLS,
  type VoiceAffect, type VoiceConversationClass, type VoiceDecisionGateway,
  type VoiceDecisionInput, type VoiceDelivery, type VoiceLatencyClass,
  type VoiceSkill, type VoiceTurnDecision,
} from '../../contracts/voiceDecisionContract.js';

export function createConfiguredVoiceDecisionGateway(
  environment: Readonly<Record<string, string | undefined>> = serverEnvironment(),
  usageStore?: LlmUsageStore,
  /** The fetch the Jev client uses; decision traces pass one that counts the calls (`infra/models/jev/jevClient.ts`). */
  jevFetcher?: typeof fetch,
  /** The server's own parts: whether her weather tool exists, so that Jev is asked about the weather (`routerSkills`). */
  parts: { weatherSkill?: boolean } = {},
): VoiceDecisionGateway {
  const skillThreshold = optionalProbability(
    environment.SHANNON_VOICE_SKILL_THRESHOLD ?? environment.SHANNON_JEV_SKILL_THRESHOLD,
  ) ?? 0.85;
  const selected = configuredResponseModel(environment, 'SHANNON_VOICE_ROUTER_MODEL');
  const modelFallback = selected ? new OpenAIVoiceDecisionGateway({
    ...selected,
    endpoint: environment.SHANNON_VOICE_ROUTER_ENDPOINT?.trim() || undefined,
    timeoutMilliseconds: optionalPositiveInteger(environment.SHANNON_VOICE_ROUTER_TIMEOUT_MS) ?? 1_200,
    skillThreshold,
    usageStore,
  }) : undefined;
  const jevApiKey = environment.TYPESAFE_API_KEY?.trim();
  if (jevApiKey) return observedVoiceGateway(new JevVoiceDecisionGateway({
    apiKey: jevApiKey,
    endpoint: environment.SHANNON_JEV_ENDPOINT?.trim() || undefined,
    model: environment.SHANNON_JEV_MODEL?.trim() || 'jev-latest',
    timeoutMilliseconds: optionalPositiveInteger(environment.SHANNON_JEV_TIMEOUT_MS) ?? 900,
    skillThreshold,
    fallbackGateway: modelFallback,
    ...(jevFetcher ? { fetcher: jevFetcher } : {}), ...(parts.weatherSkill ? { weatherSkill: true } : {}),
  }));
  if (modelFallback) return observedVoiceGateway(modelFallback);
  return observedVoiceGateway(new LocalVoiceDecisionGateway(skillThreshold));
}

/** The existing configured router decides once. No words/context or free-form model output are projected. */
function observedVoiceGateway(gateway: VoiceDecisionGateway): VoiceDecisionGateway {
  const decide = gateway.decide.bind(gateway);
  gateway.decide = input => observeAsync('jevv', { participantMode: input.participantMode, contextMessages: input.context?.length ?? 0 },
      () => decide(input), value => ({ source: value.source, shouldRespond: value.shouldRespond,
        replyRequiredProbability: value.replyRequiredProbability, solutionWantedProbability: value.solutionWantedProbability,
        conversationClass: value.conversationClass, latencyClass: value.latencyClass, affect: value.affect,
        affectIntensity: value.affectIntensity, delivery: value.delivery, selectedSkills: value.selectedSkills,
        skillScores: value.skillScores, transcriptReliabilityProbability: value.transcriptReliabilityProbability,
        roomLookProbability: value.roomLookProbability, lookSelfProbability: value.lookSelfProbability, silence: value.silence }),
      { model: gateway.model });
  return gateway;
}
