import { actionResource, type ActionDraft, type ActionThreads, type RunningAction } from '../contracts/actionThreadContract.js';
import type { MinecraftLifecycleReceipt, MinecraftLifecycleRequest } from '../contracts/minecraftLifecycleContract.js';
import { inActionExecution } from '../infra/context/actionExecution.js';
import type { MinecraftLifecycle } from '../surfaces/minecraft/minecraftLifecycle.js';
import { acquireAction } from './actionExecutionWiring.js';

/** How a detached lifecycle operation ended for its caller: an accepted native receipt, or none (not started, or unknown). */
export interface LifecycleSettlement {
  receipt: MinecraftLifecycleReceipt | null;
  /** The original command was written (it may have reached the operator); without a receipt its outcome is unknown. */
  issued: boolean;
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
    /** Takes the body under the operation's own lease, once; when another holds it the action closes as never started. */
    async takeBody(active: RunningAction): Promise<boolean> {
      if (await parts.actions.dispatch(active.execution.lease, [body]).catch(() => false)) return true;
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
        } catch {
          // The command may have arrived in the meantime; an accepted receipt is the outcome, anything else is unknown.
          receipt = accepted(parts.service.receipt(request.id));
          const [state, code] = interrupted(receipt, !!parts.service.store.command(request.id));
          await active.finish(state, code).catch(() => {});
        } finally {
          active.stop();
        }
        const settlement = { receipt, issued: !!parts.service.store.command(request.id) };
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

/** How an operation whose wait was interrupted closes its action: by its receipt, unknown once issued, else never started. */
function interrupted(receipt: MinecraftLifecycleReceipt | null, issued: boolean): ['completed' | 'failed' | 'unknown', string] {
  if (receipt) return [receipt.outcome === 'completed' ? 'completed' : 'failed', 'lifecycle_native_acknowledged'];
  return issued ? ['unknown', 'lifecycle_result_unknown'] : ['failed', 'lifecycle_not_started'];
}
