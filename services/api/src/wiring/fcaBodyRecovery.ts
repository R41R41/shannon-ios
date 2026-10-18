import type { DatabaseSync } from 'node:sqlite';
import type { ActionLease, ActionThreads } from '../contracts/actionThreadContract.js';
import type { TaskAuthority, TaskRecord, TaskRuntime } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import { TaskBodyRecoveryStore, type RecoveryCheckpoint } from '../mind/action/taskRuntime/store/taskBodyRecoveryStore.js';
import { ActionLeaseReader, type LostFcaStep } from '../mind/action/threads/store/actionLeaseReader.js';
import {
  bodyOperations, operationUnresolved, reconcileOperations, type BodyOperationState,
} from '../surfaces/minecraft/store/minecraftOperationReconcile.js';
import { fcaReleaseEvidence } from './configuredActionResourceProof.js';
import type { BodyRecheckResult } from './minecraftBodyRecheckWiring.js';

/**
 * A Minecraft request survives a step whose outcome was lost (Minebot parity audit C-20/C-21, 2026-10-19): an API restart, a Spot VM
 * stop, a body that dropped a command, a decision that never came back. The step is never replayed and no body operation of it is ever
 * sent again. Once the body itself has proven its inputs released (a re-check `release` it answered `stopped`), or when the step sent
 * nothing, the lost step's action is closed, the operations nobody answered are closed with it, and the task goes on from a fresh
 * observation with a notice naming what may or may not have happened; the model decides, as after any failed tool.
 *
 * Bounds: the body has `windowMs` to be connected again (the task stays `fca_unknown`, never retired as failed, meanwhile), after which
 * the task is paused as stopped, not failed, and the owner may resume it; a task recovered `limit.count` times within `limit.withinMs`
 * is paused the same way. The owner's stop, the task's budget cap and every lease check are untouched: this only moves a task that was
 * left unknown, and the next step is admitted like any other.
 */
export const FCA_BODY_RETURN_WINDOW_MS = 30 * 60_000;
export const FCA_BODY_RECOVERY_LIMIT = Object.freeze({ count: 6, withinMs: 60 * 60_000 });
export const FCA_BODY_RECOVERY_CODE = 'fca_body_reconciled';

/** `SHANNON_FCA_BODY_RETURN_MINUTES`: how long a Minecraft request waits for its body (1 to 720 minutes; the default is 30). */
export function fcaBodyReturnWindow(value: string | undefined): number {
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 720 ? minutes * 60_000 : FCA_BODY_RETURN_WINDOW_MS;
}
/** `retireUnknown` leaves a body task alone this long past the window, so that the pause below always comes first. */
const HOLD_GRACE_MS = 5 * 60_000;
const RELEASE_COOLDOWN_MS = 10_000;
/** What the owner and `task.get` read of a Minecraft request paused here (its state is `stopped`; resuming it is the owner's). */
export const BODY_ABSENT_SUMMARY = '体が戻らなかったため一時停止しています。体が戻ってから再開できます。';
export const RECOVERY_LIMIT_SUMMARY = '同じ依頼が短い間に何度も中断されたため一時停止しています。確認してから再開できます。';

export const BODY_RECOVERY_NOTICE = 'The previous step of this task was interrupted before its results were stored (a restart, a lost answer or a '
  + 'dropped command). The listed operations may or may not have taken effect; none of them was sent again. Read the fresh observation, '
  + 'check what is true now, and decide the next step; do not assume any listed operation succeeded or failed.';

export interface FcaBodyRecoveryParts {
  db: DatabaseSync; authority: TaskAuthority; runtime: TaskRuntime; actions: Pick<ActionThreads, 'reconcile'>;
  scopeKey: string; now(): string;
  /** Whether this process is executing the task's step right now. */
  running(taskId: string): boolean;
  body: {
    /** The body a task is bound to, or null for a task that is not a Minecraft body task. */
    bound(taskId: string): string | null;
    connected(bodyId: string): boolean;
    release(step: { actionId: string; scopeKey: string; lease: ActionLease }): Promise<BodyRecheckResult>;
  };
  windowMs?: number;
  limit?: { count: number; withinMs: number };
  /** The least time between two background passes (tests: 0). */
  passMs?: number;
  log?(line: string): void;
}

export interface FcaBodyRecovery {
  /** A Minecraft request the owner made: bound to a body, directly the owner's work. */
  isBodyTask(task: Pick<TaskRecord, 'id' | 'origin' | 'kind'>): boolean;
  /** Whether `retireUnknown` must leave this unknown task alone: it is waiting for its body. */
  holds(task: TaskRecord): boolean;
  /** Whether the task still has a lost step to close: it is not admitted until then. */
  blocks(taskId: string): boolean;
  /** Pauses (as stopped, not failed) the tasks whose body did not return in time. Synchronous: it runs before `retireUnknown`. */
  expire(): void;
  /** One background pass: closes lost steps, then returns the unknown tasks to the queue. Never throws. */
  advance(): Promise<void>;
  idle(): Promise<void>;
}

export function createFcaBodyRecovery(parts: FcaBodyRecoveryParts): FcaBodyRecovery {
  const { db, authority, runtime, scopeKey } = parts;
  const windowMs = parts.windowMs ?? FCA_BODY_RETURN_WINDOW_MS, limit = parts.limit ?? FCA_BODY_RECOVERY_LIMIT;
  const log = parts.log ?? ((line: string) => console.log(line));
  const leases = new ActionLeaseReader(db), checkpoints = new TaskBodyRecoveryStore(db);
  const instant = () => Date.parse(parts.now());
  const blocked = new Set<string>(), releasing = new Map<string, number>(), told = new Map<string, string>();
  let working: Promise<void> | null = null, lastPass = Number.NEGATIVE_INFINITY;

  const isBodyTask = (task: Pick<TaskRecord, 'id' | 'origin' | 'kind'>) => task.origin === 'owner_request'
    && (task.kind === 'research' || task.kind === 'generic') && parts.body.bound(task.id) !== null;
  /** Says a task's waiting reason once per change, not once per pass; an outcome is always said and starts the next wait afresh. */
  const say = (taskId: string, code: string, detail = '') => {
    const waiting = code === 'waiting';
    if (waiting && told.get(taskId) === detail) return;
    if (waiting) told.set(taskId, detail);
    else told.delete(taskId);
    log(`Shannon FCA body recovery task=${taskId} code=${code}${detail ? ` ${detail}` : ''}`);
  };

  /** The lost steps of Minecraft requests; the tasks they hold are not admitted until their step is closed. */
  function refreshBlocked(): LostFcaStep[] {
    const steps = leases.lostFcaSteps(scopeKey, parts.now()).filter(step => {
      const task = authority.get(scopeKey, step.taskId);
      return !!task && isBodyTask(task);
    });
    blocked.clear();
    for (const step of steps) blocked.add(step.taskId);
    return steps;
  }

  function sinceUnknown(task: TaskRecord): number {
    const since = runtime.unknownSince?.(scopeKey, task.id) ?? task.updatedAt;
    const started = Date.parse(since);
    return Number.isFinite(started) ? instant() - started : 0;
  }

  function pause(task: TaskRecord, reason: string, summary: string): void {
    authority.transaction(() => {
      const current = authority.get(scopeKey, task.id);
      if (!current || current.pauseReason !== 'fca_unknown') return;
      checkpoints.releaseStep(task.id, { clearStop: true });
      authority.event(scopeKey, task.id, 'fca_body_paused', parts.now(), { status: 'paused', pauseReason: 'fca_stopped', summary, proof: true },
        { reason });
    });
    say(task.id, 'paused', `reason=${reason}`);
  }

  function pauseExpired(): void {
    for (const id of checkpoints.unknownTaskIds(scopeKey)) {
      const task = authority.get(scopeKey, id);
      if (!task || !isBodyTask(task) || checkpoints.checkpoint(task.id)?.stopRequested) continue;
      if (sinceUnknown(task) > windowMs) pause(task, 'body_not_returned', BODY_ABSENT_SUMMARY);
    }
  }

  /** The body's proof that its inputs are released after the step's last operation; asks the body once the body is connected. */
  async function releaseEvidence(taskId: string, step: LostFcaStep) {
    const proof = fcaReleaseEvidence(db, step.lease, scopeKey);
    const bodyId = parts.body.bound(taskId);
    if (proof || !bodyId) return proof;
    if (!parts.body.connected(bodyId)) {
      say(taskId, 'waiting', 'for=body');
      return null;
    }
    if (instant() - (releasing.get(step.actionId) ?? Number.NEGATIVE_INFINITY) < RELEASE_COOLDOWN_MS) return null;
    releasing.set(step.actionId, instant());
    say(taskId, 'waiting', 'for=release');
    const asked = await parts.body.release({ actionId: step.actionId, scopeKey, lease: step.lease });
    if (asked.code === 'recheck_busy') releasing.delete(step.actionId); // another re-check holds the body: ask again at the next pass
    return fcaReleaseEvidence(db, step.lease, scopeKey);
  }

  /** The names of what the lost step sent the body, with how each stood: closed values, never arguments. */
  function lostOperations(operations: readonly BodyOperationState[]) {
    return operations.filter(operation => operation.kind === 'skill' || operation.kind === 'reflex').slice(0, 8)
      .map(operation => ({ tool: operation.skill ? `mc.${operation.skill}` : 'minecraft.reflex',
        outcome: operation.closedByApi ? 'no_receipt' : operation.outcome ?? 'no_receipt' }));
  }

  function notify(taskId: string, step: LostFcaStep, operations: readonly BodyOperationState[]): void {
    const text = JSON.stringify({ kind: 'body.recovery', reason: 'step_interrupted', lostOperations: lostOperations(operations),
      instruction: BODY_RECOVERY_NOTICE });
    try {
      runtime.send(scopeKey, taskId, taskId, text, `recovery:${step.actionId}`);
    } catch { /* the task goes on without the notice */ }
  }

  /** Closes one lost step. False: it cannot be closed yet (the body has not proven its release, or the action store refused). */
  async function close(taskId: string, step: LostFcaStep): Promise<boolean> {
    const open = bodyOperations(db, step.lease, scopeKey).filter(operationUnresolved);
    const proof = open.length ? await releaseEvidence(taskId, step) : null;
    if (open.length && !proof) return false;
    if (proof) authority.transaction(() => reconcileOperations(db, step.lease, scopeKey, proof.id, parts.now()));
    if (!await parts.actions.reconcile(step.lease, 'failed', FCA_BODY_RECOVERY_CODE).catch(() => false)) {
      say(taskId, 'waiting', 'for=action');
      return false;
    }
    const operations = bodyOperations(db, step.lease, scopeKey);
    notify(taskId, step, operations);
    say(taskId, 'reconciled', `action=${step.actionId} operations=${operations.length} unresolved=${open.length}`);
    return true;
  }

  function recentRecoveries(row: RecoveryCheckpoint): string[] {
    const kept = (row.checkpointJson ? JSON.parse(row.checkpointJson) as { fcaBodyRecoveries?: unknown } : {}).fcaBodyRecoveries;
    const since = instant() - limit.withinMs;
    return Array.isArray(kept) ? kept.filter((at): at is string => typeof at === 'string' && Date.parse(at) > since) : [];
  }

  /** The unknown task returns to the queue, with its checkpoint as it was and the count of recoveries; false: it was paused instead. */
  function resume(task: TaskRecord): boolean {
    return authority.transaction(() => {
      const current = authority.get(scopeKey, task.id), row = checkpoints.checkpoint(task.id);
      if (!current || !row || current.pauseReason !== 'fca_unknown' || row.stopRequested) return false;
      const recent = recentRecoveries(row);
      if (recent.length >= limit.count) {
        pause(current, 'recovery_limit', RECOVERY_LIMIT_SUMMARY);
        return false;
      }
      const prior = row.checkpointJson ? JSON.parse(row.checkpointJson) as Record<string, unknown> : {};
      checkpoints.releaseStep(task.id, { checkpointJson: JSON.stringify({ ...prior, fcaBodyRecoveries: [...recent, parts.now()] }) });
      authority.event(scopeKey, task.id, 'fca_body_recovered', parts.now(), { status: 'queued', pauseReason: null, proof: true },
        { stepId: row.stepId });
      return true;
    });
  }

  async function recover(task: TaskRecord, steps: readonly LostFcaStep[], receipted: ReadonlySet<string>): Promise<void> {
    const row = checkpoints.checkpoint(task.id);
    if (parts.running(task.id) || receipted.has(task.id) || !row || row.stopRequested) return;
    for (const step of steps) if (!await close(task.id, step)) return;
    if (task.pauseReason !== 'fca_unknown') return;
    const bodyId = parts.body.bound(task.id);
    if (!bodyId || !parts.body.connected(bodyId)) {
      say(task.id, 'waiting', 'for=body');
      return;
    }
    if (resume(task)) say(task.id, 'resumed');
  }

  async function pass(): Promise<void> {
    const steps = refreshBlocked();
    const receipted = new Set(runtime.pendingReceipts(scopeKey).map(receipt => receipt.taskId));
    const ids = new Set([...steps.map(step => step.taskId), ...checkpoints.unknownTaskIds(scopeKey)]);
    for (const id of ids) {
      const task = authority.get(scopeKey, id);
      if (task && isBodyTask(task)) await recover(task, steps.filter(step => step.taskId === id), receipted);
    }
    refreshBlocked();
  }

  function advance(): Promise<void> {
    if (working) return working;
    if (Date.now() - lastPass < (parts.passMs ?? 2_000)) return Promise.resolve();
    lastPass = Date.now();
    working = pass().catch(() => { /* a failed pass is tried again by the next one */ }).finally(() => { working = null; });
    return working;
  }

  const holds = (task: TaskRecord) => task.pauseReason === 'fca_unknown' && isBodyTask(task) && !checkpoints.checkpoint(task.id)?.stopRequested
    && sinceUnknown(task) <= windowMs + HOLD_GRACE_MS;
  return {
    isBodyTask,
    holds,
    blocks: taskId => blocked.has(taskId),
    expire() {
      try {
        refreshBlocked();
        pauseExpired();
      } catch {
        log('Shannon FCA body recovery code=expire_failed'); // the scheduler goes on; the next tick tries again
      }
    },
    advance,
    idle: async () => {
      await working;
    },
  };
}
