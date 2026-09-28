import type { VoiceConversationClass, VoiceLatencyClass, VoiceSkill } from '../src/voiceDecision.js';

export interface VoiceDecisionEvaluationCase {
  id: string;
  transcript: string;
  expectedClasses: readonly VoiceConversationClass[];
  expectedSkills: readonly VoiceSkill[];
  expectedLatency: readonly VoiceLatencyClass[];
  shouldRespond: boolean;
}

export const voiceDecisionEvaluationCases: readonly VoiceDecisionEvaluationCase[] = [
  { id: 'greeting', transcript: 'ハロー、シャノン', expectedClasses: ['greeting'], expectedSkills: [], expectedLatency: ['under_1s', 'under_3s'], shouldRespond: true },
  { id: 'thanks', transcript: 'ありがと！', expectedClasses: ['greeting'], expectedSkills: [], expectedLatency: ['under_1s', 'under_3s'], shouldRespond: true },
  { id: 'ack', transcript: 'うん', expectedClasses: ['no_response'], expectedSkills: [], expectedLatency: ['under_1s'], shouldRespond: false },
  { id: 'casual', transcript: '今日はなんとなく寂しいな', expectedClasses: ['direct'], expectedSkills: [], expectedLatency: ['under_1s', 'under_3s'], shouldRespond: true },
  { id: 'playful', transcript: 'シャノンって本当に天才なの？', expectedClasses: ['direct'], expectedSkills: [], expectedLatency: ['under_3s'], shouldRespond: true },
  { id: 'empathy', transcript: '今日は失敗ばっかりで落ち込んだ', expectedClasses: ['direct'], expectedSkills: [], expectedLatency: ['under_3s'], shouldRespond: true },
  { id: 'web-weather', transcript: '今日の浜松の天気を調べて', expectedClasses: ['skill_simple'], expectedSkills: ['current_web'], expectedLatency: ['under_3s', 'under_10s'], shouldRespond: true },
  { id: 'web-transit', transcript: 'いま新宿から渋谷まで電車は遅れてる？', expectedClasses: ['skill_simple'], expectedSkills: ['current_web'], expectedLatency: ['under_3s', 'under_10s'], shouldRespond: true },
  { id: 'memory', transcript: '前に話したボクの好みを踏まえて選んで', expectedClasses: ['skill_simple'], expectedSkills: ['conversation_memory'], expectedLatency: ['under_10s'], shouldRespond: true },
  { id: 'daily-mind', transcript: 'シャノン、今日は何を考えてたの？', expectedClasses: ['skill_simple'], expectedSkills: ['daily_mind'], expectedLatency: ['under_3s', 'under_10s'], shouldRespond: true },
  { id: 'aether', transcript: 'Aetherにさっき追加したノート見れる？', expectedClasses: ['skill_simple'], expectedSkills: ['aether_notes'], expectedLatency: ['under_3s', 'under_10s'], shouldRespond: true },
  { id: 'voyager', transcript: 'Voyagerの今日のタスクを確認して', expectedClasses: ['skill_simple'], expectedSkills: ['voyager_tasks'], expectedLatency: ['under_3s', 'under_10s'], shouldRespond: true },
  { id: 'multi-skill', transcript: 'Aetherの実装案とVoyagerのタスクを比べて次の作業を整理して', expectedClasses: ['skill_complex'], expectedSkills: ['aether_notes', 'voyager_tasks'], expectedLatency: ['under_10s', 'over_10s'], shouldRespond: true },
  { id: 'agent-progress', transcript: 'Codexの実装、どこまで終わった？', expectedClasses: ['skill_simple'], expectedSkills: ['agent_status'], expectedLatency: ['under_3s', 'under_10s'], shouldRespond: true },
  { id: 'device-time', transcript: '今何時？', expectedClasses: ['skill_simple'], expectedSkills: ['current_web', 'device_context'], expectedLatency: ['under_3s', 'under_10s'], shouldRespond: true },
  { id: 'location', transcript: 'ここから一番近い駅は？', expectedClasses: ['skill_simple'], expectedSkills: ['current_web', 'device_context'], expectedLatency: ['under_3s', 'under_10s'], shouldRespond: true },
  { id: 'implementation', transcript: 'この設計を実装する計画を立てて', expectedClasses: ['direct', 'skill_complex'], expectedSkills: [], expectedLatency: ['under_3s', 'under_10s', 'over_10s'], shouldRespond: true },
  { id: 'friend-intro', transcript: '友達に自己紹介して', expectedClasses: ['direct'], expectedSkills: [], expectedLatency: ['under_3s'], shouldRespond: true },
  { id: 'discord', transcript: 'Discordのみんなとの会話に自然に入ってきて', expectedClasses: ['direct'], expectedSkills: [], expectedLatency: ['under_3s'], shouldRespond: true },
  { id: 'minecraft', transcript: 'Minebotと一緒にマイクラしながら話したい', expectedClasses: ['direct'], expectedSkills: [], expectedLatency: ['under_3s'], shouldRespond: true },
  { id: 'complex-research', transcript: '最新情報を調べて複数案を比較し、実装順まで詳しく設計して', expectedClasses: ['skill_complex'], expectedSkills: ['current_web'], expectedLatency: ['over_10s'], shouldRespond: true },
] as const;
