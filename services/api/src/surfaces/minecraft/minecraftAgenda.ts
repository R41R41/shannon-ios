import { WorkAgenda, agendaLines, type WorkAgendaSource, type WorkingNeed } from '@shannon/mind';
import type { FcaExternalTools } from '../../mind/action/fca/fcaPorts.js';
import type { ToolResult } from '../../mind/tools/shannonTools.js';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { minecraftFurnaceRemaining, minecraftWaitingCall } from './minecraftWorkingArbiter.js';
import { afterCallWork, nextFiller, takeNeed, type MinecraftWorkItem } from './minecraftFillers.js';

/**
 * The executor of a Minecraft task (session mb-arch; `SHANNON_MINECRAFT_AGENDA`). It wraps the body's tools, inside the step and its
 * lease like any call, and does around each call she asks for what the moment wants:
 *
 * - **While she waits** (a timer, a furnace she waits on): the small work that fits the time left first (`nextFiller`), then the wait
 *   for what is still left. A timer fully used by that work is not waited at all.
 * - **A need that comes into reach during the wait itself** (the arbiter's verdict, `preemptForNeed`): the wait is stopped, the need
 *   taken, and the wait taken up again (resume), all in the same call.
 * - **After the call**: one short detour for a thing worth it right there (`afterCallWork`; a food animal only if Jev says now).
 *
 * The call's result says all of it in fixed words, and the next decision is told it again (`minecraftAgendaLines`): what was done for
 * her, never a suggestion (run 19: she does what a hint says).
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

interface TaskState {
  agenda: WorkAgenda;
  recent: Map<string, number>;
  /** How far the task's decisions have read the agenda. */
  cursor: number;
  /** The wait running now, which a fresh need may stop (`preemptForNeed`). */
  preempt: { controller: AbortController; need: WorkingNeed | null } | null;
  /** A wait of hers is being handled (its small work, then the wait): a need that comes now is the executor's, never a cut. */
  inWait: boolean;
}
const states = new Map<string, TaskState>();
function stateOf(taskId: string): TaskState {
  let state = states.get(taskId);
  if (!state) {
    state = { agenda: new WorkAgenda(), recent: new Map(), cursor: 0, preempt: null, inWait: false };
    states.set(taskId, state);
    if (states.size > 32) states.delete(states.keys().next().value as string);
  }
  return state;
}

/**
 * The arbiter saw a need come into reach during a wait of this task. True when the executor takes it: during the small work before
 * the wait (the fillers take what is near), or by stopping the wait itself to take the need and resume. Then nothing is cut.
 */
export function preemptForNeed(taskId: string, need: WorkingNeed): boolean {
  const state = states.get(taskId);
  const preempt = state?.preempt;
  if (state?.inWait && !preempt) return true;
  if (!preempt || preempt.controller.signal.aborted) return false;
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

type Call = Parameters<FcaExternalTools['execute']>[0];
interface Parts { on: boolean; taskId: string; observe(): BodyObservation | null; judge?: MinecraftAgendaJudge; now?: () => number; log?(line: string): void }

const short = (text: string) => text.replace(/\s+/gu, ' ').slice(0, 120);
const LABEL: Readonly<Record<WorkAgendaSource, string>> = { planner: '', filler: '待つ間に', interrupt: '割り込み', resume: '再開', cut: '切った' };
const WAIT_FILLED: ToolResult = { ok: true, text: '待つ時間を、待つ間の仕事に使った', retryable: false };

export function withMinecraftAgenda(tools: FcaExternalTools, parts: Parts): FcaExternalTools {
  if (!parts.on) return tools;
  const readOnly = (name: string) => tools.definitions.find(tool => tool.name === name)?.effect === 'read';
  return { ...tools, execute: call => !call.name.startsWith('mc.') || readOnly(call.name) ? tools.execute(call) : executeWithAgenda(tools, parts, call) };
}

/** The executor's items for one call: run under the call's signal and lease, each with an operation id of its own, told as lines. */
function workRunner(tools: FcaExternalTools, state: TaskState, call: Call, now: () => number) {
  const lines: string[] = [];
  let extra = 0;
  const offered = (name: string) => tools.definitions.some(tool => tool.name === name);
  const recent = () => new Set([...state.recent].filter(([, at]) => now() - at < RECENT_MS).map(([key]) => key));
  const run = async (item: MinecraftWorkItem | null, source: WorkAgendaSource): Promise<ToolResult | null> => {
    let result: ToolResult | null = null;
    for (let next = item; next && extra < MAX_EXTRA && !call.signal.aborted && offered(next.tool);) {
      state.recent.set(next.key, now());
      extra += 1;
      const seq = state.agenda.begin(source, next.tool, next.why, now());
      result = await tools.execute({ ...call, operationId: `${call.operationId}:${source}${extra}`, name: next.tool, input: next.input });
      state.agenda.end(seq, result.ok, short(result.text), now());
      lines.push(`${LABEL[source]}: ${next.tool}（${next.why}）${result.ok ? '→ ' : '→ できなかった: '}${short(result.text)}`);
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
  state.inWait = waiting;
  try {
    const skipWait = waiting && await fillWait(work, parts, call, now);
    const result = skipWait ? WAIT_FILLED : await callWithResume(tools, state, work, call, waiting, now);
    if (!call.signal.aborted && work.room()) await detourAfter(work, parts, call, result);
    if (work.lines.length) {
      try {
        parts.log?.(`Shannon Minecraft agenda task=${parts.taskId} tool=${call.name} extra=${work.count()} skipWait=${skipWait}`);
      } catch { /* logging never fails a step */ }
    }
    return work.lines.length ? { ...result, text: `${result.text}\n${work.lines.join('\n')}` } : result;
  } finally { state.inWait = false; }
}

/** The small work that fits a wait's time left; true when a timer's whole time went to it (then it is not waited). */
async function fillWait(work: Runner, parts: Parts, call: Call, now: () => number): Promise<boolean> {
  const started = now();
  const total = call.name === 'mc.wait-time' ? waitMs(call) : minecraftFurnaceRemaining(parts.observe(), call.input);
  if (total === null) return false;
  const waitingCell = waitCell(call);
  while (work.room() && !call.signal.aborted) {
    const item = nextFiller(parts.observe(), { remainingMs: total - (now() - started), recent: work.recent(), waitingCell });
    if (!item) break;
    await work.run(item, 'filler');
  }
  return call.name === 'mc.wait-time' && work.count() > 0 && now() - started >= total - 2_000;
}

/** The call she asked for; a wait stopped for a need that came into reach is followed by that need and then the wait again. */
async function callWithResume(tools: FcaExternalTools, state: TaskState, work: Runner, call: Call, waiting: boolean, now: () => number): Promise<ToolResult> {
  const slot: NonNullable<TaskState['preempt']> = { controller: new AbortController(), need: null };
  state.preempt = waiting ? slot : null;
  let result: ToolResult;
  try {
    result = await tools.execute({ ...call, signal: AbortSignal.any([call.signal, slot.controller.signal]) });
  } finally { state.preempt = null; }
  const need = waiting && slot.controller.signal.aborted && !call.signal.aborted ? slot.need : null;
  if (!need) return result;
  await work.run(takeNeed(need), 'interrupt');
  if (call.signal.aborted) return result;
  const seq = state.agenda.begin('resume', call.name, '割り込みの後で元の手を続ける', now());
  result = await tools.execute({ ...call, operationId: `${call.operationId}:resume` });
  state.agenda.end(seq, result.ok, short(result.text), now());
  work.lines.push(`再開: ${call.name}${result.ok ? '→ ' : '→ できなかった: '}${short(result.text)}`);
  return result;
}

/** One detour after the call, when one is worth it right there (a food animal only when Jev says now). */
async function detourAfter(work: Runner, parts: Parts, call: Call, result: ToolResult): Promise<void> {
  const found = afterCallWork(parts.observe(), { call, ok: result.ok, recent: work.recent() });
  if (!found) return;
  if (found.ask && parts.judge) {
    const need = { kind: found.item.key.split('@')[0]!, name: String(found.item.input.entityName ?? found.item.input.blockName ?? ''), distance: null };
    if (!await parts.judge.takeNow(need, parts.observe(), call.signal).catch(() => true)) return;
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
