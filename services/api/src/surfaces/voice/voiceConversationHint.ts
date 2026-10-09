import type { VoiceTurnDecision } from '../../contracts/voiceDecisionContract.js';
import type { ShannonModelToolSession } from '../../infra/models/chatModelTools.js';
import { baseToolSession, withToolMenu } from '../../mind/tools/toolsPorts.js';

/** A routing hint, never a permission decision. The stable opener can recover any still-allowed tool. */
export function plainVoiceHint(decision: VoiceTurnDecision, message: string, uncertain: boolean): boolean {
  return !uncertain && decision.source !== 'fallback' && ['greeting', 'direct'].includes(decision.conversationClass)
    && !decision.selectedSkills.length && (decision.transcriptReliabilityProbability ?? 1) >= 0.85
    && !/(?:検索|調べ|最新|今日の|今の(?:天気|ニュース|価格)|予定|タスク|メモ|ノート|覚え|忘れ|作って|送って|消して|変更|保存|起動|停止|マイクラ|Minecraft|Aether|Voyager|Notion)/iu.test(message);
}
export function conversationHintMenu(tools: ShannonModelToolSession | undefined, hinted: boolean) {
  return hinted && tools ? withToolMenu(baseToolSession(tools), [], { deferMemoryReads: true }) : tools;
}
export const PLAIN_VOICE_HINT = '[Conversation routing hint] Jev judged this a direct conversational reply using available context. Start by answering naturally without unnecessary external reads. This is a hint: if the latest words, private facts, an action, current information or uncertainty actually require a tool, correct the routing through the unchanged tool_open catalog and normal gate.';
