import { randomUUID } from 'node:crypto';
import { autonomyDayKey } from './autonomyBudget.js';
import type { AutonomyLoopCycle, AutonomyLoopReadiness, AutonomyLoopStep, AutonomyPlannedStep } from './autonomyLoopState.js';
import { adaptersFor, prepareStep, type PreparedStep, type StepCommit, type StepDependencies, type StepResult } from './autonomyLoopSteps.js';
import type { RecordedDecision } from './autonomyService.js';
import { resolveAutonomyModel } from './autonomyTextModel.js';

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
 * It runs in its own process, apart from the API, so chat and voice never wait for it.
 * A single lease in SQLite lets exactly one runner step; a second runner idles. The
 * loop starts no process, no additional runner, and no copy of itself.
 */
export type AutonomyLoopTick =
  | 'not-leader' | 'disabled' | 'not-configured' | 'paused' | 'idle' | 'owner-active' | 'budget' | 'stepped' | 'cycle-ended';

export interface AutonomyLoopDependencies extends StepDependencies {
  now: () => string;
  workerId?: string;
}

export class ShannonAutonomyLoop {
  readonly workerId: string;
  private readonly scopeKey: string;

  constructor(private readonly dependencies: AutonomyLoopDependencies) {
    this.workerId = dependencies.workerId ?? `autonomy-${randomUUID()}`;
    this.scopeKey = dependencies.loop.scopeKey;
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
    const at = now();
    const readiness = this.readiness();
    const leaseUntil = new Date(Date.parse(at) + loop.leaseMilliseconds).toISOString();
    if (!store.loop.acquireLease(this.workerId, at, leaseUntil, readiness)) return 'not-leader';
    if (readiness === 'disabled') return 'disabled';
    if (readiness === 'no_credential') return 'not-configured';
    // A stop switch that cannot be read counts as on, as in the gate.
    let paused = true;
    try { paused = store.control(this.scopeKey).paused; } catch { paused = true; }
    if (paused) return 'paused';
    this.closeInterruptedSteps(at);
    // A file handed to a device that never reported back is closed as failed, also when that device stays away.
    try { this.dependencies.service.folder.closeOverdue(this.scopeKey, at); } catch { /* the next claim or tick closes it */ }
    const cycle = store.loop.openCycle(this.scopeKey) ?? this.startCycleIfDue(at);
    return typeof cycle === 'string' ? cycle : this.advance(cycle, at, signal);
  }

  /** Lets another runner take over at once; called when this process stops. */
  release(): void {
    this.dependencies.store.loop.releaseLease(this.workerId, this.dependencies.now());
  }

  private startCycleIfDue(at: string): AutonomyLoopCycle | AutonomyLoopTick {
    const { store, service, config, loop, showing } = this.dependencies;
    const dayKey = autonomyDayKey(at, config);
    // A piece she called 「見せてもいい」 but has not told him about: one step of its own, when she may speak.
    const untold = store.study.list(this.scopeKey).find(piece => piece.kind === 'story' && piece.status === 'ready');
    if (untold && showing.mayMessageNow(this.scopeKey, at) === 'ok') {
      return store.loop.startCycle(this.scopeKey, dayKey, 'show', [{ kind: 'show', pieceId: untold.id }], at);
    }
    const next = store.loop.nextCycleAt(this.scopeKey);
    if (next && Date.parse(at) < Date.parse(next)) return 'idle';
    if (store.loop.activityCyclesOn(this.scopeKey, dayKey) >= loop.cyclesPerDay) return 'idle';
    if (loop.ownerActiveMilliseconds > 0
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
    // The next step that can be carried out; one that cannot (nothing to note, an unknown piece) is dropped unasked.
    while (!prepared) {
      if (cycle.stepsTaken >= loop.maximumStepsPerCycle) return this.endCycle(cycle, 'step-limit', at);
      step = plan.shift() ?? (cycle.kind === 'activity' && !cycle.thought ? { kind: 'think' } : undefined);
      if (!step) return this.endCycle(cycle, 'plan-done', at);
      prepared = prepareStep(this.dependencies, cycle, step, at);
      if (!prepared && step.kind === 'think') return this.endCycle(cycle, 'no-model', at);
    }
    const current = step!;
    const ready = prepared;

    // Journal the step and ask the gate in one transaction: after a crash either both exist or neither.
    const begun = store.transaction(() => {
      if (!store.loop.holdsLease(this.workerId, at)) return null;
      const row = store.loop.beginStep(cycle, current, plan, at);
      const decision = service.authorize(this.scopeKey, ready.request);
      const allowed = decision.decision === 'allow' && (decision.domain as string) === ready.request.domain;
      if (allowed) store.loop.markAuthorized(row.id, decision.activityId, ready.estimate);
      else store.loop.finishStep(row.id, 'refused', at, decision.activityId);
      return { row, decision, allowed };
    });
    if (!begun) return 'not-leader';
    if (!begun.allowed) return this.refused(cycle, current, plan, ready, begun.decision, at);

    let result: StepResult;
    try {
      result = await ready.perform(adaptersFor(begun.decision, this.dependencies), at, signal);
    } catch {
      result = { outcome: 'failed', summary: '一歩の途中で、うまくいかなくなりました。' };
    }
    this.report(cycle, begun.row, begun.decision, ready, result, plan, now());
    return 'stepped';
  }

  /** The product, the record entry with its actual cost, and the journal close commit together. */
  private report(
    cycle: AutonomyLoopCycle, row: AutonomyLoopStep, decision: RecordedDecision, prepared: PreparedStep,
    result: StepResult, plan: readonly AutonomyPlannedStep[], at: string,
  ): void {
    const { store, service } = this.dependencies;
    const usage = result.usage && prepared.request.paid ? { ...result.usage, ...(prepared.purpose ? { purpose: prepared.purpose } : {}) } : undefined;
    try {
      store.transaction(() => {
        // Already closed means another runner took the lease and abandoned it; it is not counted twice.
        if (!store.loop.finishStep(row.id, 'reported', at)) return;
        const committed = (result.commit?.(plan, at) || undefined) as StepCommit | undefined;
        const link = committed?.link ?? result.link;
        service.recordAction(this.scopeKey, {
          decisionId: decision.activityId, summary: result.summary, outcome: result.outcome,
          ...(link ? { link } : {}), ...(result.tool ? { tool: result.tool } : {}), ...(usage ? { usage } : {}),
        });
        if (committed?.plan) store.loop.setPlan(cycle.id, committed.plan, false);
      });
    } catch {
      // The product could not be saved. The call was still made, so its cost is still reported.
      try {
        store.transaction(() => {
          if (!store.loop.finishStep(row.id, 'reported', at)) return;
          service.recordAction(this.scopeKey, {
            decisionId: decision.activityId, summary: 'したことの結果を保存できませんでした。', outcome: 'failed', ...(usage ? { usage } : {}),
          });
        });
      } catch { /* left `authorized`; the next tick closes it as abandoned */ }
    }
  }

  private refused(
    cycle: AutonomyLoopCycle, step: AutonomyPlannedStep, plan: readonly AutonomyPlannedStep[],
    prepared: PreparedStep, decision: RecordedDecision, at: string,
  ): AutonomyLoopTick {
    const { store, service, config } = this.dependencies;
    if (decision.reason === 'paused' || decision.reason === 'disabled') {
      // The step was not performed; it waits at the front of the plan for the owner to resume.
      store.loop.setPlan(cycle.id, [step, ...plan], cycle.thought);
      return decision.reason === 'paused' ? 'paused' : 'disabled';
    }
    if (decision.reason === 'budget_exhausted') {
      const budget = service.overview(this.scopeKey).budget;
      store.loop.noteBudgetBlocked(this.scopeKey, autonomyDayKey(at, config), budget.capYen, at);
      this.endCycle(cycle, 'budget', at);
      if (prepared.budgetReason) this.askForBudget(prepared.budgetReason, at);
      return 'budget';
    }
    // Needs approval, forbidden, or over a limit: never performed. The rest of the plan may still go on.
    return 'stepped';
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
    this.dependencies.store.loop.endCycle(cycle.id, reason, at);
    return 'cycle-ended';
  }
}
