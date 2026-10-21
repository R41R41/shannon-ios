import type { BodyObservation, BodyPlanView, BodyValue } from '../../contracts/bodyControlContract.js';
import type { FcaBodyLifecycle } from '../../mind/action/fca/fcaPorts.js';
import { createFoodTrend, llmcPlanTokens, minecraftLlmcLive, type FoodTrend } from './minecraftLlmcLive.js';

/**
 * What a Minecraft task's body lifecycle takes in the LLM-centric mode (`createMinecraftTaskBody`, `llmc`): the task's plan (for the
 * context of every command and reflex session, `BodyTaskContext.plan`) and its path's size (the live state's room), and the per-task
 * events and food trend kept across steps.
 */
export interface LlmcBodyParts {
  plan(): BodyPlanView | undefined;
  /** The plan's path as the decision reads it (its tokens count against the live state's bound). */
  planView(): object | null;
}

interface TaskEvents { lines: Array<{ seq: number; line: string }>; seq: number; read: number; arrival: number | null; failed: boolean; trend: FoodTrend }
const tasks = new Map<string, TaskEvents>();
function eventsOf(taskId: string): TaskEvents {
  let state = tasks.get(taskId);
  if (!state) {
    state = { lines: [], seq: 0, read: 0, arrival: null, failed: false, trend: createFoodTrend() };
    tasks.set(taskId, state);
    if (tasks.size > 32) tasks.delete(tasks.keys().next().value as string);
  }
  return state;
}

/**
 * What happened to the body since the task's last decision that no tool result says (a reflex that took the body, a death, a login, a new
 * dimension): told in the live state (`events`) once, and the reason a recall runs (design 2.3: recall only on an event).
 */
export function createLlmcEvents(taskId: string) {
  const state = eventsOf(taskId);
  let shown: string[] = [];
  const note = (line: string) => {
    state.seq += 1;
    state.lines.push({ seq: state.seq, line: line.slice(0, 200) });
    if (state.lines.length > 24) state.lines.splice(0, state.lines.length - 24);
  };
  return {
    note,
    /** A body that arrived (login, respawn, reconnection, another dimension) since the last look, by its arrival time and kind. */
    arrival(at: number | null, kind: string | null) {
      if (at === null || at === state.arrival) return;
      const first = state.arrival === null;
      state.arrival = at;
      if (!first || kind === 'death') note(kind === 'death' ? '死んでリスポーンした（持ち物を落とした所へ戻るか決める）' : `体が着いた: ${kind ?? '不明'}`);
    },
    /** A tool result: a reflex that cut it is an event; a failure makes the next decision worth a recall. */
    result(name: string, ok: boolean, bodyReflex: boolean) {
      if (bodyReflex) note(`反射が ${name} を止めた`);
      state.failed = !ok;
    },
    /** At a decision's context: the events since the last one, now read. */
    take(): string[] {
      shown = state.lines.filter(item => item.seq > state.read).map(item => item.line);
      state.read = state.seq;
      return shown;
    },
    shown: () => shown,
    wanted: () => shown.length > 0 || state.failed,
    trend: state.trend,
  };
}
export type LlmcEvents = ReturnType<typeof createLlmcEvents>;

/** The live body of an LLM-centric decision: the map-first state, bounded beside the plan's path. */
export function llmcTransient(llmc: LlmcBodyParts, events: LlmcEvents, observation: BodyObservation | null,
  elapsedMinutes: number | null): Record<string, unknown> {
  const plan = llmc.planView();
  const world = observation?.state.world as Record<string, unknown> | undefined;
  const jobs = world && (world.jobs ?? world.activeFurnaces) as BodyValue | undefined;
  return minecraftLlmcLive({ observation, elapsedMinutes, trend: events.trend, events: events.shown(), ...(jobs ? { jobs } : {}) },
    llmcPlanTokens(plan));
}

/**
 * A body task's lifecycle in the mode: its live state is the map-first one (`llmcTransient`), the events since the last decision are read
 * at each context (an arrival of the body; a result a reflex cut or that failed), and a recall is wanted only after one (design 2.3).
 * Everything else is the body's as it was.
 */
export function withLlmcBody(body: FcaBodyLifecycle, parts: { llmc: LlmcBodyParts; taskId: string; createdAt: string;
  observe(): BodyObservation | null; arrival(): { at: number | null; kind: string | null }; now?: () => number }): FcaBodyLifecycle {
  const events = createLlmcEvents(parts.taskId), now = parts.now ?? Date.now, began = Date.parse(parts.createdAt);
  let observation: BodyObservation | null = null;
  return { ...body,
    context() {
      const value = body.context();
      observation = parts.observe();
      const arrival = parts.arrival();
      events.arrival(arrival.at, arrival.kind);
      events.take();
      return value;
    },
    transient: () => llmcTransient(parts.llmc, events, observation, Number.isFinite(began) ? Math.max(0, (now() - began) / 60_000) : null),
    recallWanted: () => events.wanted(),
    noteResult(call, result, durationMilliseconds) {
      body.noteResult?.(call, result, durationMilliseconds);
      events.result(call.name, result.ok, result.bodyReflex === true);
    },
  };
}

/** For tests: no task holds events. */
export function forgetLlmcEvents(): void { tasks.clear(); }
