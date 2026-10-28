import type { TaskRuntime, TaskStep } from '../taskRuntime/taskRuntimePorts.js';
import { executeTaskTool } from '../../tools/toolRunnerPorts.js';
import { observeAsync, observerHandoff, observeSync } from '../../../infra/observer/observerContext.js';
import { observedToolName } from '../../../infra/models/anthropic/observerProjection.js';
import { TOOL_OPEN_NAME, toolFailure, type ToolResult } from '../../tools/toolRegistryPorts.js';
import type { FcaStepPorts } from './fcaRunner.js';
import type { FcaDecision, FcaModelInput, FcaToolCall, FcaToolDefinition } from './fcaPorts.js';
import type { fcaDecisionMetrics } from './fcaDecisionMetrics.js';
import { failureRefreshes, openFcaTool, type selectFcaTools } from './fcaToolState.js';
import { FCA_BODY_TOOL_ABSENT, FCA_EARLIER_ACTION_FAILED } from './fcaRunnerWords.js';
import type { TaskProgressEvent } from '../taskRuntime/taskProgressPorts.js';
import { withDecisionCall } from '../../../infra/decisionRecords/decisionRecordScope.js';
import { noteDecisionCall } from '../../../infra/decisionRecords/decisionRecordNotes.js';

/** What a round of tool calls needs of the step it runs in (`executeFcaStep`'s own gates and state, by reference). */
export interface RoundContext {
  step: TaskStep; ports: FcaStepPorts; signal: AbortSignal; runtime: TaskRuntime; metrics: ReturnType<typeof fcaDecisionMetrics>;
  checked(mode?: 'fresh' | 'reuse' | 'local'): Promise<void>;
  stillFresh(): Promise<boolean>;
  stillFreshFor(call: { id: string; name: string; input: unknown } | undefined): Promise<boolean>;
  progress(event: TaskProgressEvent): void;
  catalog: readonly FcaToolDefinition[];
  /** The step's tool selection (changed in place: a failed call may ask for a new selection); null without a selector. */
  selection: Awaited<ReturnType<typeof selectFcaTools>> | null;
  input: FcaModelInput;
  provenance: Record<string, unknown>;
  bodyTask: boolean;
  /** Whether the body or the observations moved since the decision: set here, read by the step. */
  state: { bodyStale: boolean };
}
/** One call's outcome as the failure ladder reads it (`settleReflexStep`). */
export interface RoundOutcome { name: string; ok: boolean; cut: boolean; read: boolean }
export interface ToolRound { results: Array<{ id: string; text: string; ok: boolean }>; outcomes: RoundOutcome[] }

const STALE = '身体の状態が変わりました。最新の観測から判断し直してください。';
/** Past 1,000 characters the start and the end are kept: a body result says what to do first at its end (the failure review reads it). */
export const resultSummary = (text: string): string => text.length <= 1_000 ? text : `${text.slice(0, 560)}…${text.slice(-439)}`;

/** The answers that need no tool: a stale body, a skipped call, the opening of a tool, a tool the menu does not have; null when the call goes on. */
function answeredAlready(ctx: RoundContext, call: FcaToolCall, skipped: boolean): ToolResult | null {
  const { selection, input, catalog } = ctx;
  if (ctx.state.bodyStale) return toolFailure('failed', STALE, { retryable: false });
  if (skipped) return toolFailure('failed', FCA_EARLIER_ACTION_FAILED, { retryable: true });
  if (call.name === TOOL_OPEN_NAME && selection) return openFcaTool(call.input, catalog, selection);
  if (!catalog.some(definition => definition.name === call.name)) {
    return toolFailure('not_offered', call.name.startsWith('mc.') ? FCA_BODY_TOOL_ABSENT : 'このタスクでは利用できない道具です。',
      { retryable: call.name.startsWith('mc.') });
  }
  if (selection && !input.tools.some(definition => definition.name === call.name)) {
    return toolFailure('not_offered', '定義が必要な道具は、先に tool_open で開いてください。');
  }
  return null;
}

/** The result of one call: the answers that need no tool, a body or outside tool, or a task tool. */
async function runCall(ctx: RoundContext, call: FcaToolCall, parts: { operationId: string; last: boolean; skipped: boolean }): Promise<ToolResult> {
  const { step, ports, signal, runtime } = ctx;
  const early = answeredAlready(ctx, call, parts.skipped);
  if (early) return early;
  if (!ports.tools?.definitions.some(definition => definition.name === call.name)) {
    return executeTaskTool(runtime, call.name, call.input, { scopeKey: step.scopeKey, taskId: step.taskId, operationId: parts.operationId,
      ownerAlone: ports.ownerAlone, ...(ports.taskVisible ? { visible: ports.taskVisible } : {}),
      ...(ports.observeTasks ? { observed: ports.observeTasks } : {}) });
  }
  // Never turn an unknown outside outcome into a retryable tool result.
  ports.body?.noteCall?.(call, parts.operationId);
  let operationSignal = ports.body?.toolSignal(call.name, signal) ?? signal;
  for (const observation of ports.observations ?? []) operationSignal = observation.toolSignal(call.name, operationSignal);
  try {
    return await ports.tools.execute({ scopeKey: step.scopeKey, taskId: step.taskId, operationId: parts.operationId, name: call.name, input: call.input,
      signal: operationSignal, ...(parts.last ? { last: true } : {}) });
  } catch (error) {
    if (operationSignal !== signal && operationSignal.aborted && !signal.aborted && !await ctx.stillFresh()) {
      ctx.state.bodyStale = true;
      return toolFailure('failed', STALE, { retryable: false });
    }
    throw error;
  }
}

/** The progress record of a finished call: its status, a read receipt, and a report when it was a message to the parent. */
function progressOf(ctx: RoundContext, call: FcaToolCall, operationId: string, result: ToolResult): TaskProgressEvent {
  const input = call.input && typeof call.input === 'object' ? call.input as Record<string, unknown> : {};
  const report = result.ok && call.name === 'task.send' && input.id === ctx.step.snapshot.task.parentId && typeof input.message === 'string'
    ? { report: { text: String(input.message) } } : {};
  const read = result.ok && result.readReceipt ? { read: result.readReceipt } : {};
  return { operationId, tool: call.name, status: result.ok ? 'received' : 'failed', ...read, ...report };
}

/** What the call's result adds to the step's tool selection: a new selection after a failure that asks for one, and the recent results. */
function noteSelection(ctx: RoundContext, call: FcaToolCall, result: ToolResult): void {
  const selection = ctx.selection;
  if (!selection) return;
  if (!result.ok && failureRefreshes(selection, call.name)) selection.refresh = true;
  selection.recentResults = [...selection.recentResults, { name: call.name, ok: result.ok, summary: resultSummary(result.text) }].slice(-8);
}

/** What the calls of a round have left so far (by call id): the results, the cuts, the ones that made something, the ones not run. */
interface Tally {
  results: Array<{ id: string; text: string; ok: boolean }>;
  /** Calls the body's own reflex cut off: no fault of the model or the tool (until the bound of `fcaReflexCuts.ts`). */
  reflexCuts: Set<string>;
  /** Calls that failed but made something (`ToolResult.progressed`): not failed steps of a body task (`fcaFailureLadder.ts`). */
  progressed: Set<string>;
  notRun: Set<string>;
  /** The old Minebot's `earlier_action_failed`: a body action after a failed one of this response is not run. */
  earlierFailed: boolean;
}

/** A call that did its work: handed to the body's notes, the progress hooks, and the step's tool selection; its stored text goes to the results. */
async function settleCall(ctx: RoundContext, call: FcaToolCall, result: ToolResult, tally: Tally,
  parts: { operationId: string; began: number }): Promise<void> {
  const { ports, selection, state } = ctx;
  ports.body?.noteResult?.(call, result, performance.now() - parts.began);
  ports.tools?.progress?.observed(parts.operationId, call.name, result);
  if (!result.ok && isBodyAction(ctx, call.name)) tally.earlierFailed = true;
  if (!await ctx.stillFreshFor(call)) state.bodyStale = true;
  // A transient body task stores the cut text of a body result (`minecraftStoredResult.ts`); everything else here saw the whole one.
  const stored = selection?.obsMode === 'transient' && ports.body?.storedResult ? ports.body.storedResult(call, result.text) : result.text;
  tally.results.push({ id: call.id, text: stored, ok: result.ok });
  if (result.bodyReflex) tally.reflexCuts.add(call.id);
  if (result.progressed) tally.progressed.add(call.id);
  noteSelection(ctx, call, result);
}
const isBodyAction = (ctx: RoundContext, name: string): boolean => ctx.bodyTask && ctx.ports.tools?.definitions.some(definition => definition.name === name
  && definition.domain === 'minecraft_body' && definition.effect !== 'read') === true;

/** One call of the round: the gates, the call, its progress records, and its place in the tally. */
async function runOne(ctx: RoundContext, call: FcaToolCall, last: boolean, tally: Tally): Promise<void> {
  const { step, ports, metrics, catalog, provenance, state } = ctx;
  await ctx.checked(ports.tools?.permitsItself?.(call.name) ? 'local' : 'fresh');
  if (!await ctx.stillFreshFor(call)) state.bodyStale = true;
  const operationId = `${step.id}:${call.id}`;
  const tool = call.name === TOOL_OPEN_NAME ? 'tool_open' : observedToolName(call.name, catalog);
  const skipped = !state.bodyStale && tally.earlierFailed && isBodyAction(ctx, call.name);
  observerHandoff('llm', 'gate', { ...provenance, operationId, tool });
  ctx.progress({ operationId, tool: call.name, status: 'running' });
  const began = performance.now();
  const result = await observeAsync('tools', { ...provenance, operationId, tool }, () => withDecisionCall({ operationId, toolUseId: call.id, name: call.name },
    () => runCall(ctx, call, { operationId, skipped, last })),
    value => ({ ...provenance, operationId, ok: value.ok, failure: value.failure ?? null }))
    .catch(error => {
      ctx.progress({ operationId, tool: call.name, status: 'unknown' });
      ports.evidence?.unknown(step, call);
      noteDecisionCall({ toolUseId: call.id, name: call.name, input: call.input, operationId, skipped: false, ms: performance.now() - began,
        result: { ok: false, failure: 'unknown', text: `threw ${String((error as Error | undefined)?.message ?? error).slice(0, 200)}` } });
      throw error;
    });
  noteDecisionCall({ toolUseId: call.id, name: call.name, input: call.input, operationId, skipped, ms: performance.now() - began, result });
  if (skipped) metrics.skipped(call.name); else metrics.tool(call.name, performance.now() - began);
  ctx.progress(progressOf(ctx, call, operationId, result));
  if (skipped) ports.evidence?.notRun?.(step, call);
  else if (ports.evidence) observeSync('prediction', { phase: 'observed', ok: result.ok }, () => ports.evidence!.observed(step, call, result));
  if (!skipped) return settleCall(ctx, call, result, tally, { operationId, began });
  tally.notRun.add(call.id);
  tally.results.push({ id: call.id, text: result.text, ok: false });
}

/**
 * The calls of one decision, in their order (the old loop of `fcaRunner.ts`, unchanged in what it does; moved here so the step can run it once for
 * every decision of a stretch). A body action after one that failed in the same response is not run (`FCA_EARLIER_ACTION_FAILED`). A call that is a body
 * item of the task queue returns when the body has it; its own result comes later as news (`fcaStretch.ts`).
 */
export async function runToolRound(ctx: RoundContext, decision: Extract<FcaDecision, { kind: 'tools' }>,
  auxiliary: ReadonlyArray<{ id: string; text: string; ok: boolean }>): Promise<ToolRound> {
  const calls = decision.calls;
  if (!calls.length || calls.length > 8 || new Set(calls.map(call => call.id)).size !== calls.length) throw new Error('FCA_INVALID_CALLS');
  const tally: Tally = { results: [...auxiliary], reflexCuts: new Set(), progressed: new Set(), notRun: new Set(), earlierFailed: false };
  for (const [index, call] of calls.entries()) await runOne(ctx, call, index === calls.length - 1, tally);
  // The outcomes the ladder counts: not the goal and replan tools, nor a call that was not run. A cut call does not count until the same tool (or any)
  // has been cut off too many times in a row (`fcaReflexCuts.ts`, M2); a call that made something is not a failed step (`fcaFailureLadder.ts`).
  const outcomes = calls.flatMap((call, index) => ['goal.set_conditions', 'goal.verify', 'task.replan'].includes(call.name) || tally.notRun.has(call.id)
    ? [] : [{ name: call.name, ok: tally.results[auxiliary.length + index]!.ok || (ctx.bodyTask && tally.progressed.has(call.id)),
      cut: tally.reflexCuts.has(call.id), read: ctx.catalog.find(tool => tool.name === call.name)?.effect === 'read' }]);
  return { results: tally.results, outcomes };
}
