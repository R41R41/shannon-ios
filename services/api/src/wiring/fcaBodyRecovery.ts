import type { FcaBodyRecoveryParts,FcaBodyRecovery,ReleaseState } from './fcaBodyRecoveryTypes.js';
import type { TaskRecord } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import { TaskBodyRecoveryStore,type OwedNotice,type RecoveryCheckpoint } from '../mind/action/taskRuntime/store/taskBodyRecoveryStore.js';
import { ActionLeaseReader,type LostFcaStep } from '../mind/action/threads/store/actionLeaseReader.js';
import {
bodyOperations,operationUnresolved,reconcileOperations,type BodyOperationState,
} from '../surfaces/minecraft/store/minecraftOperationReconcile.js';
import { fcaReleaseEvidence } from './configuredActionResourceProof.js';
import { createPauseAnnouncer } from './fcaPauseAnnouncer.js';
import { storeNotice } from './fcaBodyRecoveryNotice.js';
import {
AWAITING_PROOF_SUMMARY,BODY_ABSENT_SUMMARY,BODY_HELD_HINT,HELD_SUMMARY,FCA_BODY_RECOVERY_CODE,FCA_BODY_RECOVERY_LIMIT,
FCA_BODY_RELEASE_ATTEMPTS,FCA_BODY_RELEASE_UNPROVEN,FCA_BODY_RETURN_WINDOW_MS,FCA_PAUSED_RELEASE_ATTEMPTS,HOLD_GRACE_MS,heldBackoffMs,
ownSummary,RECOVERY_LIMIT_SUMMARY,RELEASE_UNPROVEN_SUMMARY,releaseBackoffMs,STALE_SUMMARY,
} from './fcaBodyRecoveryPolicy.js';
export type { FcaBodyRecoveryParts, FcaBodyRecovery } from './fcaBodyRecoveryTypes.js';

/**
 * A Minecraft request survives a step whose outcome was lost (Minebot parity audit C-20/C-21, 2026-10-19). The
 * step is never replayed and
 * no body operation of it is ever sent again: once the body itself has proven its inputs released (or the step
 * sent nothing), the lost
 * step's operations and action are closed and the task goes on from a fresh observation with a notice; a PAUSED
 * task's lost step is let
 * go of the same way while it stays paused, so the body is free (M-C). The bounds, the backoffs and the words are in
 * `fcaBodyRecoveryPolicy.ts`; the whole design is in `docs/fca-runtime-contract.md` (*Provider errors and lost Minecraft steps*).
 */
export * from './fcaBodyRecoveryPolicy.js';

export function createFcaBodyRecovery(parts: FcaBodyRecoveryParts): FcaBodyRecovery {
  const { db, authority, runtime, scopeKey } = parts;
  const windowMs = parts.windowMs ?? FCA_BODY_RETURN_WINDOW_MS, limit = parts.limit ?? FCA_BODY_RECOVERY_LIMIT;
  const log = parts.log ?? ((line: string) => console.log(line));
  const leases = new ActionLeaseReader(db), checkpoints = new TaskBodyRecoveryStore(db);
  const instant = () => Date.parse(parts.now());
  const blocked = new Set<string>(), told = new Map<string, string>();
  /**
   * Per lost step: when the body was last asked to release it (this process) and how many asks did not confirm
 * (kept in the database too,
   * L-11, so that a restart does not begin the count again). Cleared with the step or the task.
   */
  const releasing = new Map<string, ReleaseState>();
  /** Tasks whose release attempts ran out in this pass, and resumed tasks whose waiting has been said to the owner. */
  const exhausted = new Set<string>(), awaiting = new Set<string>();
  const notices = createPauseAnnouncer({ runtime, authority, scopeKey, log });
  let lost: LostFcaStep[] = [];
  let working: Promise<void> | null = null, lastPass = Number.NEGATIVE_INFINITY;

  const isBodyTask = (task: Pick<TaskRecord, 'id' | 'origin' | 'kind'>) => task.origin === 'owner_request'
    && (task.kind === 'research' || task.kind === 'generic') && parts.body.bound(task.id) !== null;
  const isBodyTaskId = (taskId: string) => {
    const task = authority.get(scopeKey, taskId);
    return !!task && isBodyTask(task);
  };
  /** Says a task's waiting reason once per change, not once per pass; an outcome is always said and starts the next wait afresh. */
  const say = (taskId: string, code: string, detail = '') => {
    const waiting = code === 'waiting';
    if (waiting && told.get(taskId) === detail) return;
    if (waiting) told.set(taskId, detail);
    else told.delete(taskId);
    log(`Shannon FCA body recovery task=${taskId} code=${code}${detail ? ` ${detail}` : ''}`);
  };

  function releaseState(actionId: string): ReleaseState {
    return releasing.get(actionId) ?? { at: Number.NEGATIVE_INFINITY, ...checkpoints.releaseAttempts(actionId) };
  }
  function remember(actionId: string, taskId: string, state: ReleaseState, persist: boolean): void {
    releasing.set(actionId, state);
    if (persist) checkpoints.setReleaseAttempts(actionId, taskId, { attempts: state.attempts, held: state.held }, parts.now());
  }
  function dropRelease(actionId: string): void {
    releasing.delete(actionId);
    checkpoints.clearReleaseAttempts(actionId);
  }

  /** The lost steps of Minecraft requests; the tasks they hold, and the ones that owe a notice, are not admitted
 * until that is settled. */
  function refreshBlocked(): LostFcaStep[] {
    // Only a body task's steps are read in full (L-1): the filter runs before the per-step queries.
    const steps = leases.lostFcaSteps(scopeKey, parts.now(), isBodyTaskId);
    blocked.clear();
    for (const step of steps) blocked.add(step.taskId);
    for (const id of checkpoints.owingTaskIds(scopeKey)) {
      const task = authority.get(scopeKey, id);
      if (task && isBodyTask(task)) blocked.add(id);
    }
    lost = steps;
    return steps;
  }

  const isHeld = (task: TaskRecord): boolean => { try { return parts.held?.(task.id) === true; } catch { return false; } };
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

  const owedOf = (step: LostFcaStep): OwedNotice => ({ actionId: step.actionId, lease: step.lease, startedAt: step.startedAt, lostAt: step.lostAt });

  /** What the model is owed about the task's lost steps when the owner resumes it (L-5): the lost steps still open,
 * else the checkpoint's. */
  function owedMarkers(taskId: string): OwedNotice[] {
    const mine = openStepsOf(taskId);
    if (mine.length) return mine.map(owedOf);
    const leaseId = checkpoints.checkpoint(taskId)?.leaseId;
    return leaseId ? [{ actionId: leaseId, lease: null, startedAt: null, lostAt: null }] : [];
  }

  /** The task's lost steps that are still open now (`lost` may be older than a step closed a moment ago in the same pass). */
  const openStepsOf = (taskId: string) => leases.lostFcaSteps(scopeKey, parts.now(), id => id === taskId);

  /** The summary of a pause: with the hint while a lost step still holds the body. */
  const pausedSummary = (taskId: string, summary: string) => openStepsOf(taskId).length ? `${summary}${BODY_HELD_HINT}` : summary;

  /**
   * Pauses an unknown task as stopped (resumable) and tells the owner once, in the same commit (M-2: the failure
 * this replaced left a
   * report). False, and nothing said or logged: the task was not unknown any more (another pass or the retirement
 * got there first).
   */
  function pause(task: TaskRecord, reason: string, summary: string, detail = ''): boolean {
    const paused = authority.transaction(() => {
      const current = authority.get(scopeKey, task.id);
      if (!current || current.pauseReason !== 'fca_unknown') return false;
      // The notice the model is owed is remembered before the task lets go of its step: the action may be closed while it is paused.
      checkpoints.changeOwed(task.id, { add: owedMarkers(task.id) });
      checkpoints.releaseStep(task.id, { clearStop: true });
      const change = { status: 'paused' as const, pauseReason: 'fca_stopped', summary: pausedSummary(task.id, summary), proof: true };
      const after = authority.event(scopeKey, task.id, 'fca_body_paused', parts.now(), change, { reason });
      // L-2: the notice is in this commit when it can be; a notice that cannot be written never undoes the pause (it is tried again).
      notices.announce(current, `${reason}:${after.revision}`, summary);
      return true;
    });
    if (paused) say(task.id, 'paused', `reason=${reason}${detail ? ` ${detail}` : ''}`);
    return paused;
  }

  /** A task the owner resumed (or that never was unknown) is stopped, resumable: its lost step is still open, so it
 * must not run. */
  function stopResumed(task: TaskRecord, reason: string, summary: string): boolean {
    try {
      const stopped = runtime.stop(scopeKey, task.id, reason).find(item => item.id === task.id);
      try {
        authority.transaction(() => checkpoints.changeOwed(task.id, { add: owedMarkers(task.id) }));
      } catch { /* the step is still open: the notice is sent when it is closed */ }
      annotate(task.id, pausedSummary(task.id, summary));
      // M-2: the owner hears of it once; the stop has taken, so a failure of the report does not undo it (L-3: it is tried again).
      notices.announce(task, `${reason}:${stopped?.revision ?? 0}`, summary);
      say(task.id, 'paused', `reason=${reason}`);
      return true;
    } catch {
      return false; // the next pass tries again; the attempts are already spent, so the body is not asked
    }
  }

  function pauseExpiredUnknown(id: string): void {
    const task = authority.get(scopeKey, id);
    if (!task || !isBodyTask(task) || (checkpoints.checkpoint(task.id)?.stopRequested && !isHeld(task))) return;
    if (sinceUnknown(task) > windowMs) {
      pause(task, 'body_not_returned', BODY_ABSENT_SUMMARY);
      return;
    }
    // The window counts from the loss, not from this process noticing it: a request lost before a long stop is stale.
    const gap = gapMs(id);
    if (gap !== null && gap > windowMs) pause(task, 'stale', STALE_SUMMARY, `gapSeconds=${Math.round(gap / 1000)}`);
  }

  /** L-3: a task the owner resumed, whose lost step is still open, waits for its body under the same window,
 * counted from the resume. */
  function pauseExpiredResumed(id: string): void {
    const task = authority.get(scopeKey, id);
    if (!task || !isBodyTask(task) || task.status === 'paused' || task.pauseReason === 'fca_unknown' || parts.running(id)) return;
    const row = checkpoints.checkpoint(id);
    if (!row || row.stopRequested) return;
    const resumed = Date.parse(checkpoints.lastEventAt(id, 'fca_resumed') ?? task.updatedAt);
    if (Number.isFinite(resumed) && instant() - resumed > windowMs && stopResumed(task, 'body_not_returned', BODY_ABSENT_SUMMARY)) awaiting.delete(id);
  }

  /** One task's failure never stops the others (L-5): it is logged by task and code, and the next tick tries again. */
  function pauseExpired(): void {
    const each = (ids: Iterable<string>, work: (id: string) => void) => {
      for (const id of ids) {
        try {
          work(id);
        } catch {
          log(`Shannon FCA body recovery task=${id} code=expire_failed`);
        }
      }
    };
    each(checkpoints.unknownTaskIds(scopeKey), pauseExpiredUnknown);
    each(new Set(lost.map(step => step.taskId)), pauseExpiredResumed);
  }

  /**
   * The body's proof that its inputs are released after the step's last operation; asks the body once the body is
 * connected. `held`: the
   * task is paused, so the asking is slower and bounded in all by `FCA_PAUSED_RELEASE_ATTEMPTS` (then the body
 * stays held for the operator).
   */
  async function releaseEvidence(taskId: string, step: LostFcaStep, held: boolean) {
    const proof = fcaReleaseEvidence(db, step.lease, scopeKey);
    const bodyId = parts.body.bound(taskId);
    if (proof || !bodyId) return proof;
    if (!parts.body.connected(bodyId)) {
      say(taskId, 'waiting', 'for=body');
      return null;
    }
    const state = releaseState(step.actionId), used = held ? state.held : state.attempts;
    if (used >= (held ? FCA_PAUSED_RELEASE_ATTEMPTS : FCA_BODY_RELEASE_ATTEMPTS)) {
      if (held) say(taskId, 'waiting', 'for=operator'); // no more rows: the operator's `minecraft release` is the way on
      else exhausted.add(taskId); // the body never confirmed: no more rows, and the task is paused (never closed without the proof)
      return null;
    }
    if (instant() - state.at < (held ? heldBackoffMs(used) : releaseBackoffMs(used))) return null;
    remember(step.actionId, taskId, { ...state, at: instant() }, false);
    say(taskId, 'waiting', 'for=release');
    const asked = await parts.body.release({ actionId: step.actionId, scopeKey, lease: step.lease });
    // Another re-check holds the body, or the body went away before a command was made: no row was written and nothing is counted;
    // ask again at the next pass.
    const unasked = asked.code === 'recheck_busy' || asked.code === 'body_unavailable';
    if (unasked) remember(step.actionId, taskId, { ...state, at: Number.NEGATIVE_INFINITY }, false);
    else if (asked.code !== 'released') {
      remember(step.actionId, taskId, { at: instant(), attempts: state.attempts + (held ? 0 : 1), held: state.held + (held ? 1 : 0) }, true);
    }
    return fcaReleaseEvidence(db, step.lease, scopeKey);
  }

  const ensureNotice = (taskId: string, step: Pick<LostFcaStep, 'actionId' | 'startedAt' | 'lostAt'>, operations: readonly BodyOperationState[]) =>
    storeNotice({ runtime, checkpoints, scopeKey, instant }, taskId, step, operations);

  /** The notice for this step is in the inbox: the task owes none for it any more. */
  function settleOwed(taskId: string, actionId: string): void {
    try {
      if (checkpoints.owedNotices(taskId).some(item => item.actionId === actionId)) {
        authority.transaction(() => checkpoints.changeOwed(taskId, { remove: actionId }));
      }
    } catch { /* the next pass finds the notice stored and removes it */ }
  }

  /**
   * Closes one lost step. False: it cannot be closed yet (no proof from the body, no notice in the inbox, or the
 * action store refused).
   * `held` (the task is paused): the body's operations and the action are closed, which frees the body, but the
 * notice is not sent now:
   * the task owes it (remembered first) and sends it when the owner resumes it, with the gap as it is then (L-5).
   */
  async function close(taskId: string, step: LostFcaStep, held = false): Promise<boolean> {
    const open = bodyOperations(db, step.lease, scopeKey, taskId).filter(operationUnresolved);
    const proof = open.length ? await releaseEvidence(taskId, step, held) : null;
    if (open.length && !proof) return false;
    if (held) authority.transaction(() => checkpoints.changeOwed(taskId, { add: [owedOf(step)] }));
    if (proof) authority.transaction(() => reconcileOperations(db, step.lease, scopeKey, proof.id, parts.now(), taskId));
    const operations = bodyOperations(db, step.lease, scopeKey, taskId);
    // The notice first: the action is closed only once the model's notice is in the inbox, so a failure leaves the
// step open to be tried
    // again (the notice and the closing are both idempotent). A task never goes on without having been told.
    if (!held) {
      if (!ensureNotice(taskId, step, operations)) {
        say(taskId, 'waiting', 'for=notice');
        return false;
      }
      settleOwed(taskId, step.actionId);
    }
    if (!await parts.actions.reconcile(step.lease, 'failed', FCA_BODY_RECOVERY_CODE).catch(() => false)) {
      say(taskId, 'waiting', 'for=action');
      return false;
    }
    dropRelease(step.actionId);
    say(taskId, 'reconciled', `action=${step.actionId} operations=${operations.length} unresolved=${open.length}${held ? ' held=paused' : ''}`);
    return true;
  }

  function recentRecoveries(row: RecoveryCheckpoint): string[] {
    const kept = (row.checkpointJson ? JSON.parse(row.checkpointJson) as { fcaBodyRecoveries?: unknown } : {}).fcaBodyRecoveries;
    const since = instant() - limit.withinMs;
    return Array.isArray(kept) ? kept.filter((at): at is string => typeof at === 'string' && Date.parse(at) > since) : [];
  }

  /** The unknown task returns to the queue, with its checkpoint as it was and the count of recoveries; false: it
 * was paused instead. */
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
      // A summary this recovery wrote earlier (a pause, a wait) is not the state of a task that goes on (L-4).
      authority.event(scopeKey, task.id, 'fca_body_recovered', parts.now(),
        { status: 'queued', pauseReason: null, proof: true, ...(ownSummary(current.summary) ? { summary: '' } : {}) }, { stepId: row.stepId });
      return true;
    });
  }

  /**
   * The release attempts ran out without the body's proof. An unknown task is paused (the action stays open); a
 * resumed task that was
   * waiting is stopped, so that nothing goes on asking the body. Either is the owner's to resume, which begins a
 * new count of the asks
   * made while it runs. The count and `exhausted` are let go only once the pause or stop has taken (L-1): a stop
 * that fails leaves them,
   * so that the next pass tries the stop again and does not ask the body another ten times.
   */
  function giveUp(task: TaskRecord): void {
    let done = false;
    if (task.pauseReason === 'fca_unknown') {
      try {
        pause(task, FCA_BODY_RELEASE_UNPROVEN, RELEASE_UNPROVEN_SUMMARY);
        done = true;
      } catch { /* the next pass tries again */ }
    } else done = stopResumed(task, FCA_BODY_RELEASE_UNPROVEN, RELEASE_UNPROVEN_SUMMARY);
    if (!done) return;
    exhausted.delete(task.id);
    awaiting.delete(task.id);
    // From here the task is paused: the asks made while it runs begin again, and its slower asking begins a minute from now.
    for (const step of lost) {
      if (step.taskId !== task.id) continue;
      const state = releaseState(step.actionId);
      remember(step.actionId, task.id, { at: instant(), attempts: 0, held: state.held }, true);
    }
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

  /**
   * A paused task's lost steps (M-C): the body is asked for the proof, slowly and a bounded number of times, and
 * when it comes the
   * steps' operations and actions are closed, which frees the body for new requests. The task stays paused and
 * nothing is decided.
   */
  async function freeBody(task: TaskRecord, steps: readonly LostFcaStep[]): Promise<void> {
    if (!steps.length) return;
    for (const step of steps) if (!await close(task.id, step, true)) return;
    // The hint said the body was held; it is not any more.
    if (task.summary.endsWith(BODY_HELD_HINT)) annotate(task.id, task.summary.slice(0, -BODY_HELD_HINT.length));
  }

  /** The notices a resumed task owes for steps that were let go while it was paused (L-5). False: one is not stored yet. */
  function payOwed(task: TaskRecord, openSteps: readonly LostFcaStep[]): boolean {
    for (const owed of checkpoints.owedNotices(task.id)) {
      if (openSteps.some(step => step.actionId === owed.actionId)) continue;
      const operations = owed.lease ? bodyOperations(db, owed.lease, scopeKey, task.id) : [];
      if (!ensureNotice(task.id, owed, operations)) {
        say(task.id, 'waiting', 'for=notice');
        return false;
      }
      settleOwed(task.id, owed.actionId);
    }
    return true;
  }

  async function recover(task: TaskRecord, steps: readonly LostFcaStep[], receipted: ReadonlySet<string>): Promise<void> {
    const row = checkpoints.checkpoint(task.id);
    if (parts.running(task.id) || receipted.has(task.id) || !row) return;
    const unknown = task.pauseReason === 'fca_unknown';
    if (task.status === 'paused' && !unknown) {
      // A paused task waits for the owner, but its lost step goes on holding the body: that is let go once the body proves it (M-C).
      // One whose stop is still being acknowledged by a step is left to that stop.
      if (!row.stopRequested || row.stepId === null) await freeBody(task, steps);
    } else if (unknown && isHeld(task)) {
      // A-17: a held request is the operator's: it does not go on by itself (a stop request or not); once the body
// proves its lost steps released it is paused, stopped and resumable.
      if (bodyConnected(task.id) && await closeSteps(task, steps)) pause(task, 'held', HELD_SUMMARY);
    } else if (!row.stopRequested) {
      await (unknown ? recoverUnknown(task, steps, row) : recoverResumed(task, steps));
    }
  }

  async function recoverUnknown(task: TaskRecord, steps: readonly LostFcaStep[], row: RecoveryCheckpoint): Promise<void> {
    if (!bodyConnected(task.id)) say(task.id, 'waiting', 'for=body');
    else if (await closeSteps(task, steps)) goOn(task, steps.length === 0 ? row.leaseId : null);
  }

  /** A resumed task: its model is told of every step let go meanwhile, with the gap as it is now, before its first step. */
  async function recoverResumed(task: TaskRecord, steps: readonly LostFcaStep[]): Promise<void> {
    if (!await closeSteps(task, steps) || !payOwed(task, steps)) return;
    if (ownSummary(task.summary)) annotate(task.id, ''); // L-4: "waiting for the proof" is not what a task that starts says
  }

  function bodyConnected(taskId: string): boolean {
    const bodyId = parts.body.bound(taskId);
    return !!bodyId && parts.body.connected(bodyId);
  }

  /**
   * Returns an unknown task whose lost steps are closed to the queue. With no lost step on record (it was closed
 * before this pass), the
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
    const ids = new Set([...steps.map(step => step.taskId), ...checkpoints.unknownTaskIds(scopeKey), ...checkpoints.owingTaskIds(scopeKey)]);
    for (const id of ids) {
      try {
        const task = authority.get(scopeKey, id);
        if (task && isBodyTask(task)) await recover(task, steps.filter(step => step.taskId === id), receipted);
      } catch {
        log(`Shannon FCA body recovery task=${id} code=pass_failed`); // one task's failure never stops the others; the next pass tries again
      }
    }
    notices.retry();
    const open = refreshBlocked();
    forget(new Set(open.map(step => step.actionId)), ids);
  }

  /** What is kept per lost step and per task goes when the step is closed and the task is no longer waited for. */
  function forget(actions: ReadonlySet<string>, tasks: ReadonlySet<string>): void {
    for (const id of [...releasing.keys()]) if (!actions.has(id)) releasing.delete(id);
    for (const id of checkpoints.releaseAttemptActionIds()) if (!actions.has(id)) checkpoints.clearReleaseAttempts(id);
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

  const holds = (task: TaskRecord) => task.pauseReason === 'fca_unknown' && isBodyTask(task)
    && (isHeld(task) || (!checkpoints.checkpoint(task.id)?.stopRequested && sinceUnknown(task) <= windowMs + HOLD_GRACE_MS));
  return {
    isBodyTask,
    holds,
    blocks: taskId => blocked.has(taskId),
    expire() {
      try {
        refreshBlocked();
        pauseExpired();
        notices.retry();
      } catch {
        log('Shannon FCA body recovery code=expire_failed'); // the scheduler goes on; the next tick tries again
      }
    },
    advance,
    idle: async () => {
      await working;
    },
    retained: () => ({ releasing: releasing.size, told: told.size, awaiting: awaiting.size, exhausted: exhausted.size, unannounced: notices.pending() }),
  };
}
