import { observedTaskRuntime } from '../infra/observer/observerTaskRuntime.js';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { actionResource, type ActionThreads, type ActionLease } from '../contracts/actionThreadContract.js';
import { SQLiteFcaTaskAuthority } from '../mind/action/agentTasks/store/fcaTaskAuthority.js';
import { migrateAgentTasks } from '../mind/action/agentTasks/store/agentTaskPersistence.js';
import { SQLiteTaskRuntimeStore } from '../mind/action/taskRuntime/store/taskRuntimeStore.js';
import type { TaskStep, TaskRuntime, TaskView, TaskSleepTicket } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { FcaModel } from '../mind/action/fca/fcaPorts.js';
import { runFcaStep, type FcaStepPorts } from '../mind/action/fca/fcaRunner.js';
import { inActionExecution, type ActionExecution } from '../infra/context/actionExecution.js';
import { observeAsync, observeSync, observerHandoff, withObserverRun } from '../infra/observer/observerContext.js';
import { acquireAction } from './actionExecutionWiring.js';
import {
  UNKNOWN_EXIT_MODEL_ONLY_MS, classifyLease, deriveTaskKind, leaseOutcome, leaseUnsent, slotAdmissible, slotClassOf, type SlotClass,
} from '@shannon/mind';
import { ActionLeaseReader } from '../mind/action/threads/store/actionLeaseReader.js';
import { conversationLeaseValid, fcaTaskLeaseValid, lostAdmissionExpired } from './actionLeaseRules.js';
import type { FcaBudget } from './fcaBudgetWiring.js';

export interface TaskRuntimeWiringOptions {
  db: DatabaseSync; actions: ActionThreads; model: FcaModel; scopeKey: string;
  ownerAlone(): boolean; now?: () => string;
  sleepTicket?(scopeKey: string, jobId: string): TaskSleepTicket | null;
  maintenanceAllowed?(runtime: TaskRuntime, task: TaskView): boolean;
  canRunTask?(runtime: TaskRuntime, taskId: string): boolean;
  /** Own-time tasks (ADR-0009 stage 2, E4): whether one may run now (the Executive on, her own time enabled and not paused). */
  ownTimeAllowed?(task: TaskView): boolean;
  /** E3: per-task caps and own-time reservations around each step. */
  budget?: FcaBudget;
  /** `SHANNON_FCA_PROVENANCE_REFS` (`TaskRuntimeOptions.provenanceRefs`). */
  provenanceRefs?: boolean;
  /** The wait before a step the provider answered with a server error is run again (`PROVIDER_RETRY_DELAY`); tests give 0. */
  providerRetryDelayMs?(): number;
  stepPorts?(runtime: TaskRuntime, step: TaskStep): Partial<Pick<FcaStepPorts, 'model' | 'executionAllowed' | 'taskTools' | 'checkpoint' | 'selector' | 'tools' | 'sourcesVisible' | 'taskVisible' | 'history' | 'observeTasks' | 'recall' | 'observeMemory' | 'evidence' | 'safeToAcknowledgeStop' | 'body'
    | 'waitCounterpart' | 'keepBodyTools'>>;
}
/** The existing mind worker remains the sole action writer. This connection reads its lease as a commit fence. */
export function createTaskRuntimeWiring(options: TaskRuntimeWiringOptions) {
  const { db, actions, scopeKey } = options;
  const now = options.now ?? (() => new Date().toISOString());
  migrateAgentTasks(db);
  const authority = new SQLiteFcaTaskAuthority(db);
  const leases = new ActionLeaseReader(db);
  const leaseValid = (scope: string, taskId: string, lease: ActionLease, at: string) => {
    const action = leases.get(lease.id);
    const task = authority.get(scope, taskId);
    const sleepTicketed = () => task?.origin === 'maintenance' && task.kind === 'sleep' && !!runtime.sleepTicketForTask(scope, taskId);
    const originMatches = !!task && action?.origin === task.origin && (task.origin === 'owner_request' || task.origin === 'own_time' || sleepTicketed());
    return originMatches && fcaTaskLeaseValid(action, scope, taskId, lease, at);
  };
  const runtime: TaskRuntime = observedTaskRuntime(new SQLiteTaskRuntimeStore(db, { authority, now, sleepTicket: options.sleepTicket, leaseValid,
    ...(options.provenanceRefs ? { provenanceRefs: true } : {}),
    conversationLeaseValid: (scope, lease, at) => conversationLeaseValid(leases.get(lease.id), scope, lease, at) }), options.ownerAlone);
  function executionAllowed(task: TaskView): boolean {
    if (task.origin === 'owner_request') return options.ownerAlone();
    if (task.origin === 'own_time') return options.ownTimeAllowed?.(task) === true;
    if (task.origin !== 'maintenance' || task.kind !== 'sleep' || !options.maintenanceAllowed?.(runtime, task)) return false;
    const saved = runtime.sleepTicketForTask(scopeKey, task.id), current = saved && options.sleepTicket?.(scopeKey, saved.jobId);
    return !!current && !!saved && current.jobId === saved.jobId && current.dayKey === saved.dayKey
      && current.startAt === saved.startAt && current.endAt === saved.endAt;
  }
  /** The tasks this process runs; `claimed` once their action holds a slot (until then the slot is counted here). */
  const running = new Map<string, { controller: AbortController; done: Promise<void>; slotClass: SlotClass; claimed: boolean }>();
  let closing = false, ticking = false;
  const classify = (lease: ActionLease) => leaseOutcome(classifyLease(leases.inScope(lease.id, scopeKey), lease, now()));
  async function flushReceipts(): Promise<void> {
    for (const receipt of runtime.pendingReceipts(scopeKey)) {
      try {
        const result = receipt.state === 'cancelled' ? 'fca_stop_acknowledged' : 'fca_segment_committed';
        let action = await actions.finish(receipt.lease, receipt.state, result);
        if (!action) {
          action = await actions.get(scopeKey, receipt.lease.id);
          if (action?.state === 'unknown' && await actions.reconcile(receipt.lease, receipt.state, result)) {
            action = await actions.get(scopeKey, receipt.lease.id);
          }
        }
        if (!action || action.scopeKey !== scopeKey || action.lastHolder !== receipt.lease.holder) continue;
        const confirmed = action.state === receipt.state && action.result === result
          && [receipt.lease.generation, receipt.lease.generation + 1].includes(action.generation);
        const expiredUnsentStop = receipt.state === 'cancelled' && action.state === 'cancelled' && !action.sent
          && action.result === 'lease_expired' && action.generation === receipt.lease.generation + 1;
        if (confirmed || expiredUnsentStop) runtime.acknowledgeReceipt(scopeKey, receipt.id);
      } catch { /* Durable receipt remains; retry the acknowledgement, never the completed model or tool call. */ }
    }
  }
  function recoverAdmission(taskId: string) {
    return authority.transaction(() => {
      const task = runtime.get(scopeKey, taskId);
      if (!task || task.phase !== 'ready') return task;
      const action = leases.bySource(scopeKey, 'agentTask', `fca:${taskId}:${task.revision}`);
      // A claim reply can be lost before beginStep records its lease. Only the scheduler's exact unsent
      // expiry proves another admission is safe; advancing the canonical revision makes that retry durable.
      if (action && lostAdmissionExpired(action, task.origin, scopeKey, taskId)) {
        authority.event(scopeKey, taskId, 'fca_admission_recovered', now(), {},
          { actionId: action.id, generation: action.generation });
        return runtime.get(scopeKey, taskId);
      }
      return task;
    });
  }
  async function execute(taskId: string, controller: AbortController): Promise<void> {
    const task = recoverAdmission(taskId);
    if (!task || task.phase !== 'ready' || !executionAllowed(task) || options.canRunTask?.(runtime, taskId) === false) return;
    return withObserverRun({ scopeKey, surface: 'fca', runId: randomUUID(), audience: options.ownerAlone() ? 'owner' : 'others', taskId, parentTaskId: task.parentId }, async () => {
    observerHandoff('taskHub', 'queue', { phase: 'admission' });
    const active = await observeAsync('queue', { phase: 'admission', revision: task.revision }, () => acquireAction(actions, { scopeKey, kind: 'agentTask', origin: task.origin,
      sourceId: `fca:${taskId}:${task.revision}`, resources: [actionResource(scopeKey, `fca:${taskId}`)] }, controller.signal), value => ({ admitted: value !== null }));
    if (!active) return;
    const job = running.get(taskId);
    if (job) job.claimed = true;
    let step: TaskStep | null = null;
    let stepPorts: ReturnType<NonNullable<TaskRuntimeWiringOptions['stepPorts']>> | undefined;
    try {
      step = observeSync('taskHub', { phase: 'begin_step', actionId: active.execution.lease.id }, () => runtime.beginStep(scopeKey, taskId, active.execution.lease, task.revision), value => ({ admitted: value !== null, stepId: value?.id ?? null }));
      if (!step) { await active.finish('cancelled', 'fca_not_ready'); return; }
      const admitted = step;
      const budgeted = await options.budget?.before(task, active.execution.lease) ?? { ok: true as const };
      if (!budgeted.ok) {
        // At its cap or without her budget: the task ends here with a report, before any paid call (E3). A throw goes to settleFailedStep.
        await stopForBudget(admitted, budgeted.report);
        await flushReceipts();
        return;
      }
      try {
        stepPorts = options.stepPorts?.(runtime, admitted);
        if (task.origin === 'maintenance' && !stepPorts?.model) throw new Error('FCA_MAINTENANCE_MODEL_REQUIRED');
        observerHandoff('queue', 'fca', { stepId: admitted.id });
        await inActionExecution(active.execution, () => runFcaStep(admitted, { runtime, model: options.model,
            ...stepPorts, ...(task.origin === 'maintenance' ? { taskTools: false } : {}), ownerAlone: options.ownerAlone,
            executionAllowed: () => executionAllowed(task) && (stepPorts?.executionAllowed?.() ?? true), permit: () => active.execution.permit([actionResource(scopeKey, `fca:${taskId}`)]) }, active.execution.signal));
      } finally {
        // The step's cost, and the release or settlement of its reservation (also when its ports could not be built): never its outcome.
        await settleBudget(task, active.execution.lease, budgeted.reservationId);
      }
      // Task completion/wait was committed; this is only the completion of its execution segment.
      await flushReceipts();
    } catch (error) {
      await settleFailedStep(error, taskId, step, stepPorts, active.execution);
    } finally { active.stop(); }
    });
  }
  type StepPorts = ReturnType<NonNullable<TaskRuntimeWiringOptions['stepPorts']>> | undefined;
  /** The task is stopping and the step's model and tool promises have unwound, with the body's physical release confirmed. */
  function stoppedSafely(taskId: string, stepPorts: StepPorts, execution: ActionExecution): boolean {
    return runtime.get(scopeKey, taskId)?.phase === 'stopping' && execution.modelOutcome !== 'unknown'
      && stepPorts?.safeToAcknowledgeStop?.() !== false && stepPorts?.tools?.safeToAcknowledgeStop?.() !== false;
  }
  /** Closes a step that threw: a confirmed stop, a known refusal, or else an unknown outcome. Logs only the closed code. */
  async function settleFailedStep(error: unknown, taskId: string, step: TaskStep | null, stepPorts: StepPorts, execution: ActionExecution): Promise<void> {
    const code = fcaErrorCode(error);
    if (step && stoppedSafely(taskId, stepPorts, execution)) {
      // Model/tool promises have unwound; the body adapter also requires confirmed physical release.
      console.log(`Shannon FCA step stopped task=${taskId} code=${code}`);
      runtime.recordStoppedStep(step);
      await flushReceipts();
      return;
    }
    if (step && providerServerErrorCode(code, execution) && await retryAfterServerError(step, execution)) {
      // The provider answered 5xx/529: nothing came back, so the step ran nothing. The task runs it once more, then fails.
      console.log(`Shannon FCA step retried task=${taskId} code=${code}`);
      await flushReceipts();
      return;
    }
    // Held before its decision with nothing sent to the body or any outside tool (Minecraft run 8, 2026-10-14: held right after a
    // compaction, the task was paused as unknown and retired): the step is closed as `continue` and the task goes on. See below.
    if (await retriedHeldStep(code, taskId, step, execution)) return;
    // The provider refused the request itself (nothing ran, nothing was charged, an identical retry is refused again), or her history
    // could not be made to fit before the step's model call (a replay holds the same way; owner test 2026-10-13: FCA_HISTORY_RECENT_LIMIT
    // left a research unknown until it was retired). A known failure with its notice.
    if (step && failsBeforeAnyEffect(code, execution) && failRejectedStep(step)) {
      console.log(`Shannon FCA step failed task=${taskId} code=${code}`);
      await flushReceipts();
      return;
    }
    console.log(`Shannon FCA step unknown task=${taskId} code=${code}`);
    const lease = execution.lease;
    const action = leases.inScope(lease.id, scopeKey);
    const unsent = !!action && leaseUnsent(action, lease);
    await actions.finish(lease, unsent ? 'cancelled' : 'unknown', unsent ? 'fca_not_dispatched' : 'fca_result_unknown').catch(() => null);
    runtime.recover(scopeKey, classify);
  }
  /**
   * Once per task: after a short wait with jitter (the provider was briefly unavailable), the step is committed as `continue`
   * with nothing added, so the scheduler runs the same decision again under a new action. A stop during the wait, or a second
   * server error, leaves it to the known failure.
   */
  async function retryAfterServerError(step: TaskStep, execution: ActionExecution): Promise<boolean> {
    const prior = step.snapshot.checkpoint && typeof step.snapshot.checkpoint === 'object' ? step.snapshot.checkpoint as Record<string, unknown> : {};
    const retries = typeof prior.fcaProviderRetries === 'number' ? prior.fcaProviderRetries : 0;
    if (retries >= 1) return false;
    const waited = execution.signal.aborted ? false : await new Promise<boolean>(resolve => {
      setTimeout(() => resolve(true), options.providerRetryDelayMs?.() ?? PROVIDER_RETRY_DELAY()).unref?.();
      execution.signal.addEventListener('abort', () => resolve(false), { once: true }); // a stop wins; the timer settles nothing
    });
    if (!waited || runtime.get(scopeKey, step.taskId)?.phase !== 'executing') return false;
    try {
      // Nothing ran, so the messages the step saw stay pending for the retry (before 2026-10-14 they were consumed and lost).
      const checkpoint = { ...prior, fcaProviderRetries: retries + 1 };
      return runtime.commitStep(step, { disposition: 'continue', history: [], consumedMessageIds: [], checkpoint }) !== null;
    } catch { return false; }
  }
  /**
   * A step held before its decision (`heldBeforeAnyEffect`) is committed as `continue` with nothing in its history and no message
   * consumed, under its own lease (a lost lease cannot commit, and the step stays unknown as before). The compaction it committed
   * stays; the next step starts from it. At most `HELD_RETRIES` in a row: a normal commit resets the count (`fcaRunner.ts`).
   */
  async function retriedHeldStep(code: string, taskId: string, step: TaskStep | null, execution: ActionExecution): Promise<boolean> {
    if (!step || !heldBeforeAnyEffect(code, execution) || !retryHeldStep(step)) return false;
    console.log(`Shannon FCA step held_retried task=${taskId} code=${code}`);
    await flushReceipts();
    return true;
  }
  function retryHeldStep(step: TaskStep): boolean {
    const prior = step.snapshot.checkpoint && typeof step.snapshot.checkpoint === 'object' ? step.snapshot.checkpoint as Record<string, unknown> : {};
    const retries = typeof prior.fcaHeldRetries === 'number' ? prior.fcaHeldRetries : 0;
    if (retries >= HELD_RETRIES || runtime.get(scopeKey, step.taskId)?.phase !== 'executing') return false;
    try {
      const checkpoint = { ...prior, fcaHeldRetries: retries + 1 };
      return runtime.commitStep(step, { disposition: 'continue', history: [], consumedMessageIds: [], checkpoint }) !== null;
    } catch { return false; }
  }
  /**
   * A task at its cap, or an own-time task without budget (E3): failed with its report in one commit. A task with unfinished
   * children cannot fail while they run, so it and its children are stopped instead and this step closes as stopped. Any
   * refusal is thrown to the caller, which closes the step through settleFailedStep.
   */
  async function stopForBudget(step: TaskStep, report: string): Promise<void> {
    runtime.recordProgress?.(step, { operationId: `${step.id}:capped`, tool: 'fca.result', status: 'failed', report: { text: report } });
    const task = runtime.get(scopeKey, step.taskId);
    const open = (id: string) => !['completed', 'failed', 'stopped', undefined].includes(runtime.get(scopeKey, id)?.phase);
    if (task?.childIds.some(open)) {
      const stopped = runtime.stop(scopeKey, step.taskId, 'fca_budget_capped');
      for (const item of stopped) if (item.id !== step.taskId) running.get(item.id)?.controller.abort();
      for (const live of runtime.activeSteps(scopeKey)) {
        if (live.taskId !== step.taskId && stopped.some(item => item.id === live.taskId)) await actions.stop(scopeKey, live.lease.id, randomUUID());
      }
      if (!runtime.recordStoppedStep(step)) throw new Error('FCA_BUDGET_STOP_UNRECORDED');
      return;
    }
    if (!runtime.commitStep(step, { disposition: 'fail', summary: report, history: [] })) throw new Error('FCA_BUDGET_COMMIT_REFUSED');
  }
  /** Cost recording never changes a step's outcome: a failure is logged as a closed code, and the step stands as committed. */
  async function settleBudget(task: TaskView, lease: ActionLease, reservationId?: string): Promise<void> {
    try {
      await options.budget?.after(task, lease, reservationId);
    } catch (error) {
      console.log(`Shannon FCA budget not recorded task=${task.id} code=${fcaErrorCode(error)}`);
    }
  }
  /**
   * A known refusal fails the task in the same commit that tells its parent, and leaves a report the owner's call can speak.
   * The internal root never fails: its refused step is closed, and it returns to its inbox with the messages it saw delivered
   * once more (fix 2026-10-14; before, it went unknown for ten minutes and then waited on a message it never ran).
   */
  function failRejectedStep(step: TaskStep): boolean {
    const task = runtime.get(scopeKey, step.taskId);
    if (task?.kind === 'root' && task.origin === 'owner_request') {
      try { return runtime.closeRejectedStep?.(step) ?? false; } catch { return false; }
    }
    if (!task || task.origin !== 'owner_request' || task.kind === 'root' || task.kind === 'conversation' || task.childIds.length) return false;
    const summary = rejectedTaskReport(task.title);
    try {
      runtime.recordProgress?.(step, { operationId: `${step.id}:failed`, tool: 'fca.result', status: 'failed', report: { text: summary } });
      return runtime.commitStep(step, { disposition: 'fail', summary, history: [] }) !== null;
    } catch { return false; }
  }
  /** A task never waits on a message already delivered (fix 2026-10-14): the sweep closes any lost wakeup before admission. */
  function wakeLostInboxes(): void {
    const woken = runtime.wakePendingInboxes?.(scopeKey) ?? [];
    if (woken.length) console.log(`Shannon FCA woke ${woken.length} task(s) waiting on a pending message`);
  }
  async function tick(): Promise<void> {
    if (closing || ticking) return;
    ticking = true;
    try {
      await flushReceipts();
      runtime.recover(scopeKey, classify);
      // An unknown step is never replayed, but after the deadline its task stops holding parents, limits and sleep.
      const retired = runtime.retireUnknown?.(scopeKey, now()) ?? [];
      const minutes = UNKNOWN_EXIT_MODEL_ONLY_MS / 60_000;
      if (retired.length) console.log(`Shannon FCA retired ${retired.length} task(s) left unknown for ${minutes} min or more`);
      wakeLostInboxes();
      for (const [taskId, job] of running) {
        const task = runtime.get(scopeKey, taskId);
        if (!task || task.phase === 'stopping' || !executionAllowed(task)) job.controller.abort();
      }
      const pending = new Set(runtime.pendingReceipts(scopeKey).map(receipt => receipt.taskId));
      // ADR-0009 stage 1, S6: a task starts only while its slot class has room by the slot tables (the store decides again).
      const slots = leases.slots(scopeKey, now());
      const starting = [...running.values()].filter(job => !job.claimed).map(job => job.slotClass);
      for (const task of runtime.readyTasks(scopeKey, 256)) {
        if (pending.has(task.id) || running.has(task.id) || !executionAllowed(task) || options.canRunTask?.(runtime, task.id) === false) continue;
        const slotClass = slotClassOf({ kind: 'agentTask', sourceId: `fca:${task.id}:${task.revision}` }, deriveTaskKind(task.kind));
        if (!slotAdmissible(slotClass, [...slots.live, ...starting], slots.limits).ok) continue;
        starting.push(slotClass);
        const controller = new AbortController();
        running.set(task.id, { controller, done: Promise.resolve(), slotClass, claimed: false });
        running.get(task.id)!.done = execute(task.id, controller).catch(() => {}).finally(() => running.delete(task.id));
      }
    } finally { ticking = false; }
  }
  async function stop(taskId: string, reason: string) {
    const tasks = runtime.stop(scopeKey, taskId, reason);
    for (const task of tasks) running.get(task.id)?.controller.abort();
    for (const active of runtime.activeSteps(scopeKey)) {
      if (tasks.some(task => task.id === active.taskId)) await actions.stop(scopeKey, active.lease.id, randomUUID());
    }
    return tasks;
  }
  return { runtime, tick, stop,
    async drain() { await Promise.all([...running.values()].map(job => job.done)); },
    async close() { closing = true; for (const job of running.values()) job.controller.abort(); await Promise.all([...running.values()].map(job => job.done)); },
  };
}

/** A closed error code for logs: FCA codes are content-free; anything else is reported only by its class. */
export function fcaErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/^[A-Z][A-Z0-9_]{2,80}$/u.test(message)) return message;
  return error instanceof Error && /^[A-Za-z]{1,40}$/u.test(error.name) ? error.name : 'unknown';
}

/** 3-5 s: one short wait with jitter before a step the provider answered 5xx/529 is run again. */
export const PROVIDER_RETRY_DELAY = () => 3_000 + Math.floor(Math.random() * 2_000);

/** A decision request the provider answered with a server error (5xx, 529), with no tool outcome in doubt. */
export function providerServerErrorCode(code: string, execution: Pick<ActionExecution, 'modelOutcome' | 'stepOutcome'>): boolean {
  return /^FCA_MODEL_HTTP_5\d\d$/u.test(code) && execution.modelOutcome === 'acknowledged' && execution.stepOutcome !== 'unknown';
}

/**
 * Definitive provider answers to the decision request with no tool outcome in doubt: a refusal (4xx, not throttling or timeouts)
 * or a server error (5xx, 529, after its one retry; 2026-10-13: a research step's server error sat unknown for ten minutes
 * holding a slot while the owner waited). No decision came back, so nothing ran; a server error's spend stays booked as
 * unknown (a conservative bound), a refusal's as none. The task fails with its report and he can ask again.
 */
export function rejectedBeforeAnyEffect(code: string, execution: Pick<ActionExecution, 'modelOutcome' | 'stepOutcome'>): boolean {
  const status = /^FCA_MODEL_HTTP_([45]\d\d)$/u.exec(code)?.[1];
  return !!status && !['408', '409', '429'].includes(status) && execution.modelOutcome === 'acknowledged' && execution.stepOutcome !== 'unknown';
}

/** The history limits `prepareFcaHistory` throws before the step's model call (`fcaHistory.ts`): deterministic, so a replay holds too. */
const HISTORY_LIMITS: ReadonlySet<string> = new Set(['FCA_HISTORY_RECENT_LIMIT', 'FCA_HISTORY_ROUND_LIMIT', 'FCA_HISTORY_COMPACTION_LIMIT']);
/**
 * The closed checks of the shared-context call (`anthropicFcaContext.ts`, `fcaEvidenceStore.beforeActions`): a complete, paid answer
 * refused before any of its actions ran. The decoder answers an invalid item as a correction, so these remain only as a guard; one
 * that still reaches here is a known failure, never an unknown step (Minecraft operator run 5, 2026-10-14: FCA_EXPECTATION_INVALID).
 */
const CONTEXT_REJECTIONS: ReadonlySet<string> = new Set(['FCA_CONTEXT_INVALID', 'FCA_EXPECTATION_INVALID', 'FCA_APPRAISAL_INVALID']);
export function failsBeforeAnyEffect(code: string, execution: Pick<ActionExecution, 'modelOutcome' | 'stepOutcome'>): boolean {
  return rejectedBeforeAnyEffect(code, execution) || (HISTORY_LIMITS.has(code) && execution.stepOutcome !== 'unknown')
    || (CONTEXT_REJECTIONS.has(code) && execution.modelOutcome === 'acknowledged' && execution.stepOutcome !== 'unknown');
}

/** Holds of a step's execution (`fcaRunner.ts` `checked`, and its history's own check in `prepareFcaHistory`). */
const HELD_CODES: ReadonlySet<string> = new Set(['FCA_EXECUTION_HELD', 'FCA_HISTORY_HELD']);
const HELD_RETRIES = 3;
/**
 * A hold before the step asked for its decision, with no bounded executor started in it (a body skill, a reflex or a Minecraft
 * lifecycle operation sets `stepOutcome`), no model call in doubt and no write in flight. Before its decision a step has only run
 * internal work and model calls whose results it keeps (a committed history summary among them), so nothing outside can be done
 * twice by running the next step. Any other hold keeps today's unknown.
 */
export function heldBeforeAnyEffect(code: string,
  execution: Pick<ActionExecution, 'decisionRequested' | 'modelOutcome' | 'stepOutcome' | 'writeInFlight'>): boolean {
  return HELD_CODES.has(code) && execution.decisionRequested !== true && execution.stepOutcome === undefined
    && execution.modelOutcome !== 'unknown' && execution.writeInFlight !== true;
}

export function rejectedTaskReport(title: string): string {
  return `「${title.slice(0, 80)}」は処理中にエラーが起きて、最後まで進められませんでした。`;
}
