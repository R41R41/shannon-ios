import { randomUUID } from 'node:crypto';
import { actionPermit, currentActionExecution, inActionExecution } from '../../../infra/context/actionExecution.js';
import { actionResource } from '../../../contracts/actionThreadContract.js';
import { sessionMarked } from './autonomyLoopProvenance.js';
import { autonomyDayKey, yenFromUsd } from '../../inhibition/inhibitionPorts.js';
import { autonomyModelCostUsd } from './autonomyModels.js';
import { observeStep, sentBeforeStop } from './autonomyLoopObserve.js';
import { closeSession, fitsSession, idleBefore, mayRetryThought, nothingDone, ownerTalking, restMilliseconds, sessionBound, sessionOf, startMomentCycle, startSessionIfDue } from './autonomyLoopPacing.js';
import { REACH_OUT_REASON_LABEL } from './autonomyLoopPrompts.js';
import type { AutonomySession, SessionEndCode } from './store/autonomyLoopSessions.js';
import { noteProvenance, shownLater } from './autonomyLoopProvenance.js';
import type { AutonomyLoopCycle, AutonomyLoopReadiness, AutonomyLoopStep, AutonomyPlannedStep } from './store/autonomyLoopState.js';
import { toolRefusalLine } from './autonomyLoopToolStep.js';
import { adaptersFor, prepareStep, unpreparedCode, type PreparedStep, type StepCommit, type StepDependencies, type StepResult } from './autonomyLoopSteps.js';
import type { RecordedDecision } from './autonomyService.js';
import { resolveAutonomyModel } from './autonomyTextModel.js';
import { actionFailureCode, recoverActionAcknowledgements, saveCycleAcknowledgement, saveStepAcknowledgement, saveUnusedAcknowledgement, stepAcknowledged } from './autonomyActionAcknowledgements.js';

/**
 * The activity loop of bounded autonomy (Syzygy ADR-0002 step 3). Core.
 *
 * One call to `tick` does at most one step: decide the next small step, ask
 * `authorizeAutonomousAction` through the service, carry it out with the adapter of the
 * allowed domain, and report it with its actual usage to the activity record. Nothing
 * here decides what is allowed: the switch, the stop switch, the budget, and the
 * domains are the gate's. The loop only refrains from asking when the answer is known
 * (off, paused), so the record is not filled with refusals.
 *
 * A step's outcome is kept as an observation, and one that could change her plan puts a thinking step
 * at the front of the plan, a bounded number of times per cycle (`autonomyLoopObserve.ts`; owner decision
 * 2026-10-02). That thinking step is a step like any other: journalled, asked of the gate, counted.
 *
 * Her day is paced in sessions (owner decision 2026-10-02, ADR-0003; `autonomyLoopPacing.ts`): a cycle that goes on, thinking
 * again whenever its plan is done, until she rests or a bound stops it, and that stands still while the owner talks.
 * `SHANNON_AUTONOMY_PACING=cycles` restores the fixed cycles: no session is opened and nothing below takes a session's path.
 *
 * It runs in its own process, apart from the API, so chat and voice never wait for it.
 * A single lease in SQLite lets exactly one runner step; a second runner idles. The
 * loop starts no process, no additional runner, and no copy of itself.
 */
export type AutonomyLoopTick =
  | 'not-leader' | 'disabled' | 'not-configured' | 'paused' | 'idle' | 'owner-active' | 'budget' | 'stepped' | 'cycle-ended' | 'thread-wait';

export interface AutonomyLoopDependencies extends StepDependencies {
  /** The loop's clock; a step that waits reads the same one. */
  now: () => string;
  workerId?: string;
}

export class ShannonAutonomyLoop {
  readonly workerId: string;
  private readonly scopeKey: string;

  private readonly dependencies: AutonomyLoopDependencies;

  constructor(dependencies: AutonomyLoopDependencies) {
    this.workerId = dependencies.workerId ?? `autonomy-${randomUUID()}`;
    this.scopeKey = dependencies.loop.scopeKey;
    // A step that waits keeps this runner's lease and heartbeat alive.
    this.dependencies = { ...dependencies, renew: () => this.renew() };
  }

  /** Renews the lease from inside a waiting step. False when another runner has it. */
  private renew(): boolean {
    const { store, loop, now } = this.dependencies;
    const at = now();
    return store.loop.acquireLease(this.workerId, at, new Date(Date.parse(at) + loop.leaseMilliseconds).toISOString(), this.readiness());
  }

  /** Off unless the server switch is on and a dedicated credential can serve both thinking and prose. */
  readiness(): AutonomyLoopReadiness {
    const { config, model, store } = this.dependencies;
    if (!config.enabled) return 'disabled';
    const preferences = store.modelPreferences(this.scopeKey);
    const usable = (purpose: 'planning' | 'prose') => resolveAutonomyModel(purpose, preferences, id => model.canUse(id)) !== null;
    return usable('planning') && usable('prose') ? 'ready' : 'no_credential';
  }

  async tick(signal?: AbortSignal): Promise<AutonomyLoopTick> {
    const { store, loop, now } = this.dependencies;
    if(this.dependencies.actionSteps && !await recoverActionAcknowledgements(store,this.dependencies.actionSteps,this.scopeKey))return 'thread-wait';
    const at = now();
    const readiness = this.readiness();
    const leaseUntil = new Date(Date.parse(at) + loop.leaseMilliseconds).toISOString();
    if (!store.loop.acquireLease(this.workerId, at, leaseUntil, readiness)) return 'not-leader';
    if (readiness === 'disabled') return this.standingStill('disabled', at);
    if (readiness === 'no_credential') return this.standingStill('not-configured', at);
    // A stop switch that cannot be read counts as on, as in the gate.
    let paused = true;
    try { paused = store.control(this.scopeKey).paused; } catch { paused = true; }
    if (paused) return this.standingStill('paused', at);
    this.closeInterruptedSteps(at);
    // A file handed to a device that never reported back is closed as failed, also when that device stays away.
    try { this.dependencies.service.folder.closeOverdue(this.scopeKey, at); } catch { /* the next claim or tick closes it */ }
    const cycle = store.loop.openCycle(this.scopeKey) ?? this.startCycleIfDue(at);
    if(typeof cycle==='string')return cycle;
    const runner=this.dependencies.actionSteps;
    if(!runner)return this.advance(cycle,at,signal);
    const active=await runner.begin(this.scopeKey,cycle.id,sessionMarked(this.dependencies,cycle),signal);
    if(!active){
      // The session's own action stayed unknown past the release deadline: end it unreplayed, so the next gets a fresh action.
      if(await runner.abandoned?.(this.scopeKey,cycle.id).catch(()=>false))return this.abandonCycle(cycle,at);
      return this.standingStill('thread-wait',at);
    }
    const heartbeat=setInterval(()=>this.renew(),5_000);heartbeat.unref();
    let tick:AutonomyLoopTick;
    try{tick=await inActionExecution(active.execution,()=>this.advance(cycle,at,active.execution.signal));}finally{clearInterval(heartbeat);}
    if(tick==='cycle-ended')await runner.end('completed','cycle_ended');
    return tick;
  }

  /** While she may not act, an open session stands still: that time does not count against its clock. Under `cycles` nothing is read or written. */
  private standingStill<T extends AutonomyLoopTick>(tick: T, at: string): T {
    if (this.dependencies.loop.pacing !== 'sessions') return tick;
    try {
      const open = this.dependencies.store.loop.openCycle(this.scopeKey);
      if (open) this.dependencies.store.loop.sessions.hold(open.id, at);
    } catch { /* the clock keeps running; the session only ends sooner */ }
    return tick;
  }

  /** Lets another runner take over at once; called when this process stops. */
  release(): void {
    this.dependencies.store.loop.releaseLease(this.workerId, this.dependencies.now());
  }

  private startCycleIfDue(at: string): AutonomyLoopCycle | AutonomyLoopTick {
    const moment = startMomentCycle(this.dependencies, this.scopeKey, at); // A moment she wanted to speak of (owner decision 2026-10-14).
    if (moment) return moment;
    if (this.dependencies.executive) return this.dependencies.executive.startIfDue(this.dependencies, this.scopeKey, at); // ADR-0009 E5.
    const { store, service, config, loop, showing } = this.dependencies;
    const dayKey = autonomyDayKey(at, config);
    // A piece she called 「見せてもいい」 but has not told him about: one step of its own, when she may speak.
    const untold = store.study.list(this.scopeKey).find(piece => piece.kind === 'story' && piece.status === 'ready');
    // A marked story waits while anyone else may see her words (ADR-0007), rather than starting a step that would only wait.
    if (untold && showing.mayMessageNow(this.scopeKey, at) === 'ok' && !shownLater(this.dependencies, { id: '', scopeKey: this.scopeKey }, untold.id, at)) {
      return store.loop.startCycle(this.scopeKey, dayKey, 'show', [{ kind: 'show', pieceId: untold.id }], at);
    }
    if (loop.pacing === 'sessions') return startSessionIfDue(this.dependencies, this.scopeKey, at);
    const next = store.loop.nextCycleAt(this.scopeKey);
    if (next && Date.parse(at) < Date.parse(next)) return 'idle';
    if (store.loop.activityCyclesOn(this.scopeKey, dayKey) >= loop.cyclesPerDay) return 'idle';
    if (!this.dependencies.concurrentActions && loop.ownerActiveMilliseconds > 0
      && showing.ownerActiveSince(this.scopeKey, new Date(Date.parse(at) - loop.ownerActiveMilliseconds).toISOString())) return 'owner-active';
    // Once the day's cap has stopped a step she rests until tomorrow, or until the owner raises today's cap.
    const budget = service.overview(this.scopeKey).budget;
    if (budget.exhausted || store.loop.budgetBlocked(this.scopeKey, dayKey, budget.capYen)) return 'budget';
    return store.transaction(() => {
      store.loop.setNextCycleAt(this.scopeKey, new Date(Date.parse(at) + loop.cycleIntervalMilliseconds).toISOString());
      return store.loop.startCycle(this.scopeKey, dayKey, 'activity', [], at);
    });
  }

  private async advance(cycle: AutonomyLoopCycle, at: string, signal?: AbortSignal): Promise<AutonomyLoopTick> {
    const { store, service, loop, now } = this.dependencies;
    const plan = [...cycle.plan];
    let step: AutonomyPlannedStep | undefined;
    let prepared: PreparedStep | null = null;
    let session = sessionOf(this.dependencies, cycle);
    let stop: Exclude<SessionEndCode, 'rest'> | null = null;
    // Steps of a session's plan that could not be carried out when their turn came, as closed codes.
    const unprepared: string[] = [];
    if (session) {
      // He started talking: she stands back at once, before the next step, and her plan waits as it is.
      if (ownerTalking(this.dependencies, this.scopeKey, at)) {
        store.loop.sessions.hold(cycle.id, at);
        return 'owner-active';
      }
      if (session.heldAt) {
        store.loop.sessions.release(cycle.id, at);
        session = store.loop.sessions.get(cycle.id) ?? session;
      }
      stop = sessionBound(this.dependencies, cycle, session, at);
    }
    // The next step that can be carried out; one that cannot (nothing to note, an unknown piece) is dropped unasked.
    while (!prepared) {
      if (session) {
        const next = this.nextSessionStep(cycle, plan, stop, unprepared);
        // The session could not be closed by a step of its own: it is closed here, so it can never go on unbounded.
        if (!next) return this.endSession(cycle, stop ?? 'no_plan', at);
        step = next;
      } else {
        if (cycle.stepsTaken >= loop.maximumStepsPerCycle) return this.endCycle(cycle, 'step-limit', at);
        step = plan.shift() ?? (cycle.kind === 'activity' && !cycle.thought ? { kind: 'think' } : undefined);
        if (!step) return this.endCycle(cycle, 'plan-done', at);
      }
      prepared = prepareStep(this.dependencies, cycle, step, at);
      if (session) {
        if (!prepared && step.kind === 'rest') return this.endSession(cycle, step.forced ?? 'rest', at);
        // Without a thought there is no next step, and a paid step that does not fit what one session may spend ends it.
        if (!prepared && step.kind === 'think') stop = 'no_plan';
        else if (!prepared) unprepared.push(unpreparedCode(this.dependencies, cycle, step));
        if (prepared?.request.paid && !fitsSession(this.dependencies, cycle, prepared.request.paid.estimatedCostYen)) {
          // A step the session's budget stopped, not a rest she chose (ADR-0008 §14).
          this.dependencies.service.tools.note(this.scopeKey, 'autonomy', prepared.request.tool ?? prepared.request.domain, 'session_budget');
          stop = 'session_budget';
          prepared = null;
        }
        continue;
      }
      // Without a model there is no first thought and no cycle; a second thought that cannot be had is simply skipped.
      if (!prepared && step.kind === 'think' && !step.again) return this.endCycle(cycle, 'no-model', at);
    }
    const current = step!;
    const ready = prepared;
    const execution=currentActionExecution(),runner=this.dependencies.actionSteps;
    const reservationId=`call-${randomUUID()}`;
    // Reservations precede the existing authorization transaction; a denied step releases only this known unused estimate.
    const paid=ready.request.paid;
    if(execution && runner && paid){
      const budget=service.overview(this.scopeKey).budget;
      if(!await runner.reserve(execution.lease,reservationId,autonomyDayKey(at,this.dependencies.config),paid.estimatedCostYen,budget.capYen,budget.spentYen))return 'thread-wait';
    }

    // Journal the step and ask the gate in one transaction: after a crash either both exist or neither.
    const begun = store.transaction(() => {
      if (!store.loop.holdsLease(this.workerId, at)) { if(paid)saveUnusedAcknowledgement(store,this.scopeKey,reservationId,execution,'not_leader');return null; }
      const row = store.loop.beginStep(cycle, current, plan, at);
      const decision = service.authorize(this.scopeKey, ready.request);
      const allowed = decision.decision === 'allow' && (decision.domain as string) === ready.request.domain;
      if (allowed) store.loop.markAuthorized(row.id, decision.activityId, ready.estimate);
      else { store.loop.finishStep(row.id, 'refused', at, decision.activityId);if(paid)saveUnusedAcknowledgement(store,this.scopeKey,reservationId,execution,'refused'); }
      return { row, decision, allowed };
    });
    if (!begun) {
      if(execution && runner && paid)await recoverActionAcknowledgements(store,runner,this.scopeKey);
      return 'not-leader';
    }
    if (!begun.allowed) {
      if(execution && runner && paid)await recoverActionAcknowledgements(store,runner,this.scopeKey);
      return this.refused(cycle,begun.row,plan,ready,begun.decision,at);
    }
    // Syzygy ADR-0008 stage 1: a step the gate allowed is a choice of hers (write-only, closed values; refused ones never are).
    this.choice(tap => tap.chose?.(this.scopeKey, {
      stepId: begun.row.id, kind: current.kind, ...(current.reason ? { reason: current.reason } : {}), ...(current.call ? { call: true } : {}), ...(current.tool ? { tool: current.tool } : {}),
    }, at));

    let result: StepResult;
    let performing=false;
    if(execution){delete execution.modelOutcome;delete execution.modelUsage;delete execution.stepOutcome;}
    try {
      const resource=ready.request.host?`folder:${ready.request.host}`:'study';
      await actionPermit(ready.request.host?[actionResource(this.scopeKey,resource)]:[]);
      if(execution && (execution.signal.aborted || store.control(this.scopeKey).paused))throw new Error('ACTION_STOPPED');
      performing=true;
      result = await ready.perform(adaptersFor(begun.decision, this.dependencies), at, signal);
    } catch(error) {
      result = { outcome: 'failed', summary: '一歩の途中で、うまくいかなくなりました。',
        ...(execution?.modelUsage?{usage:execution.modelUsage}:{}),acknowledged:!performing||error instanceof Error&&error.message==='ACTION_STOPPED' };
    }
    if(execution)execution.stepOutcome=stepAcknowledged(current.kind,result,execution)?'acknowledged':'unknown';
    if(execution && !this.renew())result={...result,outcome:'failed',commit:undefined,reasonCode:'action_unknown'};
    if(execution)try{await actionPermit(result.commit?[actionResource(this.scopeKey,'study')]:[]);}catch{result={...result,outcome:'failed',commit:undefined,reasonCode:'action_unknown'};}
    const reportedAt = now();
    if(execution?.signal.aborted)result={...result,outcome:'failed',commit:undefined,reasonCode:'action_unknown',summary:'停止を受け取りました。送った処理の結果を確かめる必要があります。'};
    const reported = this.report(cycle, begun.row, begun.decision, ready, result, plan, reportedAt,reservationId);
    if(execution && runner){
      if(await runner.checkpoint(execution.lease,reservationId,reported.saved===true?result.usage?this.costYen(ready,result):0:null,current.kind,actionFailureCode(result,execution)).catch(()=>false))
        store.deliveredActionAcknowledgement(reservationId);
      if(execution.signal.aborted){
        // Only a returned provider/closed executor result and the canonical report acknowledge a stop.
        const acknowledged=reported.saved===true && execution.modelOutcome!=='unknown'
          && (current.kind==='think' || execution.stepOutcome==='acknowledged');
        await runner.end(acknowledged?'cancelled':'unknown',acknowledged?'stop_acknowledged':'step_interrupted').catch(()=>{});
      }
    }
    this.emitStep(current, begun.row.id, result.tool ?? ready.request.tool, result, reportedAt);
    this.choice(tap => tap.reported?.(this.scopeKey, {
      stepId: begun.row.id, outcome: reported.saved === 'unknown' ? 'void' : reported.saved ? result.outcome : 'failed', costYen: this.costYen(ready, result),
      ...(/^shannon-study:\/\/[A-Za-z0-9][A-Za-z0-9_:-]{0,119}$/u.test(reported.link ?? '') ? { pieceId: reported.link!.slice('shannon-study://'.length) } : {}),
    }, reportedAt));
    // Her rest, or the one a bound put in her plan, has closed the session.
    return current.kind === 'rest' && !store.loop.openCycle(this.scopeKey) ? 'cycle-ended' : 'stepped';
  }

  /**
   * The next step of a session, or null when the session must be closed without one. A bound that stopped it, or a plan
   * that ran out with nothing decided, becomes a `rest` step, so the reason is asked of the gate and recorded like her own.
   * Past the step limit there is room for that closing step and its retries only.
   */
  private nextSessionStep(cycle: AutonomyLoopCycle, plan: AutonomyPlannedStep[], stop: Exclude<SessionEndCode, 'rest'> | null, unprepared: readonly string[] = []): AutonomyPlannedStep | null {
    const { store, loop } = this.dependencies;
    if (cycle.stepsTaken >= loop.maximumStepsPerSession + SESSION_CLOSING_STEPS) return null;
    if (stop) {
      // She had already decided to rest next: her own reason and time stand.
      const own = plan[0]?.kind === 'rest' ? plan[0] : null;
      plan.length = 0;
      return own ?? { kind: 'rest', forced: stop };
    }
    const planned = plan.shift();
    if (planned) return planned;
    if (!cycle.thought) return { kind: 'think' };
    const done = store.loop.steps(cycle.id);
    const last = done.at(-1)?.step;
    if (last?.kind === 'rest') return done.at(-2)?.step.kind === 'rest' ? null : last;
    // The plan ran out because steps of it could not be carried out: she is told which and why when she thinks again.
    const dropped = [...new Set(unprepared)].slice(0, 8);
    if (dropped.length) { try { this.dependencies.log?.(`plan unprepared:${dropped.join(',')}`); } catch { /* the log is optional */ } }
    // A thought none of whose steps could be carried out is thought once more, inside the re-think limit; then, and after a
    // thought that named nothing, the session ends.
    if (!last || last.kind === 'think') {
      return dropped.length && mayRetryThought(this.dependencies, cycle, cycle.stepsTaken) ? { kind: 'think', again: true, dropped } : { kind: 'rest', forced: 'no_plan' };
    }
    return { kind: 'think', again: true, ...(dropped.length ? { dropped } : {}) };
  }

  /**
   * Syzygy ADR-0008 stage 3: a step of hers that did something (not a thought or a rest) is handed to the mind as closed values
   * (`emitMindEvent`), so the conversation's workspace can say what she did; who could see her decides who may be told.
   */
  private emitStep(step: AutonomyPlannedStep, stepId: string, named: string | undefined, result: StepResult, at: string): void {
    const emit = this.dependencies.emitMindEvent;
    if (!emit || step.kind === 'think' || step.kind === 'rest' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u.test(stepId)) return;
    try {
      let others = false;
      try { others = this.dependencies.reachOuts?.audience(this.scopeKey, at) != null; } catch { others = true; }
      const tool = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u.test(named ?? '') ? named! : step.kind;
      emit(this.scopeKey, { kind: 'own_time_step', code: result.outcome === 'done' ? 'done' : 'failed', audience: others ? 'others' : 'owner', source: 'own_time', sourceId: stepId, tool }, at);
    } catch { /* the mind never stops a step */ }
  }

  /** Hands the prediction tap one closed fact about a choice of hers; it never stops a step. */
  private choice(operation: (tap: NonNullable<StepDependencies['prediction']>) => void): void {
    const tap = this.dependencies.prediction;
    if (tap) { try { operation(tap); } catch { /* the ledger never stops a step */ } }
  }

  /** What a step cost in yen: its model's usage at the price table, or nothing for a free step. */
  private costYen(prepared: PreparedStep, result: StepResult): number {
    const paid = prepared.request.paid;
    if (!paid) return 0;
    const usd = result.usage ? autonomyModelCostUsd(paid.model, result.usage, this.dependencies.config.modelPrices) : null;
    return usd === null ? paid.estimatedCostYen : yenFromUsd(usd, this.dependencies.config);
  }

  /** The product, the record entry with its actual cost, and the journal close commit together. */
  private report(
    cycle: AutonomyLoopCycle, row: AutonomyLoopStep, decision: RecordedDecision, prepared: PreparedStep,
    result: StepResult, plan: readonly AutonomyPlannedStep[], at: string,reservationId:string,
  ): { saved: boolean | 'unknown'; link?: string } {
    const { store, service } = this.dependencies;
    const usage = result.usage && prepared.request.paid ? { ...result.usage, ...(prepared.purpose ? { purpose: prepared.purpose } : {}) } : undefined;
    const state: { saved: boolean | 'unknown'; link?: string } = { saved: false };
    try {
      store.transaction(() => {
        // Already closed means another runner took the lease and abandoned it; it is not counted twice.
        if ((currentActionExecution() && !store.loop.holdsLease(this.workerId,at)) || !store.loop.finishStep(row.id, 'reported', at)) { state.saved = 'unknown'; return; }
        state.saved = true;
        const committed = (result.commit?.(plan, at) || undefined) as StepCommit | undefined;
        const link = committed?.link ?? result.link;
        if (link) state.link = link;
        const recorded=service.recordAction(this.scopeKey, {
          decisionId: decision.activityId, summary: result.summary, outcome: result.outcome,
          ...(link ? { link } : {}), ...(result.tool ? { tool: result.tool } : {}), ...(usage ? { usage } : {}),
          ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
        });
        saveStepAcknowledgement(store,this.scopeKey,row,reservationId,result,recorded.costYen,currentActionExecution());
        if(!store.loop.openCycle(this.scopeKey))saveCycleAcknowledgement(store,cycle,currentActionExecution());
        // What it read of the owner's marks the session, and what a marked session writes is marked (ADR-0007); ids only.
        noteProvenance(this.dependencies, cycle, row.step, result, link, at);
        // What the step led to, as facts; when it is worth thinking about, she thinks again before going on.
        const rethought = this.observed(cycle, row, {
          outcome: result.outcome, ...(result.observed ? { observed: result.observed } : {}),
          ...(result.reasonCode ?? (result.tool?.endsWith('_held') ? 'held' : undefined) ? { code: result.reasonCode ?? 'held' } : {}),
        }, committed?.plan ?? plan, at);
        if (rethought ?? committed?.plan) store.loop.setPlan(cycle.id, rethought ?? committed!.plan!, false);
      });
    } catch (error) {
      if (state.saved !== 'unknown') state.saved = false;
      // The product could not be saved. The call was still made, so its cost is still reported. A sync of her study that had
      // already taken the same Aether write in keeps its closed code (`studyAether.ts`, `commit`).
      const reasonCode = error instanceof Error && error.message === 'STUDY_AETHER_LINKED' ? 'study_aether_linked' : undefined;
      try {
        store.transaction(() => {
          if ((currentActionExecution() && !store.loop.holdsLease(this.workerId,at)) || !store.loop.finishStep(row.id, 'reported', at)) return;
          const recorded=service.recordAction(this.scopeKey, {
            decisionId: decision.activityId, summary: 'したことの結果を保存できませんでした。', outcome: 'failed', ...(usage ? { usage } : {}), ...(reasonCode ? { reasonCode } : {}),
          });
          saveStepAcknowledgement(store,this.scopeKey,row,reservationId,{...result,outcome:'failed'},recorded.costYen,currentActionExecution());
        });
      } catch { /* left `authorized`; the next tick closes it as abandoned */ }
    }
    try { result.settled?.(state.saved); } catch { /* what she is told next is optional */ }
    return state;
  }

  private refused(
    cycle: AutonomyLoopCycle, row: AutonomyLoopStep, plan: readonly AutonomyPlannedStep[],
    prepared: PreparedStep, decision: RecordedDecision, at: string,
  ): AutonomyLoopTick {
    const { store, service, config } = this.dependencies;
    const step = row.step;
    if (decision.reason === 'paused' || decision.reason === 'disabled') {
      // The step was not performed; it waits at the front of the plan for the owner to resume.
      store.loop.setPlan(cycle.id, [step, ...plan], cycle.thought);
      return decision.reason === 'paused' ? 'paused' : 'disabled';
    }
    if (decision.reason === 'budget_exhausted') {
      const budget = service.overview(this.scopeKey).budget;
      store.loop.noteBudgetBlocked(this.scopeKey, autonomyDayKey(at, config), budget.capYen, at);
      if (this.session(cycle)) this.endSession(cycle, 'budget', at);
      else this.endCycle(cycle, 'budget', at);
      if (prepared.budgetReason) this.askForBudget(prepared.budgetReason, at);
      return 'budget';
    }
    // Needs approval, forbidden, or over a limit: never performed. The rest of the plan may still go on,
    // after she has seen that it was not allowed, when she may think again. A tool's refusal says why and what would work.
    if (step.kind === 'tool' && step.tool) this.dependencies.toolResults?.add(cycle.id, toolRefusalLine(step.tool, decision));
    try {
      store.transaction(() => {
        const rethought = this.observed(cycle, row, { outcome: 'refused', code: decision.reason }, plan, at);
        if (rethought) store.loop.setPlan(cycle.id, rethought, false);
      });
    } catch { /* the plan goes on as it was */ }
    return 'stepped';
  }

  /** The step's observation and the plan with a thinking step in front, or null. An observation that cannot be kept never undoes the step's report. */
  private observed(
    cycle: AutonomyLoopCycle, row: AutonomyLoopStep, outcome: Parameters<typeof observeStep>[3], remaining: readonly AutonomyPlannedStep[], at: string,
  ): AutonomyPlannedStep[] | null {
    try { return observeStep(this.dependencies, cycle, row, outcome, remaining, at); } catch { return null; }
  }

  /** 「せがむ」: at most once a day (the store refuses a second), never at night or while he is talking. */
  private askForBudget(reason: string, at: string): void {
    const { service, config, loop, showing } = this.dependencies;
    try {
      if (service.overview(this.scopeKey).budgetRequest) return;
      const may = showing.mayMessageNow(this.scopeKey, at);
      if (may === 'quiet-hours' || may === 'recent-conversation') return;
      service.requestBudget(this.scopeKey, { reason, amountYen: Math.min(loop.budgetRequestYen, config.maximumExtraYenPerDay) });
    } catch { /* asking is optional; the cap stays as it is */ }
  }

  /**
   * A step a stopped process left open is closed, never run again. One the gate had
   * already allowed is reported as failed, and a paid one is charged its estimate,
   * because the provider may have been called before the stop.
   */
  private closeInterruptedSteps(at: string): void {
    const { store, service } = this.dependencies;
    for (const step of store.loop.unfinishedSteps(this.scopeKey)) {
      try {
        store.transaction(() => {
          if (!store.loop.finishStep(step.id, 'abandoned', at)) return;
          if (step.status !== 'authorized' || !step.decisionId) return;
          // Her message was already written when the process stopped: it was sent, and only what followed is unknown.
          const sent = sentBeforeStop(this.dependencies, this.scopeKey, step);
          if (sent) {
            const label = sent.reason === 'follow_up' ? null : REACH_OUT_REASON_LABEL[sent.reason];
            service.recordAction(this.scopeKey, {
              decisionId: step.decisionId, outcome: 'done', reasonCode: 'unwatched', ...(step.estimate ? { usage: step.estimate } : {}),
              summary: `${label ? `持ち主に話しかけました（理由: ${label}）。` : '返事がなかったので、持ち主にもう一度だけ声をかけました。'}そのあとを見届ける前に止まったので、返事があったかは分かりません。費用は見積もりの上限で数えました。`,
            });
            store.loop.observations.add(this.scopeKey, { cycleId: step.cycleId, ordinal: step.ordinal, step: 'reach_out', outcome: 'done', code: 'unwatched', reachOut: sent }, at);
            return;
          }
          service.recordAction(this.scopeKey, {
            decisionId: step.decisionId, outcome: 'failed',
            summary: step.estimate ? '途中で止まった一歩を、やり直さずに閉じました。費用は見積もりの上限で数えました。' : '途中で止まった一歩を、やり直さずに閉じました。',
            ...(step.estimate ? { usage: step.estimate } : {}),
          });
        });
      } catch { /* the step stays closed to this runner's next tick */ }
    }
  }

  private endCycle(cycle: AutonomyLoopCycle, reason: string, at: string): AutonomyLoopTick {
    const {store}=this.dependencies;
    store.transaction(()=>{store.loop.endCycle(cycle.id,reason,at);saveCycleAcknowledgement(store,cycle,currentActionExecution());});
    return 'cycle-ended';
  }

  private abandonCycle(cycle: AutonomyLoopCycle, at: string): AutonomyLoopTick {
    const sessions = this.dependencies.loop.pacing === 'sessions' && this.session(cycle);
    return sessions ? this.endSession(cycle, 'action_unknown', at) : this.endCycle(cycle, 'action_unknown', at);
  }

  private session(cycle: AutonomyLoopCycle): AutonomySession | null {
    try { return sessionOf(this.dependencies, cycle); } catch { return null; }
  }

  /** Ends a session without a closing step of its own, and sets the next one a default rest away. */
  private endSession(cycle: AutonomyLoopCycle, code: SessionEndCode, at: string): AutonomyLoopTick {
    let idle = false;
    let again = false;
    try {
      idle = code === 'no_plan' && nothingDone(this.dependencies, cycle);
      again = idle && idleBefore(this.dependencies, cycle.scopeKey);
    } catch { idle = false; again = false; }
    const resumeAt = new Date(Date.parse(at) + restMilliseconds(this.dependencies.loop, undefined, again ? 'again' : idle)).toISOString();
    this.dependencies.store.transaction(()=>{closeSession(this.dependencies,cycle,idle?'idle':code,at,resumeAt);
      saveCycleAcknowledgement(this.dependencies.store,cycle,currentActionExecution());});
    return 'cycle-ended';
  }
}

/** Steps past the limit of a session that only its closing `rest` may take. */
const SESSION_CLOSING_STEPS = 3;
