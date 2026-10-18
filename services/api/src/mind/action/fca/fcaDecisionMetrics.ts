import { currentActionExecution } from '../../../infra/context/actionExecution.js';
import { eventLoopBlockedMilliseconds } from '../../../infra/observer/eventLoopWatch.js';

/**
 * Observation redesign P1 (measurement only): one content-free journal line per committed FCA decision, `fca_decision_metrics`,
 * with where its time went. It changes nothing a decision does or stores except one closed counter in the task's checkpoint
 * (`fcaDecisionIndex`, the decision's number). Never a prompt, a summary text or an argument: task id, numbers and tool names only.
 *
 *   {"event":"fca_decision_metrics","task":<id>,"d":<decision, from 1>,"t":<seconds since the task began>,"obsMode":"legacy",
 *    "llmMs","stepMs","selectorMs","recallMs","summaryMs":<ms>,"tools":[<names>],"toolMs":<ms>,
 *    "storedTokens","tailTokens":<estimates|null>,"in":{"new","read","write"}|null,"out":<tokens|null>,
 *    "loopBlockedMs":<ms of event-loop blocks named meanwhile>,"inputTransformations":<n, when the model reported it>,
 *    "cut":{"catalog","state","live":<characters or null>,"over","replayRelaxed","deferred":<bool>,"parts","items":<n>} (a transient request
 *    that was shortened to fit: the stage of each cut, whether even the floor left it over, how many parts and tool descriptions are named cut)}
 */
type Spent = 'selectorMs' | 'recallMs' | 'summaryMs' | 'llmMs';
const toolName = (name: string) => /^[A-Za-z0-9_.:-]{1,80}$/u.test(name) ? name : 'other';

export function fcaDecisionMetrics(taskId: string, createdAt: string, prior: Readonly<Record<string, unknown>>,
  options: { now?: () => number; clock?: () => number; log?: (line: string) => void } = {}) {
  const clock = options.clock ?? (() => performance.now()), now = options.now ?? Date.now, log = options.log ?? ((line: string) => console.info(line));
  const before = Number(prior.fcaDecisionIndex), index = (Number.isSafeInteger(before) && before >= 0 ? before : 0) + 1;
  const started = clock(), loopStarted = eventLoopBlockedMilliseconds(), execution = currentActionExecution();
  if (execution) delete execution.modelMetrics; // A reading of an earlier decision on the same execution is never this one's.
  const spent: Record<Spent, number> = { selectorMs: 0, recallMs: 0, summaryMs: 0, llmMs: 0 };
  let toolMs = 0;
  const tools: string[] = [];
  return {
    index,
    /** Runs `work`, adding its time to one of the parts (a part may run more than once; it is summed). */
    async timed<T>(part: Spent, work: () => Promise<T>): Promise<T> {
      const at = clock();
      try { return await work(); } finally { spent[part] += clock() - at; }
    },
    tool(name: string, milliseconds: number): void {
      tools.push(toolName(name));
      toolMs += milliseconds;
    },
    checkpoint: (): Record<string, unknown> => ({ fcaDecisionIndex: index }),
    /** Writes the line (the decision has committed). Never throws. */
    emit(): void {
      try {
        const metrics = currentActionExecution()?.modelMetrics, began = Date.parse(createdAt);
        log(JSON.stringify({ event: 'fca_decision_metrics', task: taskId, d: index,
          t: Number.isFinite(began) ? Math.max(0, Math.round((now() - began) / 1000)) : null, obsMode: metrics?.obsMode ?? 'legacy',
          llmMs: Math.round(spent.llmMs), stepMs: Math.round(clock() - started), selectorMs: Math.round(spent.selectorMs),
          recallMs: Math.round(spent.recallMs), summaryMs: Math.round(spent.summaryMs), tools, toolMs: Math.round(toolMs),
          storedTokens: metrics?.storedTokens ?? null, tailTokens: metrics?.tailTokens ?? null,
          in: metrics ? { new: metrics.inputNew, read: metrics.inputRead, write: metrics.inputWrite } : null, out: metrics?.outputTokens ?? null,
          loopBlockedMs: Math.round(eventLoopBlockedMilliseconds() - loopStarted),
          ...(metrics ? { inputTransformations: metrics.inputTransformations } : {}), ...(metrics?.cuts ? { cut: metrics.cuts } : {}) }));
      } catch { /* measuring never fails a step */ }
    },
  };
}
