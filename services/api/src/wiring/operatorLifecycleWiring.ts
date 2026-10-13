import type { MinecraftLifecycleAction, MinecraftLifecycleAuthority, MinecraftLifecycleCommand } from '../contracts/minecraftLifecycleContract.js';
import type { MinecraftLifecycle } from '../surfaces/minecraft/minecraftLifecycle.js';
import type { LifecycleRunner, LifecycleSettlement } from './minecraftLifecycleRunner.js';

/** The source and command id of an operator's lifecycle operation: `operator:<operation uuid>`. */
export const OPERATOR_LIFECYCLE_SOURCE = /^operator:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type OperatorLifecycleAdmission =
  | { ok: true; lifecycleId: string; actionId: string }
  | { ok: false; code: 'lifecycle_unavailable' | 'unresolved_operation' | 'lease_conflict' | 'refused' | 'invalid_input' | 'owner_not_alone'; message: string };

/**
 * An operator's lifecycle operation (owner decision 2026-10-14): the same path as a conversation's request (`detached` in
 * `minecraftLifecycleWiring.ts`), under its own `minecraft` action whose source is the operation's id, the body taken once, and
 * the native operation carried to its receipt in the background. The authority (`allowed`) checks the operator's audit row.
 */
export function createOperatorLifecycle(parts: {
  service: MinecraftLifecycle; runner: LifecycleRunner | null; scopeKey: string; serverIds: readonly string[]; ownerAlone(): boolean;
  allowed(authority: MinecraftLifecycleAuthority, command?: Pick<MinecraftLifecycleCommand, 'id' | 'serverId' | 'action'>): boolean;
}) {
  const refused = (code: Exclude<OperatorLifecycleAdmission, { ok: true }>['code'], message: string): OperatorLifecycleAdmission =>
    ({ ok: false, code, message });
  return {
    servers: parts.serverIds,
    /** The server an operation names, or the only registered one. */
    server(requested: string | null): string | null {
      if (requested) return parts.serverIds.includes(requested) ? requested : null;
      return parts.serverIds.length === 1 ? parts.serverIds[0]! : null;
    },
    async execute(request: { id: string; serverId: string; action: MinecraftLifecycleAction },
      settled: (settlement: LifecycleSettlement) => void): Promise<OperatorLifecycleAdmission> {
      if (!OPERATOR_LIFECYCLE_SOURCE.test(request.id) || !parts.serverIds.includes(request.serverId)) return refused('invalid_input', '登録されたサーバーではありません。');
      if (!parts.runner || !parts.service.available(parts.scopeKey)) return refused('lifecycle_unavailable', 'マイクラ管理の新しい状態が届いていません。');
      if (!parts.ownerAlone()) return refused('owner_not_alone', 'ライ氏以外の人がいる間は操作しません。');
      const state = parts.service.status(parts.scopeKey).find(item => item.serverId === request.serverId);
      if (request.action === 'set_day' && (state?.running !== 'running' || state.otherPlayers !== 0)) {
        return refused('refused', 'サーバーが動いていて、ほかの参加者がいないときだけ時刻を変えます。');
      }
      if (parts.service.store.unresolved()) return refused('unresolved_operation', '前のマイクラ管理操作の結果がまだ確認できていません。');
      const own = await parts.runner.admit({ scopeKey: parts.scopeKey, kind: 'minecraft', origin: 'owner_request', sourceId: request.id,
        ownerInformed: true }, true);
      if (!own) return refused('lease_conflict', 'いまはマイクラの作業枠が空いていません。');
      const authority: MinecraftLifecycleAuthority = { scopeKey: parts.scopeKey, origin: 'owner_request', executionId: own.execution.lease.id,
        lease: own.execution.lease, sourceIds: [request.id] };
      if (!parts.allowed(authority, request)) {
        await own.finish('cancelled', 'lifecycle_not_allowed').catch(() => {});
        return refused('refused', '実行権・停止設定・現在の入力条件を確認できません。');
      }
      if (!await parts.runner.takeBody(own)) return refused('lease_conflict', 'マイクラの体がほかの作業で使われています。');
      void parts.runner.detach(own, { ...request, authority }, settled);
      return { ok: true, lifecycleId: request.id, actionId: own.execution.lease.id };
    },
  };
}
export type OperatorLifecycle = ReturnType<typeof createOperatorLifecycle>;
