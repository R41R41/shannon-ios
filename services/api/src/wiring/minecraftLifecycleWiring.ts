import { switchOn } from '@shannon/switches';
import { createOpsMinecraftLifecycle } from './opsMinecraftLifecycleWiring.js';
import { opsLifecycleAuthorityAllowed } from '../infra/ops/store/opsLifecycleAuthority.js';
import type { OpsCommandStore } from '../infra/ops/store/opsCommandStore.js';
import { createMinecraftLifecycleRecovery } from './minecraftLifecycleRecoveryWiring.js';
import type { ActionThreads } from '../contracts/actionThreadContract.js';
import { createHash } from 'node:crypto';
import { openDatabase } from '../infra/sqlite/sqliteOpen.js';
import { stage4Enabled } from '../infra/config/stage4.js';
import { configuredMinecraftBody } from '../contracts/minecraftBodyContract.js';
import type { MinecraftLifecycleAuthority, MinecraftLifecycleAction, MinecraftLifecycleCommand } from '../contracts/minecraftLifecycleContract.js';
import { MinecraftLifecycle } from '../surfaces/minecraft/minecraftLifecycle.js';
import { MinecraftLifecycleStore } from '../surfaces/minecraft/store/minecraftLifecycleStore.js';
import { actionPermit, currentActionExecution } from '../infra/context/actionExecution.js';
import { actionResource } from '../contracts/actionThreadContract.js';
import { ActionLeaseReader } from '../mind/action/threads/store/actionLeaseReader.js';
import { lifecycleLeaseHeld } from './actionLeaseRules.js';
import { toolFailure, toolOk } from '../mind/tools/shannonTools.js';
import { withToolEvidence } from '../mind/tools/toolEvidence.js';
import type { MinecraftLifecycleToolPort } from '../mind/tools/shannonMinecraftLifecycleTools.js';
import type { ShannonAutonomyService } from '../mind/action/ownTime/autonomyService.js';

/** Same paired operator, original action lease and autonomy gate in API and own-time worker. */
export function configuredMinecraftLifecycle(values: Readonly<Record<string, string | undefined>>, parts: {
  path: string; autonomy: ShannonAutonomyService; actions?: Pick<ActionThreads, 'reconcileResource'> | null; ownerAlone(): boolean;
  /** For agentTask, the common runtime rechecks the original admitted task's canonical sources. */
  ops?: { commands: OpsCommandStore; actions: ActionThreads; enabled(): boolean };
  taskAllowed(executionId: string): boolean; taskSources?(executionId: string): readonly string[] | null; now?(): string;
}) {
  if (!switchOn(values, 'SHANNON_MINECRAFT_LIFECYCLE')) return null;
  const configuration = configuredMinecraftBody(values);
  if (!configuration || !stage4Enabled(values)) throw new Error('MINECRAFT_LIFECYCLE_CONFIG_REQUIRED');
  const now = parts.now ?? (() => new Date().toISOString());
  let ids: unknown;
  try { ids = JSON.parse(values.SHANNON_MINECRAFT_LIFECYCLE_SERVERS ?? '[]'); } catch { throw new Error('MINECRAFT_LIFECYCLE_SERVERS_REQUIRED'); }
  if (!Array.isArray(ids) || !ids.length || ids.length > 16 || new Set(ids).size !== ids.length
    || ids.some(id => typeof id !== 'string' || !configuration.servers.has(id))) throw new Error('MINECRAFT_LIFECYCLE_SERVERS_REQUIRED');
  const serverIds = ids as string[];
  const db = openDatabase(parts.path, 'minecraftLifecycle');
  const leases = new ActionLeaseReader(db);
  const allowed = (authority: MinecraftLifecycleAuthority, command?: MinecraftLifecycleCommand) => {
    try {
      const row = leases.get(authority.executionId);
      const at = now();
      if (!row || !lifecycleLeaseHeld(row, authority, configuration.ownerScopeKey, at)) return false;
      if (authority.origin === 'own_time') return row.kind === 'ownTime' && parts.autonomy.inspectAuthorization(authority.scopeKey,
        { domain: 'minecraft_lifecycle', summary: '登録されたマイクラへの参加を継続します。' }).decision === 'allow';
      // A guessed Ops prefix never falls through to the ordinary conversation authority.
      const opsSource = row.sourceId.startsWith('ops:') || authority.sourceIds.some(id => id.startsWith('ops-command:'));
      if (row.kind === 'minecraft' || opsSource) return parts.ownerAlone() && !!parts.ops?.enabled()
        && opsLifecycleAuthorityAllowed(db, authority, command);
      const taskSources = row.kind === 'agentTask' ? parts.taskSources?.(authority.executionId) : undefined;
      return parts.ownerAlone() && (row.kind === 'respond' || row.kind === 'agentTask' && parts.taskAllowed(authority.executionId)
        && (!parts.taskSources || taskSources !== null && authority.sourceIds.every(id => taskSources?.includes(id))));
    } catch { return false; }
  };
  const service = new MinecraftLifecycle(new MinecraftLifecycleStore(db), configuration, { now: () => Date.parse(now()), allowed, servers: new Set(serverIds) });
  const port: MinecraftLifecycleToolPort = {
    available: scope => service.available(scope),
    async execute(name, input, context, signal) {
      signal?.throwIfAborted(); context.beforeExecution?.();
      const requested = typeof input.serverId === 'string' ? input.serverId : serverIds.length === 1 ? serverIds[0] : undefined;
      const failure = (kind: 'invalid_input' | 'unavailable' | 'refused' | 'conflict', text: string) => ({ result: toolFailure(kind, text, { retryable: false }), acknowledged: true,
        record: { summary: 'マイクラ管理の実行条件を満たしませんでした。', outcome: 'failed' as const, reasonCode: kind } });
      if (!requested || !serverIds.includes(requested)) return failure('invalid_input', '登録されたサーバーIDを指定してください。');
      if (context.scopeKey !== configuration.ownerScopeKey || !service.available(context.scopeKey)) return failure('unavailable', 'マイクラ管理の新しい状態が届いていません。');
      if (name === 'minecraft.lifecycle_status') return { result: toolOk(JSON.stringify(service.status(context.scopeKey).filter(s => s.serverId === requested))),
        acknowledged: true, record: { summary: 'マイクラ管理状態を確認しました。', outcome: 'done' } };
      const active = currentActionExecution();
      if (!active) return failure('refused', '元の実行権がないため操作しません。');
      await actionPermit([actionResource(configuration.deviceId, 'minecraft-body')]);
      signal?.throwIfAborted(); active.signal.throwIfAborted(); context.beforeExecution?.();
      const row = leases.get(active.lease.id);
      const origin = context.surface === 'autonomy' ? 'own_time' : 'owner_request';
      const authority: MinecraftLifecycleAuthority = { scopeKey: context.scopeKey, origin, executionId: active.lease.id, lease: active.lease, sourceIds: row?.kind === 'agentTask' ? [...(parts.taskSources?.(active.lease.id) ?? [])] : row?.kind === 'respond' && context.threadId
        ? [`conversation:${context.threadId}`, `turn:${createHash('sha256').update(context.memory.turnKey ?? '').digest('hex')}`] : [] };
      if (!row || !allowed(authority)) return failure('refused', '実行権・停止設定・現在の入力条件を確認できません。');
      const operation = name.slice('minecraft.'.length);
      if (!['start', 'stop', 'login', 'logout'].includes(operation)) return failure('invalid_input', '登録されていないマイクラ管理操作です。');
      const identity = context.memory.turnKey;
      if (!identity) return failure('refused', '操作の元IDを確認できません。');
      const id = `lifecycle:${createHash('sha256').update(JSON.stringify([active.lease.id, identity, name, requested])).digest('hex')}`;
      const priorUnknown = active.stepOutcome === 'unknown';
      active.stepOutcome = 'unknown';
      try {
        const receipt = await service.execute({ id, serverId: requested, action: operation as MinecraftLifecycleAction, authority }, signal);
        active.stepOutcome = priorUnknown ? 'unknown' : 'acknowledged';
        const result = withToolEvidence(receipt.outcome === 'completed' ? toolOk(JSON.stringify(receipt))
          : toolFailure('refused', JSON.stringify(receipt), { retryable: false }),
          { outcome: receipt.outcome === 'completed' ? 'applied' : 'failed', action: receipt.action,
            target: { kind: 'minecraft_server', id: receipt.serverId }, operationId: receipt.id, receiptId: receipt.id });
        return { result, acknowledged: true, record: { summary: 'マイクラ管理操作の結果を確認しました。', outcome: result.ok ? 'done' : 'failed', reasonCode: receipt.code } };
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (['MINECRAFT_LIFECYCLE_UNAVAILABLE', 'MINECRAFT_LIFECYCLE_AUTHORITY_DENIED', 'MINECRAFT_LIFECYCLE_BUSY'].includes(code)) {
          active.stepOutcome = priorUnknown ? 'unknown' : 'acknowledged'; return failure(code.endsWith('BUSY') ? 'conflict' : 'unavailable', 'マイクラ管理操作を開始できませんでした。未確認の元操作があれば、その結果を先に確認してください。');
        }
        throw error; // Original unknown operation stays held; never converted to a retryable fresh write.
      }
    },
  };
  parts.autonomy.tools.useMinecraftLifecycle(port);
  const recovery = parts.actions ? createMinecraftLifecycleRecovery({ db, service, actions: parts.actions, deviceId: configuration.deviceId }) : null;
  const ops = parts.ops && serverIds.includes('shannon-home') ? createOpsMinecraftLifecycle({ ...parts.ops, service, scopeKey: configuration.ownerScopeKey,
    deviceId: configuration.deviceId, now, ownerAlone: parts.ownerAlone }) : null;
  return { service, ops, recover: () => recovery?.recover() ?? Promise.resolve(), async close() { await ops?.close(); await recovery?.close(); db.close(); } };
}
