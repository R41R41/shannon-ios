import { factsContext,withPlanFacts,planTreeOf,readinessParts,currentNodeOf,withRecoveryFact,roadParts } from './minecraftLlmcBodyFacts.js';
import type { LlmcBodyParts,JudgeParts } from './minecraftLlmcBodyFacts.js';
import { tasks,urgentDecisions,noteUrgentDecision,urgentReasons,urgentMeters,urgentFacts,createLlmcEvents } from './minecraftLlmcEvents.js';
import type { LlmcEvents } from './minecraftLlmcEvents.js';
import type { BodyObservation,BodyValue } from '../../contracts/bodyControlContract.js';
import type { FcaBodyInvestigation,FcaBodyLifecycle } from '../../mind/action/fca/fcaPorts.js';
import type { ProbeInput } from '../../contracts/minecraftProbeContract.js';
import {
bodyAgeField,llmcPlanTokens,llmcTokens,minecraftLlmcLive,minecraftLlmcUrgentLive,staleBodyLine
} from './minecraftLlmcLive.js';
import { noteBodySeen } from './minecraftBodyAbsent.js';
import { lookAtFooting } from './minecraftLlmcFooting.js';
import { approachingIds,newApproach,planNowTitle,URGENT_NOTE } from './minecraftLlmcUrgent.js';
import { createHitWatch,inputFacts,onceFor,queueNowLines,type HitWatch } from './minecraftLlmcFacts.js';
import { llmcStoredResult } from './minecraftLlmc.js';
import {
createSurpriseWatch,LLMC_PROBE,runInvestigation,scanLines,stepProbes,surpriseFrame,type Surprise,type SurpriseFrame,
} from './minecraftLlmcProbe.js';
import { cautionFact } from './minecraftLlmcCaution.js';
import { activeMinutes } from './minecraftLlmcRoad.js';
import {
inSightLine,keepThreatSight,keptThreatSight,nearThreats,readThreatSight,sightProbe,threatSightKey,
threatSightMeters,threatSightTargets,walledOff,type NearThreat,type ThreatSight
} from './minecraftLlmcThreat.js';
import { queueLifecycle,type LlmcQueue } from './minecraftLlmcQueueBody.js';
import { driftOf,madeInOf } from './minecraftMadeIn.js';
import type { MadeIn } from '../../contracts/continueContract.js';
export { readinessParts, staleNodeFacts, withRecoveryFact } from './minecraftLlmcBodyFacts.js';
export type { LlmcBodyParts, JudgeParts } from './minecraftLlmcBodyFacts.js';
export { urgentDecision, LLMC_URGENT_NEAR_METERS, urgentReasons, urgentMeters, urgentFacts, createLlmcEvents } from './minecraftLlmcEvents.js';
export type { LlmcEvents } from './minecraftLlmcEvents.js';

/** The first index of the hostiles' sight probes in a step (the surprises' are 0 and 1), and of the footing's
 * column probes (r8). */
const THREAT_SIGHT_INDEX = 10, FOOTING_INDEX = 20;

/** The live body of an LLM-centric decision: the map-first state, bounded beside the plan's path. */
export function llmcTransient(llmc: LlmcBodyParts, events: LlmcEvents, observation: BodyObservation | null,
  elapsedMinutes: number | null, urgent: readonly string[] = [],
  seen: { investigation?: readonly string[]; scan?: readonly string[]; unreachable?: readonly string[]; footing?: string | null;
    bodyAge?: string | null; queue?: readonly string[];
    /** Chapter 8: what the facts need beyond the frame (`JudgeParts`); the held time of the task (ms), which the
 * meter's clock leaves out. */
    judge?: JudgeParts; heldMs?: number } = {}, taskId?: string)
  : Record<string, unknown> {
  const plan = llmc.planView();
  const world = observation?.state.world as Record<string, unknown> | undefined;
  const jobs = world && (world.jobs ?? world.activeFurnaces) as BodyValue | undefined;
  // Chapter 7: `planFacts` is the machine's reading of the plan's kinds (outside the live state's bound: the
// rewrite takes it out, the model is not shown it); `onceFacts` the
  // facts to say once (`minecraftLlmcOnceFacts.ts`).
  // Chapter 8: the facts said once go first in the input's `events` (`onceFor`: those this version takes);
// `deliverOnceFacts` marks them delivered when the request's bytes hold them.
  const { planFacts, onceFacts: _onceFacts, ...readiness } = readinessParts(llmc, plan, observation, taskId);
  const facts = observation && observation.connected !== false
    ? inputFacts(observation, factsContext(llmc, observation, readiness, planFacts, seen.judge), false) : null;
  const once = taskId ? onceFor(taskId, 'normal').map(fact => fact.text) : [];
  const live = minecraftLlmcLive({ observation, elapsedMinutes: activeMinutes(elapsedMinutes, seen.heldMs), trend: events.trend, events:
     events.shown(), ...(jobs ? { jobs } : {}),
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
 * r5: the facts of the surprises met again this step (`cautionFact`), each from its own probes' answers, noted
 * through `note`; how many the plan took.
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
 * A body task's lifecycle in the mode: its live state is the map-first one (`llmcTransient`), the events since
 * the last decision are read
 * at each context (an arrival of the body; a result a reflex cut or that failed), and a recall is wanted only
 * after one (design 2.3).
 * r3: a long result is kept short in the history and shown whole once (`llmcStoredResult`), and a step is urgent
 * (`urgentReasons`) while a hostile is
 * close or the last act was cut by one. Task queue: the live state shows the queue, and `queueLifecycle` adds
 * its port. Everything else is as it was.
 */
export function withLlmcBody(body: FcaBodyLifecycle, parts: { llmc: LlmcBodyParts; taskId: string; createdAt: string;
  observe(): BodyObservation | null; arrival(): { at: number | null; kind: string | null }; now?: () => number; log?(line: string): void;
  queue?: LlmcQueue; // the task queue of the step (`minecraftLlmcQueue.ts`): the live state's lines, the lifecycle's port, a decision's staleness
  /**
   * mc-chat-stale-frame: the body as a decision reads it, a frame a few seconds old included
 * (`MinecraftControl.seen`). Everything that
   * sends a command or watches for danger keeps `observe` (the current frame); only the decision's context and
 * live read this. Absent:
   * the decision reads `observe`.
   */
  seen?(): { observation: BodyObservation; ageMs: number; current: boolean } | null;
  /**
   * Chapter 8 (the meter's clock): the time the task has been held in all, in ms (an operator's hold to its
 * resume: `operatorAuditStore.heldMs`). The meter counts the seconds
   * without it, as the time limit does. Absent: none held.
   */
  heldMs?(): number;
  /** r4: surprises probed before the decision, and the body's scan in the live state. */
  r4: LlmcProbeParts;
  /**
   * Continue contract 5: this start of the head (`MinecraftControl.headBoot`), and who is told which observation
 * each decision's context was read on
   * (`madeIn`: the commands that decision makes carry it). Absent: no decision names its frame (a test), and no
 * answer is checked against the newest one.
   */
  headBoot?(): string;
  onRead?(madeIn: MadeIn | null): void }): FcaBodyLifecycle {
  const r4 = parts.r4, watch = createSurpriseWatch(parts.taskId);
  const now = parts.now ?? Date.now, events = createLlmcEvents(parts.taskId, now), began = Date.parse(parts.createdAt);
  // Chapter 8: every frame this step reads goes through the blows' watch (`createHitWatch`: the body's frames
// carry her health and no log of blows).
  const hitWatch: HitWatch = createHitWatch(now);
  const observeNoted = (): BodyObservation | null => { const frame = parts.observe();
    hitWatch.note(frame);
    return frame; };
  const judge = (): JudgeParts => ({ hits: hitWatch.line(), since: events.since(), ahead: parts.queue?.ahead() ?? [], stops: events.stops() });
  const queueNow = (frame: BodyObservation | null): string[] => parts.queue ? queueNowLines(parts.queue.lines(frame), parts.queue.ahead()) : [];
  // The stops of the acts that ended (a go's or a vertical's distance left) are told with the next decision, from
// the receipt's result and not from its words.
  parts.queue?.onRan((_item, _result, receipt) => events.noteStops(receipt?.result));
  let observation: BodyObservation | null = null, bodyAge: string | null = null, reasons: string[] = [];
  /** Continue contract 5: the frame the last context read, as the commands name it (null: it had no life to name). */
  let read: MadeIn | null = null;
  let investigation: string[] = [], scan: string[] = [];
  // r7: what the body's sight found of the near hostiles this step (by id), the line said first after a stopIf
// stop, and the walled-off.
  let sights = new Map<number, ThreatSight>(), inSight: string | null = null, unreachable: string[] = [];
  // r8: the footing's line; the hostiles she had to act on when the request was built (`approachingIds`) and the
// one that came while it was
  // awaited (`interrupted`: the decision is then asked again, `rebuild`: on the same events); the tokens of an
// urgent state (logged with its seconds).
  let footing: string | null = null, baseline = new Set<number>(), interrupted: string | null = null, rebuild = false, urgentTokens: number | null = null;
  const say = (line: string) => { try { (parts.log ?? (text => console.info(text)))(line); } catch { /* a log never fails a step */ } };
  /**
   * r8: the footing round her feet, from the map and the body's `column` probes for the gaps the map cannot
 * measure (`lookAtFooting`), at
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
  /** r8: the live state of an urgent decision (`minecraftLlmcUrgentLive`), made on the frame now; its tokens are
 * kept for the log of its seconds. */
  const urgentState = (minutes: number | null): Record<string, unknown> => {
    const facts = urgentFacts(observation, events.cut(), sights, inSight);
    const readiness = readinessParts(parts.llmc, parts.llmc.planView() as object | null, observation);
    const live = minecraftLlmcUrgentLive({ observation, elapsedMinutes: activeMinutes(minutes, parts.heldMs?.()), events: events.shown(),
       lastResults: events.results(),
      urgent: [...(interrupted ? [`急ぎ: 判断を待つ間に ${interrupted}`] : []), ...facts.reasons], investigation, footing, bodyAge,
      planNowTitle: planNowTitle(currentNodeOf(parts.llmc)), queue: queueNow(observation), mode: URGENT_NOTE,
      recovery: readiness.recovery,
      ...(planTreeOf(parts.llmc)?.promises.length ? { promises: planTreeOf(parts.llmc)!.promises } : {}),
      ...(observation && observation.connected !== false
        ? { facts: inputFacts(observation, factsContext(parts.llmc, observation, readiness, readiness.planFacts, judge()), true).lines } : {}),
      once: onceFor(parts.taskId, 'urgent').map(fact => fact.text) });
    urgentTokens = llmcTokens(JSON.stringify(live));
    // The knowledge of a stage is picked from the plan's kinds in the raw live state, urgent or not (the rewrite
// takes `planFacts` out).
    return withPlanFacts(live, readiness.planFacts);
  };
  /**
   * r7: the near hostiles (`threatSightTargets`) looked at with the body's sight, at once, beside the surprises' probes, waited
   * `LLMC_PROBE.urgentBudgetMs` at most; an answer for the same hostile, block and feet is kept for the task.
 * After a stopIf stop, the
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
      // r8: after an interrupt this is the same decision's context again: what the first showed once (events, results,
// the scan) stands.
      const again = rebuild;
      rebuild = false;
      if (!again) {
        interrupted = null;
        urgentTokens = null;
        parts.queue?.mark();
      }
      const value = body.context();
      // The body as a decision reads it: the current frame, or an older one (said how old in the live); none only past
// `LLMC_STALE_FRAME_MS`.
      const sight = parts.seen?.() ?? null;
      observation = parts.seen ? sight?.observation ?? null : observeNoted();
      if (parts.seen && observation) hitWatch.note(observation);
      bodyAge = sight && !sight.current ? staleBodyLine(sight.ageMs) : null;
      read = parts.headBoot ? madeInOf(observation, parts.headBoot()) : null;
      try { parts.onRead?.(read); } catch { /* naming a frame never fails a decision */ }
      // A decision that finds no body is noted: its task, if it waits for that, is woken when a frame is there
// (`fcaMinecraftBodyWake.ts`).
      noteBodySeen(parts.taskId, observation !== null, now());
      const arrival = parts.arrival();
      events.arrival(arrival.at, arrival.kind);
      events.take(healthOf(observation), again);
      if (!again) {
const beginContextRead = () => {
        // r4: a new scan of the body (a spawn, a portal, a respawn) is shown once.
        const shown = scanLines((observation?.state.world as { scan?: unknown } | undefined)?.scan, scansShown.get(parts.taskId) ?? null);
        scan = shown?.lines ?? [];
        if (shown) {
          scansShown.delete(parts.taskId);
          scansShown.set(parts.taskId, shown.at);
          if (scansShown.size > 32) scansShown.delete(scansShown.keys().next().value as string);
        }

};
beginContextRead();
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
    /** r8: a hostile she must act on that has come since the request was built (once a decision), see
 * `FcaBodyLifecycle.interrupt`. */
    interrupt: (): string | null => {
      if (interrupted !== null) return null;
      interrupted = newApproach(observeNoted(), baseline, urgentMeters);
      return interrupted;
    },
    rebuilding: () => { rebuild = true; },
    /** Continue contract 5: the frame the last context read, and whether the body has left it (died, another
 * generation of the dimension, another connection) since. */
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
     * r4: before the decision, the surprises since the last one (`createSurpriseWatch`) and their fixed probes, sent
 * at once and waited
     * for `LLMC_PROBE.budgetMs` at most (an urgent step's `urgentBudgetMs`); what came is said first in this
 * decision's live state.
     * r7: beside them, the near hostiles looked at with the body's sight (`lookAtThreats`), for whether the step is
 * urgent and its line.
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
    // r5 (run 28: a plan row of run 27's task, in another world, was recalled with its coordinates): what was before
// this task is marked.
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
