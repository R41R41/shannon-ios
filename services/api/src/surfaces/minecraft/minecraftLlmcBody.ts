import type { BodyObservation, BodyPlanView, BodyValue } from '../../contracts/bodyControlContract.js';
import type { FcaBodyInvestigation, FcaBodyLifecycle } from '../../mind/action/fca/fcaPorts.js';
import { MC_ACT_TOOL } from '../../contracts/minecraftActContract.js';
import type { ProbeInput } from '../../contracts/minecraftProbeContract.js';
import {
  bodyAgeField, carriedFood, createFoodTrend, llmcPlanTokens, llmcTokens, minecraftLlmcLive, minecraftLlmcUrgentLive, staleBodyLine, type FoodTrend,
} from './minecraftLlmcLive.js';
import { noteBodySeen } from './minecraftBodyAbsent.js';
import { lookAtFooting } from './minecraftLlmcFooting.js';
import { approachingIds, newApproach, planNowTitle, urgentRange, URGENT_NOTE } from './minecraftLlmcUrgent.js';
import { doneFacts, prepUnmetFacts } from './minecraftPlanDone.js';
import { nowKinds, PLAN_FACTS_KEY, planFactsOf, type PlanFacts } from './minecraftPlanFacts.js';
import { offer, pending, withdraw, type OnceFact } from './minecraftLlmcOnceFacts.js';
import { createHitWatch, inputFacts, onceFor, queueNowLines, stopFactLines, wantsFood, type FactsContext, type HitWatch } from './minecraftLlmcFacts.js';
import { sameSpotStops } from './minecraftLlmcStalls.js';
import { llmcStoredResult } from './minecraftLlmc.js';
import {
  createSurpriseWatch, LLMC_PROBE, runInvestigation, scanLines, stepProbes, surpriseFrame, type Surprise, type SurpriseFrame,
} from './minecraftLlmcProbe.js';
import { cautionFact } from './minecraftLlmcCaution.js';
import type { PlanTree } from '@shannon/mind';
import { meterLine, roadLine } from './minecraftLlmcRoad.js';
import { feetIn, foodFirstLine, foodLeads, fuelShortage, preparationShortage, readinessOf, recoveryLine } from './minecraftLlmcReadiness.js';
import { wornItems } from './minecraftItems.js';
import {
  inSightLine, keepThreatSight, keptThreatSight, nearThreats, readThreatSight, sightProbe, THREAT_SIGHT, threatLine, threatSightKey,
  threatSightMeters, threatSightTargets, walledOff, type NearThreat, type ThreatSight,
} from './minecraftLlmcThreat.js';
import { planNowOf } from './minecraftLlmcNode.js';
import { reflexLines } from './minecraftLlmcReflexHold.js';
import type { ActInput } from '../../contracts/minecraftActContract.js';
import { normalizeActInput } from './minecraftLlmcShape.js';
import { queueLifecycle, type LlmcQueue } from './minecraftLlmcQueueBody.js';
import { driftOf, madeInOf } from './minecraftMadeIn.js';
import type { MadeIn } from '../../contracts/continueContract.js';

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
  /** r7: the last act was stopped by its own stopIf (where it stopped is looked at from the shooters near). */
  stopIf: boolean;
  /** Chapter 8: when the last decision read its context (ms), for the promises' 「直前に」; the stops of the results since (`stopFactsOf`), until the next decision shows them. */
  lastAt: number | null;
  stops: Array<string | (() => string)>;
}
const tasks = new Map<string, TaskEvents>();
function eventsOf(taskId: string): TaskEvents {
  let state = tasks.get(taskId);
  if (!state) {
    state = { lines: [], seq: 0, read: 0, arrival: null, failed: false, trend: createFoodTrend(), pending: [], cut: null, health: null,
      stopIf: false, lastAt: null, stops: [] };
    tasks.set(taskId, state);
    if (tasks.size > 32) tasks.delete(tasks.keys().next().value as string);
  }
  return state;
}

/**
 * mb-llmc v2: whether the decision a task's tools are now running was an urgent one (its live state was the short one with the
 * answer line 「手は 3 つまで」): the act preflight's urgent limit (`minecraftLlmcHandGuards.ts`) reads it when the act is sent.
 */
const urgentDecisions = new Map<string, boolean>();
function noteUrgentDecision(taskId: string, urgent: boolean): void {
  urgentDecisions.delete(taskId);
  urgentDecisions.set(taskId, urgent);
  if (urgentDecisions.size > 32) urgentDecisions.delete(urgentDecisions.keys().next().value as string);
}
export const urgentDecision = (taskId: string): boolean => urgentDecisions.get(taskId) === true;

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
  const near = open.find(item => item.distance <= urgentRange(item, urgentMeters(item.name)));
  if (near) reasons.push(`${threatLine(near, known(near))}${near.name === 'creeper' ? '（爆発は約7m まで届く）' : ''}`);
  const health = typeof world.health === 'number' && Number.isFinite(world.health) ? world.health : null;
  if (health !== null && health <= LOW_HEALTH && open.some(item => item.distance <= 16)) reasons.push(`体力 ${Math.round(health * 10) / 10} で敵が近い`);
  if (cut) reasons.push(cut);
  // r10 (H2): while a multi-hand reflex holds the body, an urgent decision is told so first; its act is sent after the reflex lets go.
  if (reasons.length) reasons.unshift(...reflexLines(observation));
  const unreachable = walled.filter(item => item.distance <= urgentMeters(item.name)).slice(0, THREAT_SIGHT.max).map(item => threatLine(item, known(item)));
  return { reasons, unreachable };
}
/**
 * Why a result makes the next step urgent: a reflex or a hostile cut the act (r3). r7 (run 31: the health stop at 8.7 left her standing
 * in the blaze's line, burning, and the next decision took 8 s): a stopIf on health too.
 */
function cutOf(text: string, bodyReflex: boolean): string | null {
  if (/急ぎ: .+ が近づいたので act を止めた/u.test(text)) return '前の act は敵が近づいて止めた';
  if (bodyReflex) return '前の act は体の反射が止めた';
  if (/stopIf: hostileWithin/u.test(text)) return '前の act は stopIf（敵が近い）で止まった';
  return /stopIf: hpBelow/u.test(text) ? '前の act は stopIf（体力）で止まった' : null;
}

/**
 * What happened to the body since the task's last decision that no tool result says (a reflex that took the body, a death, a login, a new
 * dimension): told in the live state (`events`) once, and the reason a recall runs (design 2.3: recall only on an event).
 */
export function createLlmcEvents(taskId: string, now: () => number = Date.now) {
  const state = eventsOf(taskId);
  let shown: string[] = [], results: string[] = [], healthLost = 0, stops: string[] = [], since: string | undefined;
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
     * At a decision's context: the events since the last one, now read, and the results to show once. r8, `again`: the context of a
     * decision asked again after an interrupt is the same decision's, so what the first showed once is shown again.
     */
    take(health: number | null = null, again = false): string[] {
      if (again) return shown;
      shown = state.lines.filter(item => item.seq > state.read).map(item => item.line);
      state.read = state.seq;
      results = state.pending.splice(0);
      // The stuck go's sentence counts the stops at its place when it is read, after the stall watch has counted this result; a line said twice is said once.
      stops = state.stops.splice(0).map(entry => typeof entry === 'function' ? entry() : entry).filter((line, index, all) => all.indexOf(line) === index);
      since = state.lastAt === null ? undefined : new Date(state.lastAt).toISOString();
      state.lastAt = now();
      healthLost = health !== null && state.health !== null ? Math.max(0, state.health - health) : 0;
      if (health !== null) state.health = health;
      return shown;
    },
    shown: () => shown,
    results: () => results,
    /** Chapter 8: where a go or a vertical of the results shown this once stopped (`stopFactsOf`); and the time of the decision before this one (ISO), or undefined. */
    stops: () => stops,
    since: () => since,
    /** An act's result (the receipt's JSON) that came after the last decision: its stops are told with the next one. */
    noteStops(resultJson: string | undefined) {
      for (const line of stopFactLines(resultJson, at => sameSpotStops(taskId, at))) state.stops.push(line);
      if (state.stops.length > 4) state.stops.splice(0, state.stops.length - 4);
    },
    healthLost: () => healthLost,
    /** Why the last result makes the next step urgent, or null. */
    cut: () => state.cut,
    trend: state.trend,
  };
}
export type LlmcEvents = ReturnType<typeof createLlmcEvents>;

/** The live body of an LLM-centric decision: the map-first state, bounded beside the plan's path. */
export function llmcTransient(llmc: LlmcBodyParts, events: LlmcEvents, observation: BodyObservation | null,
  elapsedMinutes: number | null, urgent: readonly string[] = [],
  seen: { investigation?: readonly string[]; scan?: readonly string[]; unreachable?: readonly string[]; footing?: string | null;
    bodyAge?: string | null; queue?: readonly string[];
    /** Chapter 8: what the facts need beyond the frame (`JudgeParts`); the held time of the task (ms), which the meter's clock leaves out. */
    judge?: JudgeParts; heldMs?: number } = {}, taskId?: string)
  : Record<string, unknown> {
  const plan = llmc.planView();
  const world = observation?.state.world as Record<string, unknown> | undefined;
  const jobs = world && (world.jobs ?? world.activeFurnaces) as BodyValue | undefined;
  // Chapter 7: `planFacts` is the machine's reading of the plan's kinds (outside the live state's bound: the rewrite takes it out, the model is not shown it); `onceFacts` the
  // facts to say once (`minecraftLlmcOnceFacts.ts`).
  // Chapter 8: the facts said once go first in the input's `events` (`onceFor`: those this version takes); `deliverOnceFacts` marks them delivered when the request's bytes hold them.
  const { planFacts, onceFacts: _onceFacts, ...readiness } = readinessParts(llmc, plan, observation, taskId);
  const facts = observation && observation.connected !== false
    ? inputFacts(observation, factsContext(llmc, observation, readiness, planFacts, seen.judge), false) : null;
  const once = taskId ? onceFor(taskId, 'normal').map(fact => fact.text) : [];
  const live = minecraftLlmcLive({ observation, elapsedMinutes, trend: events.trend, events: events.shown(), ...(jobs ? { jobs } : {}),
    lastResults: events.results(), urgent, healthLost: events.healthLost(),
    ...(seen.investigation?.length ? { investigation: seen.investigation } : {}), ...(seen.scan?.length ? { scan: seen.scan } : {}),
    ...(seen.unreachable?.length ? { unreachable: seen.unreachable } : {}), ...(seen.footing ? { footing: seen.footing } : {}),
    ...(seen.queue?.length ? { queue: seen.queue } : {}),
    ...bodyAgeField(seen.bodyAge),
    ...(facts?.lines.length ? { facts } : {}), ...(once.length ? { once } : {}),
    ...(planTreeOf(llmc)?.promises.length ? { promises: planTreeOf(llmc)!.promises } : {}),
    ...readiness, ...roadParts(llmc, observation, elapsedMinutes, seen.heldMs) }, llmcPlanTokens(plan));
  return withPlanFacts(live, planFacts);
}

/** What the chapter 8 facts need beyond the frame: the blows line (`HitWatch.line`), the time of the previous decision (ISO), the queue's inputs, the last results' stops. */
export interface JudgeParts { hits?: string | null; since?: string | undefined; ahead?: readonly ActInput[]; stops?: readonly string[] }
/** The facts' context from the plan's promises (the tree), and whether food is what she is short of (the near words' own reading). */
function factsContext(llmc: LlmcBodyParts, observation: BodyObservation | null, readiness: { shortage?: string; recovery?: string[] }, planFacts: PlanFacts | undefined,
  judge: JudgeParts = {}): FactsContext {
  const tree = planTreeOf(llmc), world = (observation?.state.world ?? {}) as Record<string, unknown>;
  const food = carriedFood(world, observation?.facts ?? {}), hunger = typeof world.food === 'number' && Number.isFinite(world.food) ? world.food : null;
  return { ...(judge.hits ? { hits: judge.hits } : {}), ...(tree?.promises.length ? { promises: tree.promises } : {}), ...(judge.since ? { since: judge.since } : {}),
    ...(judge.ahead?.length ? { ahead: judge.ahead } : {}), ...(judge.stops?.length ? { stops: judge.stops } : {}),
    wantsFood: wantsFood({ fullness: hunger, points: food.points, shortage: readiness.shortage ?? null, recovery: readiness.recovery ?? null, planFacts: planFacts ?? null }) };
}

/** The live body with the plan's facts as its internal field (none: as it is; a body that is not connected has no plan to read). */
function withPlanFacts(live: Record<string, unknown>, facts: PlanFacts | undefined): Record<string, unknown> {
  return facts && live.connected !== false ? { ...live, [PLAN_FACTS_KEY]: facts } : live;
}

/** The plan's tree, or null (none, or it could not be read). */
function planTreeOf(llmc: LlmcBodyParts): PlanTree | null {
  try { return llmc.planTree?.() ?? null; } catch { return null; }
}
/**
 * r6 (with the probe, as r4's parts): the current node before the map, what its stage lacks, and health that does not come back with
 * where food is (`minecraftLlmcReadiness.ts`). Facts only: what to do with them is the decision's.
 * The continue contract (chapter 7): `planFacts`, the plan's kinds as the code reads them (the stage that is checked, the knowledge of a stage, the near creatures a plan needs
 * all come from it, never from a title); `onceFacts`, the facts to say once (with a `taskId`: the preparation node she went down without meeting, offered when it
 * holds and taken back when the model has written `prep` on it). The code writes no `skipped`.
 */
export function readinessParts(llmc: LlmcBodyParts, view: object | null, observation: BodyObservation | null, taskId?: string)
  : { planNow?: string; shortage?: string; recovery?: string[]; planFacts?: PlanFacts; onceFacts?: OnceFact[] } {
  const facts = readinessOf(observation);
  const tree = planTreeOf(llmc), nodes = tree?.nodes ?? [], planNow = planNowOf(tree, view, observation);
  const planFacts = planFactsOf(tree) ?? undefined;
  const out = { ...(planNow ? { planNow } : {}), ...(planFacts ? { planFacts } : {}) };
  if (!facts) return out;
  const display = llmc.plan();
  // Run 43: the fuel for what she carries to smelt is a lack of its own, beside the stage's.
  const shortage = [preparationShortage({ dimension: facts.dimension, counts: facts.counts, food: facts.food, nowKinds: nowKinds(planFacts),
    worn: wornItems(facts.world.worn) }), fuelShortage(facts.world, facts.counts)].filter(Boolean).join('。') || null;
  const recovery = recoveryLine(facts.hunger, facts.health, facts.food, facts.counts);
  // r7 (runs 29, 30): no food and health that does not come back: the plan's food node is said before its now (the plan is not changed).
  const first = recovery && facts.food <= 0 && planNow ? foodFirstLine(nodes, display?.current ?? tree?.current ?? null, feetIn(facts.world)) : null;
  const onceFacts = taskId ? preparationFacts(taskId, tree, observation) : undefined;
  return { ...(planNow ? { planNow: first ? `${first}。その後に今の節 ${planNow}` : planNow } : {}), ...(shortage ? { shortage } : {}),
    ...(recovery ? { recovery: [recovery, foodLeads(facts.world, facts.dimension, nodes)] } : {}), ...(planFacts ? { planFacts } : {}),
    ...(onceFacts?.length ? { onceFacts } : {}) };
}

const PREP_FACT_KEY = 'prep_unmet:';
/**
 * Chapter 7 / chapter 8: she is below the surface with a preparation node unmet (the old `descentClosed` closed it and wrote that it was skipped). The head says the fact,
 * once (`minecraftLlmcOnceFacts.ts`); the node's `state` and `prep` are the model's. A fact still pending when the node no longer fits (done, or the model wrote `prep` on it) is taken
 * back; with no frame nothing is taken back (no frame says nothing). Returns the facts now pending for the task.
 */
function preparationFacts(taskId: string, tree: PlanTree | null, observation: BodyObservation | null): OnceFact[] {
  const frame = doneFacts(observation);
  if (!tree || !frame) return pending(taskId);
  const now = prepUnmetFacts(tree, frame);
  for (const fact of now) offer(taskId, fact.key, fact.text);
  for (const old of pending(taskId)) if (old.key.startsWith(PREP_FACT_KEY) && !now.some(fact => fact.key === old.key)) withdraw(taskId, old.key);
  return pending(taskId);
}

/** The current node (its id and title), from the tree; else from the display the body was given. */
function currentNodeOf(llmc: LlmcBodyParts): { id: string; title: string } | null {
  const tree = planTreeOf(llmc), node = tree?.current ? tree.nodes.find(item => item.id === tree.current) : undefined;
  if (node) return node;
  const display = llmc.plan();
  return display?.nodes.find(item => item.id === display.current) ?? null;
}

/** r6: an act with a wait hand, stored with the fact that health does not come back now (the same words as the live state's). */
export function withRecoveryFact(name: string, input: unknown, stored: string, observation: BodyObservation | null): string {
  if (name !== MC_ACT_TOOL) return stored;
  let hands: readonly { do?: string }[] = [];
  try { hands = (normalizeActInput(input).input as ActInput | null)?.hands ?? []; } catch { hands = []; }
  const facts = hands.some(hand => hand.do === 'wait') ? readinessOf(observation) : null;
  const recovery = facts ? recoveryLine(facts.hunger, facts.health, facts.food, facts.counts) : null;
  return recovery ? `${stored}\n頭: ${recovery}` : stored;
}

/**
 * r4: what the mode's body takes for its surprises and the body's scan. `probe`: the way to send one probe
 * to the body now (its result text, or null), or null while the body has no `probe`; `planWhere`: the current plan node's place.
 */
export interface LlmcProbeParts {
  probe(): ((input: ProbeInput, index: number) => Promise<string | null>) | null;
  planWhere(): string | null;
  /** r5: a fact noted on the current plan node's caution (true when the plan took it). Absent: none noted. */
  caution?(text: string): boolean;
}
/**
 * r5: the facts of the surprises met again this step (`cautionFact`), each from its own probes' answers, noted through `note`; how many the plan took.
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
 * r3: a long result is kept short in the history and shown whole once (`llmcStoredResult`), and a step is urgent (`urgentReasons`) while a hostile is
 * close or the last act was cut by one. Task queue: the live state shows the queue, and `queueLifecycle` adds its port. Everything else is as it was.
 */
export function withLlmcBody(body: FcaBodyLifecycle, parts: { llmc: LlmcBodyParts; taskId: string; createdAt: string;
  observe(): BodyObservation | null; arrival(): { at: number | null; kind: string | null }; now?: () => number; log?(line: string): void;
  queue?: LlmcQueue; // the task queue of the step (`minecraftLlmcQueue.ts`): the live state's lines, the lifecycle's port, a decision's staleness
  /**
   * mc-chat-stale-frame: the body as a decision reads it, a frame a few seconds old included (`MinecraftControl.seen`). Everything that
   * sends a command or watches for danger keeps `observe` (the current frame); only the decision's context and live read this. Absent:
   * the decision reads `observe`.
   */
  seen?(): { observation: BodyObservation; ageMs: number; current: boolean } | null;
  /**
   * Chapter 8 (the meter's clock): the time the task has been held in all, in ms (an operator's hold to its resume: `operatorAuditStore.heldMs`). The meter counts the seconds
   * without it, as the time limit does. Absent: none held.
   */
  heldMs?(): number;
  /** r4: surprises probed before the decision, and the body's scan in the live state. */
  r4: LlmcProbeParts;
  /**
   * Continue contract 5: this start of the head (`MinecraftControl.headBoot`), and who is told which observation each decision's context was read on
   * (`madeIn`: the commands that decision makes carry it). Absent: no decision names its frame (a test), and no answer is checked against the newest one.
   */
  headBoot?(): string;
  onRead?(madeIn: MadeIn | null): void }): FcaBodyLifecycle {
  const r4 = parts.r4, watch = createSurpriseWatch(parts.taskId);
  const now = parts.now ?? Date.now, events = createLlmcEvents(parts.taskId, now), began = Date.parse(parts.createdAt);
  // Chapter 8: every frame this step reads goes through the blows' watch (`createHitWatch`: the body's frames carry her health and no log of blows).
  const hitWatch: HitWatch = createHitWatch(now);
  const observeNoted = (): BodyObservation | null => { const frame = parts.observe(); hitWatch.note(frame); return frame; };
  const judge = (): JudgeParts => ({ hits: hitWatch.line(), since: events.since(), ahead: parts.queue?.ahead() ?? [], stops: events.stops() });
  const queueNow = (frame: BodyObservation | null): string[] => parts.queue ? queueNowLines(parts.queue.lines(frame), parts.queue.ahead()) : [];
  // The stops of the acts that ended (a go's or a vertical's distance left) are told with the next decision, from the receipt's result and not from its words.
  parts.queue?.onRan((_item, _result, receipt) => events.noteStops(receipt?.result));
  let observation: BodyObservation | null = null, bodyAge: string | null = null, reasons: string[] = [];
  /** Continue contract 5: the frame the last context read, as the commands name it (null: it had no life to name). */
  let read: MadeIn | null = null;
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
    const facts = urgentFacts(observation, events.cut(), sights, inSight);
    const readiness = readinessParts(parts.llmc, parts.llmc.planView() as object | null, observation);
    const live = minecraftLlmcUrgentLive({ observation, elapsedMinutes: minutes, events: events.shown(), lastResults: events.results(),
      urgent: [...(interrupted ? [`急ぎ: 判断を待つ間に ${interrupted}`] : []), ...facts.reasons], investigation, footing, bodyAge,
      planNowTitle: planNowTitle(currentNodeOf(parts.llmc)), queue: queueNow(observation), mode: URGENT_NOTE,
      recovery: readiness.recovery,
      ...(planTreeOf(parts.llmc)?.promises.length ? { promises: planTreeOf(parts.llmc)!.promises } : {}),
      ...(observation && observation.connected !== false
        ? { facts: inputFacts(observation, factsContext(parts.llmc, observation, readiness, readiness.planFacts, judge()), true).lines } : {}),
      once: onceFor(parts.taskId, 'urgent').map(fact => fact.text) });
    urgentTokens = llmcTokens(JSON.stringify(live));
    // The knowledge of a stage is picked from the plan's kinds in the raw live state, urgent or not (the rewrite takes `planFacts` out).
    return withPlanFacts(live, readiness.planFacts);
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
        parts.queue?.mark();
      }
      const value = body.context();
      // The body as a decision reads it: the current frame, or an older one (said how old in the live); none only past `LLMC_STALE_FRAME_MS`.
      const sight = parts.seen?.() ?? null;
      observation = parts.seen ? sight?.observation ?? null : observeNoted();
      if (parts.seen && observation) hitWatch.note(observation);
      bodyAge = sight && !sight.current ? staleBodyLine(sight.ageMs) : null;
      read = parts.headBoot ? madeInOf(observation, parts.headBoot()) : null;
      try { parts.onRead?.(read); } catch { /* naming a frame never fails a decision */ }
      // A decision that finds no body is noted: its task, if it waits for that, is woken when a frame is there (`fcaMinecraftBodyWake.ts`).
      noteBodySeen(parts.taskId, observation !== null, now());
      const arrival = parts.arrival();
      events.arrival(arrival.at, arrival.kind);
      events.take(healthOf(observation), again);
      if (!again) {
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
      const urgentNow = reasons.length > 0 || interrupted !== null;
      noteUrgentDecision(parts.taskId, urgentNow);
      if (urgentNow) return urgentState(minutes);
      return llmcTransient(parts.llmc, events, observation, minutes, reasons, { investigation, scan, unreachable, footing, bodyAge,
        queue: queueNow(observation), judge: judge(), ...(parts.heldMs ? { heldMs: parts.heldMs() } : {}) }, parts.taskId);
    },
    /** r8: a hostile she must act on that has come since the request was built (once a decision), see `FcaBodyLifecycle.interrupt`. */
    interrupt: (): string | null => {
      if (interrupted !== null) return null;
      interrupted = newApproach(observeNoted(), baseline, urgentMeters);
      return interrupted;
    },
    rebuilding: () => { rebuild = true; },
    /** Continue contract 5: the frame the last context read, and whether the body has left it (died, another generation of the dimension, another connection) since. */
    readOf: () => read,
    drifted: (value: MadeIn) => driftOf(value, parts.observe()),
    ...queueLifecycle({ queue: parts.queue, observe: observeNoted, arrival: () => parts.arrival().at, peek: () => watch.peek(),
      keep: text => events.keep(text) }, body),
    decided: ({ ms, aborted, thrownMs }: { ms: number; aborted: boolean; thrownMs: number }) => {
      if (urgentTokens !== null) {
        say(`Shannon Minecraft urgent decision task=${parts.taskId} ms=${ms} aborted=${aborted ? 1 : 0} ctxTokens=${urgentTokens}`
          + `${aborted ? ` thrownMs=${thrownMs}` : ''}`);
      }
      urgentTokens = null;
      interrupted = null;
    },
    /**
     * r4: before the decision, the surprises since the last one (`createSurpriseWatch`) and their fixed probes, sent at once and waited
     * for `LLMC_PROBE.budgetMs` at most (an urgent step's `urgentBudgetMs`); what came is said first in this decision's live state.
     * r7: beside them, the near hostiles looked at with the body's sight (`lookAtThreats`), for whether the step is urgent and its line.
     */
    async investigate(): Promise<FcaBodyInvestigation | null> {
      const seen = observeNoted();
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
    // No recall: the mode's live state shows none.
    recallWanted: () => false,
    // r5 (run 28: a plan row of run 27's task, in another world, was recalled with its coordinates): what was before this task is marked.
    recallCues: () => ({ ...(body.recallCues?.() ?? { words: [], tags: [] }), since: parts.createdAt }),
    urgent() {
      const facts = urgentFacts(observeNoted(), events.cut(), sights, inSight);
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
      return withRecoveryFact(call.name, call.input, stored, parts.observe());
    },
    noteResult(call, result, durationMilliseconds) {
      body.noteResult?.(call, result, durationMilliseconds);
      events.result(call.name, result.ok, result.bodyReflex === true, result.text);
      watch.noteResult(call.name, result.ok, result.text, call.input);
    },
  };
}

/** For tests: no task holds events. */
export function forgetLlmcEvents(): void {
  tasks.clear();
  urgentDecisions.clear();
  scansShown.clear();
}

/** mb-llmc-cand 11: the road and meter lines of a dragon task (`minecraftLlmcRoad.ts`); none for another task. */
function roadParts(llmc: LlmcBodyParts, observation: BodyObservation | null, minutes: number | null, heldMs = 0): { road?: string; meter?: string } {
  let tree: PlanTree | null = null;
  try { tree = llmc.planTree?.() ?? null; } catch { tree = null; }
  // Chapter 8: the meter's seconds are the seconds the task ran, without the time it was held (the time limit counts the same).
  const road = roadLine(tree), meter = meterLine(tree, observation, minutes, heldMs);
  return { ...(road ? { road } : {}), ...(meter ? { meter } : {}) };
}
