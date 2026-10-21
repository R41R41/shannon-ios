import { actionResource, type ActionDraft, type ActionThreads, type RunningAction } from '../contracts/actionThreadContract.js';
import type { MinecraftLifecycleCommand, MinecraftLifecycleReceipt, MinecraftLifecycleRequest } from '../contracts/minecraftLifecycleContract.js';
import { inActionExecution } from '../infra/context/actionExecution.js';
import type { MinecraftLifecycle } from '../surfaces/minecraft/minecraftLifecycle.js';
import { acquireAction } from './actionExecutionWiring.js';

/** How a detached lifecycle operation ended for its caller: an accepted native receipt, or none (not started, or unknown). */
export interface LifecycleSettlement {
  receipt: MinecraftLifecycleReceipt | null;
  /** The original command was written (it may have reached the operator); without a receipt its outcome is unknown. */
  issued: boolean;
  /** The command as stored (null when it never was): what it asked for, e.g. a new world (options.freshWorld). */
  command?: MinecraftLifecycleCommand | null;
  /**
   * The receipt the operator left unknown when none was accepted. Nothing is claimed from it as an outcome, but a world it names did
   * move (a fresh-world start that could not be confirmed), and the owner is told so.
   */
  unconfirmed?: MinecraftLifecycleReceipt | null;
}

/**
 * A Minecraft lifecycle operation that outlives whoever asked for it (Syzygy ADR-0009 D2, stage 1 S7; the 2026-10-13 TI-REQ).
 * It holds its own action of kind `minecraft` (the Minecraft slot, one lease, the action gate's) and the body for the whole native
 * operation, so that neither a conversation turn's time limit nor an Ops report window revokes a start or a login half way.
 * Its outcome is the action's: a native receipt closes it; without one it is `unknown` and leaves by the action store's one
 * unknown exit. Nothing is resent.
 */
export function createLifecycleRunner(parts: { actions?: ActionThreads | null; service: MinecraftLifecycle; deviceId: string }) {
  return parts.actions ? lifecycleRunner({ ...parts, actions: parts.actions }) : null;
}

function lifecycleRunner(parts: { actions: ActionThreads; service: MinecraftLifecycle; deviceId: string }) {
  const controller = new AbortController();
  const running = new Set<Promise<void>>();
  const body = actionResource(parts.deviceId, 'minecraft-body');
  return {
    /** Claims the operation's own action. Null when the Minecraft slot is not free now; a refused new claim is withdrawn. */
    async admit(draft: ActionDraft, withdraw: boolean): Promise<RunningAction | null> {
      const active = await acquireAction(parts.actions, { ...draft, kind: 'minecraft' }, controller.signal);
      if (active || !withdraw) return active;
      const queued = (await parts.actions.list(draft.scopeKey)).find(view => view.kind === 'minecraft' && view.sourceId === draft.sourceId);
      if (queued?.state === 'queued') await parts.actions.stop(draft.scopeKey, queued.id, `lifecycle-withdrawn:${queued.id}`).catch(() => []);
      return null;
    },
    /**
     * Takes the body under the operation's own lease, once; when another holds it the action closes as never started. `onlyLostSteps`
     * (the operator's start, login, logout and stop, `operatorLifecycleWiring.ts`): when it says the only holders are steps whose
     * outcome was lost and the body is not in the server, the operation goes on without the body resource. Nothing is moving then,
     * and the operation is what brings the body back for the re-check that frees it (run 20: twice a lost step kept the body, the
     * body could not come back for the re-check, and every start, login and logout was refused with `lease_conflict`).
     * Going on without the body still sends the operation: `dispatch` with no resource marks the action `sent` (the operation is
     * about to act outside) and holds nothing more than it already does. Without it an operation interrupted before any receipt
     * would end `unknown` with `sent=0`, outside the action store's one unknown exit, and `unresolved()` would refuse every start,
     * login, logout and stop for good (2026-10-21, run 22's stop f67261ba). A dispatch refused here closes it as never started.
     */
    async takeBody(active: RunningAction, onlyLostSteps?: () => boolean): Promise<boolean> {
      if (await parts.actions.dispatch(active.execution.lease, [body]).catch(() => false)) return true;
      if (onlyLostSteps?.() && await parts.actions.dispatch(active.execution.lease, []).catch(() => false)) return true;
      await active.finish('cancelled', 'lifecycle_body_unavailable').catch(() => {});
      return false;
    },
    /** Runs the native operation to its receipt in the background and reports how it ended. */
    detach(active: RunningAction, request: MinecraftLifecycleRequest, settled: (settlement: LifecycleSettlement) => void | Promise<void>): Promise<void> {
      const job = (async () => {
        let receipt: MinecraftLifecycleReceipt | null = null;
        try {
          receipt = await inActionExecution(active.execution, () => parts.service.execute(request, active.execution.signal));
          await active.finish(receipt.outcome === 'completed' ? 'completed' : receipt.outcome === 'cancelled' ? 'cancelled' : 'failed',
            'lifecycle_native_acknowledged').catch(() => {});
        } catch (error) {
          // The command may have arrived in the meantime; an accepted receipt is the outcome, anything else is unknown.
          receipt = accepted(parts.service.receipt(request.id));
          const issued = !!parts.service.store.command(request.id);
          const [state, code] = interrupted(receipt, issued, `${request.action}:${notStartedReason(error)}`);
          await active.finish(state, code).catch(() => {});
        } finally {
          active.stop();
        }
        const command = parts.service.store.command(request.id);
        const unconfirmed = receipt ? null : parts.service.receipt(request.id);
        // The extra facts are present only when there is something to say (a settlement that never started keeps its two fields).
        const settlement: LifecycleSettlement = { receipt, issued: !!command, ...(command ? { command } : {}), ...(unconfirmed ? { unconfirmed } : {}) };
        await (async () => settled(settlement))().catch(() => { /* reporting never fails the operation */ });
      })();
      running.add(job);
      void job.finally(() => running.delete(job));
      return job;
    },
    async close() {
      controller.abort();
      await Promise.allSettled([...running]);
    },
  };
}
export type LifecycleRunner = ReturnType<typeof lifecycleRunner>;

/** A receipt that settles the operation: known, and the body's inputs released. */
function accepted(receipt: MinecraftLifecycleReceipt | null): MinecraftLifecycleReceipt | null {
  return receipt && receipt.outcome !== 'unknown' && receipt.inputsReleased ? receipt : null;
}

/**
 * How an operation whose wait was interrupted closes its action: by its receipt, unknown once issued, else never started, with
 * the operation and the closed reason in its result (`lifecycle_not_started:<action>:<reason>`), which the notice of a
 * conversation's request reads: 「受け付けました」 was said, so 「始められなかった」 is told too.
 */
function interrupted(receipt: MinecraftLifecycleReceipt | null, issued: boolean, notStarted: string): ['completed' | 'failed' | 'unknown', string] {
  if (receipt) return [receipt.outcome === 'completed' ? 'completed' : 'failed', 'lifecycle_native_acknowledged'];
  return issued ? ['unknown', 'lifecycle_result_unknown'] : ['failed', `${LIFECYCLE_NOT_STARTED}:${notStarted}`];
}

/** The result prefix of an operation that never started. */
export const LIFECYCLE_NOT_STARTED = 'lifecycle_not_started';
/** Why an accepted operation never started, as a closed reason. */
export const NOT_STARTED_REASONS = ['busy', 'unavailable', 'not_allowed', 'error'] as const;

function notStartedReason(error: unknown): typeof NOT_STARTED_REASONS[number] {
  const code = error instanceof Error ? error.message : '';
  if (code === 'MINECRAFT_LIFECYCLE_BUSY') return 'busy';
  if (code === 'MINECRAFT_LIFECYCLE_UNAVAILABLE') return 'unavailable';
  return code === 'MINECRAFT_LIFECYCLE_AUTHORITY_DENIED' ? 'not_allowed' : 'error';
}
