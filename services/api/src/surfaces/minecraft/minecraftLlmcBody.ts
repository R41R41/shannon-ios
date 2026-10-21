import type { BodyObservation, BodyPlanView, BodyValue } from '../../contracts/bodyControlContract.js';
import type { FcaBodyInvestigation, FcaBodyLifecycle } from '../../mind/action/fca/fcaPorts.js';
import { MC_ACT_TOOL } from '../../contracts/minecraftActContract.js';
import type { ProbeInput } from '../../contracts/minecraftProbeContract.js';
import { createFoodTrend, llmcPlanTokens, minecraftLlmcLive, type FoodTrend } from './minecraftLlmcLive.js';
import { llmcStoredResult } from './minecraftLlmc.js';
import { createSurpriseWatch, LLMC_PROBE, runInvestigation, scanLines, stepProbes, surpriseFrame } from './minecraftLlmcProbe.js';

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

interface TaskEvents {
  lines: Array<{ seq: number; line: string }>; seq: number; read: number; arrival: number | null; failed: boolean; trend: FoodTrend;
  /** r3: the whole texts of results the history keeps short, until the next decision shows them. */
  pending: string[];
  /** r3: why the last result makes the next step urgent (a reflex or a hostile cut the act), or null. */
  cut: string | null;
  /** r3: her health at the last decision, for what a fall or a blast took since. */
  health: number | null;
}
const tasks = new Map<string, TaskEvents>();
function eventsOf(taskId: string): TaskEvents {
  let state = tasks.get(taskId);
  if (!state) {
    state = { lines: [], seq: 0, read: 0, arrival: null, failed: false, trend: createFoodTrend(), pending: [], cut: null, health: null };
    tasks.set(taskId, state);
    if (tasks.size > 32) tasks.delete(tasks.keys().next().value as string);
  }
  return state;
}

/** A hostile this near makes a step urgent (a creeper a little farther: its blast reaches about 7 m). */
export const LLMC_URGENT_NEAR_METERS = 8;
const CREEPER_URGENT_METERS = 10;
/** Health at or below this with a hostile within 16 m makes a step urgent (the body's own flight starts at 8). */
const LOW_HEALTH = 8;

/**
 * Why a step is urgent now, or none (r3; run 27: the step after a creeper stopped her act at 3.9 m took 12.8 s, and the blast came
 * first): a hostile within 8 m (a creeper within 10), health 8 or less beside a hostile within 16, and the last act cut by a reflex or by a
 * hostile (its `stopIf.hostileWithin`, or the head's urgent cut).
 */
export function urgentReasons(observation: BodyObservation | null, cut: string | null): string[] {
  const world = (observation?.state.world ?? {}) as { nearbyThreats?: unknown; health?: unknown };
  const threats = (Array.isArray(world.nearbyThreats) ? world.nearbyThreats as Array<Record<string, unknown>> : [])
    .flatMap(item => typeof item?.name === 'string' && typeof item.distance === 'number' && Number.isFinite(item.distance)
      ? [{ name: item.name, distance: item.distance }] : []).sort((left, right) => left.distance - right.distance);
  const reasons: string[] = [];
  const near = threats.find(item => item.distance <= (item.name === 'creeper' ? CREEPER_URGENT_METERS : LLMC_URGENT_NEAR_METERS));
  if (near) reasons.push(`${near.name} ${near.distance.toFixed(1)}m${near.name === 'creeper' ? '（爆発は約7m まで届く）' : ''}`);
  const health = typeof world.health === 'number' && Number.isFinite(world.health) ? world.health : null;
  if (health !== null && health <= LOW_HEALTH && threats.some(item => item.distance <= 16)) reasons.push(`体力 ${Math.round(health * 10) / 10} で敵が近い`);
  if (cut) reasons.push(cut);
  return reasons;
}
/** Why a result makes the next step urgent: a reflex or a hostile cut the act (r3). */
function cutOf(text: string, bodyReflex: boolean): string | null {
  if (/急ぎ: .+ が近づいたので act を止めた/u.test(text)) return '前の act は敵が近づいて止めた';
  if (bodyReflex) return '前の act は体の反射が止めた';
  return /stopIf: hostileWithin/u.test(text) ? '前の act は stopIf（敵が近い）で止まった' : null;
}

/**
 * What happened to the body since the task's last decision that no tool result says (a reflex that took the body, a death, a login, a new
 * dimension): told in the live state (`events`) once, and the reason a recall runs (design 2.3: recall only on an event).
 */
export function createLlmcEvents(taskId: string) {
  const state = eventsOf(taskId);
  let shown: string[] = [], results: string[] = [], healthLost = 0;
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
    /** A tool result: a reflex that cut it is an event; a failure makes the next decision worth a recall; a cut act makes it urgent. */
    result(name: string, ok: boolean, bodyReflex: boolean, text = '') {
      if (bodyReflex) note(`反射が ${name} を止めた`);
      state.failed = !ok;
      if (name === MC_ACT_TOOL) state.cut = cutOf(text, bodyReflex);
    },
    /** r3: a result's whole text the history keeps short, for the next decision's live state. */
    keep(text: string) {
      state.pending.push(text);
      if (state.pending.length > 6) state.pending.splice(0, state.pending.length - 6);
    },
    /** At a decision's context: the events since the last one, now read, and the results to show once. */
    take(health: number | null = null): string[] {
      shown = state.lines.filter(item => item.seq > state.read).map(item => item.line);
      state.read = state.seq;
      results = state.pending.splice(0);
      healthLost = health !== null && state.health !== null ? Math.max(0, state.health - health) : 0;
      if (health !== null) state.health = health;
      return shown;
    },
    shown: () => shown,
    results: () => results,
    healthLost: () => healthLost,
    /** Why the last result makes the next step urgent, or null. */
    cut: () => state.cut,
    wanted: () => shown.length > 0 || state.failed,
    trend: state.trend,
  };
}
export type LlmcEvents = ReturnType<typeof createLlmcEvents>;

/** The live body of an LLM-centric decision: the map-first state, bounded beside the plan's path. */
export function llmcTransient(llmc: LlmcBodyParts, events: LlmcEvents, observation: BodyObservation | null,
  elapsedMinutes: number | null, urgent: readonly string[] = [],
  r4: { investigation: readonly string[]; scan: readonly string[] } | null = null): Record<string, unknown> {
  const plan = llmc.planView();
  const world = observation?.state.world as Record<string, unknown> | undefined;
  const jobs = world && (world.jobs ?? world.activeFurnaces) as BodyValue | undefined;
  return minecraftLlmcLive({ observation, elapsedMinutes, trend: events.trend, events: events.shown(), ...(jobs ? { jobs } : {}),
    lastResults: events.results(), urgent, healthLost: events.healthLost(),
    ...(r4?.investigation.length ? { investigation: r4.investigation } : {}), ...(r4?.scan.length ? { scan: r4.scan } : {}) }, llmcPlanTokens(plan));
}

/**
 * r4 (SHANNON_MINECRAFT_LLMC_PROBE): what the mode's body takes for its surprises and the body's scan. `probe`: the way to send one probe
 * to the body now (its result text, or null), or null while the body has no `probe`; `planWhere`: the current plan node's place.
 */
export interface LlmcProbeParts {
  probe(): ((input: ProbeInput, index: number) => Promise<string | null>) | null;
  planWhere(): string | null;
}
/** The shown scan's time, by task (a new scan is shown once). */
const scansShown = new Map<string, string>();

/** Her health in a frame, or null. */
const healthOf = (observation: BodyObservation | null): number | null => {
  const value = (observation?.state.world as { health?: unknown } | undefined)?.health;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/**
 * A body task's lifecycle in the mode: its live state is the map-first one (`llmcTransient`), the events since the last decision are read
 * at each context (an arrival of the body; a result a reflex cut or that failed), and a recall is wanted only after one (design 2.3).
 * r3: a long result is kept short in the history and shown whole once (`llmcStoredResult`), and a step is urgent (`urgentReasons`) while a
 * hostile is close or the last act was cut by one or by a reflex. Everything else is the body's as it was.
 */
export function withLlmcBody(body: FcaBodyLifecycle, parts: { llmc: LlmcBodyParts; taskId: string; createdAt: string;
  observe(): BodyObservation | null; arrival(): { at: number | null; kind: string | null }; now?: () => number; log?(line: string): void;
  /** r4: surprises probed before the decision, and the body's scan in the live state. Absent: as r3. */
  r4?: LlmcProbeParts }): FcaBodyLifecycle {
  const events = createLlmcEvents(parts.taskId), now = parts.now ?? Date.now, began = Date.parse(parts.createdAt);
  let observation: BodyObservation | null = null, reasons: string[] = [];
  const r4 = parts.r4, watch = r4 ? createSurpriseWatch(parts.taskId) : null;
  let investigation: string[] = [], scan: string[] = [];
  const say = (line: string) => { try { (parts.log ?? (text => console.info(text)))(line); } catch { /* a log never fails a step */ } };
  return { ...body,
    context() {
      const value = body.context();
      observation = parts.observe();
      const arrival = parts.arrival();
      events.arrival(arrival.at, arrival.kind);
      events.take(healthOf(observation));
      if (r4) {
        // r4: a new scan of the body (a spawn, a portal, a respawn) is shown once.
        const shown = scanLines((observation?.state.world as { scan?: unknown } | undefined)?.scan, scansShown.get(parts.taskId) ?? null);
        scan = shown?.lines ?? [];
        if (shown) {
          scansShown.delete(parts.taskId);
          scansShown.set(parts.taskId, shown.at);
          if (scansShown.size > 32) scansShown.delete(scansShown.keys().next().value as string);
        }
      }
      return value;
    },
    transient: () => llmcTransient(parts.llmc, events, observation, Number.isFinite(began) ? Math.max(0, (now() - began) / 60_000) : null, reasons,
      r4 ? { investigation, scan } : null),
    ...(r4 && watch ? {
      /**
       * r4: before the decision, the surprises since the last one (`createSurpriseWatch`) and their fixed probes, sent at once and waited
       * for `LLMC_PROBE.budgetMs` at most (an urgent step's `urgentBudgetMs`); what came is said first in this decision's live state.
       */
      async investigate(): Promise<FcaBodyInvestigation | null> {
        const seen = parts.observe();
        const frame = surpriseFrame(seen, parts.arrival().at);
        let where: string | null = null;
        try { where = r4.planWhere(); } catch { where = null; }
        const surprises = watch.detect(frame, where);
        investigation = [];
        if (!surprises.length) return null;
        const probes = stepProbes(surprises), urgent = urgentReasons(seen, events.cut()).length > 0;
        let run: ReturnType<LlmcProbeParts['probe']> = null;
        try { run = r4.probe(); } catch { run = null; }
        const done = await runInvestigation({ surprises, probes: run ? probes : [], feet: frame.feet, run,
          budgetMs: urgent ? LLMC_PROBE.urgentBudgetMs : LLMC_PROBE.budgetMs });
        investigation = done.lines;
        const codes = surprises.map(item => item.code);
        const sent = run ? probes.length : 0;
        say(`Shannon Minecraft surprise task=${parts.taskId} surprises=${codes.join(',')} probes=${sent} answered=${done.answered} ms=${done.ms}`);
        return { surprises: codes, probes: sent, answered: done.answered, ms: done.ms };
      },
    } : {}),
    recallWanted: () => events.wanted(),
    urgent() {
      reasons = urgentReasons(parts.observe(), events.cut());
      if (reasons.length) {
        const line = `Shannon Minecraft urgent step task=${parts.taskId} reasons=${reasons.length}`;
        try { (parts.log ?? (text => console.info(text)))(line); } catch { /* a log never fails a step */ }
      }
      return reasons.length > 0;
    },
    storedResult(call, text) {
      const { stored, shown } = llmcStoredResult(call.name, text);
      if (shown) events.keep(shown);
      return stored;
    },
    noteResult(call, result, durationMilliseconds) {
      body.noteResult?.(call, result, durationMilliseconds);
      events.result(call.name, result.ok, result.bodyReflex === true, result.text);
      watch?.noteResult(call.name, result.ok, result.text, call.input);
    },
  };
}

/** For tests: no task holds events. */
export function forgetLlmcEvents(): void {
  tasks.clear();
  scansShown.clear();
}
