import type { ActionThreads } from '../contracts/actionThreadContract.js';
import type { MinecraftLifecycleReceipt } from '../contracts/minecraftLifecycleContract.js';
import { opsLifecycleMapping, type OpsLifecycleMapping } from '../contracts/opsMinecraftLifecycleContract.js';
import type { OpsCommandCode, OpsCommandOutcome, OpsCommandRequest } from '../contracts/opsCommandContract.js';
import type { OpsCommandStore } from '../infra/ops/store/opsCommandStore.js';
import type { MinecraftLifecycle } from '../surfaces/minecraft/minecraftLifecycle.js';
import { createLifecycleRunner } from './minecraftLifecycleRunner.js';

/** The native window an Ops operation needs inside its claim window: the operator's deadline and the cancellation drain. */
const OPS_LIFECYCLE_LEASE_MS = 130_000;

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
  const runner = createLifecycleRunner({ actions: parts.actions, service: parts.service, deviceId: parts.deviceId })!;
  const running = new Map<string, Promise<void>>();
  let closed = false;
  const projectReceipts = () => {
    for (const row of parts.commands.lifecycleAwaiting(parts.scopeKey, parts.now())) {
      const receipt = parts.service.receipt(row.lifecycleId), report = receipt && outcome(receipt);
      if (report) parts.commands.reportLifecycle(parts.scopeKey, row.commandId, report.outcome, report.code, parts.now());
    }
  };
  // 2026-10-13: an Ops login that spawned the bot was revoked half way (`ops_native_result_unknown`). The operation now holds
  // its own action of kind `minecraft` (the Minecraft slot, never the conversation's foreground slot) for the whole native
  // operation; the Ops report window bounds only the desktop's wait, and a later receipt still reports (`reportLifecycle`).
  const execute = async (row: ReturnType<OpsCommandStore['lifecyclePending']>[number]) => {
    const report = (receipt: MinecraftLifecycleReceipt | null, issued: boolean) => {
      const known = receipt && outcome(receipt);
      if (known) parts.commands.reportLifecycle(parts.scopeKey, row.command.id, known.outcome, known.code, parts.now());
      else parts.commands.reportLifecycle(parts.scopeKey, row.command.id, issued ? 'failed' : 'refused', issued ? 'no_report' : 'not_allowed', parts.now());
    };
    // A claim the slot refused stays queued (never withdrawn): the next wake claims it, until the Ops claim window ends.
    const active = await runner.admit({ scopeKey: parts.scopeKey, kind: 'minecraft', origin: 'owner_request', sourceId: `ops:${row.command.id}`,
      ownerInformed: true, deadline: row.command.expiresAt }, false).catch(() => null);
    if (!active) return;
    try {
      const claimedAt = parts.now();
      // The admission deadline is the Ops claim window; the operation needs its whole native window inside it.
      const enough = Date.parse(row.command.expiresAt) - Date.parse(claimedAt) >= OPS_LIFECYCLE_LEASE_MS;
      if (!enough || !parts.commands.bindLifecycle(parts.scopeKey, row.command.id, active.execution.lease.id)
        || !parts.commands.claimLifecycle(parts.scopeKey, row.command.id, active.execution.lease, claimedAt)) {
        await active.finish('cancelled', 'ops_request_unavailable').catch(() => {});
        return;
      }
      // One atomic permit attempt. An unknown/live body conflict is refused at once, never waited for.
      if (!await runner.takeBody(active)) return report(null, false);
      await runner.detach(active, { id: row.lifecycleId, ...row.mapping, authority: { scopeKey: parts.scopeKey, origin: 'owner_request',
        executionId: active.execution.lease.id, lease: active.execution.lease, sourceIds: [`ops-command:${row.command.id}`] } },
      settlement => report(settlement.receipt, settlement.issued));
    } catch {
      await active.finish('failed', 'ops_native_not_started').catch(() => {});
    }
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
    async close() { closed = true; clearInterval(timer); await runner.close(); await Promise.allSettled(running.values()); },
  };
}
