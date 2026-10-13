import { createHash } from 'node:crypto';
import { REPORT_CARD_LIMITS, validatedReportCard, type ReportCard } from '../../../contracts/conversationExtrasContract.js';
import type { ConversationStore } from '../../memory/memoryPorts.js';
import type { TaskProgress } from '../taskRuntime/taskProgressPorts.js';
import type { TaskRuntime, TaskView } from '../taskRuntime/taskRuntimePorts.js';
import { fallbackSpokenReport } from './fcaSpokenReport.js';

/** How long a card waits for the report's spoken form before it uses a plain cut of the report instead. */
export const REPORT_CARD_SPOKEN_WAIT_MS = 25_000;
/** Work finished longer ago than this gets no card (the first scan after a deploy does not replay old reports). */
export const REPORT_CARD_WINDOW_MS = 24 * 3_600_000;
const SCANNED_TASKS = 40;
const REMEMBERED = 512;
/** Finished work whose report is held (quiet hours) is looked at again by id, so a long night of newer tasks cannot hide it. */
const WAITING_KEPT = 256;
/**
 * Finished work not shown at its last look (held for quiet hours, its report not yet there, or not visible), unchanged since: a scan
 * asks again at most this many of them, the longest unasked first. 2026-10-13 (production, 22:26–22:55): every 5 s scan asked the
 * report gate again for each held task of the day, 600–850 ms of the API's one thread every 5 s.
 */
export const REPORT_CARD_RECHECKS_PER_SCAN = 4;

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
  runtime: Pick<TaskRuntime, 'list' | 'get' | 'taskSources'>;
  ownerScope: string;
  conversations: Pick<ConversationStore, 'assistantMessage' | 'appendReportCardOnce'>;
  /** What the owner may see of a task's progress now (null: not visible); asking may start its spoken form. */
  shown(taskId: string): TaskProgress | null;
  now(): number;
  log?(line: string): void;
};

/** Finished work he asked for, directly under the root or a conversation (a nested child reports to its parent instead). */
function finishedOwnerWork(parts: CardParts, task: TaskView, at: number): boolean {
  if (task.origin !== 'owner_request' || !['research', 'generic'].includes(task.kind)) return false;
  if (!['completed', 'failed'].includes(task.phase) || !(at - Date.parse(task.updatedAt) < REPORT_CARD_WINDOW_MS)) return false;
  const parent = task.parentId ? parts.runtime.get(parts.ownerScope, task.parentId) : null;
  return parent?.kind === 'root' || parent?.kind === 'conversation';
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
   * Finished work already settled (its card written now or before, or nothing to write), by the task as it was then: its next scan
   * asks nothing of it until the task itself changes. 2026-10-13: every 5 s scan asked the report gate again for each of the day's
   * finished tasks (each a walk over every sibling's provenance), blocking the API's one thread for 2-3 s every 5 s.
   */
  const settled = new Map<string, string>();
  const settledMark = (task: TaskView) => `${task.updatedAt}\u0000${task.phase}`;
  const settle = (task: TaskView): null => {
    settled.delete(task.id);
    settled.set(task.id, settledMark(task));
    if (settled.size > REMEMBERED) settled.delete(settled.keys().next().value!);
    return null;
  };
  /** Not shown at its last look, by the task as it was then; in the order they were last asked (the longest unasked first). */
  const deferred = new Map<string, string>();
  const defer = (task: TaskView): null => {
    deferred.delete(task.id);
    deferred.set(task.id, settledMark(task));
    if (deferred.size > REMEMBERED) deferred.delete(deferred.keys().next().value!);
    return null;
  };
  /** True when the task needs no further look (written now, written before, or nothing to write). */
  const consider = (task: TaskView, at: number): boolean | null => {
    if (settled.get(task.id) === settledMark(task)) return null;
    const progress = parts.shown(task.id), report = progress?.report;
    // Shown without its report: held (or dropped) for now; looked at again by id until it is written or leaves the window.
    if (progress && !report && waiting.size < WAITING_KEPT) waiting.add(task.id);
    if (!progress || !report?.text.trim()) return defer(task);
    deferred.delete(task.id);
    waiting.delete(task.id);
    const key = `${task.id}:${report.id}`;
    if (done.has(key)) return settle(task);
    const sources = parts.runtime.taskSources(parts.ownerScope, task.id);
    const threadId = sources.find(source => source.threadId)?.threadId;
    const messageId = reportCardMessageId(parts.ownerScope, task.id, report.id);
    const answer = threadId && !parts.conversations.assistantMessage?.(parts.ownerScope, threadId, messageId) ? answerOf(task, report, at) : '';
    if (answer === null) return null;
    remember(key);
    settle(task);
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
      const at = parts.now();
      let tasks: TaskView[] = [], appended = 0;
      try { tasks = parts.runtime.list(parts.ownerScope, { order: 'recent', limit: SCANNED_TASKS }); } catch { return 0; }
      const listed = new Set(tasks.map(task => task.id));
      for (const id of waiting) {
        const task = listed.has(id) ? null : parts.runtime.get(parts.ownerScope, id);
        if (task && finishedOwnerWork(parts, task, at)) tasks.push(task);
        else if (!listed.has(id)) waiting.delete(id);
      }
      // A changed task is looked at at once; unchanged ones not shown last time take their turn, a few a scan.
      const unchanged = (task: TaskView) => deferred.get(task.id) === settledMark(task);
      const order = [...deferred.keys()];
      const turn = new Set(tasks.filter(unchanged).map(task => task.id).sort((left, right) => order.indexOf(left) - order.indexOf(right))
        .slice(0, REPORT_CARD_RECHECKS_PER_SCAN));
      for (const task of tasks) {
        try {
          if (unchanged(task) && !turn.has(task.id)) continue;
          if (finishedOwnerWork(parts, task, at) && consider(task, at)) appended += 1;
        } catch { parts.log?.('Shannon report card skipped code=report_card_failed'); }
      }
      return appended;
    },
  };
}
