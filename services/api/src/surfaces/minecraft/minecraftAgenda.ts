import { WorkAgenda, agendaLines, type WorkAgendaSource, type WorkingNeed } from '@shannon/mind';
import type { FcaExternalTools } from '../../mind/action/fca/fcaPorts.js';
import type { ToolResult } from '../../mind/tools/shannonTools.js';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { minecraftFurnaceRemaining, minecraftWaitingCall } from './minecraftWorkingArbiter.js';
import { afterCallWork, fillable, nextFiller, takeNeed, type MinecraftWorkItem } from './minecraftFillers.js';
import { MINECRAFT_PROCEDURE_DEFINITION, runMinecraftProcedure } from './minecraftProcedureTool.js';
import { MINECRAFT_PROCEDURE_TOOL } from './minecraftProcedures.js';

/**
 * The executor of a Minecraft task (session mb-arch; `SHANNON_MINECRAFT_AGENDA`). It wraps the body's tools, inside the step and its
 * lease like any call, and does around each call she asks for what the moment wants:
 *
 * - **While she waits** (a timer, a furnace she waits on): the small work that fits the time left first (`nextFiller`), then the wait
 *   for only what is still left. A timer fully used by that work is not waited at all.
 * - **A need that comes into reach during the wait itself** (the arbiter's verdict, `preemptForNeed`): the wait is stopped, the need
 *   taken, and the wait taken up again for what is left (resume), all in the same call.
 * - **After the decision's last call**: one short detour for a thing worth it right there (`afterCallWork`; a food animal only if Jev
 *   says now), by day and with nothing hostile near, never after a shelter or a way out.
 *
 * The call's result says all of it in fixed words, and the next decision is told it again (`minecraftAgendaLines`): what was done for
 * her, never a suggestion (run 19: she does what a hint says). A failed item says only how it failed.
 */
export interface MinecraftAgendaJudge {
  /** Whether to take this need now: Jev's choice, or the rule's answer when Jev is away. */
  takeNow(need: WorkItemNeed, observation: BodyObservation | null, signal: AbortSignal): Promise<boolean>;
}
export interface WorkItemNeed { kind: string; name: string; distance: number | null }

/** How long a work key is not done again (the same ore, the same bed): a detour that failed is not tried at once again. */
const RECENT_MS = 180_000;
/** Work done for one call at most: a wait is filled, not lived in. */
const MAX_EXTRA = 4;
/** A timer with this little left is not waited after its small work. */
const WAIT_LEFT_MS = 2_000;

interface TaskState {
  agenda: WorkAgenda;
  recent: Map<string, number>;
  /** How far the task's decisions have read the agenda. */
  cursor: number;
  /** The wait running now, which a fresh need may stop (`preemptForNeed`). */
  preempt: { controller: AbortController; need: WorkingNeed | null } | null;
  /** A wait of hers is being handled (its small work, then the wait), with room for more work. */
  inWait: { room(): boolean } | null;
}
const states = new Map<string, TaskState>();
function stateOf(taskId: string): TaskState {
  let state = states.get(taskId);
  if (!state) {
    state = { agenda: new WorkAgenda(), recent: new Map(), cursor: 0, preempt: null, inWait: null };
    states.set(taskId, state);
    if (states.size > 32) states.delete(states.keys().next().value as string);
  }
  return state;
}

/**
 * The arbiter saw a need come into reach during a wait of this task. True when the executor takes it: during the small work before the
 * wait (a need its fillers take, with room left), or by stopping the wait itself to take the need and resume. Then nothing is cut.
 */
export function preemptForNeed(taskId: string, need: WorkingNeed): boolean {
  const state = states.get(taskId);
  if (!state?.inWait?.room()) return false;
  const preempt = state.preempt;
  if (!preempt) return fillable(need);
  if (preempt.controller.signal.aborted) return false;
  preempt.need = need;
  preempt.controller.abort('need');
  return true;
}

/** What was done for her since the task's last decision, a line each (for the decision's `working.agenda`). */
export function minecraftAgendaLines(taskId: string): string[] {
  const state = states.get(taskId);
  if (!state) return [];
  const since = state.agenda.since(state.cursor);
  state.cursor = since.cursor;
  return agendaLines(since.entries);
}

/** Whether the executor began anything for this task after `at` (a decision asked before it no longer fits the world). */
export function agendaActedSince(taskId: string, at: number): boolean {
  const state = states.get(taskId);
  return !!state && state.agenda.since(0).entries.some(entry => entry.startedAt >= at);
}

type Call = Parameters<FcaExternalTools['execute']>[0];
interface Parts {
  on: boolean; taskId: string; observe(): BodyObservation | null; judge?: MinecraftAgendaJudge; now?: () => number; log?(line: string): void;
  /** A message came into the task's inbox after this step began (a procedure hands the turn back for it). */
  pending?(): boolean;
  /** When the task began (ms): the procedures' time budget counts from it. */
  taskStartedAt?: number;
}

const short = (text: string) => text.replace(/\s+/gu, ' ').slice(0, 120);
const LABEL: Readonly<Record<WorkAgendaSource, string>> = { planner: '', filler: '待つ間に', interrupt: '割り込み', resume: '再開', cut: '切った',
  procedure: '手順' };
const WAIT_FILLED: ToolResult = { ok: true, text: '待つ時間を、待つ間の仕事に使った', retryable: false };
const told = (result: ToolResult) => result.ok ? `→ ${short(result.text)}` : `→ できなかった（${result.failure ?? 'failed'}）`;

export function withMinecraftAgenda(tools: FcaExternalTools, parts: Parts): FcaExternalTools {
  if (!parts.on) return tools;
  const readOnly = (name: string) => tools.definitions.find(tool => tool.name === name)?.effect === 'read';
  const body = tools.definitions.some(tool => tool.name.startsWith('mc.'));
  const one = (call: Call) => !call.name.startsWith('mc.') || readOnly(call.name) ? tools.execute(call) : executeWithAgenda(tools, parts, call);
  return { ...tools, definitions: body ? [...tools.definitions, MINECRAFT_PROCEDURE_DEFINITION] : tools.definitions,
    execute: call => call.name === MINECRAFT_PROCEDURE_TOOL && body ? procedure(tools, parts, call, one) : one(call) };
}

/** The body's own tool that casts obsidian many at a time, when its catalog offers one (mb-body). */
const batchObsidianOf = (tools: FcaExternalTools) => tools.definitions.find(tool => /^mc\.[a-z-]*obsidian[a-z-]*$/u.test(tool.name))?.name ?? null;

/** `mc.run-procedure`: each item a call of the executor's (its waits filled, a detour after it), told in the agenda as the procedure's. */
function procedure(tools: FcaExternalTools, parts: Parts, call: Call, one: (call: Call) => Promise<ToolResult>): Promise<ToolResult> {
  const now = parts.now ?? Date.now;
  const state = stateOf(parts.taskId);
  const execute = async (item: { name: string; input: unknown; operationId: string; signal: AbortSignal }) => {
    const seq = state.agenda.begin('procedure', item.name, '手順', now());
    let result: ToolResult = { ok: false, text: '', failure: 'failed', retryable: true };
    try {
      result = await one({ ...call, ...item, last: true });
      return result;
    } finally { state.agenda.end(seq, result.ok, result.ok ? short(result.text) : result.failure ?? 'failed', now()); }
  };
  log(parts, `Shannon Minecraft procedure task=${parts.taskId} input=${JSON.stringify(call.input).slice(0, 80)}`);
  return runMinecraftProcedure({ taskId: parts.taskId, observe: parts.observe, execute, now,
    offered: name => tools.definitions.some(tool => tool.name === name), batchObsidian: batchObsidianOf(tools),
    ...(parts.pending ? { pending: parts.pending } : {}), ...(parts.taskStartedAt !== undefined ? { taskStartedAt: parts.taskStartedAt } : {}) }, call);
}

/** Whether an error of a sub-command must end the call (an outcome not known, a stop); any other is told as a failed item. */
function fatal(error: unknown, call: Call): boolean {
  return call.signal.aborted || (error instanceof Error && (/OUTCOME_UNKNOWN|LEASE|STOP|WITHHELD/u.test(error.message) || error.name === 'AbortError'));
}

/** The executor's items for one call: run under the call's signal and lease, each with an operation id of its own, told as lines. */
function workRunner(tools: FcaExternalTools, state: TaskState, call: Call, now: () => number) {
  const lines: string[] = [];
  let extra = 0;
  const offered = (name: string) => tools.definitions.some(tool => tool.name === name);
  const recent = () => new Set([...state.recent].filter(([, at]) => now() - at < RECENT_MS).map(([key]) => key));
  const one = async (item: MinecraftWorkItem, source: WorkAgendaSource): Promise<ToolResult> => {
    state.recent.set(item.key, now());
    extra += 1;
    const seq = state.agenda.begin(source, item.tool, item.why, now());
    let result: ToolResult;
    try {
      result = await tools.execute({ ...call, operationId: `${call.operationId}:${source}${extra}`, name: item.tool, input: item.input });
    } catch (error) {
      if (fatal(error, call)) throw error;
      result = { ok: false, text: '', failure: 'failed', retryable: true };
    }
    state.agenda.end(seq, result.ok, result.ok ? short(result.text) : result.failure ?? 'failed', now());
    lines.push(`${LABEL[source]}: ${item.tool}（${item.why}）${told(result)}`);
    return result;
  };
  /** An item and its chain, started only when the whole chain fits; null when nothing ran. */
  const run = async (item: MinecraftWorkItem | null, source: WorkAgendaSource): Promise<ToolResult | null> => {
    if (!item || extra + (item.chain ?? 1) > MAX_EXTRA || call.signal.aborted) return null;
    let result: ToolResult | null = null;
    for (let next: MinecraftWorkItem | null = item; next && !call.signal.aborted && offered(next.tool);) {
      result = await one(next, source);
      next = result.ok && next.then ? next.then(result.text) : null;
    }
    return result;
  };
  return { run, lines, recent, room: () => extra < MAX_EXTRA, count: () => extra };
}
type Runner = ReturnType<typeof workRunner>;

async function executeWithAgenda(tools: FcaExternalTools, parts: Parts, call: Call): Promise<ToolResult> {
  const now = parts.now ?? Date.now;
  const state = stateOf(parts.taskId);
  const work = workRunner(tools, state, call, now);
  const waiting = minecraftWaitingCall(call.name, call.input);
  state.inWait = waiting ? { room: work.room } : null;
  try {
    const left = waiting ? await fillWait(work, parts, call, now) : null;
    const asked = left === null ? call : withWait(call, left);
    const result = asked ? await callWithResume(tools, state, work, asked, waiting, now) : WAIT_FILLED;
    if (call.last && !call.signal.aborted && work.room()) await detourAfter(work, parts, call, result);
    if (work.lines.length) log(parts, `Shannon Minecraft agenda task=${parts.taskId} tool=${call.name} extra=${work.count()} skipWait=${!asked}`);
    return work.lines.length ? withLines(result, work.lines) : result;
  } finally { state.inWait = null; }
}

function log(parts: Parts, line: string): void {
  try {
    parts.log?.(line);
  } catch { /* logging never fails a step */ }
}

/** The result with the executor's lines before its retry hint (which stays the text's last part). */
function withLines(result: ToolResult, lines: readonly string[]): ToolResult {
  const at = result.text.lastIndexOf('［再試行の目安');
  const text = at < 0 ? `${result.text}\n${lines.join('\n')}` : `${result.text.slice(0, at)}\n${lines.join('\n')}\n${result.text.slice(at)}`;
  return { ...result, text };
}

/** A timer asked for what is left of it (null: nothing is left, it is not waited); any other call as it is. */
function withWait(call: Call, leftMs: number): Call | null {
  if (call.name !== 'mc.wait-time') return call;
  if (leftMs <= WAIT_LEFT_MS) return null;
  return { ...call, input: { ...(call.input as Record<string, unknown>), milliseconds: Math.round(leftMs) } };
}

/** The small work that fits a wait's time left; how long the wait still has after it (null: not known). */
async function fillWait(work: Runner, parts: Parts, call: Call, now: () => number): Promise<number | null> {
  const started = now();
  const total = call.name === 'mc.wait-time' ? waitMs(call) : minecraftFurnaceRemaining(parts.observe(), call.input);
  if (total === null) return null;
  const waitingCell = waitCell(call);
  while (work.room() && !call.signal.aborted) {
    const before = work.count();
    await work.run(nextFiller(parts.observe(), { remainingMs: total - (now() - started), recent: work.recent(), waitingCell }), 'filler');
    // Nothing ran (nothing fits, or its tool is not offered): the wait itself now.
    if (work.count() === before) break;
  }
  return total - (now() - started);
}

/** The call she asked for; a wait stopped for a need that came into reach is followed by that need and then the wait again. */
async function callWithResume(tools: FcaExternalTools, state: TaskState, work: Runner, call: Call, waiting: boolean, now: () => number): Promise<ToolResult> {
  const slot: NonNullable<TaskState['preempt']> = { controller: new AbortController(), need: null };
  state.preempt = waiting ? slot : null;
  const started = now();
  let result: ToolResult;
  try {
    result = await tools.execute({ ...call, signal: AbortSignal.any([call.signal, slot.controller.signal]) });
  } finally { state.preempt = null; }
  const need = waiting && slot.controller.signal.aborted && !call.signal.aborted ? slot.need : null;
  if (!need) return result;
  await work.run(takeNeed(need), 'interrupt');
  const again = call.name === 'mc.wait-time' ? withWait(call, (waitMs(call) ?? 0) - (now() - started)) : call;
  if (!again || call.signal.aborted) return again ? result : WAIT_FILLED;
  const seq = state.agenda.begin('resume', call.name, '割り込みの後で元の手を続ける', now());
  result = await tools.execute({ ...again, operationId: `${call.operationId}:resume` });
  state.agenda.end(seq, result.ok, result.ok ? short(result.text) : result.failure ?? 'failed', now());
  work.lines.push(`再開: ${call.name}${told(result)}`);
  return result;
}

/** One detour after the decision's last call, when one is worth it right there (a food animal only when Jev says now). */
async function detourAfter(work: Runner, parts: Parts, call: Call, result: ToolResult): Promise<void> {
  const found = afterCallWork(parts.observe(), { call, ok: result.ok, recent: work.recent() });
  if (!found) return;
  if (found.ask && parts.judge) {
    const need = { kind: found.item.key.split('@')[0]!, name: String(found.item.input.entityName ?? found.item.input.blockName ?? ''), distance: null };
    if (!await parts.judge.takeNow(need, parts.observe(), call.signal).catch(() => false)) return;
  }
  await work.run(found.item, 'interrupt');
}

function waitMs(call: Call): number | null {
  const value = call.input && typeof call.input === 'object' ? Number((call.input as { milliseconds?: unknown }).milliseconds) : NaN;
  return Number.isFinite(value) ? value : null;
}

function waitCell(call: Call): string | null {
  const input = call.input && typeof call.input === 'object' ? call.input as Record<string, unknown> : null;
  if (!input || call.name !== 'mc.withdraw-from-furnace' || ![input.x, input.y, input.z].every(value => typeof value === 'number')) return null;
  return `${input.x},${input.y},${input.z}`;
}
