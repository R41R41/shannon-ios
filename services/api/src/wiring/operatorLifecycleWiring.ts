import { setTimeout as delay } from 'node:timers/promises';
import type {
  MinecraftLifecycleAction, MinecraftLifecycleAuthority, MinecraftLifecycleCommand, MinecraftLifecycleState,
} from '../contracts/minecraftLifecycleContract.js';
import type { MinecraftLifecycle } from '../surfaces/minecraft/minecraftLifecycle.js';
import type { LifecycleRunner, LifecycleSettlement } from './minecraftLifecycleRunner.js';
import type { FreshWorldAdmission } from './freshWorldWiring.js';

/** The source and command id of an operator's lifecycle operation: `operator:<operation uuid>`. */
export const OPERATOR_LIFECYCLE_SOURCE = /^operator:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type OperatorLifecycleAdmission =
  | { ok: true; lifecycleId: string; actionId: string }
  | { ok: false; code: 'lifecycle_unavailable' | 'unresolved_operation' | 'lease_conflict' | 'refused' | 'invalid_input' | 'owner_not_alone'
    | 'not_settled'; message: string };

/** Whether the time may be changed now: a running server with no other player, or why not (`not_settled`: not known yet). */
export type SetDayReadiness = 'ready' | 'not_running' | 'players_present' | 'not_settled';
export function setDayReadiness(state: MinecraftLifecycleState | undefined): SetDayReadiness {
  if (!state || state.running === 'unknown') return 'not_settled';
  if (state.running !== 'running') return 'not_running';
  if (state.otherPlayers === null) return 'not_settled';
  return state.otherPlayers === 0 ? 'ready' : 'players_present';
}
/**
 * How long a set_day waits for the server's state to settle (Minecraft run 6, 2026-10-14: asked right after a login, the
 * player count was still unknown while RCON `list uuids` was slow during world generation, and it was refused as if players were
 * present). The operator's CLI waits for the reply (30 s), so this stays well inside it.
 */
export const SET_DAY_SETTLE_MS = 12_000;
const SET_DAY_STEP_MS = 500;
const SET_DAY_REFUSALS: Record<Exclude<SetDayReadiness, 'ready'>, { code: 'refused' | 'not_settled'; message: string }> = {
  not_running: { code: 'refused', message: 'サーバーが動いていないので、時刻は変えません。' },
  players_present: { code: 'refused', message: 'ほかの参加者がいるので、時刻は変えません。' },
  not_settled: { code: 'not_settled', message: 'ログイン直後で、サーバーの状態（ほかの参加者の数）をまだ確かめられません。少し待ってからもう一度頼んでください。' },
};

/**
 * An operator's lifecycle operation (owner decision 2026-10-14): the same path as a conversation's request (`detached` in
 * `minecraftLifecycleWiring.ts`), under its own `minecraft` action whose source is the operation's id, the body taken once, and
 * the native operation carried to its receipt in the background. The authority (`allowed`) checks the operator's audit row.
 */
export function createOperatorLifecycle(parts: {
  service: MinecraftLifecycle; runner: LifecycleRunner | null; scopeKey: string; serverIds: readonly string[]; ownerAlone(): boolean;
  allowed(authority: MinecraftLifecycleAuthority, command?: Pick<MinecraftLifecycleCommand, 'id' | 'serverId' | 'action'>): boolean;
  /** How long set_day waits for an unsettled state, and how often it looks (tests shorten both). */
  setDaySettleMs?: number; setDayStepMs?: number;
  /** 「新しいワールドで始める」 (`freshWorldWiring.ts`), decided when an operator's start is admitted. Absent: never. */
  freshWorld?: FreshWorldAdmission;
}) {
  const refused = (code: Exclude<OperatorLifecycleAdmission, { ok: true }>['code'], message: string): OperatorLifecycleAdmission =>
    ({ ok: false, code, message });
  /** The server's readiness for set_day, looked at again while it is not settled, up to `SET_DAY_SETTLE_MS`. */
  async function settledForDay(serverId: string): Promise<SetDayReadiness> {
    const until = Date.now() + (parts.setDaySettleMs ?? SET_DAY_SETTLE_MS);
    for (;;) {
      const readiness = setDayReadiness(parts.service.status(parts.scopeKey).find(item => item.serverId === serverId));
      if (readiness !== 'not_settled' || Date.now() >= until) return readiness;
      await delay(parts.setDayStepMs ?? SET_DAY_STEP_MS);
    }
  }
  return {
    servers: parts.serverIds,
    /** The server an operation names, or the only registered one. */
    server(requested: string | null): string | null {
      if (requested) return parts.serverIds.includes(requested) ? requested : null;
      return parts.serverIds.length === 1 ? parts.serverIds[0]! : null;
    },
    async execute(request: { id: string; serverId: string; action: MinecraftLifecycleAction; keepWorld?: boolean },
      settled: (settlement: LifecycleSettlement) => void): Promise<OperatorLifecycleAdmission> {
      if (!OPERATOR_LIFECYCLE_SOURCE.test(request.id) || !parts.serverIds.includes(request.serverId)) return refused('invalid_input', '登録されたサーバーではありません。');
      if (!parts.runner || !parts.service.available(parts.scopeKey)) return refused('lifecycle_unavailable', 'マイクラ管理の新しい状態が届いていません。');
      if (!parts.ownerAlone()) return refused('owner_not_alone', 'ライ氏以外の人がいる間は操作しません。');
      if (request.action === 'set_day') {
        const readiness = await settledForDay(request.serverId);
        if (readiness !== 'ready') return refused(SET_DAY_REFUSALS[readiness].code, SET_DAY_REFUSALS[readiness].message);
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
      // `--keep-world` is the operator's opt-out; the switch is followed by default.
      const { keepWorld, ...operation } = request;
      const options = parts.freshWorld?.({ ...operation, origin: 'owner_request', via: 'operator', keepWorld: keepWorld === true });
      void parts.runner.detach(own, { ...operation, authority, ...(options ? { options } : {}) }, settled);
      return { ok: true, lifecycleId: request.id, actionId: own.execution.lease.id };
    },
  };
}
export type OperatorLifecycle = ReturnType<typeof createOperatorLifecycle>;
