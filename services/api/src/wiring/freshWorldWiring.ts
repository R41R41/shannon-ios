import type { AutonomyActivityRecord } from '../mind/inhibition/store/autonomyActivity.js';
import { autonomyDayKey, type AutonomyConfig } from '../mind/inhibition/autonomyBudget.js';
import type { MinecraftLifecycle } from '../surfaces/minecraft/minecraftLifecycle.js';
import { LIFECYCLE_CAPABILITY_FRESH_WORLD } from '../contracts/minecraftLifecycleContract.js';
import type { MinecraftLifecycleAction, MinecraftLifecycleCommand, MinecraftLifecycleOptions, MinecraftLifecycleReceipt, MinecraftLifecycleState }
  from '../contracts/minecraftLifecycleContract.js';

/**
 * 「新しいワールドで始める」 (`docs/ops-contract.md`): whether a Minecraft start asks the body to keep the current world under another
 * name (it is not deleted) and start a new one. This is the one place that decides; the conversation's `minecraft.start`, the Ops
 * `minecraft.start` (not `minebot.start`, which is a login and never asks) and the operator CLI's start all ask it
 * (`minecraftLifecycleWiring.ts`, `opsMinecraftLifecycleWiring.ts`, `operatorLifecycleWiring.ts`). The old world stays on the server as
 * a backup, so nothing is lost; but the owner's map changes, so every doubt is "no": the answer is yes only when every condition holds,
 * and only for a body that said, in its polls, that it can do it (`capabilities: ['freshWorld']`).
 */
export const FRESH_WORLD_SERVER = 'shannon-home';

/** The only three ways the owner newly asks for a start. Anything else (a task step, her own time, a recovery) has no `via`. */
export type FreshWorldVia = 'conversation' | 'ops' | 'operator';

export const FRESH_WORLD_REASONS = [
  'applied', 'existing_command', 'not_owner_request', 'not_start', 'other_server', 'switch_off', 'keep_world', 'server_not_stopped',
  'unsupported', 'tasks_open', 'tasks_unknown', 'unresolved_operation',
] as const;
export type FreshWorldReason = typeof FRESH_WORLD_REASONS[number];

export interface FreshWorldFacts {
  action: MinecraftLifecycleAction; serverId: string;
  /** Who the command acts for; only the owner's own request qualifies. */
  origin: 'owner_request' | 'own_time';
  /** How the owner asked; null for anything that is not a new request of his (an `agentTask` step, own time, a resend). */
  via: FreshWorldVia | null;
  /** The command stored under this id, when there already is one: a replay is never decided again. */
  existing: Pick<MinecraftLifecycleCommand, 'options'> | null;
  switchedOn: boolean;
  /** The operator asked, with `--keep-world`, for this start to keep the current world. */
  keepWorld: boolean;
  /** The server's state from a fresh frame of the paired operator; undefined when there is none. */
  state: Pick<MinecraftLifecycleState, 'running'> | undefined;
  /** Whether the body of that fresh frame advertised the `freshWorld` capability (a body that predates it never does). */
  bodySupports: boolean;
  /** Whether a Minecraft-bound task that has not reached a final phase exists; null when that cannot be known. */
  bodyTasksOpen: boolean | null;
  /** Whether an earlier lifecycle command is unresolved. */
  unresolved: boolean;
}

export interface FreshWorldDecision { reason: FreshWorldReason; options?: MinecraftLifecycleOptions }

/** The decision as a pure truth table. The reason is the first condition that fails, in the order of the owner's question. */
export function freshWorldDecision(facts: FreshWorldFacts): FreshWorldDecision {
  // A command that exists keeps exactly what it was issued with: nothing is added to it and nothing taken away.
  if (facts.existing) return { reason: 'existing_command', ...(facts.existing.options ? { options: facts.existing.options } : {}) };
  if (facts.via === null || facts.origin !== 'owner_request') return { reason: 'not_owner_request' };
  if (facts.action !== 'start') return { reason: 'not_start' };
  if (facts.serverId !== FRESH_WORLD_SERVER) return { reason: 'other_server' };
  if (!facts.switchedOn) return { reason: 'switch_off' };
  if (facts.keepWorld) return { reason: 'keep_world' };
  if (facts.state?.running !== 'stopped') return { reason: 'server_not_stopped' };
  if (!facts.bodySupports) return { reason: 'unsupported' };
  if (facts.bodyTasksOpen === null) return { reason: 'tasks_unknown' };
  if (facts.bodyTasksOpen) return { reason: 'tasks_open' };
  if (facts.unresolved) return { reason: 'unresolved_operation' };
  return { reason: 'applied', options: { freshWorld: true } };
}

export interface FreshWorldRequest {
  id: string; serverId: string; action: MinecraftLifecycleAction; origin: 'owner_request' | 'own_time'; via: FreshWorldVia | null;
  /** `--keep-world` of the operator CLI: this start keeps the current world even with the switch on. */
  keepWorld?: boolean;
}
export type FreshWorldAdmission = (request: FreshWorldRequest) => MinecraftLifecycleOptions | undefined;

/** What the activity record keeps of a decision: no words of the owner's; closed codes and the operation's own id. */
export interface FreshWorldRecord { at: string; applied: boolean; reason: FreshWorldReason; via: FreshWorldVia; operationId: string; serverId: string }

/** How a start that carried the option ended, as far as the API can tell from the accepted receipt. */
export const FRESH_WORLD_RESULTS = ['started', 'refused', 'cancelled', 'unknown', 'not_issued'] as const;
export type FreshWorldResult = typeof FRESH_WORLD_RESULTS[number];
/** The result record: closed codes, the operation's id, and (a started world only) the new id and where the old world was kept. */
export interface FreshWorldResultRecord {
  at: string; result: FreshWorldResult; via: FreshWorldVia; operationId: string; serverId: string; worldId?: string; movedTo?: string | null;
}

/** What the API composition hands to the lifecycle wiring (`server.ts`): the switch, the record, and the open-task probe. */
export interface FreshWorldPorts {
  policy: { freshWorld(scopeKey: string): boolean };
  activity: Pick<AutonomyActivityRecord, 'append'>;
  config: Pick<AutonomyConfig, 'timeZone'>;
  bodyTasksOpen: () => boolean | null;
}

export interface FreshWorldParts {
  scopeKey: string;
  /** The switch, read from the store every time. Absent: never. */
  policy?: { freshWorld(scopeKey: string): boolean } | null;
  /** The fresh states of the paired operator (`MinecraftLifecycle.status`); empty when its frame is old. */
  status(scopeKey: string): readonly MinecraftLifecycleState[];
  /** Whether the body of the fresh frame advertised the capability (`MinecraftLifecycle.supports`). */
  supports(scopeKey: string): boolean;
  command(id: string): Pick<MinecraftLifecycleCommand, 'options'> | null;
  unresolved(): boolean;
  /** Whether a Minecraft-bound task is still open; null when unknown or when the task runtime is not there. */
  bodyTasksOpen?: (() => boolean | null) | null;
  /**
   * Writes a decision that kept the world to the activity record. Its presence is also the condition for an `applied` decision (the
   * record of an applied one is written when the command is stored, `freshWorldIssuance`, so that a command that never existed is
   * never recorded as sent).
   */
  record?: ((record: FreshWorldRecord) => void) | null;
  now(): string;
}

/** Whether this is a start the owner newly asked for on the home server: the only kind whose decision is written down. */
function askedFor(request: FreshWorldRequest): request is FreshWorldRequest & { via: FreshWorldVia } {
  return request.via !== null && request.origin === 'owner_request' && request.action === 'start' && request.serverId === FRESH_WORLD_SERVER;
}

/** Writes a kept-world decision when it is to be written. An `applied` one is not written here; it is allowed only with a record port. */
function noted(parts: Pick<FreshWorldParts, 'record' | 'now'>, request: FreshWorldRequest, decision: FreshWorldDecision): boolean {
  const applied = decision.reason === 'applied';
  if (!parts.record) return !applied;
  if (applied) return true;
  if (!askedFor(request) || decision.reason === 'existing_command' || decision.reason === 'switch_off') return true;
  try {
    parts.record({ at: parts.now(), applied: false, reason: decision.reason, via: request.via, operationId: request.id, serverId: request.serverId });
  } catch { /* a missing record of a kept world changes nothing */ }
  return true;
}

/**
 * The admission the three call sites share. Returns the options to put on the new command, or undefined (the legacy command,
 * exactly as before). A decision that kept the world is recorded only when the switch was on for a start the owner newly asked for on
 * the home server, saying why. An applied one is recorded when the command is stored (`freshWorldIssuance`). Any error here is "no".
 */
export function createFreshWorldAdmission(parts: FreshWorldParts): FreshWorldAdmission {
  const facts = (request: FreshWorldRequest): FreshWorldFacts => ({
    action: request.action, serverId: request.serverId, origin: request.origin, via: request.via, existing: parts.command(request.id),
    switchedOn: request.action === 'start' && request.serverId === FRESH_WORLD_SERVER && parts.policy?.freshWorld(parts.scopeKey) === true,
    keepWorld: request.keepWorld === true,
    state: parts.status(parts.scopeKey).find(item => item.serverId === request.serverId),
    bodySupports: parts.supports(parts.scopeKey),
    bodyTasksOpen: parts.bodyTasksOpen ? parts.bodyTasksOpen() : null,
    unresolved: parts.unresolved(),
  });
  return request => {
    try {
      const decision = freshWorldDecision(facts(request));
      return noted(parts, request, decision) ? decision.options : undefined;
    } catch {
      return undefined;
    }
  };
}

/** The admission of one lifecycle wiring: the ports `server.ts` hands in (none: never), over the wiring's own service. */
export function freshWorldAdmissionOf(ports: FreshWorldPorts | undefined, own: {
  scopeKey: string; now(): string;
  service: Pick<MinecraftLifecycle, 'status' | 'supports'> & { store: Pick<MinecraftLifecycle['store'], 'command' | 'unresolved'> };
}): FreshWorldAdmission {
  return createFreshWorldAdmission({ scopeKey: own.scopeKey, policy: ports?.policy ?? null, bodyTasksOpen: ports?.bodyTasksOpen ?? null, now: own.now,
    status: scope => own.service.status(scope), supports: scope => own.service.supports(scope, LIFECYCLE_CAPABILITY_FRESH_WORLD),
    command: id => own.service.store.command(id), unresolved: () => own.service.store.unresolved(),
    record: ports ? freshWorldRecorder(ports.activity, own.scopeKey, ports.config) : null });
}
const VIA_LABEL: Record<FreshWorldVia, string> = { conversation: '会話', ops: '運用ページ', operator: '運用者' };
const REFUSED_LABEL: Partial<Record<FreshWorldReason, string>> = {
  keep_world: '運用者が今のワールドのまま始めるよう指定した',
  server_not_stopped: 'サーバーが止まっていると確かめられなかった',
  unsupported: 'マイクラの体がまだ新しいワールドに対応していない',
  tasks_open: 'マイクラの作業がまだ残っている',
  tasks_unknown: 'マイクラの作業が残っているか確かめられなかった',
  unresolved_operation: '前のマイクラ管理操作の結果がまだ確認できていない',
};

/** The activity record's sentence for one decision. */
export function freshWorldSummary(record: Pick<FreshWorldRecord, 'applied' | 'reason' | 'via'>): string {
  if (record.applied) return `ライ氏の${VIA_LABEL[record.via]}からの開始の頼みで、「新しいワールドで始める」を体に伝えました（今のワールドは別の名前で残り、消えません）。`;
  const why = REFUSED_LABEL[record.reason] ?? '条件を確かめられなかった';
  return `「新しいワールドで始める」はオンですが、${why}ので、今のワールドのまま始めます。`;
}

/** The activity record's sentence for how a start that asked for a new world ended. */
export function freshWorldResultSummary(record: Pick<FreshWorldResultRecord, 'result' | 'movedTo'>): string {
  switch (record.result) {
    case 'started': return record.movedTo
      ? `新しいワールドで始めました（前のワールドは ${record.movedTo} として残しています）。`
      : '新しいワールドで始めました（前のワールドはありませんでした）。';
    case 'refused': return '新しいワールドを用意できなかったので、体は何も変えず、サーバーも始めていません（今のワールドのままです）。';
    case 'cancelled': return '新しいワールドで始める前に取りやめになったので、ワールドは今のままです。';
    case 'not_issued': return '開始の指示を保存できなかったので、新しいワールドは用意していません（今のワールドのままです）。';
    default: return '新しいワールドで始められたか確かめられません。サーバーの状態とワールドの名前を確かめてください。';
  }
}

/** Writes one decision to the owner's activity record (「したことの記録」). */
export function freshWorldRecorder(activity: Pick<AutonomyActivityRecord, 'append'>, scopeKey: string, config: Pick<AutonomyConfig, 'timeZone'>) {
  return (record: FreshWorldRecord): void => {
    activity.append(scopeKey, autonomyDayKey(record.at, config), record.at, {
      kind: 'control', actor: 'owner', domain: 'minecraft_lifecycle', approval: 'not_needed', outcome: record.applied ? 'done' : 'recorded',
      tool: 'minecraft.fresh_world', reasonCode: `fresh_world_${record.reason}`, summary: freshWorldSummary(record),
      detail: `operation=${record.operationId} server=${record.serverId} via=${record.via}`,
    });
  };
}

/** Writes how a start that asked for a new world ended (the receipt's `worldId` and `movedTo`) to the activity record. */
export function freshWorldResultRecorder(activity: Pick<AutonomyActivityRecord, 'append'>, scopeKey: string, config: Pick<AutonomyConfig, 'timeZone'>) {
  return (record: FreshWorldResultRecord): void => {
    const world = record.worldId ? ` world=${record.worldId} movedTo=${record.movedTo ?? 'none'}` : '';
    activity.append(scopeKey, autonomyDayKey(record.at, config), record.at, {
      kind: 'control', actor: 'owner', domain: 'minecraft_lifecycle', approval: 'not_needed', outcome: record.result === 'started' ? 'done' : 'recorded',
      tool: 'minecraft.fresh_world', reasonCode: `fresh_world_${record.result}`, summary: freshWorldResultSummary(record),
      detail: `operation=${record.operationId} server=${record.serverId} via=${record.via}${world}`,
    });
  };
}

/** How the operation id says it was asked: only these three ids are made by a path that may ask for a new world. */
export function freshWorldViaOfOperation(id: string): FreshWorldVia | null {
  if (/^lifecycle:[a-f0-9]{64}$/u.test(id)) return 'conversation';
  if (/^ops-lifecycle:[0-9a-f-]{36}$/u.test(id)) return 'ops';
  if (/^operator:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) return 'operator';
  return null;
}

/** The part of a settled receipt the owner is told about a new world: undefined unless a fresh world was really made. */
export function freshWorldOfReceipt(
  receipt: Pick<MinecraftLifecycleReceipt, 'outcome' | 'action' | 'worldId' | 'movedTo'> | null | undefined,
): { worldId: string; movedTo: string | null } | undefined {
  if (!receipt || receipt.action !== 'start' || receipt.outcome !== 'completed' || !receipt.worldId) return undefined;
  return { worldId: receipt.worldId, movedTo: receipt.movedTo ?? null };
}

/**
 * The hooks `MinecraftLifecycle` calls for a command that carries the option: the decision is written when the command is about to
 * be stored (a failing record makes it an ordinary start), a compensating line if it then could not be stored, and the result when its
 * receipt is accepted. Without ports: no hook, so the service sends an ordinary start.
 */
export function freshWorldIssuance(ports: FreshWorldPorts | undefined, own: { scopeKey: string; now(): string }) {
  if (!ports) return undefined;
  const decide = freshWorldRecorder(ports.activity, own.scopeKey, ports.config), result = freshWorldResultRecorder(ports.activity, own.scopeKey, ports.config);
  const base = (command: MinecraftLifecycleCommand) => ({
    at: own.now(), via: freshWorldViaOfOperation(command.id), operationId: command.id, serverId: command.serverId,
  });
  return {
    issue(command: MinecraftLifecycleCommand): boolean {
      const { via, ...rest } = base(command);
      if (!via) return false;
      decide({ ...rest, via, applied: true, reason: 'applied' });
      return true;
    },
    aborted(command: MinecraftLifecycleCommand): void {
      const { via, ...rest } = base(command);
      if (via) result({ ...rest, via, result: 'not_issued' });
    },
    settled(command: MinecraftLifecycleCommand, receipt: MinecraftLifecycleReceipt): void {
      const { via, ...rest } = base(command);
      if (!via || receipt.action !== 'start') return;
      const made = freshWorldOfReceipt(receipt);
      const kind: FreshWorldResult = made ? 'started' : receipt.outcome === 'refused' ? 'refused' : receipt.outcome === 'cancelled' ? 'cancelled' : 'unknown';
      result({ ...rest, via, result: kind, ...(made ? made : {}) });
    },
  };
}

/** Writes one change of the switch itself (`POST /v1/ops/settings`) to the activity record. */
export function freshWorldSettingRecorder(activity: Pick<AutonomyActivityRecord, 'append'>, config: Pick<AutonomyConfig, 'timeZone'>) {
  return (scopeKey: string, change: { setting: 'freshWorld'; value: boolean; at: string; deviceId?: string }): void => {
    activity.append(scopeKey, autonomyDayKey(change.at, config), change.at, {
      kind: 'control', actor: 'owner', domain: 'minecraft_lifecycle', approval: 'not_needed', outcome: 'recorded',
      tool: 'ops.settings.freshWorld', reasonCode: change.value ? 'fresh_world_on' : 'fresh_world_off',
      summary: change.value
        ? '所有者が「新しいワールドで始める」をオンにしました。止まっているサーバーを新しく頼んで始めるとき、今のワールドを別の名前で残して、新しいワールドで始めます。'
        : '所有者が「新しいワールドで始める」をオフにしました。',
      ...(change.deviceId ? { detail: `device=${change.deviceId}` } : {}),
    });
  };
}
