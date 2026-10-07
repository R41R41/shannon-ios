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
): VoiceDecisionGateway {
  const skillThreshold = optionalProbability(
    environment.SHANNON_VOICE_SKILL_THRESHOLD ?? environment.SHANNON_JEV_SKILL_THRESHOLD,
  ) ?? 0.85;
  const openAIApiKey = environment.OPENAI_API_KEY?.trim();
  const openAIFallback = openAIApiKey ? new OpenAIVoiceDecisionGateway({
    apiKey: openAIApiKey,
    endpoint: environment.SHANNON_VOICE_ROUTER_ENDPOINT?.trim() || undefined,
    model: environment.SHANNON_VOICE_ROUTER_MODEL?.trim() || 'gpt-5.6-luna',
    timeoutMilliseconds: optionalPositiveInteger(environment.SHANNON_VOICE_ROUTER_TIMEOUT_MS) ?? 1_200,
    skillThreshold,
    usageStore,
  }) : undefined;
  const jevApiKey = environment.TYPESAFE_API_KEY?.trim();
  if (jevApiKey) return new JevVoiceDecisionGateway({
    apiKey: jevApiKey,
    endpoint: environment.SHANNON_JEV_ENDPOINT?.trim() || undefined,
    model: environment.SHANNON_JEV_MODEL?.trim() || 'jev-latest',
    timeoutMilliseconds: optionalPositiveInteger(environment.SHANNON_JEV_TIMEOUT_MS) ?? 900,
    skillThreshold,
    fallbackGateway: openAIFallback,
    ...(jevFetcher ? { fetcher: jevFetcher } : {}),
  });
  if (openAIFallback) return openAIFallback;
  return new LocalVoiceDecisionGateway(skillThreshold);
}
