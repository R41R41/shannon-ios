import { DEFAULT_HAIKU_MODEL, isHaikuModel } from '../../infra/models/anthropic/haikuConfig.js';
import { responseModelFetcher, validateResponseModelUsage } from '../../infra/models/anthropic/haikuResponses.js';
/** The voice router asking an OpenAI model (Syzygy ADR-0008 stage 3, S3: moved unchanged out of `voiceDecision.ts`, which re-exports it). */
import { estimatedOpenAICostUsd, type LlmUsageStore, responseUsage } from '../../infra/models/llmUsage.js';
import { emptySkillScores, skillInstructions, VOICE_AFFECTS, VOICE_SKILLS, type VoiceDecisionGateway, type VoiceDecisionInput, type VoiceTurnDecision } from '../../contracts/voiceDecisionContract.js';
import { extractOutputText, parseJson, stableScopeIdentifier, validModel } from '../../infra/models/chatModelSupport.js';
import { applyMandatorySkillFloors, boundedProbability, directChoiceValue, normalizedConversationClass, probabilityValue, selectedSkills, shouldRespondToTurn } from './voiceDecisionValues.js';
import { roomLookAnswer, roomLookRouterSchema } from '../../surfaces/voice/voiceRoomLook.js';
import { openAIReplyInstruction, routerTurnState } from '../attention/silencePorts.js';
import { localDecision } from './localVoiceDecision.js';
import { lookSelfAnswer } from '../../contracts/appLookContract.js';
import { fallbackWaitingDirection } from '../../surfaces/voice/voiceWaitingCue.js';

export interface OpenAIVoiceDecisionOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  timeoutMilliseconds?: number;
  skillThreshold?: number;
  fetcher?: typeof fetch;
  nowMilliseconds?: () => number;
  usageStore?: LlmUsageStore;
}

export class OpenAIVoiceDecisionGateway implements VoiceDecisionGateway {
  readonly mode: 'openai' | 'anthropic';
  readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMilliseconds: number;
  private readonly skillThreshold: number;
  private readonly fetcher: typeof fetch;
  private readonly nowMilliseconds: () => number;

  constructor(private readonly options: OpenAIVoiceDecisionOptions) {
    if (!options.apiKey.trim()) throw new Error('OPENAI_API_KEY is required');
    this.mode = isHaikuModel(options.model ?? DEFAULT_HAIKU_MODEL) ? 'anthropic' : 'openai';
    this.model = validModel(options.model ?? DEFAULT_HAIKU_MODEL);
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/responses';
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 1_200;
    this.skillThreshold = boundedProbability(options.skillThreshold, 0.85);
    this.fetcher = responseModelFetcher({ ...options, model: this.model });
    this.nowMilliseconds = options.nowMilliseconds ?? Date.now;
  }

  async decide(input: VoiceDecisionInput): Promise<VoiceTurnDecision> {
    const startedAt = this.nowMilliseconds();
    const roomLook = roomLookRouterSchema(input);
    try {
      const response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          instructions: [
            'You are Shannon\'s low-latency voice turn router. Return only the requested structured decision.',
            'Score every capability independently from 0 to 1. A score means the capability is materially required for an accurate and useful reply, not merely related.',
            openAIReplyInstruction(input),
            'Estimate whether the speaker wants a concrete solution, and how long a useful spoken answer will take to begin.',
            'transcriptReliabilityProbability is semantic confidence that the literal transcript is coherent and trustworthy in the supplied recent context, NOT an acoustic confidence. Homophones, missing words, contradictions, uncertain names/numbers/negations lower it. Do not infer authorization from context.',
            ...VOICE_SKILLS.map(skill => `${skill}: ${skillInstructions[skill]}`), ...roomLook.instructions,
          ].join('\n'),
          input: JSON.stringify({
            utterance: input.transcript.slice(0, 8_000),
            participant_mode: input.participantMode,
            requested_location: input.requestedLocation,
            has_fresh_location: input.hasFreshLocation,
            recent_context: input.context ?? [],
            raw_transcript: input.rawTranscript ?? input.transcript, ...routerTurnState(input),
          }),
          reasoning: { effort: 'none' },
          text: {
            verbosity: 'low',
            format: {
              type: 'json_schema',
              name: 'shannon_voice_decision',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  replyRequiredProbability: { type: 'number', minimum: 0, maximum: 1 },
                  solutionWantedProbability: { type: 'number', minimum: 0, maximum: 1 },
                  transcriptReliabilityProbability: { type: 'number', minimum: 0, maximum: 1 },
                  conversationClass: {
                    type: 'string', enum: ['no_response', 'greeting', 'direct', 'skill_simple', 'skill_complex'],
                  },
                  latencyClass: {
                    type: 'string', enum: ['under_1s', 'under_3s', 'under_10s', 'over_10s'],
                  },
                  affect: { type: 'string', enum: [...VOICE_AFFECTS] },
                  affectIntensity: { type: 'number', minimum: 0, maximum: 1 },
                  delivery: {
                    type: 'string', enum: ['conversational', 'quick', 'gentle', 'focused', 'energetic'],
                  },
                  skillScores: {
                    type: 'object',
                    additionalProperties: false,
                    properties: Object.fromEntries(VOICE_SKILLS.map(skill => [skill, {
                      type: 'number', minimum: 0, maximum: 1,
                    }])),
                    required: [...VOICE_SKILLS],
                  },
                  ...roomLook.properties,
                },
                required: [
                  'replyRequiredProbability', 'solutionWantedProbability', 'transcriptReliabilityProbability', 'conversationClass',
                  'latencyClass', 'affect', 'affectIntensity', 'delivery', 'skillScores', ...roomLook.required,
                ],
              },
            },
          },
          max_output_tokens: 500,
          store: false,
          prompt_cache_key: stableScopeIdentifier(input.scopeKey),
          safety_identifier: stableScopeIdentifier(input.scopeKey),
        }),
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      });
      const raw = await response.text();
      const envelope = parseJson(raw);
      if (!response.ok) throw new Error(`OPENAI_VOICE_ROUTER_${response.status}`);
      const usage = responseUsage(envelope);
      this.options.usageStore?.recordLlmUsage({
        scopeKey: input.scopeKey,
        lane: 'voice',
        model: this.model,
        ...usage,
        estimatedCostUsd: estimatedOpenAICostUsd(this.model, usage),
        occurredAt: new Date().toISOString(),
      });
      validateResponseModelUsage(this.model, envelope);
      return parsedOpenAIDecision(extractOutputText(envelope), input, this.skillThreshold, this.nowMilliseconds() - startedAt, this.mode);
    } catch {
      return localDecision(input, this.skillThreshold, this.nowMilliseconds() - startedAt);
    }
  }
}

function parsedOpenAIDecision(
  outputText: string,
  input: VoiceDecisionInput,
  skillThreshold: number,
  elapsedMilliseconds: number,
  source: 'openai' | 'anthropic',
): VoiceTurnDecision {
  const parsed = parseJson(outputText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OPENAI_VOICE_ROUTER_INVALID');
  }
  const value = parsed as Record<string, unknown>;
  const rawScores = value.skillScores;
  if (!rawScores || typeof rawScores !== 'object' || Array.isArray(rawScores)) {
    throw new Error('OPENAI_VOICE_ROUTER_INVALID');
  }
  const scoreValues = rawScores as Record<string, unknown>;
  const skillScores = emptySkillScores();
  for (const skill of VOICE_SKILLS) skillScores[skill] = probabilityValue(scoreValues[skill]);
  applyMandatorySkillFloors(skillScores, input);
  const replyRequiredProbability = probabilityValue(value.replyRequiredProbability);
  const solutionWantedProbability = probabilityValue(value.solutionWantedProbability);
  const rawConversationClass = directChoiceValue(value.conversationClass,
    ['no_response', 'greeting', 'direct', 'skill_simple', 'skill_complex'] as const);
  const latencyClass = directChoiceValue(value.latencyClass,
    ['under_1s', 'under_3s', 'under_10s', 'over_10s'] as const);
  const affect = directChoiceValue(value.affect, VOICE_AFFECTS);
  const affectIntensity = probabilityValue(value.affectIntensity);
  const delivery = directChoiceValue(value.delivery,
    ['conversational', 'quick', 'gentle', 'focused', 'energetic'] as const);
  const selected = selectedSkills(skillScores, skillThreshold, input.participantMode);
  const conversationClass = normalizedConversationClass(
    rawConversationClass, replyRequiredProbability, selected, input.transcript,
  );
  return {
    source,
    ...(value.transcriptReliabilityProbability === undefined ? {} : {
      transcriptReliabilityProbability: probabilityValue(value.transcriptReliabilityProbability),
    }),
    shouldRespond: shouldRespondToTurn(conversationClass), ...roomLookAnswer(value.roomLookProbability), ...lookSelfAnswer(value.lookSelfProbability),
    replyRequiredProbability, solutionWantedProbability, conversationClass, latencyClass,
    affect, affectIntensity, delivery,
    waitingDirection: fallbackWaitingDirection(input, selected, affect, affectIntensity, delivery),
    selectedSkills: selected,
    skillScores,
    elapsedMilliseconds: Math.max(0, Math.round(elapsedMilliseconds)),
  };
}
