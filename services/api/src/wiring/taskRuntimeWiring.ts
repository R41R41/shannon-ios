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
import { inActionExecution } from '../infra/context/actionExecution.js';
import { observeAsync, observeSync, observerHandoff, withObserverRun } from '../infra/observer/observerContext.js';
import { acquireAction } from './actionExecutionWiring.js';

export interface TaskRuntimeWiringOptions {
  db: DatabaseSync; actions: ActionThreads; model: FcaModel; scopeKey: string;
  ownerAlone(): boolean; now?: () => string;
  sleepTicket?(scopeKey: string, jobId: string): TaskSleepTicket | null;
  maintenanceAllowed?(runtime: TaskRuntime, task: TaskView): boolean;
  canRunTask?(runtime: TaskRuntime, taskId: string): boolean;
  stepPorts?(runtime: TaskRuntime, step: TaskStep): Partial<Pick<FcaStepPorts, 'model' | 'executionAllowed' | 'taskTools' | 'checkpoint' | 'selector' | 'tools' | 'sourcesVisible' | 'taskVisible' | 'history' | 'observeTasks' | 'recall' | 'observeMemory' | 'evidence' | 'safeToAcknowledgeStop' | 'body'>>;
}
/** The existing mind worker remains the sole action writer. This connection reads its lease as a commit fence. */
export function createTaskRuntimeWiring(options: TaskRuntimeWiringOptions) {
  const { db, actions, scopeKey } = options;
  const now = options.now ?? (() => new Date().toISOString());
  migrateAgentTasks(db);
  const authority = new SQLiteFcaTaskAuthority(db);
  const runtime: TaskRuntime = observedTaskRuntime(new SQLiteTaskRuntimeStore(db, { authority, now, sleepTicket: options.sleepTicket, leaseValid: (scope, taskId, lease, at) => {
    const row = db.prepare('SELECT * FROM mind_actions WHERE id=?').get(lease.id);
    const task = authority.get(scope, taskId);
    const originMatches = !!task && row?.origin === task.origin && (task.origin === 'owner_request'
      || (task.origin === 'maintenance' && task.kind === 'sleep' && !!runtime.sleepTicketForTask(scope, taskId)));
    return !!row && originMatches && row.scope_key === scope && row.kind === 'agentTask'
      && row.holder === lease.holder && row.generation === lease.generation && row.state === 'running'
      && typeof row.source_id === 'string' && row.source_id.startsWith(`fca:${taskId}:`)
      && typeof row.lease_until === 'string' && row.lease_until > at
      && JSON.parse(String(row.base_resources_json)).includes(actionResource(scope, `fca:${taskId}`));
  }, conversationLeaseValid: (scope, lease, at) => {
    const row = db.prepare('SELECT * FROM mind_actions WHERE id=?').get(lease.id);
    return !!row && row.scope_key === scope && row.origin === 'owner_request' && row.kind === 'respond'
      && row.holder === lease.holder && row.generation === lease.generation && row.state === 'running'
      && typeof row.lease_until === 'string' && row.lease_until > at;
  } }), options.ownerAlone);
  function executionAllowed(task: TaskView): boolean {
    if (task.origin === 'owner_request') return options.ownerAlone();
    if (task.origin !== 'maintenance' || task.kind !== 'sleep' || !options.maintenanceAllowed?.(runtime, task)) return false;
    const saved = runtime.sleepTicketForTask(scopeKey, task.id), current = saved && options.sleepTicket?.(scopeKey, saved.jobId);
    return !!current && !!saved && current.jobId === saved.jobId && current.dayKey === saved.dayKey
      && current.startAt === saved.startAt && current.endAt === saved.endAt;
  }
  const running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let closing = false, ticking = false;
  const classify = (lease: ActionLease): 'live' | 'safe' | 'unknown' => {
    const row = db.prepare('SELECT * FROM mind_actions WHERE id=?').get(lease.id);
    if (!row || row.scope_key !== scopeKey) return 'unknown';
    if (row.generation === lease.generation + 1 && row.last_holder === lease.holder && row.sent === 0
      && row.state === 'cancelled' && row.result === 'lease_expired') return 'safe';
    if (row.generation === lease.generation && row.last_holder === lease.holder
      && row.state === 'cancelled' && row.result === 'fca_stop_acknowledged') return 'safe';
    if (row.generation !== lease.generation) return 'unknown';
    if (['running', 'waiting', 'stopping'].includes(String(row.state)) && row.holder === lease.holder
      && typeof row.lease_until === 'string' && row.lease_until > now()) return 'live';
    // A model response lost after dispatch remains unknown even if the process only held local tools.
    return row.sent === 0 && ['cancelled', 'failed', 'completed'].includes(String(row.state)) ? 'safe' : 'unknown';
  };
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
      const action = db.prepare("SELECT * FROM mind_actions WHERE scope_key=? AND kind='agentTask' AND source_id=?")
        .get(scopeKey, `fca:${taskId}:${task.revision}`);
      // A claim reply can be lost before beginStep records its lease. Only the scheduler's exact unsent
      // expiry proves another admission is safe; advancing the canonical revision makes that retry durable.
      if (action && action.origin === task.origin && ['owner_request', 'maintenance'].includes(String(action.origin)) && action.state === 'cancelled'
        && action.sent === 0 && action.result === 'lease_expired' && Number(action.generation) >= 2
        && typeof action.last_holder === 'string' && action.last_holder.length > 0
        && action.holder === null && action.lease_until === null && action.parent_id === null
        && action.base_resources_json === JSON.stringify([actionResource(scopeKey, `fca:${taskId}`)])) {
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
    let step: TaskStep | null = null;
    let stepPorts: ReturnType<NonNullable<TaskRuntimeWiringOptions['stepPorts']>> | undefined;
    try {
      step = observeSync('taskHub', { phase: 'begin_step', actionId: active.execution.lease.id }, () => runtime.beginStep(scopeKey, taskId, active.execution.lease, task.revision), value => ({ admitted: value !== null, stepId: value?.id ?? null }));
      if (!step) { await active.finish('cancelled', 'fca_not_ready'); return; }
      const admitted = step;
      stepPorts = options.stepPorts?.(runtime, admitted);
      if (task.origin === 'maintenance' && !stepPorts?.model) throw new Error('FCA_MAINTENANCE_MODEL_REQUIRED');
      observerHandoff('queue', 'fca', { stepId: admitted.id });
      await inActionExecution(active.execution, () => runFcaStep(admitted, { runtime, model: options.model,
          ...stepPorts, ...(task.origin === 'maintenance' ? { taskTools: false } : {}), ownerAlone: options.ownerAlone,
          executionAllowed: () => executionAllowed(task) && (stepPorts?.executionAllowed?.() ?? true), permit: () => active.execution.permit([actionResource(scopeKey, `fca:${taskId}`)]) }, active.execution.signal));
      // Task completion/wait was committed; this is only the completion of its execution segment.
      await flushReceipts();
    } catch {
      const stopped = step && runtime.get(scopeKey, taskId)?.phase === 'stopping';
      if (stopped && active.execution.modelOutcome !== 'unknown'
        && stepPorts?.safeToAcknowledgeStop?.() !== false && stepPorts?.tools?.safeToAcknowledgeStop?.() !== false) {
        // Model/tool promises have unwound; the body adapter also requires confirmed physical release.
        runtime.recordStoppedStep(step!);
        await flushReceipts();
      } else {
        const lease = active.execution.lease;
        const row = db.prepare('SELECT * FROM mind_actions WHERE id=?').get(lease.id);
        const unsent = row?.scope_key === scopeKey && row.holder === lease.holder && row.generation === lease.generation && row.sent === 0;
        await actions.finish(lease, unsent ? 'cancelled' : 'unknown', unsent ? 'fca_not_dispatched' : 'fca_result_unknown').catch(() => null);
        runtime.recover(scopeKey, classify);
      }
    } finally { active.stop(); }
    });
  }
  async function tick(): Promise<void> {
    if (closing || ticking) return;
    ticking = true;
    try {
      await flushReceipts();
      runtime.recover(scopeKey, classify);
      for (const [taskId, job] of running) {
        const task = runtime.get(scopeKey, taskId);
        if (!task || task.phase === 'stopping' || !executionAllowed(task)) job.controller.abort();
      }
      const pending = new Set(runtime.pendingReceipts(scopeKey).map(receipt => receipt.taskId));
      for (const task of runtime.readyTasks(scopeKey, 256)) {
        if (running.size >= 2) break;
        if (pending.has(task.id) || running.has(task.id) || !executionAllowed(task) || options.canRunTask?.(runtime, task.id) === false) continue;
        const controller = new AbortController();
        const done = execute(task.id, controller).catch(() => {}).finally(() => running.delete(task.id));
        running.set(task.id, { controller, done });
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
