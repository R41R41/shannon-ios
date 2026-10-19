import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { actionResource, type ActionLease, type ActionThreads } from '../contracts/actionThreadContract.js';
import type { BodyTaskContext } from '../contracts/bodyControlContract.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import { ActionLeaseReader, fcaTaskIdOf } from '../mind/action/threads/store/actionLeaseReader.js';
import { FCA_RECHECK_PREFIX, fcaReleaseAcknowledgement, fcaReleaseEvidence } from './configuredActionResourceProof.js';

/** What one re-check came to (the operator's CLI prints it as its code). */
export type BodyRecheckCode = 'released' | 'not_retained' | 'body_unavailable' | 'not_confirmed' | 'proof_refused' | 'recheck_busy';
export interface BodyRecheckResult { code: BodyRecheckCode; actionIds: readonly string[]; detail: string }
/** Attempts the API makes on its own (at start, then while the body is away) per held step and process; the operator may ask again. */
export const BODY_RECHECK_ATTEMPTS = 3;
const TICK_MS = 5_000;

/**
 * The body re-check (Minecraft run 6; owner decision 2026-10-14 「直しを入れてから自動で解放」, never the owner's force release and
 * never an edit of the database). An FCA step whose outcome stayed unknown keeps the Minecraft body retained until a release
 * proof. Here the API asks the body itself: a `release` of the same lease and session under a new id. The body cancels whatever of
 * that session may remain and answers `stopped` only once its actuator confirmed every physical input released; that original
 * receipt is the domain proof (`minecraftFcaReleaseProof`) the action store re-reads under its writer lock before it ends the
 * retained record. A body that cannot confirm leaves the body retained, as before.
 *
 * It runs at start for every retained body of an unknown step (so a lease held before this build clears once the body is
 * connected), and whenever the operator asks (`opsCli.ts minecraft release`): a request to check again, not a force.
 */
export function createMinecraftBodyRecheck(parts: {
  db: DatabaseSync; control: MinecraftControl; actions: Pick<ActionThreads, 'reconcileResource'>; ownerScope: string; deviceId: string;
  log?(line: string): void; tickMilliseconds?: number; releaseMilliseconds?: number;
}) {
  const resource = actionResource(parts.deviceId, 'minecraft-body');
  const leases = new ActionLeaseReader(parts.db);
  const attempts = new Map<string, number>();
  let running: Promise<BodyRecheckResult> | null = null, closing = false;
  const held = () => leases.retainedUnknownSteps(resource).filter(step => step.scopeKey === parts.ownerScope);
  const reconcile = async (lease: ActionLease): Promise<boolean> => {
    const evidence = fcaReleaseEvidence(parts.db, lease, parts.ownerScope);
    return !!evidence && await parts.actions.reconcileResource(lease, resource, fcaReleaseAcknowledgement(evidence));
  };
  /**
   * The task, body and session to ask about. A step that sent nothing itself (run 12: a judgment that timed out) has no body command
   * under its lease: take the session its holder last used for this task, as this lease. The session only names the command: the
   * body's cleanup releases the whole body (`actuator.release`), and the proof still needs the body's own `stopped` receipt.
   */
  function contextOf(lease: ActionLease): BodyTaskContext | null {
    const own = parts.control.store.lastOfLease(lease);
    if (own) return own.context;
    const taskId = fcaTaskIdOf(leases.get(lease.id)?.sourceId ?? '');
    return taskId ? parts.control.store.lastOfHolder(lease, taskId, parts.ownerScope)?.context ?? null : null;
  }
  async function recheck(step: ReturnType<typeof held>[number], attempt: number): Promise<BodyRecheckCode> {
    if (await reconcile(step.lease)) return 'released'; // Proven earlier (a reconcile lost in transit): no new command.
    const context = contextOf(step.lease);
    if (!context) return 'proof_refused';
    if (!parts.control.frame(context.bodyId)) return 'body_unavailable';
    const id = `${FCA_RECHECK_PREFIX}${createHash('sha256').update(JSON.stringify([step.lease, context.sessionId, attempt, Date.now()])).digest('hex')}`;
    try {
      const receipt = await parts.control.command({ id, context, lease: step.lease, kind: 'release',
        stop: { context, requestId: id, reason: 'cancel' }, milliseconds: parts.releaseMilliseconds ?? 5_000 });
      if (receipt.stop?.state !== 'stopped' || !receipt.stop.inputsReleased) return 'not_confirmed';
    } catch (error) {
      return error instanceof Error && error.message === 'FCA_BODY_UNAVAILABLE' ? 'body_unavailable' : 'not_confirmed';
    }
    return await reconcile(step.lease) ? 'released' : 'proof_refused';
  }
  /** One pass over every retained body of an unknown step. `operator`: asked now, whatever the API's own attempts so far. */
  function request(origin: 'start' | 'operator'): Promise<BodyRecheckResult> {
    if (running) return origin === 'operator' ? Promise.resolve({ code: 'recheck_busy', actionIds: [], detail: 'a re-check is running' }) : running;
    const job = (async (): Promise<BodyRecheckResult> => {
      const steps = held();
      if (!steps.length) return { code: 'not_retained', actionIds: [], detail: 'no unknown step holds the body' };
      const codes: BodyRecheckCode[] = [];
      for (const step of steps) {
        const tried = attempts.get(step.actionId) ?? 0;
        if (origin === 'start' && tried >= BODY_RECHECK_ATTEMPTS) continue;
        const code = await recheck(step, tried + 1);
        // Only a physical attempt counts against the API's own budget; waiting for the body to connect does not.
        if (code === 'not_confirmed' || code === 'proof_refused') attempts.set(step.actionId, tried + 1);
        if (code === 'released') attempts.delete(step.actionId);
        parts.log?.(`Shannon Minecraft body re-check origin=${origin} action=${step.actionId} code=${code}`);
        codes.push(code);
      }
      const order: BodyRecheckCode[] = ['not_confirmed', 'proof_refused', 'body_unavailable', 'released'];
      const code = order.find(value => codes.includes(value)) ?? 'not_retained';
      return { code, actionIds: steps.map(step => step.actionId), detail: codes.join(',') || 'attempts exhausted' };
    })().catch((error: unknown): BodyRecheckResult => ({ code: 'not_confirmed', actionIds: [],
      detail: error instanceof Error ? error.message.slice(0, 120) : 'error' }))
      .finally(() => { if (running === job) running = null; });
    running = job;
    return job;
  }
  /**
   * One physical release of one step, now (the Minecraft recovery, `fcaBodyRecovery.ts`): an unknown step need not wait for its
   * unknown exit to record the body as retained before the body is asked. The same command, proof and attempt count as above; the
   * recovery judges the evidence itself. Busy while another re-check runs. Every call that reaches the body writes one `recheck:` row, so
   * the caller owns the bound: the recovery asks with a backoff (10 s doubling to 5 min) and at most `FCA_BODY_RELEASE_ATTEMPTS` times
   * per lost step before it pauses the task (`fcaBodyRecovery.ts`); a call that finds no body connection writes no row.
   */
  function releaseStep(step: { actionId: string; scopeKey: string; lease: ActionLease }): Promise<BodyRecheckResult> {
    if (running || closing) return Promise.resolve({ code: 'recheck_busy', actionIds: [], detail: 'a re-check is running' });
    const job = (async (): Promise<BodyRecheckResult> => {
      const tried = attempts.get(step.actionId) ?? 0;
      const code = await recheck(step, tried + 1);
      if (code === 'not_confirmed' || code === 'proof_refused') attempts.set(step.actionId, tried + 1);
      if (code === 'released') attempts.delete(step.actionId);
      parts.log?.(`Shannon Minecraft body re-check origin=recovery action=${step.actionId} code=${code}`);
      return { code, actionIds: [step.actionId], detail: code };
    })().catch((error: unknown): BodyRecheckResult => ({ code: 'not_confirmed', actionIds: [step.actionId],
      detail: error instanceof Error ? error.message.slice(0, 120) : 'error' }))
      .finally(() => { if (running === job) running = null; });
    running = job;
    return job;
  }
  const timer = setInterval(() => { if (!closing && !running && held().length) void request('start'); }, parts.tickMilliseconds ?? TICK_MS);
  timer.unref();
  async function close() {
    closing = true;
    clearInterval(timer);
    await running;
  }
  return { request, held, close, releaseStep };
}
export type MinecraftBodyRecheck = ReturnType<typeof createMinecraftBodyRecheck>;
