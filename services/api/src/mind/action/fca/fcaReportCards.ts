import { createHash } from 'node:crypto';
import { REPORT_CARD_LIMITS, validatedReportCard, type ReportCard } from '../../../contracts/conversationExtrasContract.js';
import type { ConversationStore } from '../../memory/memoryPorts.js';
import type { TaskProgress } from '../taskRuntime/taskProgressPorts.js';
import type { TaskRuntime, TaskView } from '../taskRuntime/taskRuntimePorts.js';
import { fallbackSpokenReport } from './fcaSpokenReport.js';

/** How long a card waits for the report's spoken form before it uses a plain cut of the report instead. */
export const REPORT_CARD_SPOKEN_WAIT_MS = 25_000;
/** How long a finished task whose report is not shown (held, dropped, not visible) waits before the scan asks again. */
export const REPORT_CARD_RECHECK_MS = 60_000;
/** Work finished longer ago than this gets no card (the first scan after a deploy does not replay old reports). */
export const REPORT_CARD_WINDOW_MS = 24 * 3_600_000;
const SCANNED_TASKS = 40;
const REMEMBERED = 512;
/** Finished work whose report is held (quiet hours) is looked at again by id, so a long night of newer tasks cannot hide it. */
const WAITING_KEPT = 256;

/** The card's message id: one per task and report, a UUID so every client keeps it as the message's identity. */
export function reportCardMessageId(scopeKey: string, taskId: string, reportId: string): string {
  const hex = createHash('sha256').update(JSON.stringify(['report-card', scopeKey, taskId, reportId])).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A card from what the owner's screen shows of a finished task; null when there is nothing to show. */
export function reportCardOf(task: Pick<TaskView, 'id' | 'title' | 'phase'>, progress: TaskProgress, answer: string): ReportCard | null {
  const report = progress.report;
  if (!report?.text.trim() || !answer.trim()) return null;
  return validatedReportCard({
    version: 1, taskId: task.id, reportId: report.id, title: task.title, status: task.phase === 'failed' ? 'failed' : 'completed',
    answer, report: report.text,
    findings: progress.findings.slice(-REPORT_CARD_LIMITS.findings).map(finding => ({ text: finding.text, sources: finding.sources })),
    ...(progress.places?.length ? { places: progress.places } : {}), reportedAt: report.updatedAt,
  });
}

type CardParts = {
  runtime: Pick<TaskRuntime, 'list' | 'get' | 'taskSources'> & Partial<Pick<TaskRuntime, 'progress'>>;
  ownerScope: string;
  conversations: Pick<ConversationStore, 'assistantMessage' | 'appendReportCardOnce'>;
  /** What the owner may see of a task's progress now (null: not visible); asking may start its spoken form. */
  shown(taskId: string): TaskProgress | null;
  /** Whether only the owner can see now: while not, the scan asks nothing (and decides nothing). */
  ownerAlone?(): boolean;
  now(): number;
  log?(line: string): void;
};

/** Finished work he asked for, directly under the root or a conversation (a nested child reports to its parent instead). */
function finishedOwnerWork(parts: CardParts, task: TaskView, at: number, parentKind: (id: string) => string | undefined): boolean {
  if (task.origin !== 'owner_request' || !['research', 'generic'].includes(task.kind)) return false;
  if (!['completed', 'failed'].includes(task.phase) || !(at - Date.parse(task.updatedAt) < REPORT_CARD_WINDOW_MS)) return false;
  const parent = task.parentId ? parentKind(task.parentId) : undefined;
  return parent === 'root' || parent === 'conversation';
}

/** A task's own offset within one more recheck window, so the tasks decided in one scan are not all asked again in one scan. */
function spreadOf(taskId: string): number {
  let sum = 0;
  for (const char of taskId) sum = (sum * 31 + char.charCodeAt(0)) % REPORT_CARD_RECHECK_MS;
  return sum;
}

/** The short answer: the spoken form once written, a plain cut of the report once its wait is over, otherwise not yet. */
function answerOf(task: TaskView, report: NonNullable<TaskProgress['report']>, at: number): string | null {
  const spoken = report.spoken?.trim();
  if (spoken) return spoken;
  return at - Date.parse(report.updatedAt) < REPORT_CARD_SPOKEN_WAIT_MS ? null : fallbackSpokenReport(report.text, task.title);
}

/**
 * Leaves the report of each finished piece of work the owner asked for in the Talk it came from, once, as a report card
 * (owner decision 2026-10-13, Syzygy ADR-0009 §10). Only while the owner may see it (`shown` is the 「いま」 projection's own
 * guard: owner alone, every source still visible), and with its short answer once the spoken form is written or its wait is over.
 */
export function createReportCards(parts: CardParts) {
  const done = new Set<string>();
  const waiting = new Set<string>();
  const remember = (key: string) => {
    done.add(key);
    if (done.size > REMEMBERED) done.delete(done.values().next().value!);
  };
  /**
   * What the scan already decided about a finished task, by the task and its stored progress as they were then (`markOf`, cheap:
   * one row, no visibility walk): settled (`until` never) or looked at again only after `until`. 2026-10-13: every 5 s scan asked
   * the report gate and the visibility guard again for each finished task whose report it does not show (a failure an hour late,
   * one answered by a sibling, one held for the night): 0.7-1.4 s of the API's one thread every 5 s on the VM.
   */
  const decided = new Map<string, { mark: string; until: number }>();
  const markOf = (task: TaskView) => {
    const stored = parts.runtime.progress?.(parts.ownerScope, task.id);
    return [task.updatedAt, task.phase, stored?.updatedAt, stored?.report?.id, stored?.report?.spoken ? 1 : 0, stored?.report?.heard ? 1 : 0].join('\u0000');
  };
  const decide = (task: TaskView, mark: string, until: number): null => {
    decided.delete(task.id);
    decided.set(task.id, { mark, until });
    if (decided.size > REMEMBERED) decided.delete(decided.keys().next().value!);
    return null;
  };
  /** True when a card was written; false or null when not (settled, or to be looked at again later). */
  const consider = (task: TaskView, at: number): boolean | null => {
    const mark = markOf(task), known = decided.get(task.id);
    if (known && known.mark === mark && at < known.until) return null;
    const progress = parts.shown(task.id), report = progress?.report;
    // Not shown, or shown without its report (held for the night, dropped, not written yet): looked at again by id, slowly, or
    // at once when the task or its stored progress changes.
    if (progress && !report && waiting.size < WAITING_KEPT) waiting.add(task.id);
    if (!progress || !report?.text.trim()) return decide(task, mark, at + REPORT_CARD_RECHECK_MS + spreadOf(task.id));
    waiting.delete(task.id);
    const key = `${task.id}:${report.id}`;
    if (done.has(key)) return decide(task, mark, Infinity);
    return write(task, progress, mark, at);
  };
  /** The card of a shown report: written once its short answer is ready (then settled), or looked at again when it may be. */
  const write = (task: TaskView, progress: TaskProgress, mark: string, at: number): boolean | null => {
    const report = progress.report!;
    const sources = parts.runtime.taskSources(parts.ownerScope, task.id);
    const threadId = sources.find(source => source.threadId)?.threadId;
    const messageId = reportCardMessageId(parts.ownerScope, task.id, report.id);
    const answer = threadId && !parts.conversations.assistantMessage?.(parts.ownerScope, threadId, messageId) ? answerOf(task, report, at) : '';
    // Waiting for the spoken form: its writing changes the mark; else the plain cut once the wait is over.
    if (answer === null) return decide(task, mark, Date.parse(report.updatedAt) + REPORT_CARD_SPOKEN_WAIT_MS);
    remember(`${task.id}:${report.id}`);
    decide(task, mark, Infinity);
    const card = threadId && answer ? reportCardOf(task, progress, answer) : null;
    if (!card || !threadId) return false;
    const recalledMemoryIds = sources.flatMap(source => [...source.experienceId ? [source.experienceId] : [], ...source.recalledMemoryIds]);
    const observedAt = new Date(at).toISOString();
    parts.conversations.appendReportCardOnce!(parts.ownerScope, threadId, messageId, { card, observedAt, recalledMemoryIds });
    return true;
  };
  return {
    /** One scan, called from the runtime's own timer; returns the cards written. Never throws. */
    tick(): number {
      if (!parts.conversations.appendReportCardOnce) return 0;
      try { if (parts.ownerAlone && !parts.ownerAlone()) return 0; } catch { return 0; }
      const at = parts.now();
      let tasks: TaskView[] = [], appended = 0;
      try { tasks = parts.runtime.list(parts.ownerScope, { order: 'recent', limit: SCANNED_TASKS }); } catch { return 0; }
      // A parent's kind, once a scan (the conversation's view lists all its children).
      const kinds = new Map<string, string | undefined>();
      const parentKind = (id: string) => {
        if (!kinds.has(id)) kinds.set(id, parts.runtime.get(parts.ownerScope, id)?.kind);
        return kinds.get(id);
      };
      const listed = new Set(tasks.map(task => task.id));
      for (const id of waiting) {
        const task = listed.has(id) ? null : parts.runtime.get(parts.ownerScope, id);
        if (task && finishedOwnerWork(parts, task, at, parentKind)) tasks.push(task);
        else if (!listed.has(id)) waiting.delete(id);
      }
      for (const task of tasks) {
        try {
          if (finishedOwnerWork(parts, task, at, parentKind) && consider(task, at)) appended += 1;
        } catch { parts.log?.('Shannon report card skipped code=report_card_failed'); }
      }
      return appended;
    },
  };
}
