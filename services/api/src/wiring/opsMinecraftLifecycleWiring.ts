import { actionResource, type ActionThreads, type RunningAction } from '../contracts/actionThreadContract.js';
import type { MinecraftLifecycleReceipt } from '../contracts/minecraftLifecycleContract.js';
import { opsLifecycleMapping, type OpsLifecycleMapping } from '../contracts/opsMinecraftLifecycleContract.js';
import type { OpsCommandCode, OpsCommandOutcome, OpsCommandRequest } from '../contracts/opsCommandContract.js';
import { inActionExecution } from '../infra/context/actionExecution.js';
import type { OpsCommandStore } from '../infra/ops/store/opsCommandStore.js';
import type { MinecraftLifecycle } from '../surfaces/minecraft/minecraftLifecycle.js';
import { acquireAction } from './actionExecutionWiring.js';

/** Project only accepted original native receipts into the existing desktop contract. */
function outcome(receipt: MinecraftLifecycleReceipt): { outcome: OpsCommandOutcome; code?: OpsCommandCode } | null {
  if (receipt.outcome === 'unknown' || !receipt.inputsReleased) return null;
  if (receipt.outcome === 'completed') return { outcome: 'done',
    ...(receipt.code === 'already_running' || receipt.code === 'already_stopped' ? { code: receipt.code }
      : receipt.code === 'already_joined' ? { code: 'already_running' as const }
      : receipt.code === 'already_absent' ? { code: 'already_stopped' as const } : {}) };
  return { outcome: receipt.outcome === 'refused' ? 'refused' : 'failed',
    code: receipt.code === 'error' ? 'error' : receipt.code === 'deadline' ? 'timeout' : 'not_allowed' };
}

/** No model and no legacy retry: one original owner command, action lease and native operation. */
export function createOpsMinecraftLifecycle(parts: {
  commands: OpsCommandStore; actions: ActionThreads; service: MinecraftLifecycle; scopeKey: string; deviceId: string;
  now(): string; enabled(): boolean; ownerAlone(): boolean;
}) {
  const controller = new AbortController();
  const running = new Map<string, Promise<void>>();
  let closed = false;
  const projectReceipts = () => {
    for (const row of parts.commands.lifecycleAwaiting(parts.scopeKey, parts.now())) {
      const receipt = parts.service.receipt(row.lifecycleId), report = receipt && outcome(receipt);
      if (report) parts.commands.reportLifecycle(parts.scopeKey, row.commandId, report.outcome, report.code, parts.now());
    }
  };
  const execute = async (row: ReturnType<OpsCommandStore['lifecyclePending']>[number]) => {
    let active: RunningAction | null = null;
    try {
      active = await acquireAction(parts.actions, { scopeKey: parts.scopeKey, kind: 'respond', origin: 'owner_request',
        sourceId: `ops:${row.command.id}`, deadline: row.command.expiresAt }, controller.signal);
      if (!active) return;
      const claimedAt = parts.now();
      if (!parts.commands.bindLifecycle(parts.scopeKey, row.command.id, active.execution.lease.id)
        || !parts.commands.claimLifecycle(parts.scopeKey, row.command.id, active.execution.lease, claimedAt)) {
        await active.finish('cancelled', 'ops_request_unavailable'); return;
      }
      // Foreground admission clears its admission deadline. This original Ops report window still bounds native work.
      const reportBy=parts.commands.lifecycleReportBy(parts.scopeKey,row.command.id,active.execution.lease);
      if(!reportBy)throw new Error('OPS_REQUEST_DEADLINE_UNAVAILABLE');
      const remaining = Date.parse(reportBy) - Date.parse(parts.now());
      if(!Number.isFinite(remaining)||remaining<=0)throw new Error('OPS_REQUEST_DEADLINE_EXPIRED');
      const signal = AbortSignal.any([active.execution.signal, AbortSignal.timeout(remaining)]);
      await inActionExecution(active.execution, async () => {
        signal.throwIfAborted();
        // One atomic permit attempt. An unknown/live body conflict cannot occupy foreground while waiting.
        if (!await parts.actions.dispatch(active!.execution.lease, [actionResource(parts.deviceId, 'minecraft-body')])) {
          throw new Error('OPS_BODY_RESOURCE_UNAVAILABLE');
        }
        signal.throwIfAborted();
        const receipt = await parts.service.execute({ id: row.lifecycleId, ...row.mapping,
          authority: { scopeKey: parts.scopeKey, origin: 'owner_request', executionId: active!.execution.lease.id,
            lease: active!.execution.lease, sourceIds: [`ops-command:${row.command.id}`] } }, signal);
        const report = outcome(receipt);
        if (!report) throw new Error('MINECRAFT_LIFECYCLE_OUTCOME_UNKNOWN');
        parts.commands.reportLifecycle(parts.scopeKey, row.command.id, report.outcome, report.code, parts.now());
        await active!.finish(receipt.outcome === 'completed' ? 'completed' : receipt.outcome === 'cancelled' ? 'cancelled' : 'failed', 'ops_native_acknowledged');
      });
    } catch {
      if (!active) return; // An unavailable IPC admission never starts an external operation.
      const original = parts.service.store.command(row.lifecycleId);
      const receipt = parts.service.receipt(row.lifecycleId), report = receipt && outcome(receipt);
      if (report) {
        parts.commands.reportLifecycle(parts.scopeKey, row.command.id, report.outcome, report.code, parts.now());
        await active.finish(receipt!.outcome === 'completed' ? 'completed' : 'failed', 'ops_native_acknowledged').catch(() => {});
      } else {
        const unknown = !!original;
        parts.commands.reportLifecycle(parts.scopeKey, row.command.id, unknown ? 'failed' : 'refused', unknown ? 'no_report' : 'not_allowed', parts.now());
        await active.finish(unknown ? 'unknown' : 'failed', unknown ? 'ops_native_result_unknown' : 'ops_native_not_started').catch(() => {});
      }
    } finally { active?.stop(); }
  };
  const wake = () => {
    if (closed) return;
    projectReceipts();
    if (!parts.enabled() || !parts.ownerAlone() || !parts.service.available(parts.scopeKey)) return;
    // One API broker admission at a time; a crash cannot replay claimed requests.
    if (running.size) return;
    const row = parts.commands.lifecyclePending(parts.scopeKey, parts.now())[0];
    if (!row) return;
    const work = execute(row).finally(() => { running.delete(row.command.id); });
    running.set(row.command.id, work);
  };
  const timer = setInterval(wake, 1000); timer.unref();
  return {
    mapping(scopeKey: string, request: OpsCommandRequest): OpsLifecycleMapping | null {
      return scopeKey === parts.scopeKey && parts.enabled() && parts.service.configuration.servers.has('shannon-home')
        ? opsLifecycleMapping(request) : null;
    },
    wake,
    async close() { closed = true; clearInterval(timer); controller.abort(); await Promise.allSettled(running.values()); },
  };
}
