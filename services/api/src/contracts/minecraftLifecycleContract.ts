import type { ActionLease } from '@shannon/mind';

/** Always-on operator channel; independent of world-body presence and paid game planning. */
export const MINECRAFT_LIFECYCLE_PATH = '/v1/body/minecraft/lifecycle';
/**
 * `set_day` (owner request via the Minebot lane, 2026-10-14; body ea1ef4ce): the operator runs exactly `time set day` over its private
 * RCON on the running server, only after a fresh authority check and with no other player online. Accepted completion is
 * `completed`/`changed` on a running server, with no stop guard; others online refuse it as `players_present`; an RCON error or
 * an unexpected reply stays `unknown` with inputs not released. A body that predates it drops the command, which then leaves
 * by the one unknown exit.
 */
export const MINECRAFT_LIFECYCLE_ACTIONS = ['start', 'stop', 'login', 'logout', 'set_day'] as const;
export type MinecraftLifecycleAction = typeof MINECRAFT_LIFECYCLE_ACTIONS[number];
export interface MinecraftLifecycleState {
  serverId: string; observedAt: string;
  running: 'running' | 'stopped' | 'unknown'; bot: 'joined' | 'absent' | 'unknown';
  /** Authoritative count after excluding only the configured bot's authenticated UUID. Null means unknown. */
  otherPlayers: number | null;
}
export interface MinecraftLifecycleAuthority {
  scopeKey: string; origin: 'owner_request' | 'own_time';
  /** Original execution and provenance; operator never manufactures an owner request. */
  executionId: string; lease: ActionLease; sourceIds: readonly string[];
}
/**
 * What a command may additionally ask of the body. Optional and absent on every command that does not ask: a body that predates it
 * ignores it, and an API that predates it never sends it. `freshWorld: true` is only ever on a `start` of `shannon-home` that the
 * owner newly asked for while the server was stopped and nothing else was open (`wiring/freshWorldWiring.ts`); the body then
 * deletes the current world and starts a new one. It is part of the command's identity: it is never added to, or taken from, a
 * command that already exists.
 */
export interface MinecraftLifecycleOptions { freshWorld?: true }
export interface MinecraftLifecycleCommand {
  schemaVersion: 1; id: string; connectionId: string; serverId: string;
  action: MinecraftLifecycleAction; authority: MinecraftLifecycleAuthority; issuedAt: string; deadlineAt: string;
  options?: MinecraftLifecycleOptions;
}
export interface MinecraftLifecycleReceipt {
  id: string; connectionId: string; serverId: string; action: MinecraftLifecycleAction;
  outcome: 'completed' | 'refused' | 'cancelled' | 'unknown';
  code: 'changed' | 'already_running' | 'already_stopped' | 'already_joined' | 'already_absent'
    | 'players_present' | 'state_unknown' | 'authority_revoked' | 'deadline' | 'error';
  observedAt: string; inputsReleased: boolean; state: MinecraftLifecycleState;
  /** Successful stop must be one atomic runtime decision under a join barrier, including a fresh player check. */
  stopGuard?: { admissionClosed: true; otherPlayers: 0; checkedAt: string };
}
export interface MinecraftLifecyclePoll {
  schemaVersion: 1; connectionId: string; sequence: number;
  states: readonly MinecraftLifecycleState[]; receipts: readonly MinecraftLifecycleReceipt[];
}
export interface MinecraftLifecycleReply {
  schemaVersion: 1; commands: readonly MinecraftLifecycleCommand[]; cancel: readonly string[]; acknowledged: readonly string[];
}
export interface MinecraftLifecycleRequest {
  id: string; serverId: string; action: MinecraftLifecycleAction; authority: MinecraftLifecycleAuthority;
  options?: MinecraftLifecycleOptions;
}
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u.test(v);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fresh = (v: unknown, now: number): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && now - Date.parse(v) >= -1000 && now - Date.parse(v) <= 3000;
const recorded = (v: unknown, now: number): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && Date.parse(v) <= now + 1000;
export function validLifecycleState(v: unknown, now: number, historical = false): v is MinecraftLifecycleState {
  return record(v) && id(v.serverId) && (historical ? recorded(v.observedAt, now) : fresh(v.observedAt, now)) && ['running', 'stopped', 'unknown'].includes(String(v.running))
    && ['joined', 'absent', 'unknown'].includes(String(v.bot))
    && (v.otherPlayers === null || Number.isSafeInteger(v.otherPlayers) && Number(v.otherPlayers) >= 0 && Number(v.otherPlayers) <= 10000);
}
export function validLifecyclePoll(v: unknown, now: number): v is MinecraftLifecyclePoll {
  return record(v) && v.schemaVersion === 1 && id(v.connectionId) && Number.isSafeInteger(v.sequence) && Number(v.sequence) >= 0
    && Array.isArray(v.states) && v.states.length >= 1 && v.states.length <= 16 && v.states.every(s => validLifecycleState(s, now))
    && new Set(v.states.map(s => s.serverId)).size === v.states.length
    && Array.isArray(v.receipts) && v.receipts.length <= 16 && v.receipts.every(r => record(r) && id(r.id) && id(r.connectionId)
      && id(r.serverId) && MINECRAFT_LIFECYCLE_ACTIONS.includes(r.action as MinecraftLifecycleAction)
      && ['completed', 'refused', 'cancelled', 'unknown'].includes(String(r.outcome))
      && ['changed', 'already_running', 'already_stopped', 'already_joined', 'already_absent', 'players_present', 'state_unknown', 'authority_revoked', 'deadline', 'error'].includes(String(r.code))
      && typeof r.inputsReleased === 'boolean' && recorded(r.observedAt, now) && validLifecycleState(r.state, now, true)
      && (r.stopGuard === undefined || record(r.stopGuard) && r.stopGuard.admissionClosed === true && r.stopGuard.otherPlayers === 0 && recorded(r.stopGuard.checkedAt, now)));
}

/**
 * The source reference of her message telling how a lifecycle operation asked for in a conversation ended (owner decision
 * 2026-10-14, `lifecycleOutcomeLine.ts`): this prefix and the operation's own id. One message per operation (the reference is
 * unique in `initiative_messages`). It answers his request, so it is not her own initiative, and a body says it as it says a due
 * promise (`initiativeFreshness.ts`).
 */
export const LIFECYCLE_OUTCOME_SOURCE_PREFIX = 'lifecycle-outcome:';
