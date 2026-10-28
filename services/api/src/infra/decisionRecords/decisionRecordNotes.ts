import type { MinecraftControlCommand } from '../../contracts/minecraftControlContract.js';
import type { DecisionRecorder, RequestKind, ResponseNote } from './decisionRecorder.js';
import { currentDecisionScope, withDecisionScope } from './decisionRecordScope.js';

/**
 * The places that write a decision's record (`decisionRecorder.ts`) reach it through these functions. There is one recorder for the API's process,
 * installed by wiring (this module imports the recorder as a type only, so that the places that call it load almost nothing); with none
 * installed (a test, a tool) every function does nothing, so no caller needs to ask. What is recorded is what a step of a body task (Minebot)
 * does: a request and its answer (`decisionRecordClient.ts`), what the step did with the decision, each call of its tools, and each command sent
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

/** What the step did with the decision it asked last (`applied`, `discarded` with a closed reason, or `failed` with a closed code). */
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

/** A command that went to the body (the form the head sent after its checks and rewrites), with the decision and call it came from when it came from one. */
export function noteBodyCommand(command: MinecraftControlCommand): void {
  if (!installed || command.kind !== 'skill') return;
  const scope = currentDecisionScope(), state = scope?.state, own = state && state.taskId === command.context.taskId ? scope : undefined;
  const { context } = command;
  installed.append(context.taskId, { ev: 'sent', commandId: command.id, decisionId: own?.state.lastDecisionId ?? null, stepId: own?.state.stepId ?? null,
    operationId: own?.call?.operationId ?? null, toolUseId: own?.call?.toolUseId ?? null, skill: command.skill ?? null, arguments: command.arguments ?? null,
    queue: command.queue ?? null, deadlineAt: command.deadlineAt, serverId: command.serverId, connectionId: command.connectionId, leaseId: command.lease.id,
    context: { bodyId: context.bodyId, taskRevision: context.taskRevision, sessionId: context.sessionId, generation: context.generation,
      ...(context.incident ? { incident: context.incident } : {}) } });
}

/** The first plan's one request (`minecraftFirstPlan.ts`) is recorded as the task's: it runs outside any step. */
export function recordedPlanner<A extends unknown[], R>(task: { taskId: string; stepId: string }, planner: ((...args: A) => Promise<R>) | undefined):
  ((...args: A) => Promise<R>) | undefined {
  return planner ? (...args: A) => withDecisionScope({ ...task, record: true }, () => planner(...args)) : undefined;
}
