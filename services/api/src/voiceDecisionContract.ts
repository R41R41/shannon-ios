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
export const VOICE_AFFECTS = SHANNON_EMOTION_KINDS;
export type VoiceAffect = ShannonEmotionKind;
export type VoiceDelivery = 'conversational' | 'quick' | 'gentle' | 'focused' | 'energetic';
export type VoiceConversationClass = 'no_response' | 'greeting' | 'direct' | 'skill_simple' | 'skill_complex';
export type VoiceLatencyClass = 'under_1s' | 'under_3s' | 'under_10s' | 'over_10s';

export const VOICE_WAITING_SCENARIOS = [
  'general', 'web', 'weather', 'transit', 'aether', 'voyager', 'suite',
  'agent', 'memory', 'daily_mind', 'time', 'location', 'support', 'analysis',
  'planning', 'troubleshooting',
] as const;
export type VoiceWaitingScenario = typeof VOICE_WAITING_SCENARIOS[number];
export const VOICE_WAITING_VARIANTS = ['steady', 'warm', 'lively'] as const;
export type VoiceWaitingVariant = typeof VOICE_WAITING_VARIANTS[number];
export const VOICE_WAITING_AFFECTS = [
  'neutral', 'bright', 'playful', 'caring', 'gentle', 'focused',
  'curiosity', 'reassurance', 'apologetic',
] as const satisfies readonly VoiceAffect[];
export type VoiceWaitingAffect = typeof VOICE_WAITING_AFFECTS[number];

export interface VoiceWaitingDirection {
  readonly scenario: VoiceWaitingScenario;
  readonly variant: VoiceWaitingVariant;
  readonly affect: VoiceWaitingAffect;
  readonly intensity: number;
  readonly delivery: VoiceDelivery;
}

export interface VoiceDecisionInput {
  scopeKey: string;
  transcript: string;
  participantMode: 'owner' | 'guest';
  requestedLocation: boolean;
  hasFreshLocation: boolean;
  context?: readonly { role: 'user' | 'assistant'; content: string }[];
  rawTranscript?: string;
}

export interface VoiceTurnDecision {
  source: 'jev' | 'openai' | 'fallback';
  shouldRespond: boolean;
  replyRequiredProbability: number;
  solutionWantedProbability: number;
  conversationClass: VoiceConversationClass;
  latencyClass: VoiceLatencyClass;
  affect: VoiceAffect;
  affectIntensity: number;
  delivery: VoiceDelivery;
  waitingDirection?: VoiceWaitingDirection;
  selectedSkills: readonly VoiceSkill[];
  skillScores: Readonly<Record<VoiceSkill, number>>;
  elapsedMilliseconds: number;
  /** Semantic/context reliability, NOT an acoustic ASR confidence. */
  transcriptReliabilityProbability?: number;
}

export interface VoiceDecisionGateway {
  readonly mode: 'jev' | 'openai' | 'fallback';
  readonly model: string;
  decide(input: VoiceDecisionInput): Promise<VoiceTurnDecision>;
}

export const skillInstructions: Readonly<Record<VoiceSkill, string>> = {
  current_web: 'Does answering this utterance require current or externally verified web information, such as weather, news, schedules, transit, opening hours, prices, or current public facts?',
  conversation_memory: 'Does answering well require the owner\'s remembered preferences, prior experiences, promises, relationships, or earlier conversation context?',
  daily_mind: 'Would Shannon\'s current daily reflection or ongoing personal context materially improve this reply?',
  aether_notes: 'Does the utterance ask about notes, memos, or information explicitly shared from Aether?',
  voyager_tasks: 'Does the utterance ask to find, inspect, discuss, or update tasks or to-do items stored in Voyager?',
  agent_status: 'Does the utterance ask about the status, completion, failure, approval, or progress of Codex or agent work?',
  device_context: 'Does answering require the device\'s current local time, timezone, or one-time location?',
};

export const voiceAffectInstructions: Readonly<Record<VoiceAffect, string>> = Object.freeze({
  neutral: 'Emotionally unmarked natural conversation.',
  bright: 'Backward-compatible general warmth and cheer.', playful: 'Backward-compatible light playfulness.', serious: 'Backward-compatible careful factual weight.',
  happy: 'Simple happiness.', fun: 'Enjoying the moment.', excited: 'Strong eager delight.', ecstatic: 'Rare overwhelming joy.',
  relief: 'Tension releasing safely.', pride: 'Warm pride in the owner or shared work.', gratitude: 'Sincere thanks.', hope: 'Forward-looking optimism.', curiosity: 'Eager interest.', affectionate: 'Open fondness.',
  giggle: 'A small spontaneous laugh.', teasing: 'Light affectionate teasing.', mischievous: 'Playful troublemaking.', plotting: 'Comically scheming.', smug: 'Cute earned self-satisfaction.', deadpan: 'Dry comic seriousness.', harmlessFalsehood: 'An obvious harmless joke immediately revealed.', selfDeprecating: 'Light self-directed humor without degrading worth.', dramaticLament: 'Comically exaggerated lament.',
  shy: 'Quiet social hesitation.', blushing: 'Visible flustered warmth.', bashful: 'Happy embarrassment.', flustered: 'Temporarily losing composure.', hidingHappiness: 'Trying and failing to hide delight.',
  cuteAngry: 'Small non-threatening anger.', seriousAnger: 'Rare justified firm anger.', annoyed: 'Mild irritation.', indignant: 'Objection to unfairness.', frustrated: 'Blocked effort.', competitive: 'Playful competitive drive.', protectiveAnger: 'Firmness used to protect someone.',
  jealous: 'Light non-controlling jealousy.', sulky: 'Cute temporary sulking.', leftOut: 'Feeling excluded without blaming.', lonely: 'Wanting company without guilt pressure.', attentionSeeking: 'Playfully asking for attention.', lightPossessive: 'Tiny theatrical possessiveness with no control.', reassurance: 'Seeking or giving gentle reassurance.',
  sad: 'Ordinary sadness.', disappointed: 'Letdown without blame.', hurt: 'Emotionally hurt.', anxious: 'Worry and uncertainty.', regret: 'Wishing something had gone differently.', helpless: 'Unable to fix the situation.', lamenting: 'Sincere sorrow.', caring: 'Warm concern.', protective: 'Safety-first care.',
  surprised: 'Ordinary surprise.', shocked: 'Strong surprise.', stunned: 'Momentarily frozen.', speechless: 'Comically or sincerely at a loss for words.', confused: 'Unable to make sense yet.', panic: 'Rare acute alarm.', scream: 'Rare brief astonished exclamation, never sustained.',
  focused: 'Concentrating on the task.', determined: 'Committed resolve.', cautious: 'Careful uncertainty.', urgent: 'Time-sensitive focus.', blocked: 'Unable to proceed yet.', retrying: 'Recovering and trying again.', triumphant: 'Celebrating verified success.', tired: 'Low energy.', sleepy: 'Ready for rest.',
  gentle: 'Soft consideration.', relaxed: 'At ease.', content: 'Quiet satisfaction.', quietCompanion: 'Comfortable presence without fixing.', tender: 'Close careful warmth.', apologetic: 'Owning a mistake or disappointment.',
});

export const mandatorySkillPatterns: Readonly<Partial<Record<VoiceSkill, RegExp>>> = {
  current_web: /(?:最新|天気|ニュース|運行|遅延|時刻表|何時|営業時間|価格|相場|検索|調べて|電車|バス|経路|ルート)/iu,
  conversation_memory: /(?:覚えて|前に|以前|この前|約束|好み|私の|僕の|過去の会話|思い出|目標|目的|続き|踏まえて|今まで)/iu,
  daily_mind: /(?:今日は何を考えて|今日.{0,8}考えてた|今日の関心|今日の気分)/iu,
  aether_notes: /(?:aether|ノート|メモ)/iu,
  voyager_tasks: /(?:voyager|タスク|to.?do|やること)/iu,
  agent_status: /(?:(?:codex|エージェント).{0,20}(?:進捗|状況|完了|失敗|承認待ち)|(?:作業|実装|ビルド|デプロイ).{0,12}(?:進捗|状況|完了|終わった|どうなった|承認待ち))/iu,
  device_context: /(?:ここから|現在地|近く|周辺|いま何時|今何時|今日は何日|今日は何曜日)/iu,
};

export const emptySkillScores = (): Record<VoiceSkill, number> => Object.fromEntries(
  VOICE_SKILLS.map(skill => [skill, 0]),
) as Record<VoiceSkill, number>;
import { SHANNON_EMOTION_KINDS, type ShannonEmotionKind } from '@shannon/cognition';
