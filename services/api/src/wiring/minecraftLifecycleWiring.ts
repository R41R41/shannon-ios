import { switchOn } from '@shannon/switches';
import { createOpsMinecraftLifecycle } from './opsMinecraftLifecycleWiring.js';
import { opsLifecycleAuthorityAllowed } from '../infra/ops/store/opsLifecycleAuthority.js';
import type { OpsCommandStore } from '../infra/ops/store/opsCommandStore.js';
import { createMinecraftLifecycleRecovery } from './minecraftLifecycleRecoveryWiring.js';
import type { ActionThreads } from '../contracts/actionThreadContract.js';
import { createLifecycleRunner, type LifecycleSettlement } from './minecraftLifecycleRunner.js';
import type { LifecycleOutcomeTeller } from './lifecycleOutcomeTellingWiring.js';
import type { LifecycleOutcomeKind } from '../mind/action/respond/lifecycleOutcomeLine.js';
import { createOperatorLifecycle, OPERATOR_LIFECYCLE_SOURCE } from './operatorLifecycleWiring.js';
import { operatorLifecycleAllowed } from '../infra/ops/store/operatorAuditStore.js';
import { createHash } from 'node:crypto';
import { openDatabase } from '../infra/sqlite/sqliteOpen.js';
import { stage4Enabled } from '../infra/config/stage4.js';
import { configuredMinecraftBody } from '../contracts/minecraftBodyContract.js';
import { MINECRAFT_LIFECYCLE_ACTIONS, type MinecraftLifecycleAuthority, type MinecraftLifecycleAction, type MinecraftLifecycleCommand,
  type MinecraftLifecycleState } from '../contracts/minecraftLifecycleContract.js';
import { MinecraftLifecycle } from '../surfaces/minecraft/minecraftLifecycle.js';
import { MinecraftLifecycleStore } from '../surfaces/minecraft/store/minecraftLifecycleStore.js';
import { actionPermit, currentActionExecution } from '../infra/context/actionExecution.js';
import { actionResource } from '../contracts/actionThreadContract.js';
import { ActionLeaseReader } from '../mind/action/threads/store/actionLeaseReader.js';
import { lifecycleLeaseHeld } from './actionLeaseRules.js';
import { toolFailure, toolOk } from '../mind/tools/shannonTools.js';
import { withToolEvidence } from '../mind/tools/toolEvidence.js';
import type { MinecraftLifecycleToolPort } from '../mind/tools/shannonMinecraftLifecycleTools.js';
import type { ToolRun } from '../mind/tools/shannonToolTypes.js';
import type { ShannonAutonomyService } from '../mind/action/ownTime/autonomyService.js';

/** What she says when a conversation's request cannot be accepted now. */
const BUSY_TEXT = Object.freeze({
  unresolved: '前のマイクラ管理操作の結果がまだ確認できていないので、受け付けられません。',
  slot: 'いまはマイクラの作業枠が空いていないので、受け付けられません。',
  body: 'マイクラの体がほかの作業で使われているので、受け付けられません。',
});
/** The source of a conversation's lifecycle action: the operation's own id. */
const LIFECYCLE_SOURCE = /^lifecycle:[a-f0-9]{64}$/u;

/**
 * A conversation's request runs under its own Minecraft action, whose source is exactly the operation's server-made id
 * (`lifecycle:<sha256>`, from the turn's lease and words): only that operation, only while the owner is alone.
 */
function conversationOperation(row: { kind: string; origin: string; sourceId: string }, opsSource: boolean): boolean {
  return !opsSource && row.kind === 'minecraft' && row.origin === 'owner_request' && LIFECYCLE_SOURCE.test(row.sourceId);
}

/**
 * Why `set_day` is refused before anything is admitted, or null. It is the owner's own request in a conversation with him alone
 * (never her own time or a task step), on a running server with no other player; the operator checks the players again itself.
 */
function setDayRefusal(kind: string, origin: string, ownerAlone: boolean, state: MinecraftLifecycleState | undefined): string | null {
  if (kind !== 'respond' || origin !== 'owner_request' || !ownerAlone) return '時刻の変更はライ氏と二人の会話で頼まれた時だけ行います。';
  if (state?.running !== 'running') return 'サーバーが起動していないので、時刻は変えられません。';
  return state.otherPlayers === 0 ? null : 'ほかの参加者がいるか、人数を確かめられないので、時刻は変えません。';
}

/** How a settled operation ended for him: its accepted receipt's outcome, else unknown once its command was written, else never started. */
export function settledOutcome(settlement: LifecycleSettlement): LifecycleOutcomeKind {
  const outcome = settlement.receipt?.outcome;
  if (outcome === 'completed' || outcome === 'refused' || outcome === 'cancelled') return outcome;
  return settlement.issued ? 'unknown' : 'not_started';
}

/** Same paired operator, original action lease and autonomy gate in API and own-time worker. */
export function configuredMinecraftLifecycle(values: Readonly<Record<string, string | undefined>>, parts: {
  path: string; autonomy: ShannonAutonomyService; actions?: ActionThreads | null; ownerAlone(): boolean;
  /** For agentTask, the common runtime rechecks the original admitted task's canonical sources. */
  ops?: { commands: OpsCommandStore; actions: ActionThreads; enabled(): boolean };
  taskAllowed(executionId: string): boolean; taskSources?(executionId: string): readonly string[] | null; now?(): string;
  /**
   * Tells him how a conversation's request ended, once it settles (owner decision 2026-10-14: she said 「終わったら知らせます」).
   * Absent (the own-time worker, tests): only the 【知らせ:作業終了】 notice tells her.
   */
  told?: LifecycleOutcomeTeller;
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
  const allowed = (authority: MinecraftLifecycleAuthority, command?: Pick<MinecraftLifecycleCommand, 'id' | 'serverId' | 'action'>) => {
    try {
      const row = leases.get(authority.executionId);
      const at = now();
      if (!row || !lifecycleLeaseHeld(row, authority, configuration.ownerScopeKey, at)) return false;
      if (authority.origin === 'own_time') return row.kind === 'ownTime' && parts.autonomy.inspectAuthorization(authority.scopeKey,
        { domain: 'minecraft_lifecycle', summary: '登録されたマイクラへの参加を継続します。' }).decision === 'allow';
      // A guessed Ops prefix never falls through to the ordinary conversation authority.
      const opsSource = row.sourceId.startsWith('ops:') || authority.sourceIds.some(id => id.startsWith('ops-command:'));
      // The operator's own operation (2026-10-14): its own action, its id as the only source, and its audit row; never another's.
      if (OPERATOR_LIFECYCLE_SOURCE.test(row.sourceId)) return operatorOperation(row, authority, command, opsSource);
      if (conversationOperation(row, opsSource)) return parts.ownerAlone() && command?.id === row.sourceId;
      if (row.kind === 'minecraft' || opsSource) return parts.ownerAlone() && !!parts.ops?.enabled()
        && opsLifecycleAuthorityAllowed(db, authority, command);
      const taskSources = row.kind === 'agentTask' ? parts.taskSources?.(authority.executionId) : undefined;
      // A turn only admits a request (no command yet): every command runs under its own action or an own-time/FCA step (S7).
      return parts.ownerAlone() && (row.kind === 'respond' && !command || row.kind === 'agentTask' && parts.taskAllowed(authority.executionId)
        && (!parts.taskSources || taskSources !== null && authority.sourceIds.every(id => taskSources?.includes(id))));
    } catch { return false; }
  };
  function operatorOperation(row: { kind: string; origin: string; sourceId: string }, authority: MinecraftLifecycleAuthority,
    command: Pick<MinecraftLifecycleCommand, 'id' | 'serverId' | 'action'> | undefined, opsSource: boolean): boolean {
    return !opsSource && row.kind === 'minecraft' && row.origin === 'owner_request' && parts.ownerAlone() && command?.id === row.sourceId
      && authority.sourceIds.length === 1 && authority.sourceIds[0] === row.sourceId
      && operatorLifecycleAllowed(db, authority.scopeKey, row.sourceId, command);
  }
  const lifecycleStore = new MinecraftLifecycleStore(db, id => leases.unknownExited(id));
  const service = new MinecraftLifecycle(lifecycleStore, configuration, { now: () => Date.parse(now()), allowed, servers: new Set(serverIds) });
  const runner = createLifecycleRunner({ actions: parts.actions, service, deviceId: configuration.deviceId });
  /**
   * The owner's conversation request (2026-10-13 TI-REQ): admitted under its own `minecraft` action and the body, answered
   * 「受け付けた」 at once, finished in the background; its late outcome reaches her as a 【知らせ:作業終了】 notice
   * (`conversationLifecycleReports`), and him in her words when it settles (`told`, owner decision 2026-10-14). Busy, body held
   * or an unresolved operation: a closed refusal now, nothing started.
   */
  /** The provenance a command is pinned to: the task's sources, or the conversation and the turn's words (hashed). */
  const sourcesOf = (kind: string | undefined, executionId: string, context: { threadId?: string; memory: { turnKey?: string } }): string[] => {
    if (kind === 'agentTask') return [...(parts.taskSources?.(executionId) ?? [])];
    if (kind !== 'respond' || !context.threadId) return [];
    return [`conversation:${context.threadId}`, `turn:${createHash('sha256').update(context.memory.turnKey ?? '').digest('hex')}`];
  };
  const detached = async (request: { id: string; serverId: string; action: MinecraftLifecycleAction; sourceIds: readonly string[]; threadId: string | null },
    failure: (kind: 'unavailable' | 'refused' | 'conflict', text: string) => ToolRun): Promise<ToolRun> => {
    if (service.store.unresolved()) return failure('conflict', BUSY_TEXT.unresolved);
    const draft = { scopeKey: configuration.ownerScopeKey, kind: 'minecraft' as const, origin: 'owner_request' as const, sourceId: request.id };
    const own = await runner!.admit({ ...draft, ownerInformed: true }, true);
    if (!own) return failure('conflict', BUSY_TEXT.slot);
    const authority: MinecraftLifecycleAuthority = { scopeKey: configuration.ownerScopeKey, origin: 'owner_request', executionId: own.execution.lease.id,
      lease: own.execution.lease, sourceIds: request.sourceIds };
    if (!allowed(authority, request)) {
      await own.finish('cancelled', 'lifecycle_not_allowed').catch(() => {});
      return failure('refused', '実行権・停止設定・現在の入力条件を確認できません。');
    }
    if (!await runner!.takeBody(own)) return failure('conflict', BUSY_TEXT.body);
    // Its end is told to him in her words when it settles (`lifecycleOutcomeTellingWiring.ts`); the notice tells her either way. Not
    // awaited: writing the line (up to 20 s) never holds the operation's close or a shutdown.
    void runner!.detach(own, { id: request.id, serverId: request.serverId, action: request.action, authority }, settlement => {
      void parts.told?.({ scopeKey: configuration.ownerScopeKey, threadId: request.threadId, operationId: request.id, action: request.action,
        outcome: settledOutcome(settlement) });
    });
    const accepted = toolOk(`受け付けました。まだ終わっていません（${request.action} を実行中）。終わったら知らせます。`);
    const target = { kind: 'minecraft_server' as const, id: request.serverId };
    const result = withToolEvidence(accepted, { outcome: 'queued', action: request.action, target, operationId: request.id });
    return { result, acknowledged: true, record: { summary: 'マイクラ管理操作を受け付けました。', outcome: 'done', reasonCode: 'accepted' } };
  };
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
      const turn = leases.get(active.lease.id);
      // A conversation's request is accepted at once and carried out under its own action (`detached` below); the turn never
      // holds the body, so its time limit cannot revoke the operation half way.
      if (turn?.kind !== 'respond') await actionPermit([actionResource(configuration.deviceId, 'minecraft-body')]);
      signal?.throwIfAborted(); active.signal.throwIfAborted(); context.beforeExecution?.();
      const row = leases.get(active.lease.id);
      const origin = context.surface === 'autonomy' ? 'own_time' : 'owner_request';
      const authority: MinecraftLifecycleAuthority = { scopeKey: context.scopeKey, origin, executionId: active.lease.id, lease: active.lease,
        sourceIds: sourcesOf(row?.kind, active.lease.id, context) };
      if (!row || !allowed(authority)) return failure('refused', '実行権・停止設定・現在の入力条件を確認できません。');
      const operation = name.slice('minecraft.'.length);
      if (!(MINECRAFT_LIFECYCLE_ACTIONS as readonly string[]).includes(operation)) return failure('invalid_input', '登録されていないマイクラ管理操作です。');
      const refusedDay = operation === 'set_day'
        ? setDayRefusal(row.kind, origin, parts.ownerAlone(), service.status(context.scopeKey).find(state => state.serverId === requested)) : null;
      if (refusedDay) return failure('refused', refusedDay);
      const identity = context.memory.turnKey;
      if (!identity) return failure('refused', '操作の元IDを確認できません。');
      const id = `lifecycle:${createHash('sha256').update(JSON.stringify([active.lease.id, identity, name, requested])).digest('hex')}`;
      const action = operation as MinecraftLifecycleAction;
      const threadId = context.threadId ?? null;
      if (row.kind === 'respond') return runner ? detached({ id, serverId: requested, action, sourceIds: authority.sourceIds, threadId }, failure)
        : failure('unavailable', 'マイクラ管理操作の作業枠を確かめられないので、受け付けられません。');
      const priorUnknown = active.stepOutcome === 'unknown';
      active.stepOutcome = 'unknown';
      try {
        const receipt = await service.execute({ id, serverId: requested, action, authority }, signal);
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
  const operator = createOperatorLifecycle({ service, runner, scopeKey: configuration.ownerScopeKey, serverIds, ownerAlone: parts.ownerAlone, allowed });
  return { service, ops, operator, recover: () => recovery?.recover() ?? Promise.resolve(),
    async close() { await ops?.close(); await runner?.close(); await recovery?.close(); db.close(); } };
}
