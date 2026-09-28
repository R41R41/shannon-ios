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
export type VoiceLatencyClass = 'under_1s' | 'under_3s' | 'under_10s' | 'over_10s';

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
  solutionWantedProbability: number;
  conversationClass: VoiceConversationClass;
  latencyClass: VoiceLatencyClass;
  affect: VoiceAffect;
  affectIntensity: number;
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

export const skillInstructions: Readonly<Record<VoiceSkill, string>> = {
  current_web: 'Does answering this utterance require current or externally verified web information, such as weather, news, schedules, transit, opening hours, prices, or current public facts?',
  conversation_memory: 'Does answering well require the owner\'s remembered preferences, prior experiences, promises, relationships, or earlier conversation context?',
  daily_mind: 'Would Shannon\'s current daily reflection or ongoing personal context materially improve this reply?',
  aether_notes: 'Does the utterance ask about notes, memos, or information explicitly shared from Aether?',
  voyager_tasks: 'Does the utterance ask to find, inspect, discuss, or update tasks or to-do items stored in Voyager?',
  agent_status: 'Does the utterance ask about the status, completion, failure, approval, or progress of Codex or agent work?',
  device_context: 'Does answering require the device\'s current local time, timezone, or one-time location?',
};

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
