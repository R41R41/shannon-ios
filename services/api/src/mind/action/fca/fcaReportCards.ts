import { createHash } from 'node:crypto';
import { REPORT_CARD_LIMITS, validatedReportCard, type ReportCard } from '../../../contracts/conversationExtrasContract.js';
import type { ConversationStore } from '../../memory/memoryPorts.js';
import type { TaskProgress } from '../taskRuntime/taskProgressPorts.js';
import type { TaskRuntime, TaskView } from '../taskRuntime/taskRuntimePorts.js';
import { plainSpokenReport } from './fcaSpokenReport.js';
import type { ReportGateVerdict } from './fcaReportGate.js';

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
/** The siblings the gate compares a dropped report with (`fcaReportGate.ts`, the same request's list). */
const SIBLINGS_LISTED = 50;

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
  conversations: Pick<ConversationStore, 'assistantMessage' | 'appendReportCardOnce'> & Partial<Pick<ConversationStore, 'recentThreadMessages'>>;
  /**
   * What the owner may see of a task's progress now (null: not visible); asking may start its spoken form. With `gate` this is
   * the visibility view alone (the gate is asked first); without it, the view the report gate already holds and drops in.
   */
  shown(taskId: string): TaskProgress | null;
  /**
   * The report gate of the card on the stored progress (`reportGates(...).cardGate`): asked before the visibility walk, which is
   * made only for a report it delivers. 2026-10-13: the walk of a held or dropped report cost 160–1,300 ms a scan.
   */
  gate?: { verdict(task: TaskView, progress: TaskProgress): ReportGateVerdict; quiet(at: number): boolean };
  /** Whether only the owner can see now: while not, the scan asks nothing (and decides nothing). */
  ownerAlone?(): boolean;
  now(): number;
  log?(line: string): void;
};

/**
 * Finished work of origin `owner_request`, directly under the root or a conversation (a nested child reports to its parent
 * instead). A request the operator handed over for him is one too; its card keeps the title's 「（運用者経由）」 and its answer is
 * the operator's line (`plainSpokenReport`, the spoken form), never words saying he asked for it. It has no source Talk, so no
 * card is written for it today; the Talk note of `operatorTalkNote` is what he sees.
 */
function finishedOwnerWork(task: TaskView, at: number, parentKind: (id: string) => string | undefined): boolean {
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

/** The short answer: the spoken form once written, a plain cut of the report once its wait (from `since`) is over, otherwise not yet. */
function answerOf(task: TaskView, report: NonNullable<TaskProgress['report']>, at: number, since: number): string | null {
  const spoken = report.spoken?.trim();
  if (spoken) return spoken;
  return at - since < REPORT_CARD_SPOKEN_WAIT_MS ? null : plainSpokenReport(task, report.text);
}

/**
 * What besides a change of the task or its stored progress can change a decision: a held report's quiet hours and its Talk (anything
 * said there, his words included), a dropped one's siblings (the same request answered, still running, failed again).
 */
type Watch = { kind: 'quiet'; threadId?: string; thread: string } | { kind: 'siblings'; parentId: string; siblings: string };
type Decided = { mark: string; until: number; watch?: Watch };
/** The task and its stored progress as one scan read them (`mark`: their cheap fingerprint). */
type Read = { mark: string; stored: TaskProgress | null | undefined };

/** What one scan reads at most once: the quiet hours, each watched Talk's newest message, each watched parent's children. */
function scanOf(parts: CardParts, at: number) {
  const threads = new Map<string, string>(), siblings = new Map<string, string>();
  let quiet: boolean | undefined;
  // A failed read differs from every real one: a decision made on a real read is asked again once (the gate, cheap).
  const safely = (read: () => string) => { try { return read(); } catch { return '\u0000unread'; } };
  // A read only (`recentThreadMessages`): watching a Talk every few seconds creates no thread and never moves the default Talk.
  const threadMark = (threadId: string) => safely(() => {
    const last = parts.conversations.recentThreadMessages?.(parts.ownerScope, threadId, 1).at(-1);
    return last ? `${last.id}\u0000${last.observedAt}` : '';
  });
  const siblingsMark = (parentId: string) => safely(() => parts.runtime.list(parts.ownerScope, { parentId, order: 'recent', limit: SIBLINGS_LISTED })
    .map(task => [task.id, task.phase, task.updatedAt].join('\u0000')).join('\n'));
  return {
    at,
    quiet(): boolean {
      if (quiet === undefined) { try { quiet = parts.gate?.quiet(at) ?? false; } catch { quiet = false; } }
      return quiet;
    },
    thread(threadId: string | undefined): string {
      if (!threadId) return '';
      if (!threads.has(threadId)) threads.set(threadId, threadMark(threadId));
      return threads.get(threadId)!;
    },
    siblings(parentId: string): string {
      if (!siblings.has(parentId)) siblings.set(parentId, siblingsMark(parentId));
      return siblings.get(parentId)!;
    },
  };
}
type Scan = ReturnType<typeof scanOf>;

function watchFired(watch: Watch | undefined, scan: Scan): boolean {
  if (!watch) return false;
  if (watch.kind === 'quiet') return !scan.quiet() || scan.thread(watch.threadId) !== watch.thread;
  return scan.siblings(watch.parentId) !== watch.siblings;
}

/**
 * Leaves the report of each finished piece of work the owner asked for in the Talk it came from, once, as a report card
 * (owner decision 2026-10-13, Syzygy ADR-0009 §10). Only while the owner may see it (`shown` is the 「いま」 projection's own
 * guard: owner alone, every source still visible), and with its short answer once the spoken form is written or its wait is over.
 *
 * With `gate`, the report gate is asked first, on the stored progress: a dropped report is settled until the task, its stored
 * progress or (for a sibling's drop) its siblings change; a held one is asked again when the quiet hours end or something is said
 * in its Talk; the sources are walked only for a report the gate delivers. What differs from asking every 60-120 s: a result
 * dropped as stale stays dropped (only time or his later words made it stale, and neither goes back); a report released at
 * 7:00 or by his words is written at the next scan instead of within the next 60-120 s, but, its spoken form being asked for
 * only then, its card may wait for it up to `REPORT_CARD_SPOKEN_WAIT_MS` (typically a few seconds, ~20 s at worst).
 */
export function createReportCards(parts: CardParts) {
  const done = new Set<string>();
  const waiting = new Set<string>();
  const remember = (key: string) => {
    done.add(key);
    if (done.size > REMEMBERED) done.delete(done.values().next().value!);
  };
  const keepWaiting = (taskId: string) => { if (waiting.size < WAITING_KEPT) waiting.add(taskId); };
  /**
   * What the scan already decided about a finished task, by the task and its stored progress as they were then (`markOf`, cheap:
   * one row, no visibility walk): settled (`until` never, and no watch) or looked at again after `until` or when its watch fires.
   */
  const decided = new Map<string, Decided>();
  const markOf = (task: TaskView): Read => {
    const stored = parts.runtime.progress?.(parts.ownerScope, task.id);
    const report = stored?.report;
    return { stored, mark: [task.updatedAt, task.phase, stored?.updatedAt, report?.id, report?.spoken ? 1 : 0, report?.heard ? 1 : 0].join('\u0000') };
  };
  const decide = (task: TaskView, mark: string, until: number, watch?: Watch): null => {
    decided.delete(task.id);
    decided.set(task.id, { mark, until, ...(watch ? { watch } : {}) });
    if (decided.size > REMEMBERED) decided.delete(decided.keys().next().value!);
    return null;
  };
  const recheck = (task: TaskView, at: number) => at + REPORT_CARD_RECHECK_MS + spreadOf(task.id);
  /**
   * When the scan first found each report deliverable (by task and report). A report it first meets long after it was written (held
   * for the night, or met again after a restart of the API) has its spoken form asked for only then, so its card waits for that form
   * from then, as for a new report, instead of taking a plain cut at once.
   */
  const delivering = new Map<string, number>();
  const sinceOf = (key: string, report: NonNullable<TaskProgress['report']>, at: number) => {
    if (!delivering.has(key)) {
      delivering.set(key, at);
      if (delivering.size > REMEMBERED) delivering.delete(delivering.keys().next().value!);
    }
    const written = Date.parse(report.updatedAt), first = delivering.get(key)!;
    return first - written < REPORT_CARD_SPOKEN_WAIT_MS ? written : first;
  };
  /** The gate's own decision of a report it holds or drops (true: decided here); false for one it delivers, or without a gate. */
  const gated = (task: TaskView, read: Read, scan: Scan): boolean => {
    if (!parts.gate) return false;
    // A gate without the stored progress cannot judge: closed, nothing is delivered (asked again after a while).
    if (!parts.runtime.progress) return decide(task, read.mark, recheck(task, scan.at)) === null;
    const report = read.stored?.report;
    // No report yet: nothing to show or walk; asked again when one is written (the mark), or after a while.
    if (!report?.text.trim()) {
      keepWaiting(task.id);
      return decide(task, read.mark, recheck(task, scan.at)) === null;
    }
    let verdict: ReportGateVerdict;
    // As in the gated view: a gate that fails delivers, to the visibility walk.
    try { verdict = parts.gate.verdict(task, read.stored!); } catch { return false; }
    if (verdict.decision === 'deliver') return false;
    keepWaiting(task.id);
    if (verdict.decision === 'hold') {
      const watch: Watch = { kind: 'quiet', ...(verdict.threadId ? { threadId: verdict.threadId } : {}), thread: scan.thread(verdict.threadId) };
      // Without a way to see his words in the Talk, a hold is asked again after a while, as before.
      return decide(task, read.mark, parts.conversations.recentThreadMessages ? Infinity : recheck(task, scan.at), watch) === null;
    }
    const siblings: Watch | undefined = verdict.reason === 'sibling' && task.parentId
      ? { kind: 'siblings', parentId: task.parentId, siblings: scan.siblings(task.parentId) } : undefined;
    return decide(task, read.mark, Infinity, siblings) === null;
  };
  /** True when a card was written; false or null when not (settled, or to be looked at again later). */
  const consider = (task: TaskView, read: Read, scan: Scan): boolean | null => {
    if (gated(task, read, scan)) return null;
    const progress = parts.shown(task.id), report = progress?.report;
    // Not shown, or shown without its report (held for the night, dropped, not written yet): looked at again by id, slowly, or
    // at once when the task or its stored progress changes.
    if (progress && !report) keepWaiting(task.id);
    if (!progress || !report?.text.trim()) return decide(task, read.mark, recheck(task, scan.at));
    waiting.delete(task.id);
    const key = `${task.id}:${report.id}`;
    if (done.has(key)) return decide(task, read.mark, Infinity);
    return write(task, progress, read.mark, scan.at);
  };
  /** The card of a shown report: written once its short answer is ready (then settled), or looked at again when it may be. */
  const write = (task: TaskView, progress: TaskProgress, mark: string, at: number): boolean | null => {
    const report = progress.report!;
    const sources = parts.runtime.taskSources(parts.ownerScope, task.id);
    const threadId = sources.find(source => source.threadId)?.threadId;
    const messageId = reportCardMessageId(parts.ownerScope, task.id, report.id);
    const since = sinceOf(`${task.id}:${report.id}`, report, at);
    const answer = threadId && !parts.conversations.assistantMessage?.(parts.ownerScope, threadId, messageId) ? answerOf(task, report, at, since) : '';
    // Waiting for the spoken form: its writing changes the mark; else the plain cut once the wait is over.
    if (answer === null) return decide(task, mark, since + REPORT_CARD_SPOKEN_WAIT_MS);
    remember(`${task.id}:${report.id}`);
    decide(task, mark, Infinity);
    const card = threadId && answer ? reportCardOf(task, progress, answer) : null;
    if (!card || !threadId) return false;
    const recalledMemoryIds = sources.flatMap(source => [...source.experienceId ? [source.experienceId] : [], ...source.recalledMemoryIds]);
    const observedAt = new Date(at).toISOString();
    parts.conversations.appendReportCardOnce!(parts.ownerScope, threadId, messageId, { card, observedAt, recalledMemoryIds });
    return true;
  };
  /**
   * The finished work of this scan to look at: changed work, and unchanged work whose time came (its recheck window over, the quiet
   * hours over, its Talk or its siblings changed). Every one looked at is decided again in `consider`, or in `failed` if it throws,
   * so none is asked again on every scan.
   */
  const looks = (tasks: TaskView[], scan: Scan, parentKind: (id: string) => string | undefined) => {
    const due: Array<[TaskView, Read]> = [];
    for (const task of tasks) {
      const known = decided.get(task.id);
      try {
        if (!finishedOwnerWork(task, scan.at, parentKind)) continue;
        const read = markOf(task);
        if (!known || known.mark !== read.mark || scan.at >= known.until || watchFired(known.watch, scan)) due.push([task, read]);
      } catch {
        // Unreadable: decided as not shown, then left alone until its recheck window is over.
        if (!known || scan.at >= known.until) failed(task, null, scan);
      }
    }
    return due;
  };
  /** A look that threw: logged, and looked at again after a recheck window (or at once when the task changes), like one not shown. */
  const failed = (task: TaskView, read: Read | null, scan: Scan) => {
    parts.log?.('Shannon report card skipped code=report_card_failed');
    decide(task, read?.mark ?? `failed:${scan.at}`, recheck(task, scan.at));
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
        if (listed.has(id)) continue;
        try {
          const task = parts.runtime.get(parts.ownerScope, id);
          if (task && finishedOwnerWork(task, at, parentKind)) tasks.push(task);
          else waiting.delete(id);
        } catch { /* Unreadable now: kept for the next scan; it holds up no other task. */ }
      }
      const scan = scanOf(parts, at);
      for (const [task, read] of looks(tasks, scan, parentKind)) {
        try {
          if (consider(task, read, scan)) appended += 1;
        } catch { failed(task, read, scan); }
      }
      return appended;
    },
  };
}
