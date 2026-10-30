import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { MC_ACT_TOOL } from '../../contracts/minecraftActContract.js';
import { createFoodTrend, type FoodTrend } from './minecraftLlmcLive.js';
import { urgentRange } from './minecraftLlmcUrgent.js';
import { stopFactLines } from './minecraftLlmcFacts.js';
import { sameSpotStops } from './minecraftLlmcStalls.js';
import { nearThreats, THREAT_SIGHT, threatLine, walledOff, type NearThreat, type ThreatSight } from './minecraftLlmcThreat.js';
import { reflexLines } from './minecraftLlmcReflexHold.js';

export interface TaskEvents {
  lines: Array<{ seq: number; line: string }>;
  seq: number;
  read: number;
  arrival: number | null;
  failed: boolean;
  trend: FoodTrend;
  /** r3: the whole texts of results the history keeps short, until the next decision shows them. */
  pending: string[];
  /** r3: why the last result makes the next step urgent (a reflex or a hostile cut the act), or null. */
  cut: string | null;
  /** r3: her health at the last decision, for what a fall or a blast took since. */
  health: number | null;
  /** r7: the last act was stopped by its own stopIf (where it stopped is looked at from the shooters near). */
  stopIf: boolean;
  /** Chapter 8: when the last decision read its context (ms), for the promises' 「直前に」; the stops of the results
   * since (`stopFactsOf`),
   * until the next decision shows them. */
  lastAt: number | null;
  stops: Array<string | (() => string)>;
}

export const tasks = new Map<string, TaskEvents>();

export function eventsOf(taskId: string): TaskEvents {
  let state = tasks.get(taskId);
  if (!state) {
    state = {
      lines: [],
      seq: 0,
      read: 0,
      arrival: null,
      failed: false,
      trend: createFoodTrend(),
      pending: [],
      cut: null,
      health: null,
      stopIf: false,
      lastAt: null,
      stops: [],
    };
    tasks.set(taskId, state);
    if (tasks.size > 32) tasks.delete(tasks.keys().next().value as string);
  }
  return state;
}

/**
 * mb-llmc v2: whether the decision a task's tools are now running was an urgent one (its live state was the short one with the
 * answer line 「手は 3 つまで」): the act preflight's urgent limit (`minecraftLlmcHandGuards.ts`) reads it when the act is sent.
 */
export const urgentDecisions = new Map<string, boolean>();

export function noteUrgentDecision(taskId: string, urgent: boolean): void {
  urgentDecisions.delete(taskId);
  urgentDecisions.set(taskId, urgent);
  if (urgentDecisions.size > 32) urgentDecisions.delete(urgentDecisions.keys().next().value as string);
}

export const urgentDecision = (taskId: string): boolean => urgentDecisions.get(taskId) === true;

/** A hostile this near makes a step urgent (a creeper a little farther: its blast reaches about 7 m). */
export const LLMC_URGENT_NEAR_METERS = 8;

export const CREEPER_URGENT_METERS = 10;

/** Health at or below this with a hostile within 16 m makes a step urgent (the body's own flight starts at 8). */
export const LOW_HEALTH = 8;

/**
 * Why a step is urgent now, or none (r3; run 27: the step after a creeper stopped her act at 3.9 m took 12.8 s,
 * and the blast came
 * first): a hostile within 8 m (a creeper within 10), health 8 or less beside a hostile within 16, and the last
 * act cut by a reflex or by a
 * hostile (its `stopIf.hostileWithin`, or the head's urgent cut).
 */
export function urgentReasons(observation: BodyObservation | null, cut: string | null): string[] {
  return urgentFacts(observation, cut).reasons;
}

/** How near a hostile makes a step urgent (a creeper a little farther). */
export const urgentMeters = (name: string) => (name === 'creeper' ? CREEPER_URGENT_METERS : LLMC_URGENT_NEAR_METERS);

/**
 * r7 (runs 29–31: 「blaze 4.0m」 first in the live state at almost every step, the blaze 2–6 up behind the bricks;
 * 3 of 3 runs fought
 * before the check): the reasons with what the body's sight found of each near hostile (`sights`, by id; none:
 * as r3 said them), and
 * the hostiles that can neither see her nor come (`walledOff`), which make no step urgent and are said after the plan's now
 * (`unreachable`). `inSight`: after a stopIf stop, that a hostile sees her where she stopped, said first (run 31).
 */
export function urgentFacts(
  observation: BodyObservation | null,
  cut: string | null,
  sights: ReadonlyMap<number, ThreatSight> | null = null,
  inSight: string | null = null,
): { reasons: string[]; unreachable: string[] } {
  const world = (observation?.state.world ?? {}) as { health?: unknown };
  const known = (threat: NearThreat) => (threat.id !== null ? sights?.get(threat.id) : undefined);
  const threats = nearThreats(observation),
    walled = threats.filter((threat) => walledOff(threat, known(threat)));
  const open = threats.filter((threat) => !walled.includes(threat));
  const reasons: string[] = inSight ? [inSight] : [];
  const near = open.find((item) => item.distance <= urgentRange(item, urgentMeters(item.name)));
  if (near) reasons.push(`${threatLine(near, known(near))}${near.name === 'creeper' ? '（爆発は約7m まで届く）' : ''}`);
  const health = typeof world.health === 'number' && Number.isFinite(world.health) ? world.health : null;
  if (health !== null && health <= LOW_HEALTH && open.some((item) => item.distance <= 16))
    reasons.push(`体力 ${Math.round(health * 10) / 10} で敵が近い`);
  if (cut) reasons.push(cut);
  // r10 (H2): while a multi-hand reflex holds the body, an urgent decision is told so first; its act is sent after
  // the reflex lets go.
  if (reasons.length) reasons.unshift(...reflexLines(observation));
  const unreachable = walled
    .filter((item) => item.distance <= urgentMeters(item.name))
    .slice(0, THREAT_SIGHT.max)
    .map((item) => threatLine(item, known(item)));
  return { reasons, unreachable };
}

/**
 * Why a result makes the next step urgent: a reflex or a hostile cut the act (r3). r7 (run 31: the health stop
 * at 8.7 left her standing
 * in the blaze's line, burning, and the next decision took 8 s): a stopIf on health too.
 */
export function cutOf(text: string, bodyReflex: boolean): string | null {
  if (/急ぎ: .+ が近づいたので act を止めた/u.test(text)) return '前の act は敵が近づいて止めた';
  if (bodyReflex) return '前の act は体の反射が止めた';
  if (/stopIf: hostileWithin/u.test(text)) return '前の act は stopIf（敵が近い）で止まった';
  return /stopIf: hpBelow/u.test(text) ? '前の act は stopIf（体力）で止まった' : null;
}

/**
 * What happened to the body since the task's last decision that no tool result says (a reflex that took the
 * body, a death, a login, a new
 * dimension): told in the live state (`events`) once, and the reason a recall runs (design 2.3: recall only on an event).
 */
export function createLlmcEvents(taskId: string, now: () => number = Date.now) {
  const state = eventsOf(taskId);
  let shown: string[] = [],
    results: string[] = [],
    healthLost = 0,
    stops: string[] = [],
    since: string | undefined;
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
      if (!first || kind === 'death')
        note(kind === 'death' ? '死んでリスポーンした（持ち物を落とした所へ戻るか決める）' : `体が着いた: ${kind ?? '不明'}`);
    },
    /** A tool result: a reflex that cut it is an event; a failure makes the next decision worth a recall; a cut act
     * makes it urgent. */
    result(name: string, ok: boolean, bodyReflex: boolean, text = '') {
      if (bodyReflex) note(`反射が ${name} を止めた`);
      state.failed = !ok;
      if (name === MC_ACT_TOOL) {
        state.cut = cutOf(text, bodyReflex);
        state.stopIf = /（stopIf: /u.test(text);
      }
    },
    /** r7: whether the last act was stopped by its own stopIf. */
    stoppedByStopIf: () => state.stopIf,
    /** r3: a result's whole text the history keeps short, for the next decision's live state. */
    keep(text: string) {
      state.pending.push(text);
      if (state.pending.length > 6) state.pending.splice(0, state.pending.length - 6);
    },
    /**
     * At a decision's context: the events since the last one, now read, and the results to show once. r8, `again`:
     * the context of a
     * decision asked again after an interrupt is the same decision's, so what the first showed once is shown again.
     */
    take(health: number | null = null, again = false): string[] {
      if (again) return shown;
      shown = state.lines.filter((item) => item.seq > state.read).map((item) => item.line);
      state.read = state.seq;
      results = state.pending.splice(0);
      // The stuck go's sentence counts the stops at its place when it is read, after the stall watch has counted this
      // result; a line said twice is said once.
      stops = state.stops
        .splice(0)
        .map((entry) => (typeof entry === 'function' ? entry() : entry))
        .filter((line, index, all) => all.indexOf(line) === index);
      since = state.lastAt === null ? undefined : new Date(state.lastAt).toISOString();
      state.lastAt = now();
      healthLost = health !== null && state.health !== null ? Math.max(0, state.health - health) : 0;
      if (health !== null) state.health = health;
      return shown;
    },
    shown: () => shown,
    results: () => results,
    /** Chapter 8: where a go or a vertical of the results shown this once stopped (`stopFactsOf`); and the time of
     * the decision before this one (ISO), or undefined. */
    stops: () => stops,
    since: () => since,
    /** An act's result (the receipt's JSON) that came after the last decision: its stops are told with the next one. */
    noteStops(resultJson: string | undefined) {
      for (const line of stopFactLines(resultJson, (at) => sameSpotStops(taskId, at))) state.stops.push(line);
      if (state.stops.length > 4) state.stops.splice(0, state.stops.length - 4);
    },
    healthLost: () => healthLost,
    /** Why the last result makes the next step urgent, or null. */
    cut: () => state.cut,
    trend: state.trend,
  };
}

export type LlmcEvents = ReturnType<typeof createLlmcEvents>;
