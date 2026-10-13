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
 * - `drop`, never delivered: said in the turn that asked for it; a sibling for the same request (the same words, or admitted
 *   within `SAME_REQUEST_WINDOW_MS` of it under the same conversation) already delivered, or, for a failure, completed or still
 *   runs; a failure older than `REPORT_STALE_MS`; a result older than that while he has since talked about the same thing.
 * - `hold`, delivered later: owner-local quiet hours (23–7) while he has not talked in that Talk for `OWNER_ACTIVE_MS`.
 * - `deliver` otherwise.
 *
 * Deterministic, no model. The card writer holds and drops (`createReportCards`); the call's report (the 「いま」 route) drops only,
 * since a call is spoken only while he is in it.
 */
export type ReportGateDecision = 'deliver' | 'hold' | 'drop';

export const REPORT_STALE_MS = 60 * 60_000;
export const SAME_REQUEST_WINDOW_MS = 2 * 60_000;
export const OWNER_ACTIVE_MS = 10 * 60_000;

export interface ReportGateParts {
  runtime: Pick<TaskRuntime, 'get' | 'list' | 'progress' | 'taskSources'>;
  ownerScope: string;
  history(threadId: string): readonly { role: 'user' | 'assistant'; content: string; observedAt: string }[];
  timeZone: string;
  now(): number;
}

const ACTIVE = ['ready', 'executing', 'waiting'];

/** Words too common to say two messages are about the same thing. */
const COMMON = new Set(['今日', '明日', '昨日', '今週', '来週', '今夜', '時間', '何時', '自分', '大丈夫', 'ライ']);

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

/** Siblings for the same request: the same words, or admitted within `SAME_REQUEST_WINDOW_MS` under the same conversation. */
function sameRequestSiblings(parts: ReportGateParts, task: TaskView): TaskView[] {
  if (!task.parentId) return [];
  const created = Date.parse(task.createdAt);
  return parts.runtime.list(parts.ownerScope, { parentId: task.parentId, order: 'recent', limit: 50 })
    .filter(other => other.id !== task.id && other.origin === 'owner_request'
      && (sameRequest(other.goal, task.goal) || Math.abs(Date.parse(other.createdAt) - created) <= SAME_REQUEST_WINDOW_MS));
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

/** Older than `REPORT_STALE_MS`: a failure always, a result once he has since talked about the same thing in that Talk. */
function stale(task: TaskView, progress: TaskProgress, history: ReturnType<ReportGateParts['history']>, at: number): boolean {
  const created = Date.parse(task.createdAt);
  if (at - created <= REPORT_STALE_MS) return false;
  if (failed(task, progress)) return true;
  const words = topicWords(task.goal);
  return history.some(message => message.role === 'user' && Date.parse(message.observedAt) > created
    && [...topicWords(message.content)].some(word => words.has(word)));
}

/** Owner-local quiet hours while he has not talked in that Talk for `OWNER_ACTIVE_MS`. */
function quietNow(parts: ReportGateParts, history: ReturnType<ReportGateParts['history']>, at: number): boolean {
  const hour = localDateParts(new Date(at), parts.timeZone).hour;
  if (!(hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR)) return false;
  return !history.some(message => message.role === 'user' && at - Date.parse(message.observedAt) < OWNER_ACTIVE_MS);
}

export function reportGateDecision(parts: ReportGateParts, task: TaskView, progress: TaskProgress): ReportGateDecision {
  if (!progress.report || task.origin !== 'owner_request' || !['research', 'generic'].includes(task.kind)) return 'deliver';
  if (progress.report.heard || supersededBySibling(parts, task, progress)) return 'drop';
  const at = parts.now();
  const threadId = parts.runtime.taskSources(parts.ownerScope, task.id).find(source => source.threadId)?.threadId;
  const history = threadId ? parts.history(threadId) : [];
  if (stale(task, progress, history, at)) return 'drop';
  return quietNow(parts, history, at) ? 'hold' : 'deliver';
}

/** A progress view with its report left out unless the gate lets it through (`hold` too, unless only drops are applied). */
export function gatedProgress(parts: ReportGateParts, shown: (taskId: string) => TaskProgress | null, holds: boolean) {
  return (taskId: string): TaskProgress | null => {
    const progress = shown(taskId);
    if (!progress?.report) return progress;
    let decision: ReportGateDecision = 'deliver';
    try {
      const task = parts.runtime.get(parts.ownerScope, taskId);
      decision = task ? reportGateDecision(parts, task, progress) : 'deliver';
    } catch { decision = 'deliver'; }
    if (decision === 'deliver' || (decision === 'hold' && !holds)) return progress;
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
  return { card: gatedProgress(gate, shown, true), call: gatedProgress(gate, shown, false) };
}
