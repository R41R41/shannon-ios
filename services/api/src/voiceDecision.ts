import { extractOutputText, parseJson, stableScopeIdentifier, validModel } from './chatModelSupport.js';
import { estimatedOpenAICostUsd, responseUsage, type LlmUsageStore } from './llmUsage.js';

export const VOICE_SKILLS = [
  'current_web',
  'conversation_memory',
  'daily_mind',
  'aether_notes',
  'voyager_tasks',
  'agent_status',
  'device_context',
] as const;

export type VoiceSkill = typeof VOICE_SKILLS[number];
export type VoiceAffect = 'neutral' | 'bright' | 'playful' | 'caring' | 'serious' | 'apologetic' | 'excited';
export type VoiceDelivery = 'conversational' | 'quick' | 'gentle' | 'focused' | 'energetic';
export type VoiceConversationClass = 'no_response' | 'greeting' | 'direct' | 'skill_simple' | 'skill_complex';

export interface VoiceDecisionInput {
  scopeKey: string;
  transcript: string;
  participantMode: 'owner' | 'guest';
  requestedLocation: boolean;
  hasFreshLocation: boolean;
}

export interface VoiceTurnDecision {
  source: 'jev' | 'openai' | 'fallback';
  shouldRespond: boolean;
  replyRequiredProbability: number;
  conversationClass: VoiceConversationClass;
  affect: VoiceAffect;
  delivery: VoiceDelivery;
  selectedSkills: readonly VoiceSkill[];
  skillScores: Readonly<Record<VoiceSkill, number>>;
  elapsedMilliseconds: number;
}

export interface VoiceDecisionGateway {
  readonly mode: 'jev' | 'openai' | 'fallback';
  readonly model: string;
  decide(input: VoiceDecisionInput): Promise<VoiceTurnDecision>;
}

const skillInstructions: Readonly<Record<VoiceSkill, string>> = {
  current_web: 'Does answering this utterance require current or externally verified web information, such as weather, news, schedules, transit, opening hours, prices, or current public facts?',
  conversation_memory: 'Does answering well require the owner\'s remembered preferences, prior experiences, promises, relationships, or earlier conversation context?',
  daily_mind: 'Would Shannon\'s current daily reflection or ongoing personal context materially improve this reply?',
  aether_notes: 'Does the utterance ask about notes, memos, or information explicitly shared from Aether?',
  voyager_tasks: 'Does the utterance ask to find, inspect, discuss, or update tasks or to-do items stored in Voyager?',
  agent_status: 'Does the utterance ask about the status, completion, failure, approval, or progress of Codex or agent work?',
  device_context: 'Does answering require the device\'s current local time, timezone, or one-time location?',
};

const mandatorySkillPatterns: Readonly<Partial<Record<VoiceSkill, RegExp>>> = {
  current_web: /(?:最新|天気|ニュース|運行|遅延|時刻表|何時|営業時間|価格|相場|検索|調べて|電車|バス|経路|ルート)/iu,
  conversation_memory: /(?:覚えて|前に|以前|この前|約束|好み|私の|僕の|過去の会話|思い出|目標|目的|続き|踏まえて|今まで)/iu,
  aether_notes: /(?:aether|ノート|メモ)/iu,
  voyager_tasks: /(?:voyager|タスク|to.?do|やること)/iu,
  agent_status: /(?:(?:codex|エージェント).{0,20}(?:進捗|状況|完了|失敗|承認待ち)|(?:作業|実装|ビルド|デプロイ).{0,12}(?:進捗|状況|完了|終わった|どうなった|承認待ち))/iu,
  device_context: /(?:ここから|現在地|近く|周辺|いま何時|今何時|今日は何日|今日は何曜日)/iu,
};

const emptySkillScores = (): Record<VoiceSkill, number> => Object.fromEntries(
  VOICE_SKILLS.map(skill => [skill, 0]),
) as Record<VoiceSkill, number>;

export class LocalVoiceDecisionGateway implements VoiceDecisionGateway {
  readonly mode = 'fallback' as const;
  readonly model = 'local-rules';

  constructor(private readonly skillThreshold = 0.55) {}

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
    this.skillThreshold = boundedProbability(options.skillThreshold, 0.55);
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
                  conversationClass: {
                    type: 'string', enum: ['no_response', 'greeting', 'direct', 'skill_simple', 'skill_complex'],
                  },
                  affect: {
                    type: 'string', enum: ['neutral', 'bright', 'playful', 'caring', 'serious', 'apologetic', 'excited'],
                  },
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
                required: ['replyRequiredProbability', 'conversationClass', 'affect', 'delivery', 'skillScores'],
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
    this.model = options.model ?? 'jev-1.13.0';
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 900;
    this.skillThreshold = boundedProbability(options.skillThreshold, 0.55);
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
            neutral: 'Natural and emotionally unmarked.', bright: 'Warm and cheerful.', playful: 'Teasing or mischievous.',
            caring: 'Gentle concern or affection.', serious: 'Careful, factual, or weighty.', apologetic: 'Owning a mistake or disappointment.',
            excited: 'Celebratory or strongly enthusiastic.',
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
  ) ?? 0.55;
  const jevApiKey = environment.TYPESAFE_API_KEY?.trim();
  if (jevApiKey) return new JevVoiceDecisionGateway({
    apiKey: jevApiKey,
    endpoint: environment.SHANNON_JEV_ENDPOINT?.trim() || undefined,
    model: environment.SHANNON_JEV_MODEL?.trim() || 'jev-1.13.0',
    timeoutMilliseconds: optionalPositiveInteger(environment.SHANNON_JEV_TIMEOUT_MS) ?? 900,
    skillThreshold,
  });
  const openAIApiKey = environment.OPENAI_API_KEY?.trim();
  if (openAIApiKey) return new OpenAIVoiceDecisionGateway({
    apiKey: openAIApiKey,
    endpoint: environment.SHANNON_VOICE_ROUTER_ENDPOINT?.trim() || undefined,
    model: environment.SHANNON_VOICE_ROUTER_MODEL?.trim() || 'gpt-5.6-luna',
    timeoutMilliseconds: optionalPositiveInteger(environment.SHANNON_VOICE_ROUTER_TIMEOUT_MS) ?? 1_200,
    skillThreshold,
    usageStore,
  });
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
  const conversationClass = directChoiceValue(value.conversationClass,
    ['no_response', 'greeting', 'direct', 'skill_simple', 'skill_complex'] as const);
  const affect = directChoiceValue(value.affect,
    ['neutral', 'bright', 'playful', 'caring', 'serious', 'apologetic', 'excited'] as const);
  const delivery = directChoiceValue(value.delivery,
    ['conversational', 'quick', 'gentle', 'focused', 'energetic'] as const);
  return {
    source: 'openai',
    shouldRespond: !(conversationClass === 'no_response' && replyRequiredProbability < 0.4),
    replyRequiredProbability,
    conversationClass,
    affect,
    delivery,
    selectedSkills: selectedSkills(skillScores, skillThreshold, input.participantMode),
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
  const conversationClass = choiceValue(answerMap.conversation_class, [
    'no_response', 'greeting', 'direct', 'skill_simple', 'skill_complex',
  ] as const);
  const affect = choiceValue(answerMap.affect, [
    'neutral', 'bright', 'playful', 'caring', 'serious', 'apologetic', 'excited',
  ] as const);
  const delivery = choiceValue(answerMap.delivery, [
    'conversational', 'quick', 'gentle', 'focused', 'energetic',
  ] as const);
  const shouldRespond = !(conversationClass === 'no_response' && replyRequiredProbability < 0.4);
  return {
    source: 'jev', shouldRespond, replyRequiredProbability, conversationClass, affect, delivery,
    selectedSkills: selectedSkills(skillScores, skillThreshold, input.participantMode),
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
  return {
    source: 'fallback', shouldRespond: !acknowledgementOnly,
    replyRequiredProbability: acknowledgementOnly ? 0.1 : 0.9,
    conversationClass, affect, delivery, selectedSkills: selected, skillScores,
    elapsedMilliseconds: Math.max(0, Math.round(elapsedMilliseconds)),
  };
}

function applyMandatorySkillFloors(scores: Record<VoiceSkill, number>, input: VoiceDecisionInput): void {
  for (const skill of VOICE_SKILLS) {
    if (mandatorySkillPatterns[skill]?.test(input.transcript)) scores[skill] = Math.max(scores[skill], 1);
  }
  if (input.requestedLocation) scores.device_context = 1;
  if (input.participantMode === 'guest') {
    scores.conversation_memory = 0;
    scores.daily_mind = 0;
    scores.aether_notes = 0;
    scores.voyager_tasks = 0;
    scores.agent_status = 0;
  }
}

function selectedSkills(
  scores: Readonly<Record<VoiceSkill, number>>,
  threshold: number,
  participantMode: VoiceDecisionInput['participantMode'],
): VoiceSkill[] {
  const privateSkills = new Set<VoiceSkill>([
    'conversation_memory', 'daily_mind', 'aether_notes', 'voyager_tasks', 'agent_status',
  ]);
  return VOICE_SKILLS.filter(skill => scores[skill] >= threshold
    && !(participantMode === 'guest' && privateSkills.has(skill)));
}

function noulValue(value: unknown): number {
  if (!value || typeof value !== 'object') throw new Error('JEV_RESPONSE_INVALID');
  const probability = (value as { noul?: unknown }).noul;
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error('JEV_RESPONSE_INVALID');
  }
  return probability;
}

function probabilityValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('VOICE_DECISION_PROBABILITY_INVALID');
  }
  return value;
}

function choiceValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (!value || typeof value !== 'object') throw new Error('JEV_RESPONSE_INVALID');
  const choice = (value as { choice?: unknown }).choice;
  if (typeof choice !== 'string' || !allowed.includes(choice)) throw new Error('JEV_RESPONSE_INVALID');
  return choice as T[number];
}

function directChoiceValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error('VOICE_DECISION_CHOICE_INVALID');
  return value as T[number];
}

function optionalProbability(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function boundedProbability(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}
