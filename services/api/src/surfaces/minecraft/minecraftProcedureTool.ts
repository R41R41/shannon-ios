import { procedureRunLines, runProcedures, type ProcedureItemResult, type ProcedureRunResult } from '@shannon/mind';
import type { FcaToolDefinition } from '../../mind/action/fca/fcaPorts.js';
import type { TaskRuntime, TaskStep } from '../../mind/action/taskRuntime/taskRuntimePorts.js';
import type { ToolResult } from '../../mind/tools/shannonTools.js';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { MinecraftWorkItem } from './minecraftFillers.js';
import { milestoneNow } from './minecraftStage.js';
import { minecraftProcedureFacts, type MinecraftProcedureFacts } from './minecraftProcedureFacts.js';
import { MINECRAFT_PROCEDURE_TOOL, PROCEDURE_MILESTONES, minecraftProcedureChain } from './minecraftProcedures.js';
import type { ProcedureTaskStore } from './minecraftProceduresIron.js';
import { finalFailure, minecraftStopWhy, minecraftUpkeep } from './minecraftProcedureUpkeep.js';

/**
 * The planner's one call for a whole procedure (session mb-arch, owner 2026-10-20: 「30分でスムーズにネザーに行く」; run 19 took 64
 * decisions for less than half the way). `mc.run-procedure` names the milestone to start at and, optionally, the last one to go on to;
 * the executor runs their procedures (`minecraftProcedures.ts`) with the body's own tools until they are done or the turn must go back
 * (`minecraftProcedureUpkeep.ts`), and says in fixed words what it did and why it returned. The planner's turn stays for three things:
 * which procedure to start, what to do about the unexpected, and what to cut when a step is late.
 */
export const MINECRAFT_PROCEDURE_DEFINITION: FcaToolDefinition = {
  name: MINECRAFT_PROCEDURE_TOOL,
  description: '節目の手順を、実行役が体の道具で最後まで流す（掘る・作る・焼く・着る・食べる・寝るを、観測を見ながら自分で続ける）。'
    + 'milestone=始める節目、through=続けて進める最後の節目（省けば milestone だけ）。'
    + '新しい伝言・体力が少ない・敵が近い・食べ物が無い・夜にベッドが無い・手が無い・同じ失敗が続いた・時間の目安を過ぎた、の時は途中で理由を添えて返る。'
    + '返ったら、その理由に対してだけ判断し、また続きを頼む。',
  input: { type: 'object', properties: {}, required: [], additionalProperties: false },
  nativeInputSchema: { type: 'object', additionalProperties: false, required: ['milestone'], properties: {
    milestone: { type: 'string', enum: [...PROCEDURE_MILESTONES], description: '始める節目（今の節目）' },
    through: { type: 'string', enum: [...PROCEDURE_MILESTONES], description: '続けて進める最後の節目' },
  } },
  domain: 'minecraft_body', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'],
};

interface TaskProcedureState {
  store: ProcedureTaskStore;
  toldLate: Set<string>;
  /** The item running now: what the arbiter follows, and what a cut stops. */
  item: { name: string; input: unknown; operationId: string; controller: AbortController } | null;
}
const states = new Map<string, TaskProcedureState>();
function stateOf(taskId: string): TaskProcedureState {
  let state = states.get(taskId);
  if (!state) {
    state = { store: { furnaces: [] }, toldLate: new Set(), item: null };
    states.set(taskId, state);
    if (states.size > 32) states.delete(states.keys().next().value as string);
  }
  return state;
}

/** The procedure's item running now in this task (the arbiter watches it as the running command), or null. */
export function procedureItem(taskId: string): { name: string; input: unknown; operationId: string } | null {
  const item = states.get(taskId)?.item;
  return item ? { name: item.name, input: item.input, operationId: item.operationId } : null;
}
/** The arbiter cut the procedure's running item: only it stops, and the procedure goes on (true); false when none runs. */
export function cutProcedureItem(taskId: string): boolean {
  const item = states.get(taskId)?.item;
  if (!item || item.controller.signal.aborted) return false;
  item.controller.abort('cut');
  return true;
}

/**
 * What a step hands the executor's procedures: whether a message came into the task's inbox after the step began (the step's own are
 * not new), and when the task began.
 */
export function minecraftProcedureStepParts(runtime: Pick<TaskRuntime, 'pendingMessageIds'>, step: TaskStep): { pending(): boolean; taskStartedAt?: number } {
  const started = Date.parse(step.snapshot.task.createdAt);
  const pending = () => {
    try {
      return (runtime.pendingMessageIds?.(step.scopeKey, step.taskId) ?? []).some(id => !step.messageIds.includes(id));
    } catch { return false; }
  };
  return { pending, ...(Number.isFinite(started) ? { taskStartedAt: started } : {}) };
}

/** The decision's line that names the procedure of the step now, when there is one (the planner does what it is shown, run 19). */
export function minecraftProcedureHint(observation: BodyObservation | null): string[] {
  if (!observation) return [];
  const now = milestoneNow(minecraftProcedureFacts(observation).milestone).now.name;
  return PROCEDURE_MILESTONES.includes(now) ? [`手順: ${MINECRAFT_PROCEDURE_TOOL}（milestone=${now}、through=先の節目）で「${now}」から先をまとめて流せる`] : [];
}

type Call = { operationId: string; input: unknown; signal: AbortSignal };
export interface ProcedureRunParts {
  taskId: string;
  observe(): BodyObservation | null;
  /** One body call by the executor (its fillers and resume included), under the call's lease. */
  execute(item: { name: string; input: unknown; operationId: string; signal: AbortSignal }): Promise<ToolResult>;
  offered(name: string): boolean;
  /** The body's tool that casts obsidian many at a time, when its catalog has one. */
  batchObsidian?: string | null;
  pending?(): boolean;
  taskStartedAt?: number;
  now(): number;
}

function readInput(input: unknown): { from: string; through: string | null } | null {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
  if (!value || Object.keys(value).some(key => key !== 'milestone' && key !== 'through')) return null;
  if (typeof value.milestone !== 'string' || !PROCEDURE_MILESTONES.includes(value.milestone)) return null;
  const named = value.through !== undefined && value.through !== null;
  if (named && (typeof value.through !== 'string' || !PROCEDURE_MILESTONES.includes(value.through))) return null;
  const through = typeof value.through === 'string' ? value.through : null;
  return through && PROCEDURE_MILESTONES.indexOf(through) < PROCEDURE_MILESTONES.indexOf(value.milestone) ? null : { from: value.milestone, through };
}

/** One item and its chain, each a body call with an operation id of its own; a cut of the arbiter ends the item as failed `cut`. */
async function runItem(parts: ProcedureRunParts, call: Call, state: TaskProcedureState, item: MinecraftWorkItem, index: number): Promise<ProcedureItemResult> {
  let result: ProcedureItemResult = { ok: false, text: '', failure: 'not_offered' };
  let link = 0;
  for (let next: MinecraftWorkItem | null = item; next; link += 1) {
    if (!parts.offered(next.tool)) return { ok: false, text: '', failure: 'not_offered' };
    const controller = new AbortController();
    const operationId = `${call.operationId}:p${index}.${link}`;
    state.item = { name: next.tool, input: next.input, operationId, controller };
    try {
      const told = await parts.execute({ name: next.tool, input: next.input, operationId, signal: AbortSignal.any([call.signal, controller.signal]) });
      // The body's own kind when it named one (`target_not_found`), else the tool's.
      result = { ok: told.ok, text: told.text, failure: told.ok ? null : told.bodyFailure ?? told.failure ?? 'failed' };
    } catch (error) {
      if (call.signal.aborted || !controller.signal.aborted) throw error;
      result = { ok: false, text: '', failure: 'cut' };
    } finally { state.item = null; }
    if (controller.signal.aborted && !call.signal.aborted && !result.ok) result = { ...result, failure: 'cut' };
    next = result.ok && next.then ? next.then(result.text) : null;
  }
  return result;
}

function resultText(chainText: string, run: ProcedureRunResult, facts: MinecraftProcedureFacts): string {
  const now = milestoneNow(facts.milestone).now.name;
  return [`手順 ${chainText}`, ...procedureRunLines(run), `今の節目: ${now}`].join('\n');
}

/** `mc.run-procedure`: the chain from the milestone named, run through; its result in fixed words. */
export async function runMinecraftProcedure(parts: ProcedureRunParts, call: Call): Promise<ToolResult> {
  const asked = readInput(call.input);
  if (!asked) {
    return { ok: false, text: `milestone は次のどれか（through はそれ以降）: ${PROCEDURE_MILESTONES.join('・')}`, failure: 'invalid_input', retryable: false };
  }
  const state = stateOf(parts.taskId);
  const chain = minecraftProcedureChain(asked.from, asked.through, { store: state.store, batchObsidian: parts.batchObsidian ?? null });
  const facts = () => minecraftProcedureFacts(parts.observe());
  const run = await runProcedures(chain, {
    facts, now: parts.now, signal: call.signal, upkeep: minecraftUpkeep, final: finalFailure,
    stopWhy: (current, at) => minecraftStopWhy(current, at.procedure, { ...parts, toldLate: state.toldLate }),
    run: (item, step) => runItem(parts, call, state, item, step.index),
  });
  const text = resultText(asked.through ? `「${asked.from}」→「${asked.through}」` : `「${asked.from}」`, run, facts());
  const ok = run.outcome === 'done' || run.outcome === 'stopped' || run.outcome === 'limit';
  return ok ? { ok, text, retryable: false } : { ok, text, failure: 'failed', retryable: run.outcome === 'failed' };
}
