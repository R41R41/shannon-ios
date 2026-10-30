import type { TraceIds } from '../../contracts/continueContract.js';
import type { MinecraftControlCommand } from '../../contracts/minecraftControlContract.js';
import type { DecisionRecorder, RequestKind, ResponseNote } from './decisionRecorder.js';
import { currentDecisionScope, withDecisionScope, type LiveNote, type ResultMark } from './decisionRecordScope.js';

/**
 * The places that write a decision's record (`decisionRecorder.ts`) reach it through these functions. There is
 * one recorder for the API's process,
 * installed by wiring (this module imports the recorder as a type only, so that the places that call it load
 * almost nothing); with none
 * installed (a test, a tool) every function does nothing, so no caller needs to ask. What is recorded is what a
 * step of a body task (Minebot)
 * does: a request and its answer (`decisionRecordClient.ts`), what the step did with the decision, each call of
 * its tools, and each command sent
 * to the body. See `docs/decision-records-2026-10.md`.
 */
let installed: DecisionRecorder | null = null;
export function installDecisionRecorder(recorder: DecisionRecorder | null): DecisionRecorder | null {
  installed = recorder;
  return recorder;
}
export function decisionRecorder(): DecisionRecorder | null { return installed; }

/** A request that is about to go out, if the step it belongs to is recorded: its id (for `recordResponse`), else null. */
export function recordRequest(kind: RequestKind, body: Readonly<Record<string, unknown>>, headers?: Readonly<Record<string, string>>): string | null {
  const state = currentDecisionScope()?.state;
  return installed && state?.record ? installed.request({ kind, scope: state, body, headers }) : null;
}
export function recordResponse(id: string, note: ResponseNote): void { installed?.response(id, note); }

const cut = (text: unknown, size: number) => String(text ?? '').slice(0, size);

/** What the step did with the decision it asked last (`applied`, `discarded` with a closed reason, or `failed`
 * with a closed code). */
export function noteDecisionOutcome(ev: 'applied' | 'discarded' | 'failed', detail: Readonly<Record<string, unknown>> = {}): void {
  const state = currentDecisionScope()?.state;
  if (!installed || !state?.record || !state.lastDecisionId) return;
  installed.append(state.taskId, { ev, id: state.lastDecisionId, stepId: state.stepId, operationId: state.operationId, round: state.round, ...detail });
}

/** One call of the decision's tools: what the tool was given and what came back (cut), or that it was not run. */
export function noteDecisionCall(call: { toolUseId: string; name: string; input: unknown; operationId: string; skipped: boolean; ms: number;
  result: { ok: boolean; text: string; failure?: string; retryable?: boolean; bodyReflex?: boolean; progressed?: boolean } }): void {
  const state = currentDecisionScope()?.state;
  if (!installed || !state?.record) return;
  const { result } = call;
  installed.append(state.taskId, { ev: 'call', decisionId: state.lastDecisionId, stepId: state.stepId, operationId: call.operationId, toolUseId: call.toolUseId,
    name: call.name, input: call.input, skipped: call.skipped, ms: Math.round(call.ms),
    result: { ok: result.ok, failure: result.failure ?? null, retryable: result.retryable ?? null, text: cut(result.text, 6_000),
      ...(result.bodyReflex ? { bodyReflex: true } : {}), ...(result.progressed ? { progressed: true } : {}) } });
}

/** Amendment A-12: who is told of the `redecide` rows as they are written (`onRedecideNote`). */
type RedecideListener = (taskId: string, detail: Readonly<Record<string, unknown>>) => void;
const redecideListeners = new Set<RedecideListener>();
/** Tells `listener` of each `redecide` row of a recorded task (its failure, its refusal); returns the way to stop. */
export function onRedecideNote(listener: RedecideListener): () => void {
  redecideListeners.add(listener);
  return () => { redecideListeners.delete(listener); };
}

/** Amendment A-12: the last rows of a task's record as lines of at most 400 characters (the notes of a take);
 * none when no recorder is installed. */
export function noteHeadTail(taskId: string, rows = 20): string[] {
  return (installed?.tail(taskId, rows) ?? []).map(row => JSON.stringify(row).slice(0, 400));
}

/**
 * Amendment A-12: the box of a stall the head found itself (the reason and the last rows of the task's record),
 * written beside its
 * `events.jsonl`; its path below the records' root,
 * or null when no recorder is installed or nothing could be written.
 */
export function noteHeadHold(taskId: string, hold: { id: string; kind: string; why: string; detail?: Readonly<Record<string, unknown>> }): string | null {
  return installed?.headHold(taskId, hold) ?? null;
}

/**
 * Amendment A-10: the row of a call of the decision that was asked again (or could have been: `asked: false`
 * says only what the head
 * could not count). Beside the `redecide`
 * request and its answer, which are written as any request is; the row says what came of them. The decision and
 * call are those the step is in.
 */
export function noteRedecide(detail: Readonly<Record<string, unknown>>): void {
  const scope = currentDecisionScope(), state = scope?.state;
  if (!state?.record) return;
  installed?.append(state.taskId, { ev: 'redecide', decisionId: state.lastDecisionId, stepId: state.stepId, operationId:
     scope?.call?.operationId ?? state.operationId,
    toolUseId: scope?.call?.toolUseId ?? null, ids: { run: state.taskId, ...(state.lastDecisionId ? { decision: state.lastDecisionId } : {}) }, ...detail });
  // Amendment A-12: the row is also told, once written (a box made for it holds it), to whoever watches the decision's errors (a
// record installed or not), with the task it belongs to.
  for (const listener of redecideListeners) try { listener(state.taskId, detail); } catch { /* a watcher never fails a decision */ }
}

/** A command that went to the body (the form the head sent after its checks and rewrites), with the decision and
 * call it came from
 * when it came from one. */
export function noteBodyCommand(command: MinecraftControlCommand, extra: { resumeOf?: string } = {}): void {
  if (!installed || command.kind !== 'skill') return;
  const scope = currentDecisionScope(), state = scope?.state, own = state && state.taskId === command.context.taskId ? scope : undefined;
  const { context } = command, made = command.queue?.madeIn ?? context.madeIn, decision = own?.state.lastDecisionId ?? undefined;
  // Continue contract 8: the numbers that join this command to the decision that made it, to its receipt and to
// the body's own record
// (`ids`; the old fields stay).
  const commandTraceIds = (): TraceIds => ({ run: context.taskId, ...(decision ? { decision } : {}), command: command.id, ...(command.queue?.queue ? { queue:
     command.queue.queue } : {}),
    ...(command.queue?.item ? { item: command.queue.item } : {}), life: made?.life ?? context.life ?? -1, ...(made?.bodyBoot ? { bodyBoot:
       made.bodyBoot } : {}),
    ...(made?.headBoot ?? context.headBoot ? { headBoot: (made?.headBoot ?? context.headBoot)! } : {}), obsSeq: made?.obsSeq ?? -1, obsAt:
       new Date().toISOString() });
  const ids = commandTraceIds();
  const commandContext = () => ({ bodyId: context.bodyId, taskRevision: context.taskRevision, sessionId: context.sessionId, generation: context.generation,
      ...(context.life !== undefined ? { life: context.life } : {}), ...(context.headBoot ? { headBoot: context.headBoot } : {}),
      ...(context.incident ? { incident: context.incident } : {}) });
  installed.append(context.taskId, { ev: 'sent', ids, commandId: command.id, decisionId: own?.state.lastDecisionId ?? null, stepId: own?.state.stepId ?? null,
    operationId: own?.call?.operationId ?? null, toolUseId: own?.call?.toolUseId ?? null, skill: command.skill ?? null, arguments: command.arguments ?? null,
    queue: command.queue ?? null, deadlineAt: command.deadlineAt, serverId: command.serverId, connectionId: command.connectionId, leaseId: command.lease.id,
    ...(extra.resumeOf ? { resumeOf: extra.resumeOf } : {}),
    context: commandContext() });
}

/** The first plan's one request (`minecraftFirstPlan.ts`) is recorded as the task's: it runs outside any step. */
export function recordedPlanner<A extends unknown[], R>(task: { taskId: string; stepId: string }, planner: ((...args: A) => Promise<R>) | undefined):
  ((...args: A) => Promise<R>) | undefined {
  return planner ? (...args: A) => withDecisionScope({ ...task, record: true }, () => planner(...args)) : undefined;
}

// ---- continue contract 8: the rows of the measure
// -----------------------------------------------------------------------------------------------------

/** A row of the measure (`received`, `released`, `corrected`, `woke`, `unknown_notified`, `ledger`, …): in the
 * record of the run its `ids` name. */
export function noteStageRow(row: Readonly<{ ev: string; ids?: { run?: string } }>): void {
  const run = row.ids?.run;
  if (installed && run) installed.row(run, row as Readonly<Record<string, unknown>>);
}

/**
 * The results of commands the step has just put in front of the model (`decision.reads`): each command with the
 * words that stand for
 * it in the history. The next
 * requests of the step name the ones whose words they hold. Called where the queue's news is taken for the step.
 */
export function noteResultsRead(marks: readonly ResultMark[]): void {
  const state = currentDecisionScope()?.state;
  if (!installed || !state?.record || !marks.length) return;
  state.results.push(...marks);
  if (state.results.length > 512) state.results.splice(0, state.results.length - 512);
}

/** The live state of the request being built (before the rewrite, after, and what the rewrite left out): the request that follows
 * writes the `live` row with its size. */
export function noteLiveState(note: LiveNote): void {
  const state = currentDecisionScope()?.state;
  if (installed && state?.record) state.liveNote = note;
}

/** The node kinds a plan.update turned into `other` (the model wrote a word outside the list): the word as written is kept in the
 * decision's record (`kindRaw`). */
export function noteKindRaw(nodes: readonly { node: string; kindRaw: string }[]): void {
  const state = currentDecisionScope()?.state;
  if (!installed || !state?.record || !nodes.length) return;
  installed.append(state.taskId, { ev: 'kind_raw', decisionId: state.lastDecisionId, stepId: state.stepId, ids: { run: state.taskId, ...(
    state.lastDecisionId ? { decision: state.lastDecisionId } : {}) },
    nodes: nodes.map(item => ({ node: item.node, kind: 'other', kindRaw: cut(item.kindRaw, 64) })) });
}

/** The task's history was made again before its next decision (`resume`: a step that begins from an operator's hold). */
export function noteHistoryChange(taskId: string, change: 'resume' | 'summary'): void { installed?.noteHistory(taskId, change); }

/** The head answered a body's connection for the first time in this start: `row(run)` is the `head_boot` row of one run. */
export function noteHeadBoot(bodyId: string, row: (run: string) => Record<string, unknown>): void { installed?.headBooted(bodyId, row); }
