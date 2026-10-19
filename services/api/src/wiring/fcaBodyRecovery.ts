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
 * What is guaranteed is about the BODY's operations only: each is either answered by the body, or closed here after the body proved
 * its release, and none is sent twice. A lost step may also have made a child task (`task.create`) or sent a note (`task.send`); the
 * recovery does not undo or close those. It lists the ones it finds (made or sent at or after the step began) in the notice, so that the
 * model sees them before it acts and does not make or send the same again.
 *
 * Bounds:
 * - the notice is stored and verified (`recovery:<actionId>` is in the inbox) before the step is closed and before the task goes on; if
 *   it cannot be stored the task stays as it was and the next pass tries again;
 * - the body has `windowMs` to be connected again, counted from when the step was LOST (its lease's end, else its start), not from
 *   when this process noticed (a Spot VM stopped for eight hours must not make yesterday's request young): the task stays
 *   `fca_unknown`, never retired as failed, meanwhile, and is paused as stopped, not failed (the owner may resume it) when the window
 *   has run out, either because the body did not return (`body_not_returned`) or because the step was already older than the window
 *   when it was noticed (`stale`);
 * - the release is asked of the body with a backoff (10 s, doubling to 5 min) and at most `FCA_BODY_RELEASE_ATTEMPTS` times; then the
 *   task is paused with `fca_body_release_unproven` and the action stays open (a lost step is never closed without proof);
 * - a task recovered `limit.count` times within `limit.withinMs` is paused the same way.
 * The owner's stop, the task's budget cap and every lease check are untouched: this only moves a task that was left unknown, and the
 * next step is admitted like any other. A paused task is left alone until the owner resumes it.
 */
export const FCA_BODY_RETURN_WINDOW_MS = 30 * 60_000;
export const FCA_BODY_RECOVERY_LIMIT = Object.freeze({ count: 6, withinMs: 60 * 60_000 });
export const FCA_BODY_RECOVERY_CODE = 'fca_body_reconciled';
/** The release asked of the body: the first wait, the longest wait, and the attempts after which the task is paused. */
export const RELEASE_BACKOFF_BASE_MS = 10_000;
export const RELEASE_BACKOFF_CAP_MS = 5 * 60_000;
export const FCA_BODY_RELEASE_ATTEMPTS = 10;
export const FCA_BODY_RELEASE_UNPROVEN = 'fca_body_release_unproven';

/** The wait after `attempts` unconfirmed releases: none before the first, then 10 s, 20 s, 40 s ... to 5 min. */
export function releaseBackoffMs(attempts: number): number {
  return attempts <= 0 ? 0 : Math.min(RELEASE_BACKOFF_CAP_MS, RELEASE_BACKOFF_BASE_MS * 2 ** (attempts - 1));
}

/** `SHANNON_FCA_BODY_RETURN_MINUTES`: how long a Minecraft request waits for its body (1 to 720 minutes; the default is 30). */
export function fcaBodyReturnWindow(value: string | undefined): number {
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 720 ? minutes * 60_000 : FCA_BODY_RETURN_WINDOW_MS;
}
/** `retireUnknown` leaves a body task alone this long past the window, so that the pause below always comes first. */
const HOLD_GRACE_MS = 5 * 60_000;
/** What the owner and `task.get` read of a Minecraft request paused here (its state is `stopped`; resuming it is the owner's). */
export const BODY_ABSENT_SUMMARY = '体が戻らなかったため一時停止しています。体が戻ってから再開できます。';
export const RECOVERY_LIMIT_SUMMARY = '同じ依頼が短い間に何度も中断されたため一時停止しています。確認してから再開できます。';
export const STALE_SUMMARY = '前回の操作から時間がたちすぎているため一時停止しています。状況を確かめてから再開できます。';
export const RELEASE_UNPROVEN_SUMMARY = '体が前回の操作の解放を確認できなかったため一時停止しています。体の状態を確かめてから再開できます。';
/** A resumed request that waits for the body's proof about the step it lost (it is not started until then). */
export const AWAITING_PROOF_SUMMARY = '前回の操作の結果を体がまだ確認できていないため、確認できるまで開始を待っています。';

export const BODY_RECOVERY_NOTICE = 'The previous step of this task was interrupted before its results were stored (a restart, a lost answer or a '
  + 'dropped command). The listed operations may or may not have taken effect; none of them was sent again. Read the fresh observation, '
  + 'check what is true now, and decide the next step; do not assume any listed operation succeeded or failed. Child tasks that step may '
  + 'have made and notes it may have sent are listed too: look at them before you make or send the same again.';

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
  /** Diagnostics: what is kept per lost step and per task. Every count returns to zero once nothing is waited for (L-8). */
  retained(): { releasing: number; told: number; awaiting: number; exhausted: number };
}

export function createFcaBodyRecovery(parts: FcaBodyRecoveryParts): FcaBodyRecovery {
  const { db, authority, runtime, scopeKey } = parts;
  const windowMs = parts.windowMs ?? FCA_BODY_RETURN_WINDOW_MS, limit = parts.limit ?? FCA_BODY_RECOVERY_LIMIT;
  const log = parts.log ?? ((line: string) => console.log(line));
  const leases = new ActionLeaseReader(db), checkpoints = new TaskBodyRecoveryStore(db);
  const instant = () => Date.parse(parts.now());
  const blocked = new Set<string>(), told = new Map<string, string>();
  /** Per lost step: when the body was last asked to release it and how many asks did not confirm (cleared with the step or the task). */
  const releasing = new Map<string, { at: number; attempts: number }>();
  /** Tasks whose release attempts ran out in this pass, and resumed tasks whose waiting has been said to the owner. */
  const exhausted = new Set<string>(), awaiting = new Set<string>();
  let lost: LostFcaStep[] = [];
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
    lost = steps;
    return steps;
  }

  function sinceUnknown(task: TaskRecord): number {
    const since = runtime.unknownSince?.(scopeKey, task.id) ?? task.updatedAt;
    const started = Date.parse(since);
    return Number.isFinite(started) ? instant() - started : 0;
  }

  /** Seconds since the task's oldest lost step was last alive, or null when no lost step has a time on record. */
  function gapMs(taskId: string): number | null {
    const gaps = lost.filter(step => step.taskId === taskId).flatMap(step => {
      const at = step.lostAt === null ? Number.NaN : Date.parse(step.lostAt);
      return Number.isFinite(at) ? [Math.max(0, instant() - at)] : [];
    });
    return gaps.length ? Math.max(...gaps) : null;
  }

  /** The owner-visible words of a task (what `task.get` and the owner's list read), without a change of state. */
  function annotate(taskId: string, summary: string): void {
    try {
      authority.transaction(() => authority.event(scopeKey, taskId, 'fca_note', parts.now(), { summary }, {}));
    } catch { /* the words are for the owner; the state is untouched either way */ }
  }

  function pause(task: TaskRecord, reason: string, summary: string, detail = ''): void {
    authority.transaction(() => {
      const current = authority.get(scopeKey, task.id);
      if (!current || current.pauseReason !== 'fca_unknown') return;
      checkpoints.releaseStep(task.id, { clearStop: true });
      authority.event(scopeKey, task.id, 'fca_body_paused', parts.now(), { status: 'paused', pauseReason: 'fca_stopped', summary, proof: true },
        { reason });
    });
    say(task.id, 'paused', `reason=${reason}${detail ? ` ${detail}` : ''}`);
  }

  function pauseExpired(): void {
    for (const id of checkpoints.unknownTaskIds(scopeKey)) {
      const task = authority.get(scopeKey, id);
      if (!task || !isBodyTask(task) || checkpoints.checkpoint(task.id)?.stopRequested) continue;
      if (sinceUnknown(task) > windowMs) {
        pause(task, 'body_not_returned', BODY_ABSENT_SUMMARY);
        continue;
      }
      // The window counts from the loss, not from this process noticing it: a request lost before a long stop is stale.
      const gap = gapMs(id);
      if (gap !== null && gap > windowMs) pause(task, 'stale', STALE_SUMMARY, `gapSeconds=${Math.round(gap / 1000)}`);
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
    const state = releasing.get(step.actionId) ?? { at: Number.NEGATIVE_INFINITY, attempts: 0 };
    if (state.attempts >= FCA_BODY_RELEASE_ATTEMPTS) {
      exhausted.add(taskId); // the body never confirmed: no more rows, and the task is paused (never closed without the proof)
      return null;
    }
    if (instant() - state.at < releaseBackoffMs(state.attempts)) return null;
    releasing.set(step.actionId, { at: instant(), attempts: state.attempts });
    say(taskId, 'waiting', 'for=release');
    const asked = await parts.body.release({ actionId: step.actionId, scopeKey, lease: step.lease });
    // Another re-check holds the body, or the body went away before a command was made: no row was written, ask again at the next pass.
    const unasked = asked.code === 'recheck_busy' || asked.code === 'body_unavailable';
    if (unasked) releasing.set(step.actionId, { at: Number.NEGATIVE_INFINITY, attempts: state.attempts });
    else if (asked.code !== 'released') releasing.set(step.actionId, { at: instant(), attempts: state.attempts + 1 });
    return fcaReleaseEvidence(db, step.lease, scopeKey);
  }

  /** The names of what the lost step sent the body, with how each stood: closed values, never arguments. */
  function lostOperations(operations: readonly BodyOperationState[]) {
    return operations.filter(operation => operation.kind === 'skill' || operation.kind === 'reflex').slice(0, 8)
      .map(operation => ({ tool: operation.skill ? `mc.${operation.skill}` : 'minecraft.reflex',
        outcome: operation.closedByApi ? 'no_receipt' : operation.outcome ?? 'no_receipt' }));
  }

  /**
   * The model's notice about a lost step, stored in the task's inbox and verified there (`recovery:<actionId>`): sending is idempotent,
   * so a later pass finds it. False: it is not in the inbox, and the caller does not go on without it.
   */
  function ensureNotice(taskId: string, step: Pick<LostFcaStep, 'actionId' | 'startedAt' | 'lostAt'>, operations: readonly BodyOperationState[]): boolean {
    const id = `recovery:${step.actionId}`;
    if (checkpoints.messageStored(scopeKey, taskId, id)) return true;
    const lostAt = step.lostAt === null ? Number.NaN : Date.parse(step.lostAt);
    const effects = checkpoints.effectsSince(scopeKey, taskId, step.startedAt);
    const text = JSON.stringify({ kind: 'body.recovery', reason: 'step_interrupted',
      ...(Number.isFinite(lostAt) ? { gapSeconds: Math.max(0, Math.round((instant() - lostAt) / 1000)) } : {}),
      lostOperations: lostOperations(operations), existingChildren: effects.children, sentNotes: effects.notes, instruction: BODY_RECOVERY_NOTICE });
    try {
      runtime.send(scopeKey, taskId, taskId, text, id);
    } catch { /* judged below by what the inbox holds, not by what this call said */ }
    try {
      return checkpoints.messageStored(scopeKey, taskId, id);
    } catch {
      return false;
    }
  }

  /** Closes one lost step. False: it cannot be closed yet (no proof from the body, no notice in the inbox, or the action store refused). */
  async function close(taskId: string, step: LostFcaStep): Promise<boolean> {
    const open = bodyOperations(db, step.lease, scopeKey).filter(operationUnresolved);
    const proof = open.length ? await releaseEvidence(taskId, step) : null;
    if (open.length && !proof) return false;
    if (proof) authority.transaction(() => reconcileOperations(db, step.lease, scopeKey, proof.id, parts.now()));
    const operations = bodyOperations(db, step.lease, scopeKey);
    // The notice first: the action is closed only once the model's notice is in the inbox, so a failure leaves the step open to be tried
    // again (the notice and the closing are both idempotent). A task never goes on without having been told.
    if (!ensureNotice(taskId, step, operations)) {
      say(taskId, 'waiting', 'for=notice');
      return false;
    }
    if (!await parts.actions.reconcile(step.lease, 'failed', FCA_BODY_RECOVERY_CODE).catch(() => false)) {
      say(taskId, 'waiting', 'for=action');
      return false;
    }
    releasing.delete(step.actionId);
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

  /**
   * The release attempts ran out without the body's proof. An unknown task is paused (the action stays open); a resumed task that was
   * waiting is stopped, so that nothing goes on asking the body. Either is the owner's to resume, which begins a new count.
   */
  function giveUp(task: TaskRecord): void {
    exhausted.delete(task.id);
    awaiting.delete(task.id);
    for (const step of lost) if (step.taskId === task.id) releasing.delete(step.actionId);
    if (task.pauseReason === 'fca_unknown') {
      pause(task, FCA_BODY_RELEASE_UNPROVEN, RELEASE_UNPROVEN_SUMMARY);
      return;
    }
    try {
      runtime.stop(scopeKey, task.id, FCA_BODY_RELEASE_UNPROVEN);
      annotate(task.id, RELEASE_UNPROVEN_SUMMARY);
      say(task.id, 'paused', `reason=${FCA_BODY_RELEASE_UNPROVEN}`);
    } catch { /* the next pass tries again; the attempts are already spent, so the body is not asked */ }
  }

  /** Closes the task's lost steps in order. False: one is still open, and the owner is told why a resumed task does not start. */
  async function closeSteps(task: TaskRecord, steps: readonly LostFcaStep[]): Promise<boolean> {
    for (const step of steps) {
      if (await close(task.id, step)) continue;
      if (exhausted.has(task.id)) giveUp(task);
      else if (task.pauseReason !== 'fca_unknown' && !awaiting.has(task.id)) {
        // The owner resumed it, and it is not started until the body proves the lost step released: say so where the owner reads.
        awaiting.add(task.id);
        annotate(task.id, AWAITING_PROOF_SUMMARY);
      }
      return false;
    }
    awaiting.delete(task.id);
    return true;
  }

  async function recover(task: TaskRecord, steps: readonly LostFcaStep[], receipted: ReadonlySet<string>): Promise<void> {
    const row = checkpoints.checkpoint(task.id);
    if (parts.running(task.id) || receipted.has(task.id) || !row || row.stopRequested) return;
    const unknown = task.pauseReason === 'fca_unknown';
    // A paused task waits for the owner; nothing is asked of the body for it.
    if (task.status === 'paused' && !unknown) return;
    if (unknown && !bodyConnected(task.id)) {
      say(task.id, 'waiting', 'for=body');
      return;
    }
    if (await closeSteps(task, steps) && unknown) goOn(task, steps.length === 0 ? row.leaseId : null);
  }

  function bodyConnected(taskId: string): boolean {
    const bodyId = parts.body.bound(taskId);
    return !!bodyId && parts.body.connected(bodyId);
  }

  /**
   * Returns an unknown task whose lost steps are closed to the queue. With no lost step on record (it was closed before this pass), the
   * notice of the step the checkpoint still names (`unrecordedLease`) must be in the inbox first.
   */
  function goOn(task: TaskRecord, unrecordedLease: string | null): void {
    if (unrecordedLease && !ensureNotice(task.id, { actionId: unrecordedLease, startedAt: null, lostAt: null }, [])) {
      say(task.id, 'waiting', 'for=notice');
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
    const open = refreshBlocked();
    forget(new Set(open.map(step => step.actionId)), ids);
  }

  /** What is kept per lost step and per task goes when the step is closed and the task is no longer waited for. */
  function forget(actions: ReadonlySet<string>, tasks: ReadonlySet<string>): void {
    for (const id of [...releasing.keys()]) if (!actions.has(id)) releasing.delete(id);
    for (const id of [...told.keys()]) if (!tasks.has(id)) told.delete(id);
    for (const id of [...awaiting]) if (!blocked.has(id)) awaiting.delete(id);
    for (const id of [...exhausted]) if (!tasks.has(id)) exhausted.delete(id);
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
    retained: () => ({ releasing: releasing.size, told: told.size, awaiting: awaiting.size, exhausted: exhausted.size }),
  };
}
