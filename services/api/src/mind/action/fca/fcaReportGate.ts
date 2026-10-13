import { QUIET_END_HOUR, QUIET_START_HOUR } from '../../../contracts/initiativeTiming.js';
import { localDateParts } from '../../../infra/time/localDate.js';
import type { TaskProgress } from '../taskRuntime/taskProgressPorts.js';
import type { TaskRuntime, TaskView } from '../taskRuntime/taskRuntimePorts.js';
import { sameRequest } from './fcaConversation.js';

/**
 * Whether the report of a piece of work he asked for reaches him now (owner decision 2026-10-13, from the conversation audit:
 * an answer delivered at 5:20 in the morning, a 「調べきれなかった」 for a question answered 16 minutes earlier, three notices for
 * one request, a failure notice six hours late for a question re-asked and answered in another Talk).
 *
 * - A report said in the voice turn that asked for it (`heard`) keeps its card in the Talk at once (the sources and the full
 *   report stay on screen, owner request 2026-10-13) and is never said or announced again: the call drops it.
 * - `drop`, never delivered: a sibling for the same request (the same words folded, `sameRequest`, or admitted by the same turn
 *   with at least `TOPIC_OVERLAP` shared topic pieces) already delivered, or, for a failure, completed or still runs; a failure
 *   older than `REPORT_STALE_MS`; a result older than that once he has, after it finished, talked about the same thing.
 * - `hold`, delivered later: owner-local quiet hours (23–7) while he has not talked in that Talk for `OWNER_ACTIVE_MS`.
 * - `deliver` otherwise.
 *
 * Deterministic, no model. The card writer holds and drops (`createReportCards`); the call's report (the 「いま」 route) drops only,
 * since a call is spoken only while he is in it.
 */
export type ReportGateDecision = 'deliver' | 'hold' | 'drop';

/** Where the report would go: the Talk's report card (rich, with sources), or the call that says it aloud (the 「いま」 route). */
export type ReportView = 'card' | 'call';

export const REPORT_STALE_MS = 60 * 60_000;
/** Distinct topic pieces two texts must share to be about the same thing. */
export const TOPIC_OVERLAP = 2;
export const OWNER_ACTIVE_MS = 10 * 60_000;

export interface ReportGateParts {
  runtime: Pick<TaskRuntime, 'get' | 'list' | 'progress' | 'taskSources'>;
  ownerScope: string;
  history(threadId: string): readonly { role: 'user' | 'assistant'; content: string; observedAt: string }[];
  timeZone: string;
  now(): number;
}

const ACTIVE = ['ready', 'executing', 'waiting'];

/** Pieces too common to say two messages are about the same thing (dates, times, generic nouns and verbs of asking). */
const COMMON = new Set(['今日', '明日', '昨日', '今週', '来週', '今夜', '今朝', '今年', '時間', '時刻', '何時', '何分', '自分', '大丈夫', 'ライ',
  '天気', '予定', '予報', '確認', '電車', '情報', '最新', '検索', '調査', '場所', '方法', '結果', '問題', '一番', '本当', '気分', '教え']);

/**
 * What a later turn shares with a request about the same thing: two-character pieces of its kanji and katakana runs (「太宰府天満宮」
 * and 「太宰府」 share 「太宰」), and Latin words, without the most common ones.
 */
function topicWords(text: string): Set<string> {
  const runs = text.normalize('NFKC').match(/[\p{Script=Han}ー\p{Script=Katakana}]{2,}|[a-z0-9]{3,}/giu) ?? [];
  const pairs = (run: string) => [...run].slice(0, -1).map((char, index) => `${char}${[...run][index + 1]}`);
  const pieces = runs.flatMap(run => /^[a-z0-9]+$/iu.test(run) ? [run.toLowerCase()] : pairs(run));
  return new Set(pieces.filter(piece => !COMMON.has(piece)));
}

function failed(task: TaskView, progress: TaskProgress): boolean {
  return task.phase === 'failed' || progress.status === 'failed';
}

/** True when two texts share at least `TOPIC_OVERLAP` distinct topic pieces. */
export function sameTopic(left: string, right: string): boolean {
  const words = topicWords(left);
  return [...topicWords(right)].filter(word => words.has(word)).length >= TOPIC_OVERLAP;
}

/** The conversation steps (turns) a task was admitted by. */
function admittingSteps(parts: ReportGateParts, taskId: string): Set<string> {
  return new Set(parts.runtime.taskSources(parts.ownerScope, taskId).map(source => source.stepId));
}

/**
 * Siblings for the same request: the same words folded (`sameRequest`), or admitted by the same turn about the same thing
 * (the router's research for his words and the model's `web.research` question). Never by time alone: 「明日の東京の天気調べて」
 * and 「あと新幹線の時刻も調べて」 30 s later are two requests.
 */
function sameRequestSiblings(parts: ReportGateParts, task: TaskView): TaskView[] {
  if (!task.parentId) return [];
  const steps = admittingSteps(parts, task.id);
  return parts.runtime.list(parts.ownerScope, { parentId: task.parentId, order: 'recent', limit: 50 })
    .filter(other => other.id !== task.id && other.origin === 'owner_request' && (sameRequest(other.goal, task.goal)
      || ([...admittingSteps(parts, other.id)].some(step => steps.has(step)) && sameTopic(other.goal, task.goal))));
}

/** One request, at most one notice: true when a sibling already answers it (or, for a failure, still works on it). */
function supersededBySibling(parts: ReportGateParts, task: TaskView, progress: TaskProgress): boolean {
  const report = progress.report!, isFailure = failed(task, progress);
  return sameRequestSiblings(parts, task).some(sibling => {
    const theirs = parts.runtime.progress?.(parts.ownerScope, sibling.id) ?? null;
    const theirReport = theirs?.report;
    const answered = sibling.phase === 'completed' && Boolean(theirReport?.text.trim()) && !failed(sibling, theirs!);
    // A failure is not news while the same request was answered or is still being worked on; of two failures, the later one.
    const laterFailure = Boolean(theirReport && failed(sibling, theirs!) && theirReport.updatedAt > report.updatedAt);
    if (isFailure) return answered || ACTIVE.includes(sibling.phase) || laterFailure;
    // Of two answers, the one that came first (or the one already said in its turn).
    return answered && Boolean(theirReport!.heard || theirReport!.updatedAt < report.updatedAt);
  });
}

/** Older than `REPORT_STALE_MS`: a failure always, a result once he has talked about the same thing in that Talk after it finished. */
function stale(task: TaskView, progress: TaskProgress, history: ReturnType<ReportGateParts['history']>, at: number): boolean {
  if (at - Date.parse(task.createdAt) <= REPORT_STALE_MS) return false;
  if (failed(task, progress)) return true;
  const finished = Date.parse(progress.report!.updatedAt);
  return history.some(message => message.role === 'user' && Date.parse(message.observedAt) > finished && sameTopic(message.content, task.goal));
}

/** Owner-local quiet hours while he has not talked in that Talk for `OWNER_ACTIVE_MS`. */
function quietNow(parts: ReportGateParts, history: ReturnType<ReportGateParts['history']>, at: number): boolean {
  const hour = localDateParts(new Date(at), parts.timeZone).hour;
  if (!(hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR)) return false;
  return !history.some(message => message.role === 'user' && at - Date.parse(message.observedAt) < OWNER_ACTIVE_MS);
}

export function reportGateDecision(parts: ReportGateParts, task: TaskView, progress: TaskProgress, view: ReportView = 'card'): ReportGateDecision {
  if (!progress.report || task.origin !== 'owner_request' || !['research', 'generic'].includes(task.kind)) return 'deliver';
  if (progress.report.heard) return view === 'card' ? 'deliver' : 'drop';
  if (supersededBySibling(parts, task, progress)) return 'drop';
  const at = parts.now();
  const threadId = parts.runtime.taskSources(parts.ownerScope, task.id).find(source => source.threadId)?.threadId;
  const history = threadId ? parts.history(threadId) : [];
  if (stale(task, progress, history, at)) return 'drop';
  return quietNow(parts, history, at) ? 'hold' : 'deliver';
}

/** A progress view with its report left out unless the gate lets it through for this view (the call never holds, it only drops). */
export function gatedProgress(parts: ReportGateParts, shown: (taskId: string) => TaskProgress | null, view: ReportView) {
  return (taskId: string): TaskProgress | null => {
    const progress = shown(taskId);
    if (!progress?.report) return progress;
    let decision: ReportGateDecision = 'deliver';
    try {
      const task = parts.runtime.get(parts.ownerScope, taskId);
      decision = task ? reportGateDecision(parts, task, progress, view) : 'deliver';
    } catch { decision = 'deliver'; }
    if (decision === 'deliver' || (decision === 'hold' && view === 'call')) return progress;
    const { report: _withheld, ...rest } = progress;
    return rest;
  };
}

/** The two views of a progress the server hands out: the card's (holds and drops) and the call's (drops only). */
export function reportGates(parts: Omit<ReportGateParts, 'history'> & {
  conversations?: { recentMessages?(scopeKey: string, threadId: string, limit: number): ReturnType<ReportGateParts['history']>;
    conversationHistory(scopeKey: string, threadId?: string): ReturnType<ReportGateParts['history']> } | undefined;
}, shown: (taskId: string) => TaskProgress | null) {
  const { conversations, ...rest } = parts;
  const gate: ReportGateParts = { ...rest, history: threadId => conversations?.recentMessages?.(parts.ownerScope, threadId, 40)
    ?? conversations?.conversationHistory(parts.ownerScope, threadId).slice(-40) ?? [] };
  return { card: gatedProgress(gate, shown, 'card'), call: gatedProgress(gate, shown, 'call') };
}
