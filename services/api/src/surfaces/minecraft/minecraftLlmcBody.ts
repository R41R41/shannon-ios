import type { BodyObservation, BodyPlanView, BodyValue } from '../../contracts/bodyControlContract.js';
import type { FcaBodyInvestigation, FcaBodyLifecycle } from '../../mind/action/fca/fcaPorts.js';
import { MC_ACT_TOOL } from '../../contracts/minecraftActContract.js';
import type { ProbeInput } from '../../contracts/minecraftProbeContract.js';
import { createFoodTrend, llmcPlanTokens, llmcTokens, minecraftLlmcLive, minecraftLlmcUrgentLive, type FoodTrend } from './minecraftLlmcLive.js';
import { lookAtFooting } from './minecraftLlmcFooting.js';
import { approachingIds, newApproach, planNowTitle, URGENT_ANSWER } from './minecraftLlmcUrgent.js';
import { llmcStoredResult } from './minecraftLlmc.js';
import {
  createSurpriseWatch, LLMC_PROBE, runInvestigation, scanLines, stepProbes, surpriseFrame, type Surprise, type SurpriseFrame,
} from './minecraftLlmcProbe.js';
import { cautionFact } from './minecraftLlmcCaution.js';
import type { PlanTree } from '@shannon/mind';
import { feetIn, foodFirstLine, foodLeads, preparationShortage, readinessOf, recoveryLine } from './minecraftLlmcReadiness.js';
import {
  inSightLine, keepThreatSight, keptThreatSight, nearThreats, readThreatSight, sightProbe, THREAT_SIGHT, threatLine, threatSightKey,
  threatSightMeters, threatSightTargets, walledOff, type NearThreat, type ThreatSight,
} from './minecraftLlmcThreat.js';
import { planNowLine } from './minecraftLlmcNode.js';
import type { ActInput } from '../../contracts/minecraftActContract.js';
import { normalizeActInput } from './minecraftLlmcShape.js';

/** The first index of the hostiles' sight probes in a step (the surprises' are 0 and 1), and of the footing's column probes (r8). */
const THREAT_SIGHT_INDEX = 10, FOOTING_INDEX = 20;

/**
 * What a Minecraft task's body lifecycle takes in the LLM-centric mode (`createMinecraftTaskBody`, `llmc`): the task's plan (for the
 * context of every command and reflex session, `BodyTaskContext.plan`) and its path's size (the live state's room), and the per-task
 * events and food trend kept across steps.
 */
export interface LlmcBodyParts {
  plan(): BodyPlanView | undefined;
  /** The plan's path as the decision reads it (its tokens count against the live state's bound). */
  planView(): object | null;
  /** r6: the whole tree (the places of its nodes: the gate back, for where food is). Absent: none read. */
  planTree?(): PlanTree;
}

interface TaskEvents {
  lines: Array<{ seq: number; line: string }>; seq: number; read: number; arrival: number | null; failed: boolean; trend: FoodTrend;
  /** r3: the whole texts of results the history keeps short, until the next decision shows them. */
  pending: string[];
  /** r3: why the last result makes the next step urgent (a reflex or a hostile cut the act), or null. */
  cut: string | null;
  /** r3: her health at the last decision, for what a fall or a blast took since. */
  health: number | null;
  /** r5: the last act did not go as asked (no decision is asked ahead of the next one). */
  actFailed: boolean;
  /** r7: the last act was stopped by its own stopIf (where it stopped is looked at from the shooters near). */
  stopIf: boolean;
}
const tasks = new Map<string, TaskEvents>();
function eventsOf(taskId: string): TaskEvents {
  let state = tasks.get(taskId);
  if (!state) {
    state = { lines: [], seq: 0, read: 0, arrival: null, failed: false, trend: createFoodTrend(), pending: [], cut: null, health: null,
      actFailed: false, stopIf: false };
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
  return urgentFacts(observation, cut).reasons;
}
/** How near a hostile makes a step urgent (a creeper a little farther). */
export const urgentMeters = (name: string) => name === 'creeper' ? CREEPER_URGENT_METERS : LLMC_URGENT_NEAR_METERS;
/**
 * r7 (runs 29–31: 「blaze 4.0m」 first in the live state at almost every step, the blaze 2–6 up behind the bricks; 3 of 3 runs fought
 * before the check): the reasons with what the body's sight found of each near hostile (`sights`, by id; none: as r3 said them), and
 * the hostiles that can neither see her nor come (`walledOff`), which make no step urgent and are said after the plan's now
 * (`unreachable`). `inSight`: after a stopIf stop, that a hostile sees her where she stopped, said first (run 31).
 */
export function urgentFacts(observation: BodyObservation | null, cut: string | null, sights: ReadonlyMap<number, ThreatSight> | null = null,
  inSight: string | null = null): { reasons: string[]; unreachable: string[] } {
  const world = (observation?.state.world ?? {}) as { health?: unknown };
  const known = (threat: NearThreat) => threat.id !== null ? sights?.get(threat.id) : undefined;
  const threats = nearThreats(observation), walled = threats.filter(threat => walledOff(threat, known(threat)));
  const open = threats.filter(threat => !walled.includes(threat));
  const reasons: string[] = inSight ? [inSight] : [];
  const near = open.find(item => item.distance <= urgentMeters(item.name));
  if (near) reasons.push(`${threatLine(near, known(near))}${near.name === 'creeper' ? '（爆発は約7m まで届く）' : ''}`);
  const health = typeof world.health === 'number' && Number.isFinite(world.health) ? world.health : null;
  if (health !== null && health <= LOW_HEALTH && open.some(item => item.distance <= 16)) reasons.push(`体力 ${Math.round(health * 10) / 10} で敵が近い`);
  if (cut) reasons.push(cut);
  const unreachable = walled.filter(item => item.distance <= urgentMeters(item.name)).slice(0, THREAT_SIGHT.max).map(item => threatLine(item, known(item)));
  return { reasons, unreachable };
}
/**
 * Why a result makes the next step urgent: a reflex or a hostile cut the act (r3). r7 (`stopIfHp`, with the probe; run 31: the health
 * stop at 8.7 left her standing in the blaze's line, burning, and the next decision took 8 s): a stopIf on health too.
 */
function cutOf(text: string, bodyReflex: boolean, stopIfHp = false): string | null {
  if (/急ぎ: .+ が近づいたので act を止めた/u.test(text)) return '前の act は敵が近づいて止めた';
  if (bodyReflex) return '前の act は体の反射が止めた';
  if (/stopIf: hostileWithin/u.test(text)) return '前の act は stopIf（敵が近い）で止まった';
  return stopIfHp && /stopIf: hpBelow/u.test(text) ? '前の act は stopIf（体力）で止まった' : null;
}

/**
 * What happened to the body since the task's last decision that no tool result says (a reflex that took the body, a death, a login, a new
 * dimension): told in the live state (`events`) once, and the reason a recall runs (design 2.3: recall only on an event).
 */
export function createLlmcEvents(taskId: string, options: { stopIfHp?: boolean } = {}) {
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
      if (name === MC_ACT_TOOL) {
        state.cut = cutOf(text, bodyReflex, options.stopIfHp === true);
        state.actFailed = !ok;
        state.stopIf = /（stopIf: /u.test(text);
      }
    },
    /** r5: whether the last act failed (`FcaBodyLifecycle.troubled`). */
    actFailed: () => state.actFailed,
    /** r7: whether the last act was stopped by its own stopIf. */
    stoppedByStopIf: () => state.stopIf,
    /** r3: a result's whole text the history keeps short, for the next decision's live state. */
    keep(text: string) {
      state.pending.push(text);
      if (state.pending.length > 6) state.pending.splice(0, state.pending.length - 6);
    },
    /**
     * At a decision's context: the events since the last one, now read, and the results to show once. r8, `again`: the context of a
     * decision asked again after an interrupt is the same decision's, so what the first showed once is shown again.
     */
    take(health: number | null = null, again = false): string[] {
      if (again) return shown;
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
  r4: { investigation: readonly string[]; scan: readonly string[]; unreachable?: readonly string[]; footing?: string | null } | null = null)
  : Record<string, unknown> {
  const plan = llmc.planView();
  const world = observation?.state.world as Record<string, unknown> | undefined;
  const jobs = world && (world.jobs ?? world.activeFurnaces) as BodyValue | undefined;
  return minecraftLlmcLive({ observation, elapsedMinutes, trend: events.trend, events: events.shown(), ...(jobs ? { jobs } : {}),
    lastResults: events.results(), urgent, healthLost: events.healthLost(),
    ...(r4?.investigation.length ? { investigation: r4.investigation } : {}), ...(r4?.scan.length ? { scan: r4.scan } : {}),
    ...(r4?.unreachable?.length ? { unreachable: r4.unreachable } : {}), ...(r4?.footing ? { footing: r4.footing } : {}),
    ...(r4 ? readinessParts(llmc, plan, observation) : {}) }, llmcPlanTokens(plan));
}

/**
 * r6 (with the probe, as r4's parts): the current node before the map, what its stage lacks, and health that does not come back with
 * where food is (`minecraftLlmcReadiness.ts`). Facts only: what to do with them is the decision's.
 */
export function readinessParts(llmc: LlmcBodyParts, view: object | null, observation: BodyObservation | null)
  : { planNow?: string; shortage?: string; recovery?: string[] } {
  const planNow = planNowLine(view as { now?: unknown; path?: unknown } | null), facts = readinessOf(observation);
  const out = planNow ? { planNow } : {};
  if (!facts) return out;
  const display = llmc.plan(), nowTitle = display?.nodes.find(node => node.id === display.current)?.title ?? null;
  const shortage = preparationShortage({ dimension: facts.dimension, counts: facts.counts, food: facts.food, nowTitle });
  const recovery = recoveryLine(facts.hunger, facts.health, facts.food);
  let nodes: PlanTree['nodes'] = [];
  try { nodes = llmc.planTree?.().nodes ?? []; } catch { nodes = []; }
  // r7 (runs 29, 30): no food and health that does not come back: the plan's food node is said before its now (the plan is not changed).
  const first = recovery && facts.food <= 0 && planNow ? foodFirstLine(nodes, display?.current ?? null, feetIn(facts.world)) : null;
  return { ...(planNow ? { planNow: first ? `${first}。その後に今の節 ${planNow}` : planNow } : {}), ...(shortage ? { shortage } : {}),
    ...(recovery ? { recovery: [recovery, foodLeads(facts.world, facts.dimension, nodes)] } : {}) };
}

/** r6: an act with a wait hand, stored with the fact that health does not come back now (the same words as the live state's). */
export function withRecoveryFact(name: string, input: unknown, stored: string, observation: BodyObservation | null): string {
  if (name !== MC_ACT_TOOL) return stored;
  let hands: readonly { do?: string }[] = [];
  try { hands = (normalizeActInput(input).input as ActInput | null)?.hands ?? []; } catch { hands = []; }
  const facts = hands.some(hand => hand.do === 'wait') ? readinessOf(observation) : null;
  const recovery = facts ? recoveryLine(facts.hunger, facts.health, facts.food) : null;
  return recovery ? `${stored}\n頭: ${recovery}` : stored;
}

/**
 * r4 (SHANNON_MINECRAFT_LLMC_PROBE): what the mode's body takes for its surprises and the body's scan. `probe`: the way to send one probe
 * to the body now (its result text, or null), or null while the body has no `probe`; `planWhere`: the current plan node's place.
 */
export interface LlmcProbeParts {
  probe(): ((input: ProbeInput, index: number) => Promise<string | null>) | null;
  planWhere(): string | null;
  /** r5: a fact noted on the current plan node's caution (true when the plan took it). Absent: none noted. */
  caution?(text: string): boolean;
}
/**
 * r5: the facts of the surprises met again this step (`cautionFact`), each from its own probes' answers, noted through `note`; how many
 * the plan took.
 */
export function noteCautions(surprises: readonly Surprise[], probes: readonly ProbeInput[], answers: ReadonlyArray<string | null | undefined>,
  note: ((text: string) => boolean) | undefined): number {
  if (!note) return 0;
  let noted = 0;
  for (const surprise of surprises) {
    const own = probes.flatMap((probe, index) => surprise.probes.some(item => JSON.stringify(item) === JSON.stringify(probe))
      ? [{ probe, answer: answers[index] }] : []);
    const fact = cautionFact({ code: surprise.code, nth: surprise.nth ?? 1, hand: surprise.hand ?? null }, own.map(item => item.probe),
      own.map(item => item.answer));
    try { if (fact && note(fact)) noted += 1; } catch { /* a note never fails a step */ }
  }
  return noted;
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
  const r4 = parts.r4, watch = r4 ? createSurpriseWatch(parts.taskId) : null;
  const events = createLlmcEvents(parts.taskId, { stopIfHp: !!r4 }), now = parts.now ?? Date.now, began = Date.parse(parts.createdAt);
  let observation: BodyObservation | null = null, reasons: string[] = [];
  let investigation: string[] = [], scan: string[] = [];
  // r7: what the body's sight found of the near hostiles this step (by id), the line said first after a stopIf stop, and the walled-off.
  let sights = new Map<number, ThreatSight>(), inSight: string | null = null, unreachable: string[] = [];
  // r8: the footing's line; the hostiles she had to act on when the request was built (`approachingIds`) and the one that came while it was
  // awaited (`interrupted`: the decision is then asked again, `rebuild`: on the same events); the tokens of an urgent state (logged with its seconds).
  let footing: string | null = null, baseline = new Set<number>(), interrupted: string | null = null, rebuild = false, urgentTokens: number | null = null;
  const say = (line: string) => { try { (parts.log ?? (text => console.info(text)))(line); } catch { /* a log never fails a step */ } };
  /**
   * r8: the footing round her feet, from the map and the body's `column` probes for the gaps the map cannot measure (`lookAtFooting`), at
   * once beside the sight probes, waited `LLMC_PROBE.urgentBudgetMs` at most.
   */
  const lookAtFootingNow = async (seen: BodyObservation | null, feet: SurpriseFrame['feet'],
    run: ((input: ProbeInput, index: number) => Promise<string | null>) | null): Promise<void> => {
    footing = null;
    const map = (seen?.state.world as { localMap?: unknown } | undefined)?.localMap;
    const found = await lookAtFooting({ taskId: parts.taskId, map: typeof map === 'string' ? map : undefined, feet, run,
      budgetMs: LLMC_PROBE.urgentBudgetMs, index: FOOTING_INDEX }).catch(() => null);
    footing = found?.line ?? null;
    if (found?.gaps) {
      say(`Shannon Minecraft footing task=${parts.taskId} gaps=${found.gaps} asked=${found.asked} line=${footing ? 1 : 0}`
        + ` by=${found.by ?? '-'} ms=${found.ms}`);
    }
  };
  /** r8: the live state of an urgent decision (`minecraftLlmcUrgentLive`), made on the frame now; its tokens are kept for the log of its seconds. */
  const urgentState = (minutes: number | null): Record<string, unknown> => {
    const facts = urgentFacts(observation, events.cut(), r4 ? sights : null, r4 ? inSight : null);
    const nowLine = planNowLine(parts.llmc.planView() as { now?: unknown; path?: unknown } | null);
    const live = minecraftLlmcUrgentLive({ observation, elapsedMinutes: minutes, events: events.shown(), lastResults: events.results(),
      urgent: [...(interrupted ? [`急ぎ: 判断を待つ間に ${interrupted}`] : []), ...facts.reasons], investigation, footing,
      planNowTitle: planNowTitle(nowLine), answer: URGENT_ANSWER });
    urgentTokens = llmcTokens(JSON.stringify(live));
    return live;
  };
  /**
   * r7: the near hostiles (`threatSightTargets`) looked at with the body's sight, at once, beside the surprises' probes, waited
   * `LLMC_PROBE.urgentBudgetMs` at most; an answer for the same hostile, block and feet is kept for the task. After a stopIf stop, the
   * shooters within 16 m too, and whether one sees her where she stopped (`inSightLine`).
   */
  const lookAtThreats = async (seen: BodyObservation | null, feet: SurpriseFrame['feet'],
    run: ((input: ProbeInput, index: number) => Promise<string | null>) | null): Promise<void> => {
    sights = new Map();
    inSight = null;
    const afterStop = events.stoppedByStopIf(), began = performance.now();
    const targets = threatSightTargets(nearThreats(seen), threat => threatSightMeters(threat, urgentMeters(threat.name), afterStop));
    if (!targets.length) return;
    const asked: NearThreat[] = [];
    for (const threat of targets) {
      const known = keptThreatSight(parts.taskId, threatSightKey(threat, feet));
      if (known) sights.set(threat.id!, known);
      else asked.push(threat);
    }
    if (run && asked.length) {
      const jobs = asked.map(async (threat, index) => {
        try {
          // The index past the surprises' (a probe's command id is the step's and its index).
          const sight = readThreatSight(await run(sightProbe(threat), THREAT_SIGHT_INDEX + index));
          if (!sight) return;
          sights.set(threat.id!, sight);
          keepThreatSight(parts.taskId, threatSightKey(threat, feet), sight);
        } catch { /* no answer: as r3 said it */ }
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all(jobs), new Promise<void>(resolve => { timer = setTimeout(resolve, LLMC_PROBE.urgentBudgetMs); })]);
      clearTimeout(timer);
    }
    inSight = afterStop ? inSightLine(targets, sights) : null;
    const walled = targets.filter(threat => walledOff(threat, sights.get(threat.id!))).length;
    say(`Shannon Minecraft threat sight task=${parts.taskId} looked=${targets.length} asked=${run ? asked.length : 0} known=${sights.size}`
      + ` walled=${walled} inSight=${inSight ? 1 : 0} afterStop=${afterStop ? 1 : 0} ms=${Math.round(performance.now() - began)}`);
  };
  return { ...body,
    context() {
      // r8: after an interrupt this is the same decision's context again: what the first showed once (events, results, the scan) stands.
      const again = rebuild;
      rebuild = false;
      if (!again) {
        interrupted = null;
        urgentTokens = null;
      }
      const value = body.context();
      observation = parts.observe();
      const arrival = parts.arrival();
      events.arrival(arrival.at, arrival.kind);
      events.take(healthOf(observation), again);
      if (r4 && !again) {
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
    transient() {
      baseline = approachingIds(observation, urgentMeters);
      const minutes = Number.isFinite(began) ? Math.max(0, (now() - began) / 60_000) : null;
      // r8: an urgent step, or a decision asked again after an interrupt, reads the short state.
      if (r4 && (reasons.length > 0 || interrupted !== null)) return urgentState(minutes);
      return llmcTransient(parts.llmc, events, observation, minutes, reasons, r4 ? { investigation, scan, unreachable, footing } : null);
    },
    ...(r4 ? {
      /** r8: a hostile she must act on that has come since the request was built (once a decision), see `FcaBodyLifecycle.interrupt`. */
      interrupt: (): string | null => {
        if (interrupted !== null) return null;
        interrupted = newApproach(parts.observe(), baseline, urgentMeters);
        return interrupted;
      },
      rebuilding: () => { rebuild = true; },
      decided: ({ ms, aborted, thrownMs }: { ms: number; aborted: boolean; thrownMs: number }) => {
        if (urgentTokens !== null) {
          say(`Shannon Minecraft urgent decision task=${parts.taskId} ms=${ms} aborted=${aborted ? 1 : 0} ctxTokens=${urgentTokens}`
            + `${aborted ? ` thrownMs=${thrownMs}` : ''}`);
        }
        urgentTokens = null;
        interrupted = null;
      },
    } : {}),
    ...(r4 && watch ? {
      /**
       * r4: before the decision, the surprises since the last one (`createSurpriseWatch`) and their fixed probes, sent at once and waited
       * for `LLMC_PROBE.budgetMs` at most (an urgent step's `urgentBudgetMs`); what came is said first in this decision's live state.
       * r7: beside them, the near hostiles looked at with the body's sight (`lookAtThreats`), for whether the step is urgent and its line.
       */
      async investigate(): Promise<FcaBodyInvestigation | null> {
        const seen = parts.observe();
        const frame = surpriseFrame(seen, parts.arrival().at);
        let where: string | null = null;
        try { where = r4.planWhere(); } catch { where = null; }
        const surprises = watch.detect(frame, where);
        investigation = [];
        let run: ReturnType<LlmcProbeParts['probe']> = null;
        try { run = r4.probe(); } catch { run = null; }
        const looking = Promise.all([lookAtThreats(seen, frame.feet, run), lookAtFootingNow(seen, frame.feet, run)]);
        if (!surprises.length) {
          await looking;
          return null;
        }
        const probes = stepProbes(surprises), urgent = urgentReasons(seen, events.cut()).length > 0;
        const [done] = await Promise.all([runInvestigation({ surprises, probes: run ? probes : [], feet: frame.feet, run,
          budgetMs: urgent ? LLMC_PROBE.urgentBudgetMs : LLMC_PROBE.budgetMs }), looking]);
        investigation = done.lines;
        const codes = surprises.map(item => item.code);
        const sent = run ? probes.length : 0;
        // r5: a surprise met the second time has its fact noted on the current node (shown in this decision's plan.rules).
        const noted = noteCautions(surprises, run ? probes : [], done.answers, r4.caution ? text => r4.caution!(text) : undefined);
        say(`Shannon Minecraft surprise task=${parts.taskId} surprises=${codes.join(',')} probes=${sent} answered=${done.answered} ms=${done.ms}`
          + `${noted ? ` noted=${noted}` : ''}`);
        return { surprises: codes, probes: sent, answered: done.answered, ms: done.ms };
      },
    } : {}),
    recallWanted: () => events.wanted(),
    // r5: no decision asked ahead of an act chosen right after a failed one (run 28: 73% of acts failed within seconds).
    troubled: () => events.actFailed(),
    // r5 (run 28: a plan row of run 27's task, in another world, was recalled with its coordinates): what was before this task is marked.
    recallCues: () => ({ ...(body.recallCues?.() ?? { words: [], tags: [] }), since: parts.createdAt }),
    urgent() {
      const facts = urgentFacts(parts.observe(), events.cut(), r4 ? sights : null, r4 ? inSight : null);
      reasons = facts.reasons;
      unreachable = facts.unreachable;
      if (reasons.length) {
        const line = `Shannon Minecraft urgent step task=${parts.taskId} reasons=${reasons.length}`;
        try { (parts.log ?? (text => console.info(text)))(line); } catch { /* a log never fails a step */ }
      }
      return reasons.length > 0;
    },
    storedResult(call, text) {
      const { stored, shown } = llmcStoredResult(call.name, text);
      if (shown) events.keep(shown);
      // r6 (run 29: 325 s of waits at hunger 17 and no food): a wait's result says when health cannot come back.
      return r4 ? withRecoveryFact(call.name, call.input, stored, parts.observe()) : stored;
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
