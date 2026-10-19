import type { AutonomyActivityRecord } from '../mind/inhibition/store/autonomyActivity.js';
import { autonomyDayKey, type AutonomyConfig } from '../mind/inhibition/autonomyBudget.js';
import type { MinecraftLifecycle } from '../surfaces/minecraft/minecraftLifecycle.js';
import type { MinecraftLifecycleAction, MinecraftLifecycleCommand, MinecraftLifecycleOptions, MinecraftLifecycleState }
  from '../contracts/minecraftLifecycleContract.js';

/**
 * 「新しいワールドで始める」 (`docs/ops-contract.md`): whether a Minecraft start asks the body to delete the current world and start a
 * new one. This is the one place that decides; the conversation's request, the Ops `minecraft.start` / `minebot.start` and the
 * operator CLI's start all ask it (`minecraftLifecycleWiring.ts`, `opsMinecraftLifecycleWiring.ts`, `operatorLifecycleWiring.ts`).
 * It is destructive and cannot be undone, so every doubt is "no": the answer is yes only when every condition below holds.
 */
export const FRESH_WORLD_SERVER = 'shannon-home';

/** The only three ways the owner newly asks for a start. Anything else (a task step, her own time, a recovery) has no `via`. */
export type FreshWorldVia = 'conversation' | 'ops' | 'operator';

export const FRESH_WORLD_REASONS = [
  'applied', 'existing_command', 'not_owner_request', 'not_start', 'other_server', 'switch_off', 'server_not_stopped', 'tasks_open',
  'tasks_unknown', 'unresolved_operation',
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
  /** The server's state from a fresh frame of the paired operator; undefined when there is none. */
  state: Pick<MinecraftLifecycleState, 'running'> | undefined;
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
  if (facts.state?.running !== 'stopped') return { reason: 'server_not_stopped' };
  if (facts.bodyTasksOpen === null) return { reason: 'tasks_unknown' };
  if (facts.bodyTasksOpen) return { reason: 'tasks_open' };
  if (facts.unresolved) return { reason: 'unresolved_operation' };
  return { reason: 'applied', options: { freshWorld: true } };
}

export interface FreshWorldRequest {
  id: string; serverId: string; action: MinecraftLifecycleAction; origin: 'owner_request' | 'own_time'; via: FreshWorldVia | null;
}
export type FreshWorldAdmission = (request: FreshWorldRequest) => MinecraftLifecycleOptions | undefined;

/** What the activity record keeps of a decision: no words of the owner's, no world name; closed codes and the operation's own id. */
export interface FreshWorldRecord { at: string; applied: boolean; reason: FreshWorldReason; via: FreshWorldVia; operationId: string; serverId: string }

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
  command(id: string): Pick<MinecraftLifecycleCommand, 'options'> | null;
  unresolved(): boolean;
  /** Whether a Minecraft-bound task is still open; null when unknown or when the task runtime is not there. */
  bodyTasksOpen?: (() => boolean | null) | null;
  /** Writes the decision to the activity record. Throwing stops an `applied` decision (no record, no deletion). */
  record?: ((record: FreshWorldRecord) => void) | null;
  now(): string;
}

/** Whether this is a start the owner newly asked for on the home server: the only kind whose decision is written down. */
function askedFor(request: FreshWorldRequest): request is FreshWorldRequest & { via: FreshWorldVia } {
  return request.via !== null && request.origin === 'owner_request' && request.action === 'start' && request.serverId === FRESH_WORLD_SERVER;
}

/** Writes the decision when it is to be written. False only for an `applied` one that could not be: no record, no deletion. */
function noted(parts: Pick<FreshWorldParts, 'record' | 'now'>, request: FreshWorldRequest, decision: FreshWorldDecision): boolean {
  const applied = decision.reason === 'applied';
  if (!parts.record) return !applied;
  if (!askedFor(request) || decision.reason === 'existing_command' || decision.reason === 'switch_off') return true;
  try {
    parts.record({ at: parts.now(), applied, reason: decision.reason, via: request.via, operationId: request.id, serverId: request.serverId });
    return true;
  } catch {
    return !applied; // a missing record of a kept world changes nothing
  }
}

/**
 * The admission the three call sites share. Returns the options to put on the new command, or undefined (the legacy command,
 * exactly as before). A decision is recorded only when the switch was on for a start the owner newly asked for on the home server:
 * either that it was applied, or why this start keeps the current world. Any error here is "no".
 */
export function createFreshWorldAdmission(parts: FreshWorldParts): FreshWorldAdmission {
  const facts = (request: FreshWorldRequest): FreshWorldFacts => ({
    action: request.action, serverId: request.serverId, origin: request.origin, via: request.via, existing: parts.command(request.id),
    switchedOn: request.action === 'start' && request.serverId === FRESH_WORLD_SERVER && parts.policy?.freshWorld(parts.scopeKey) === true,
    state: parts.status(parts.scopeKey).find(item => item.serverId === request.serverId),
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
  scopeKey: string; service: Pick<MinecraftLifecycle, 'status'> & { store: Pick<MinecraftLifecycle['store'], 'command' | 'unresolved'> }; now(): string;
}): FreshWorldAdmission {
  return createFreshWorldAdmission({ scopeKey: own.scopeKey, policy: ports?.policy ?? null, bodyTasksOpen: ports?.bodyTasksOpen ?? null, now: own.now,
    status: scope => own.service.status(scope), command: id => own.service.store.command(id), unresolved: () => own.service.store.unresolved(),
    record: ports ? freshWorldRecorder(ports.activity, own.scopeKey, ports.config) : null });
}
const VIA_LABEL: Record<FreshWorldVia, string> = { conversation: '会話', ops: '運用ページ', operator: '運用者' };
const REFUSED_LABEL: Partial<Record<FreshWorldReason, string>> = {
  server_not_stopped: 'サーバーが止まっていると確かめられなかった',
  tasks_open: 'マイクラの作業がまだ残っている',
  tasks_unknown: 'マイクラの作業が残っているか確かめられなかった',
  unresolved_operation: '前のマイクラ管理操作の結果がまだ確認できていない',
};

/** The activity record's sentence for one decision. */
export function freshWorldSummary(record: Pick<FreshWorldRecord, 'applied' | 'reason' | 'via'>): string {
  if (record.applied) return `ライ氏の${VIA_LABEL[record.via]}からの開始の頼みで、「新しいワールドで始める」を体に伝えました（今のワールドは消えます）。`;
  const why = REFUSED_LABEL[record.reason] ?? '条件を確かめられなかった';
  return `「新しいワールドで始める」はオンですが、${why}ので、今のワールドのまま始めます。`;
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

/** Writes one change of the switch itself (`POST /v1/ops/settings`) to the activity record. */
export function freshWorldSettingRecorder(activity: Pick<AutonomyActivityRecord, 'append'>, config: Pick<AutonomyConfig, 'timeZone'>) {
  return (scopeKey: string, change: { setting: 'freshWorld'; value: boolean; at: string }): void => {
    activity.append(scopeKey, autonomyDayKey(change.at, config), change.at, {
      kind: 'control', actor: 'owner', domain: 'minecraft_lifecycle', approval: 'not_needed', outcome: 'recorded',
      tool: 'ops.settings.freshWorld', reasonCode: change.value ? 'fresh_world_on' : 'fresh_world_off',
      summary: change.value
        ? '所有者が「新しいワールドで始める」をオンにしました。止まっているサーバーを新しく頼んで始めるとき、今のワールドを消します。'
        : '所有者が「新しいワールドで始める」をオフにしました。',
    });
  };
}
