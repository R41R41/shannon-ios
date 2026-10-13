import type { VoiceTurnDecision } from '../../contracts/voiceDecisionContract.js';
import type { ShannonModelToolSession } from '../../infra/models/chatModelTools.js';
import { baseToolSession, withToolMenu } from '../../mind/tools/toolsPorts.js';
import type { FcaConversationTurn } from '../../mind/action/fca/fcaConversationPorts.js';
import type { TaskView } from '../../mind/action/taskRuntime/taskRuntimePorts.js';
import { VOICE_RESEARCH_WAIT_MS } from './voiceResearchTurn.js';
import { mandatorySkillPatterns } from '../../contracts/voiceDecisionContract.js';

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


/**
 * The turn's capabilities with the web for a forecast question when her weather tool is not offered (anyone else there, or no
 * read tools): the web answers it as before. With the tool the weather is hers to read (2026-10-13 daily evals E2/E3).
 */
export function webForWeather(skills: Set<string>, weatherTool: boolean): Set<string> {
  if (skills.has('weather') && !weatherTool) skills.add('current_web');
  return skills;
}

/** 「どうなった？」「結果は？」「終わった？」: he asks how the work he asked for is going. */
const WORK_PROGRESS = /(?:どうなった|どうなってる|どんな感じ|結果(?:は|って|出た|どう)|終わった[？?か]|まだ(?:かな|[？?])|わかった[？?]|分かった[？?]|進み具合|進捗)/u;
export const asksWorkProgress = (transcript: string): boolean => WORK_PROGRESS.test(transcript);
/**
 * A progress question about her research, not about other work: Codex or agent work, a build, Voyager's tasks, Aether's notes
 * (「Codexの作業どうなった？」 must not hear a web research's result; review of a4ff16e7).
 */
export function asksResearchProgress(transcript: string): boolean {
  return asksWorkProgress(transcript) && !OTHER_WORK.some(pattern => pattern?.test(transcript));
}
const OTHER_WORK = [mandatorySkillPatterns.agent_status, mandatorySkillPatterns.voyager_tasks, mandatorySkillPatterns.aether_notes,
  /(?:codex|コーデックス|エージェント|作業|実装|ビルド|デプロイ|リリース|配信|testflight|テストフライト|PR|プルリク|修正|改修)/iu];

/** The content words of a progress question (kanji, katakana, Latin), without the progress words themselves. */
function topicWords(transcript: string): string[] {
  const content = transcript.replace(WORK_PROGRESS, ' ').replace(/(?:調べもの|調べ物|調べ|検索|リサーチ|結果|さっき|あれ|それ)/gu, ' ');
  return [...new Set(content.match(/[\p{Script=Han}\p{Script=Katakana}ー]{2,}|[A-Za-z0-9]{2,}/gu) ?? [])];
}

/** How long a followed research may still be said in the turn that asked how it is going. */
export const FOLLOWED_WORK_WAIT_MS = 15_000;
/** The canonical state answers a progress question (2026-10-13 daily evals R5: a finished research was called 「まだ」). */
export const WORK_PROGRESS_HINT = '[Progress question] He asks how the work he asked for is going. Read [Current work]: a phase of completed means it is '
  + 'done, so give its result in one or two short sentences; executing, ready or waiting means it is still running, so say so in one sentence with what '
  + 'is known so far. Do not start new research and do not say a completed task is still running.';

/**
 * 「どうなった？」 in a turn that admitted no research: the hint above, and the newest research of the conversation still running
 * followed (`followWork`), so that its result is said in this turn if it arrives within `FOLLOWED_WORK_WAIT_MS`
 * (`researchHeardInTurn`). Any other turn keeps what it admitted.
 */
export function followUp<T extends { work: TaskView | null; admittedAt: number }>(turn: FcaConversationTurn | null, transcript: string,
  admitted: T): { hint: string; admitted: T | { work: TaskView; admittedAt: number } } {
  if (admitted.work || !turn || !asksResearchProgress(transcript)) return { hint: '', admitted };
  const words = topicWords(transcript);
  // A question that names something (「太宰府の行き方どうなった？」) follows only the research about it; a bare one, the newest.
  const followed = turn.followWork?.(task => !words.length || words.some(word => `${task.title}\n${task.goal}`.includes(word))) ?? null;
  // The research turn's window is `VOICE_RESEARCH_WAIT_MS` from its admission: a followed one has `FOLLOWED_WORK_WAIT_MS` from now.
  const admittedAt = performance.now() - (VOICE_RESEARCH_WAIT_MS - FOLLOWED_WORK_WAIT_MS);
  return { hint: WORK_PROGRESS_HINT, admitted: followed ? { work: followed, admittedAt } : admitted };
}
