import { currentActionExecution } from '../../../infra/context/actionExecution.js';
import { eventLoopBlockedMilliseconds } from '../../../infra/observer/eventLoopWatch.js';

/**
 * Observation redesign P1 (measurement only): one content-free journal line per committed FCA decision, `fca_decision_metrics`,
 * with where its time went. It changes nothing a decision does or stores except one closed counter in the task's checkpoint
 * (`fcaDecisionIndex`, the decision's number). Never a prompt, a summary text or an argument: task id, numbers and tool names only.
 *
 *   {"event":"fca_decision_metrics","task":<id>,"d":<decision, from 1>,"t":<seconds since the task began>,"obsMode":"legacy",
 *    "llmMs","stepMs","selectorMs","recallMs","recallStartMs","evidenceMs","summaryMs":<ms>,"tools":[<names>],"toolMs":<ms>,
 *    "storedTokens","tailTokens":<estimates|null>,"in":{"new","read","write"}|null,"out":<tokens|null>,
 *    "loopBlockedMs":<ms of event-loop blocks named meanwhile>,"inputTransformations":<n, when the model reported it>,
 *    "cut":{"catalog","state","live":<characters or null>,"over","replayRelaxed","deferred":<bool>,"parts","items":<n>} (a transient request
 *    that was shortened to fit: the stage of each cut, whether even the floor left it over, how many parts and tool descriptions are named cut)}
 *
 * `recallStartMs` is what the recall's deterministic start held the API's one thread (0 when a settling body defers it into the packet,
 * whose time is then in `recallMs`); `evidenceMs` is the evidence's shared context, wall time like `recallMs` (it lets I/O through).
 * Production run 15 (2026-10-19): the first stretch of every decision held the thread 2.5-8.8 s and no part named it.
 *
 * The rest of a step (run 15: 7.7 s a decision named by no part, and 1.9 s between one decision's commit and the next one's start):
 *   "other":{"startMs","permitMs","guardMs","contextMs","verifyMs","closeMs","commitMs"} — the monitors' start, the lease and audience
 *     checks (`checked`, every one of them), the waits for a settled body and observation revision, building the request's parts, the
 *     completion check, closing the monitors and the recall segment, and the commit;
 *   "gap":{"sinceCommitMs","afterMs","waitMs","admitMs"} — from the previous decision's commit to this step's start: the previous step's
 *     work after its commit (`afterMs`: its budget and receipts), the scheduler's wait for its next turn (`waitMs`), and this step's
 *     admission (`admitMs`: lease, begin, budget, ports); null for a first step, or when the scheduler did not say (`ActionExecution.admission`);
 *   "skipped":[<names>] — body actions of the response left unrun because an earlier one of it failed (`fcaRunner.ts`).
 */
type Spent = 'selectorMs' | 'recallMs' | 'summaryMs' | 'llmMs' | 'recallStartMs' | 'evidenceMs';
type Other = 'startMs' | 'permitMs' | 'guardMs' | 'contextMs' | 'verifyMs' | 'closeMs' | 'commitMs';
const toolName = (name: string) => /^[A-Za-z0-9_.:-]{1,80}$/u.test(name) ? name : 'other';
const whole = (value: number) => Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

export function fcaDecisionMetrics(taskId: string, createdAt: string, prior: Readonly<Record<string, unknown>>,
  options: { now?: () => number; clock?: () => number; log?: (line: string) => void; enteredAt?: number } = {}) {
  const clock = options.clock ?? (() => performance.now()), now = options.now ?? Date.now, log = options.log ?? ((line: string) => console.info(line));
  const before = Number(prior.fcaDecisionIndex), index = (Number.isSafeInteger(before) && before >= 0 ? before : 0) + 1;
  const started = clock(), loopStarted = eventLoopBlockedMilliseconds(), execution = currentActionExecution(), startedAt = now();
  if (execution) delete execution.modelMetrics; // A reading of an earlier decision on the same execution is never this one's.
  const spent: Record<Spent, number> = { selectorMs: 0, recallMs: 0, summaryMs: 0, llmMs: 0, recallStartMs: 0, evidenceMs: 0 };
  const other: Record<Other, number> = { startMs: options.enteredAt === undefined ? 0 : Math.max(0, started - options.enteredAt),
    permitMs: 0, guardMs: 0, contextMs: 0, verifyMs: 0, closeMs: 0, commitMs: 0 };
  const committedBefore = typeof prior.fcaCommittedAt === 'number' && Number.isFinite(prior.fcaCommittedAt) ? prior.fcaCommittedAt : null;
  let toolMs = 0;
  const tools: string[] = [], skipped: string[] = [];
  /** The time before this step, from the previous decision's commit (`gap` above). */
  const gap = () => {
    if (committedBefore === null) return null;
    const admission = execution?.admission, previousEnd = admission?.previousEndAt ?? null;
    const sinceCommitMs = whole(startedAt - committedBefore) ?? 0, startMs = Math.round(other.startMs);
    if (!admission || previousEnd === null || previousEnd < committedBefore) return { sinceCommitMs, afterMs: null, waitMs: null, admitMs: null, startMs };
    return { sinceCommitMs, afterMs: whole(previousEnd - committedBefore), waitMs: whole(admission.startedAt - previousEnd),
      admitMs: whole(admission.acquireMs + admission.beginMs + admission.budgetMs + admission.portsMs), startMs };
  };
  return {
    index,
    /** Runs `work`, adding its time to one of the parts (a part may run more than once; it is summed). */
    async timed<T>(part: Spent | Other, work: () => Promise<T>): Promise<T> {
      const at = clock();
      try { return await work(); } finally { add(part, clock() - at); }
    },
    /** `timed` for synchronous work: what it held the API's one thread. */
    timedSync<T>(part: Spent | Other, work: () => T): T {
      const at = clock();
      try { return work(); } finally { add(part, clock() - at); }
    },
    tool(name: string, milliseconds: number): void {
      tools.push(toolName(name));
      toolMs += milliseconds;
    },
    /** A body action of the response left unrun because an earlier one of it failed. */
    skipped(name: string): void { skipped.push(toolName(name)); },
    /** `fcaCommittedAt`: when this decision committed (epoch ms), the start of the next one's `gap`. */
    checkpoint: (): Record<string, unknown> => ({ fcaDecisionIndex: index, fcaCommittedAt: now() }),
    /** Writes the line (the decision has committed). Never throws. */
    emit(): void {
      try {
        const metrics = currentActionExecution()?.modelMetrics, began = Date.parse(createdAt);
        log(JSON.stringify({ event: 'fca_decision_metrics', task: taskId, d: index,
          t: Number.isFinite(began) ? Math.max(0, Math.round((now() - began) / 1000)) : null, obsMode: metrics?.obsMode ?? 'legacy',
          llmMs: Math.round(spent.llmMs), stepMs: Math.round(clock() - started), selectorMs: Math.round(spent.selectorMs),
          recallMs: Math.round(spent.recallMs), recallStartMs: Math.round(spent.recallStartMs), evidenceMs: Math.round(spent.evidenceMs),
          summaryMs: Math.round(spent.summaryMs), tools, toolMs: Math.round(toolMs),
          storedTokens: metrics?.storedTokens ?? null, tailTokens: metrics?.tailTokens ?? null,
          in: metrics ? { new: metrics.inputNew, read: metrics.inputRead, write: metrics.inputWrite } : null, out: metrics?.outputTokens ?? null,
          loopBlockedMs: Math.round(eventLoopBlockedMilliseconds() - loopStarted),
          other: Object.fromEntries(Object.entries(other).map(([key, value]) => [key, Math.round(value)])), gap: gap(),
          ...(skipped.length ? { skipped } : {}),
          ...(metrics ? { inputTransformations: metrics.inputTransformations } : {}), ...(metrics?.cuts ? { cut: metrics.cuts } : {}) }));
      } catch { /* measuring never fails a step */ }
    },
  };
  function add(part: Spent | Other, milliseconds: number): void {
    if (part in spent) spent[part as Spent] += milliseconds;
    else other[part as Other] += milliseconds;
  }
}
