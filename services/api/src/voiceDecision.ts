import { extractOutputText, parseJson, stableScopeIdentifier, validModel } from './chatModelSupport.js';
import { estimatedOpenAICostUsd, responseUsage, type LlmUsageStore } from './llmUsage.js';
import {
  emptySkillScores, skillInstructions, VOICE_AFFECTS, VOICE_SKILLS, voiceAffectInstructions,
  type VoiceAffect, type VoiceConversationClass, type VoiceDecisionGateway,
  type VoiceDecisionInput, type VoiceDelivery, type VoiceLatencyClass,
  type VoiceSkill, type VoiceTurnDecision,
} from './voiceDecisionContract.js';
import {
  affectIntensityValue, applyMandatorySkillFloors, boundedProbability, choiceValue,
  directChoiceValue, noulValue, optionalPositiveInteger, optionalProbability,
  normalizedConversationClass, probabilityValue, selectedSkills, shouldRespondToTurn,
} from './voiceDecisionValues.js';

export {
  VOICE_AFFECTS, VOICE_SKILLS,
  type VoiceAffect, type VoiceConversationClass, type VoiceDecisionGateway,
  type VoiceDecisionInput, type VoiceDelivery, type VoiceLatencyClass,
  type VoiceSkill, type VoiceTurnDecision,
} from './voiceDecisionContract.js';

export class LocalVoiceDecisionGateway implements VoiceDecisionGateway {
  readonly mode = 'fallback' as const;
  readonly model = 'local-rules';

  constructor(private readonly skillThreshold = 0.85) {}

  async decide(input: VoiceDecisionInput): Promise<VoiceTurnDecision> {
    return localDecision(input, this.skillThreshold, 0);
  }
}

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
  readonly mode = 'openai' as const;
  readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMilliseconds: number;
  private readonly skillThreshold: number;
  private readonly fetcher: typeof fetch;
  private readonly nowMilliseconds: () => number;

  constructor(private readonly options: OpenAIVoiceDecisionOptions) {
    if (!options.apiKey.trim()) throw new Error('OPENAI_API_KEY is required');
    this.model = validModel(options.model ?? 'gpt-5.6-luna');
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/responses';
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 1_200;
    this.skillThreshold = boundedProbability(options.skillThreshold, 0.85);
    this.fetcher = options.fetcher ?? fetch;
    this.nowMilliseconds = options.nowMilliseconds ?? Date.now;
  }

  async decide(input: VoiceDecisionInput): Promise<VoiceTurnDecision> {
    const startedAt = this.nowMilliseconds();
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
            'Use no_response only for noise, abandoned fragments, or acknowledgements where silence is clearly natural. Choose the cheapest sufficient conversation class and a natural spoken affect and delivery.',
            'Estimate whether the speaker wants a concrete solution, and how long a useful spoken answer will take to begin.',
            ...VOICE_SKILLS.map(skill => `${skill}: ${skillInstructions[skill]}`),
          ].join('\n'),
          input: JSON.stringify({
            utterance: input.transcript.slice(0, 8_000),
            participant_mode: input.participantMode,
            requested_location: input.requestedLocation,
            has_fresh_location: input.hasFreshLocation,
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
                },
                required: [
                  'replyRequiredProbability', 'solutionWantedProbability', 'conversationClass',
                  'latencyClass', 'affect', 'affectIntensity', 'delivery', 'skillScores',
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
      const decision = parsedOpenAIDecision(
        extractOutputText(envelope), input, this.skillThreshold, this.nowMilliseconds() - startedAt,
      );
      const usage = responseUsage(envelope);
      this.options.usageStore?.recordLlmUsage({
        scopeKey: input.scopeKey,
        lane: 'voice',
        model: this.model,
        ...usage,
        estimatedCostUsd: estimatedOpenAICostUsd(this.model, usage),
        occurredAt: new Date().toISOString(),
      });
      return decision;
    } catch {
      return localDecision(input, this.skillThreshold, this.nowMilliseconds() - startedAt);
    }
  }
}

export interface JevVoiceDecisionOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  timeoutMilliseconds?: number;
  skillThreshold?: number;
  fetcher?: typeof fetch;
  nowMilliseconds?: () => number;
  fallbackGateway?: VoiceDecisionGateway;
}

export class JevVoiceDecisionGateway implements VoiceDecisionGateway {
  readonly mode = 'jev' as const;
  readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMilliseconds: number;
  private readonly skillThreshold: number;
  private readonly fetcher: typeof fetch;
  private readonly nowMilliseconds: () => number;

  constructor(private readonly options: JevVoiceDecisionOptions) {
    if (!options.apiKey.trim()) throw new Error('TYPESAFE_API_KEY is required');
    this.endpoint = options.endpoint ?? 'https://api.typesafe.ai/v1/systemone';
    this.model = options.model ?? 'jev-latest';
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 900;
    this.skillThreshold = boundedProbability(options.skillThreshold, 0.85);
    this.fetcher = options.fetcher ?? fetch;
    this.nowMilliseconds = options.nowMilliseconds ?? Date.now;
  }

  async decide(input: VoiceDecisionInput): Promise<VoiceTurnDecision> {
    const startedAt = this.nowMilliseconds();
    try {
      const questions = Object.fromEntries([
        ...VOICE_SKILLS.map(skill => [`skill__${skill}`, {
          type: 'noul',
          instructions: skillInstructions[skill],
          criteria: {
            true: 'This capability is materially needed for an accurate, useful reply.',
            false: 'The reply can be accurate and useful without this capability.',
          },
        }]),
        ['reply_required', {
          type: 'noul',
          instructions: 'Should Shannon produce a spoken reply to this utterance? False only for noise, a discarded fragment, or a conversational acknowledgement that naturally needs no response.',
          criteria: {
            true: 'A spoken response is expected or useful.',
            false: 'Silence is the most natural response.',
          },
        }],
        ['solution_wanted', {
          type: 'noul',
          instructions: 'Does the speaker primarily want a concrete answer, recommendation, plan, action, or problem solution rather than emotional presence or casual companionship?',
          criteria: {
            true: 'A solution or concrete outcome is the main need.',
            false: 'Empathy, companionship, playful conversation, or simply being heard is the main need.',
          },
        }],
        ['conversation_class', {
          type: 'choice',
          instructions: 'Classify the cheapest sufficient response path for this utterance.',
          criteria: {
            no_response: 'No spoken response is naturally needed.',
            greeting: 'A greeting, farewell, thanks, or similarly tiny social exchange.',
            direct: 'An LLM can answer directly without external skills or private context.',
            skill_simple: 'One or more skills are needed, but retrieval and synthesis are straightforward.',
            skill_complex: 'Skills plus multi-step analysis, comparison, planning, or substantial synthesis are needed.',
          },
        }],
        ['affect', {
          type: 'choice',
          instructions: 'Choose the primary emotional performance for Shannon\'s spoken reply.',
          criteria: {
            ...voiceAffectInstructions,
          },
        }],
        ['affect_intensity', {
          type: 'choice',
          instructions: 'Choose how strongly the primary emotion should be expressed. Prefer subtle unless the utterance clearly supports more.',
          criteria: {
            subtle: 'A light emotional tint within ordinary conversation.',
            moderate: 'Clearly audible emotion without dominating the content.',
            strong: 'A rare, unmistakable emotional performance justified by the moment.',
          },
        }],
        ['delivery', {
          type: 'choice',
          instructions: 'Choose the spoken delivery that best fits the utterance and likely reply.',
          criteria: {
            conversational: 'Ordinary natural conversation.', quick: 'Brief and brisk.', gentle: 'Softer and slower.',
            focused: 'Clear and deliberate for facts or instructions.', energetic: 'Lively tempo and larger pitch movement.',
          },
        }],
        ['latency_class', {
          type: 'choice',
          instructions: 'Estimate time until a useful spoken answer can begin, including selected skills and reasoning.',
          criteria: {
            under_1s: 'Tiny social or deterministic response.',
            under_3s: 'Direct generation or one very fast lookup.',
            under_10s: 'Skill retrieval or moderate synthesis.',
            over_10s: 'Complex multi-step work, broad research, or external action.',
          },
        }],
      ]);
      const response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          state: {
            utterance: input.transcript.slice(0, 8_000),
            participant_mode: input.participantMode,
            requested_location: input.requestedLocation,
            has_fresh_location: input.hasFreshLocation,
          },
          questions,
        }),
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      });
      const body = await response.json() as unknown;
      if (!response.ok) throw new Error(`JEV_RESPONSE_${response.status}`);
      return parsedJevDecision(body, input, this.skillThreshold, this.nowMilliseconds() - startedAt);
    } catch {
      if (this.options.fallbackGateway) {
        const fallback = await this.options.fallbackGateway.decide(input);
        return { ...fallback, elapsedMilliseconds: Math.max(0, Math.round(this.nowMilliseconds() - startedAt)) };
      }
      return localDecision(input, this.skillThreshold, this.nowMilliseconds() - startedAt);
    }
  }
}

export function createConfiguredVoiceDecisionGateway(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  usageStore?: LlmUsageStore,
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
  });
  if (openAIFallback) return openAIFallback;
  return new LocalVoiceDecisionGateway(skillThreshold);
}

function parsedOpenAIDecision(
  outputText: string,
  input: VoiceDecisionInput,
  skillThreshold: number,
  elapsedMilliseconds: number,
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
    source: 'openai',
    shouldRespond: shouldRespondToTurn(conversationClass),
    replyRequiredProbability, solutionWantedProbability, conversationClass, latencyClass,
    affect, affectIntensity, delivery,
    selectedSkills: selected,
    skillScores,
    elapsedMilliseconds: Math.max(0, Math.round(elapsedMilliseconds)),
  };
}

function parsedJevDecision(
  value: unknown,
  input: VoiceDecisionInput,
  skillThreshold: number,
  elapsedMilliseconds: number,
): VoiceTurnDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JEV_RESPONSE_INVALID');
  const answers = (value as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('JEV_RESPONSE_INVALID');
  const answerMap = answers as Record<string, unknown>;
  const skillScores = emptySkillScores();
  for (const skill of VOICE_SKILLS) {
    skillScores[skill] = noulValue(answerMap[`skill__${skill}`]);
  }
  applyMandatorySkillFloors(skillScores, input);
  const replyRequiredProbability = noulValue(answerMap.reply_required);
  const solutionWantedProbability = noulValue(answerMap.solution_wanted);
  const rawConversationClass = choiceValue(answerMap.conversation_class, [
    'no_response', 'greeting', 'direct', 'skill_simple', 'skill_complex',
  ] as const);
  const latencyClass = choiceValue(answerMap.latency_class, [
    'under_1s', 'under_3s', 'under_10s', 'over_10s',
  ] as const);
  const affect = choiceValue(answerMap.affect, VOICE_AFFECTS);
  const affectIntensity = affectIntensityValue(answerMap.affect_intensity);
  const delivery = choiceValue(answerMap.delivery, [
    'conversational', 'quick', 'gentle', 'focused', 'energetic',
  ] as const);
  const selected = selectedSkills(skillScores, skillThreshold, input.participantMode);
  const conversationClass = normalizedConversationClass(
    rawConversationClass, replyRequiredProbability, selected, input.transcript,
  );
  const shouldRespond = shouldRespondToTurn(conversationClass);
  return {
    source: 'jev', shouldRespond, replyRequiredProbability, solutionWantedProbability,
    conversationClass, latencyClass, affect, affectIntensity, delivery,
    selectedSkills: selected,
    skillScores, elapsedMilliseconds: Math.max(0, Math.round(elapsedMilliseconds)),
  };
}

function localDecision(
  input: VoiceDecisionInput,
  skillThreshold: number,
  elapsedMilliseconds: number,
): VoiceTurnDecision {
  const text = input.transcript.trim();
  const skillScores = emptySkillScores();
  applyMandatorySkillFloors(skillScores, input);
  const acknowledgementOnly = /^(?:うん|はい|へえ|なるほど|そうなんだ|ふーん)[。！!…]*$/u.test(text);
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
    source: 'fallback', shouldRespond: !acknowledgementOnly,
    replyRequiredProbability: acknowledgementOnly ? 0.1 : 0.9,
    solutionWantedProbability: solutionWanted ? 0.9 : 0.25,
    conversationClass, latencyClass, affect, affectIntensity, delivery,
    selectedSkills: selected, skillScores,
    elapsedMilliseconds: Math.max(0, Math.round(elapsedMilliseconds)),
  };
}
