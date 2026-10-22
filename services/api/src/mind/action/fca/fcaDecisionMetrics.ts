import { currentActionExecution, type ActionExecution } from '../../../infra/context/actionExecution.js';
import { eventLoopBlockedMilliseconds, namedWork } from '../../../infra/observer/eventLoopWatch.js';
import type { BodyRecallMeasure } from '../../recall/taskRecallPorts.js';
import { fcaTaskTelemetry } from './fcaTaskTelemetry.js';

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
 * Syzygy ADR-0014 D8 (measurement only), added to the line: `kind` ("main", "urgent" or "first_plan": the decision's own call), `model` (the id
 * the provider answered with), `ttftMs` (time to the first token; null where the transport does not stream, never 0) and `layers`
 * ({"policy","tools","history","task","live","retrieved"}: token estimates of the request's input layers, `llmcTokens`; the provider's
 * own counts stay in `in`). `lookahead: "taken"` marks a step that took the decision asked ahead (no model call of its own: `in` is null).
 * The model calls that are no decision of the step (asked ahead, history summaries) write `fca_aux_call` (`anthropicFcaModel.ts`).
 *
 * `recallStartMs` is what the recall's deterministic start held the API's one thread (0 when a settling body defers it into the packet,
 * whose time is then in `recallMs`); `evidenceMs` is the evidence's shared context, wall time like `recallMs` (it lets I/O through).
 * Production run 15 (2026-10-19): the first stretch of every decision held the thread 2.5-8.8 s and no part named it.
 *
 * The rest of a step (run 15: 7.7 s a decision named by no part, and 1.9 s between one decision's commit and the next one's start):
 *   "other":{"startMs","permitMs","guardMs","contextMs","verifyMs","closeMs","commitMs","progressMs"} — the monitors' start, the lease and audience
 *     checks (`checked`, every one of them), the waits for a settled body and observation revision, building the request's parts, the
 *     completion check, closing the monitors and the recall segment, the commit, and the progress records of the decision and its tools;
 *   "permitAsks" — how many of the checks asked the lease of the mind (Minecraft run 18: about ten, 0.12 s each);
 *   "gap":{"sinceCommitMs","afterMs","waitMs","admitMs"} — from the previous decision's commit to this step's start: the previous step's
 *     work after its commit (`afterMs`: its budget and receipts), the scheduler's wait for its next turn (`waitMs`), and this step's
 *     admission (`admitMs`: lease, begin, budget, ports); null for a first step, or when the scheduler did not say (`ActionExecution.admission`);
 *   "skipped":[<names>] — body actions of the response left unrun because an earlier one of it failed (`fcaRunner.ts`);
 *   "probe":{"surprises":[<codes>],"probes","answered":<n>,"ms"} — mb-llmc r4: the body's investigation before the decision (a surprise's
 *     fixed probes, `FcaBodyLifecycle.investigate`) and the ms the step waited for it; absent when there was no surprise.
 * The parts may overlap: a check inside the summary, the selection or the completion check is in `permitMs` too, and a freshness wait
 * after a cut-off call in `guardMs` and `toolMs`; read each as where time went, not as a share of `stepMs` to add up.
 */
type Spent = 'selectorMs' | 'recallMs' | 'summaryMs' | 'llmMs' | 'recallStartMs' | 'evidenceMs' | 'probeMs';
type Other = 'startMs' | 'permitMs' | 'guardMs' | 'contextMs' | 'verifyMs' | 'closeMs' | 'commitMs' | 'progressMs';
const toolName = (name: string) => /^[A-Za-z0-9_.:-]{1,80}$/u.test(name) ? name : 'other';
const whole = (value: number) => Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
/**
 * The provider's input of a decision in counts (mb-llmc r8, run 32: 「キャッシュに無い入力」 was read from `new` alone, and the cache's write was
 * left out): `new` is what is after the last cache breakpoint (a transient task's live state), `read` is served by the cache, `write` is
 * stored in it at the one-hour price (twice the input's), `uncached` is `new` + `write`, `live` is the estimate of the live state's tokens
 * (when the request had one), and `hit` is `read` over all three, in thousandths.
 */
function inputCounts(metrics: NonNullable<ActionExecution['modelMetrics']>): Record<string, number> {
  const all = metrics.inputNew + metrics.inputRead + metrics.inputWrite;
  return { new: metrics.inputNew, read: metrics.inputRead, write: metrics.inputWrite, uncached: metrics.inputNew + metrics.inputWrite,
    ...(metrics.liveTokens !== undefined ? { live: metrics.liveTokens } : {}), hit: all > 0 ? Math.round(1000 * metrics.inputRead / all) : 0 };
}

export function fcaDecisionMetrics(taskId: string, createdAt: string, prior: Readonly<Record<string, unknown>>,
  options: { now?: () => number; clock?: () => number; log?: (line: string) => void; enteredAt?: number; body?: boolean;
    summaryLog?: (line: string) => void } = {}) {
  const clock = options.clock ?? (() => performance.now()), now = options.now ?? Date.now, log = options.log ?? ((line: string) => console.info(line));
  const before = Number(prior.fcaDecisionIndex), index = (Number.isSafeInteger(before) && before >= 0 ? before : 0) + 1;
  const started = clock(), loopStarted = eventLoopBlockedMilliseconds(), execution = currentActionExecution(), startedAt = now();
  if (execution) delete execution.modelMetrics; // A reading of an earlier decision on the same execution is never this one's.
  // ADR-0014 D8: a body task's model calls are counted for its summary (`fcaTaskTelemetry.ts`); the call's kind is set before each attempt.
  if (execution && options.body) execution.telemetry = { taskId, kind: 'main' };
  let attempts = 0, taken = false, planned: Array<{ name: string; act: boolean }> = [];
  const spent: Record<Spent, number> = { selectorMs: 0, recallMs: 0, summaryMs: 0, llmMs: 0, recallStartMs: 0, evidenceMs: 0, probeMs: 0 };
  const other: Record<Other, number> = { startMs: options.enteredAt === undefined ? 0 : Math.max(0, started - options.enteredAt),
    permitMs: 0, guardMs: 0, contextMs: 0, verifyMs: 0, closeMs: 0, commitMs: 0, progressMs: 0 };
  const committedBefore = typeof prior.fcaCommittedAt === 'number' && Number.isFinite(prior.fcaCommittedAt) ? prior.fcaCommittedAt : null;
  let toolMs = 0, permitAsks = 0;
  const tools: string[] = [], skipped: string[] = [];
  let recalled: BodyRecallMeasure | null = null;
  /** mb-llmc r3: an urgent step (`FcaBodyLifecycle.urgent`), and what the history did beside the decision (`prepareFcaHistory`'s `ahead`). */
  let urgent = false, thrown: number | null = null;
  const ahead: string[] = [];
  /** mb-llmc r4: what the body's investigation did before the decision (`FcaBodyLifecycle.investigate`), or null. */
  let probe: { surprises: string[]; probes: number; answered: number } | null = null;
  const kindOf = (): 'main' | 'urgent' | 'first_plan' => urgent ? 'urgent' : index === 1 ? 'first_plan' : 'main';
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
    /**
     * Runs `work`, adding its time to one of the parts (a part may run more than once; it is summed). `skip`: r8, a call thrown away
     * after an interrupt (`fcaUrgentDecision.ts`) adds nothing when it ends: its time is the interrupt's (`thrownMs`), not the decision's.
     */
    async timed<T>(part: Spent | Other, work: () => Promise<T>, skip?: () => boolean): Promise<T> {
      const at = clock();
      if (part === 'llmMs') attempts += 1;
      if (part === 'llmMs' && execution?.telemetry) execution.telemetry.kind = kindOf();
      try { return await work(); } finally { if (!skip?.()) add(part, clock() - at); }
    },
    /** `timed` for synchronous work: what it held the API's one thread. */
    timedSync<T>(part: Spent | Other, work: () => T): T {
      const at = clock();
      try { return namedWork(`fca_${part}`, work); } finally { add(part, clock() - at); }
    },
    /** A tool call ended (`result`: its arguments are only compared, a failed same call repeated is counted for the task summary). */
    tool(name: string, milliseconds: number, result?: { input: unknown; ok: boolean }): void {
      tools.push(toolName(name));
      toolMs += milliseconds;
      if (result && options.body) fcaTaskTelemetry.toolCall(taskId, name, result.input, result.ok);
    },
    /** The calls of the decision, and which of them act on the body (a decision of `plan.update` and no act is plan-only). */
    decided(calls: ReadonlyArray<{ name: string; act: boolean }>): void { planned = [...calls]; },
    /** One ask of the action lease of the mind (checked in fcaRunner.ts asks only some of the times it checks). */
    asked(): void { permitAsks += 1; },
    /** A body action of the response left unrun because an earlier one of it failed. */
    skipped(name: string): void { skipped.push(toolName(name)); },
    /** What a body task's recall did (`bodyTaskRecall.ts`: pool, groups, shown, characters, cue tags, Jev). Content-free. */
    bodyRecall(measure: BodyRecallMeasure): void { recalled = measure; },
    /** The step was urgent (mb-llmc r3). */
    urgent(): void { urgent = true; },
    /** The decision asked ahead that this step took, or null (`fcaLookahead.ts`): the step then asks no model. */
    lookahead<T>(prepared: T | null): T | null {
      taken = prepared !== null;
      return prepared;
    },
    /** The task is being stopped by its runner: its summary line, then the reason as it was. */
    stopping<T>(reason: T): T {
      if (options.body) fcaTaskTelemetry.summary(taskId, 'stopped', options.summaryLog);
      return reason;
    },
    /** The kind of this step's decision call (ADR-0014 D8): the first decision of a task asks for its first plan. */
    kind: kindOf,
    /** mb-llmc r8: the decision awaited was thrown away after `milliseconds` for a hostile that came, and asked again (`fcaUrgentDecision.ts`). */
    interrupted(milliseconds: number): void {
      urgent = true;
      thrown = whole(milliseconds);
    },
    /** What the history's summary ahead did in this step: `started`, `installed`, `waited` (mb-llmc r3). Content-free. */
    ahead(what: string): void { if (ahead.length < 4) ahead.push(/^[a-z_]{1,24}$/u.test(what) ? what : 'other'); },
    /** The body's investigation (mb-llmc r4): its surprises' closed codes and the probes sent and answered. Content-free. */
    investigated(found: { surprises: readonly string[]; probes: number; answered: number }): void {
      probe = { surprises: found.surprises.slice(0, 8).map(code => /^[a-z_]{1,24}$/u.test(code) ? code : 'other'),
        probes: Number.isSafeInteger(found.probes) ? found.probes : 0, answered: Number.isSafeInteger(found.answered) ? found.answered : 0 };
    },
    /** `fcaCommittedAt`: when this decision committed (epoch ms), the start of the next one's `gap`. */
    checkpoint: (): Record<string, unknown> => ({ fcaDecisionIndex: index, fcaCommittedAt: now() }),
    /** Writes the line (the decision has committed), then the task's counters (`phase`: the task's after the commit). Never throws. */
    emit(phase?: string): void {
      try {
        const metrics = currentActionExecution()?.modelMetrics, began = Date.parse(createdAt);
        log(JSON.stringify({ event: 'fca_decision_metrics', task: taskId, d: index, kind: kindOf(),
          t: Number.isFinite(began) ? Math.max(0, Math.round((now() - began) / 1000)) : null, obsMode: metrics?.obsMode ?? 'legacy',
          llmMs: Math.round(spent.llmMs), stepMs: Math.round(clock() - started), selectorMs: Math.round(spent.selectorMs),
          recallMs: Math.round(spent.recallMs), recallStartMs: Math.round(spent.recallStartMs), evidenceMs: Math.round(spent.evidenceMs),
          summaryMs: Math.round(spent.summaryMs), tools, toolMs: Math.round(toolMs),
          storedTokens: metrics?.storedTokens ?? null, tailTokens: metrics?.tailTokens ?? null,
          in: metrics ? inputCounts(metrics) : null, out: metrics?.outputTokens ?? null,
          ...(metrics?.model ? { model: metrics.model } : {}), ttftMs: metrics?.ttftMs ?? null, ...(metrics?.layers ? { layers: metrics.layers } : {}),
          ...(taken ? { lookahead: 'taken' } : {}),
          loopBlockedMs: Math.round(eventLoopBlockedMilliseconds() - loopStarted),
          other: Object.fromEntries(Object.entries(other).map(([key, value]) => [key, Math.round(value)])), permitAsks, gap: gap(),
          ...optional(metrics) }));
      } catch { /* measuring never fails a step */ }
      if (options.body) {
        fcaTaskTelemetry.decision(taskId, { attempts, interrupted: thrown !== null, surprised: probe !== null, taken, planned, phase }, options.summaryLog);
      }
    },
  };
  /** The fields of the line that are there only when there is something to say. */
  function optional(metrics: ActionExecution['modelMetrics']): Record<string, unknown> {
    return { ...(skipped.length ? { skipped } : {}), ...(recalled ? { bodyRecall: recalled } : {}),
      ...(urgent ? { urgent } : {}), ...(thrown !== null ? { interrupt: { thrownMs: thrown } } : {}),
      ...(ahead.length ? { summaryAhead: ahead } : {}),
      ...(probe ? { probe: { ...probe, ms: Math.round(spent.probeMs) } } : {}),
      ...(metrics ? { inputTransformations: metrics.inputTransformations } : {}), ...(metrics?.cuts ? { cut: metrics.cuts } : {}) };
  }
  function add(part: Spent | Other, milliseconds: number): void {
    if (part in spent) spent[part as Spent] += milliseconds;
    else other[part as Other] += milliseconds;
  }
}
