import { MINECRAFT_LIFECYCLE_ACTIONS, type MinecraftLifecycleAction } from './minecraftLifecycleContract.js';

/**
 * The operator's Minecraft path (owner decision 2026-10-14, 「Minecraft だけに限って作る」; `docs/operator-minecraft-contract.md`).
 * An operator on the production VM, as the service user, asks the running API through a socket only that user can open to do
 * one of three things on the owner's behalf: a Minecraft lifecycle operation, one Minecraft work request (the same common task
 * `minecraft.request` makes), or the cancel of such a request it started itself. Nothing else is offered: no conversation message
 * as the owner, no memory or note, no other tool, no setting, no credential.
 */
export const OPERATOR_VIA = 'operator_cli';
export const OPERATOR_DOMAINS = ['minecraft'] as const;
export const OPERATOR_COMMANDS = ['lifecycle', 'request', 'cancel'] as const;
export type OperatorCommand = typeof OPERATOR_COMMANDS[number];
export const OPERATOR_PATH = '/operator/v1/minecraft';
/** Where the socket is, beside the database the CLI was told to use (never a guessed default path). */
export const OPERATOR_SOCKET_DIRECTORY = 'operator-runtime';
export const OPERATOR_SOCKET_NAME = 'operator.sock';

export const OPERATOR_LIMITS = Object.freeze({
  bodyBytes: 8 * 1024,
  goalCharacters: 1000,
  operatorCharacters: 64,
  /** The owner's rule for a run (2026-10-14): at most 30 minutes unless the operator asks for less; never above two hours. */
  defaultMinutes: 30,
  maxMinutes: 120,
  /** The cap of an admitted Minecraft request (`MINECRAFT_TASK_CAP.yen`, owner answer of 2026-10-13); a lower cap may be asked. */
  maxBudgetYen: 2000,
  requestsPerHour: 20,
  /** Invocations an hour (socket refusals included) that are audited one by one; past it they are coalesced (`flooded`). */
  invocationsPerHour: 120,
  /** At most one coalesced `flooded` audit row this often while flooded. */
  floodRowMs: 60_000,
  /** Refusals an hour written to the owner's activity record; the rest are in the audit only. */
  refusalsRecordedPerHour: 10,
});

/** The closed outcome codes the API answers and the audit records. */
export const OPERATOR_CODES = [
  'accepted', 'out_of_scope', 'invalid_input', 'disabled', 'owner_not_alone', 'body_unavailable', 'lifecycle_unavailable',
  'minecraft_busy', 'lease_conflict', 'unresolved_operation', 'budget_above_cap', 'refused', 'not_found', 'not_operator_task',
  'not_running', 'rate_limited', 'flooded', 'stopped', 'time_limit', 'settled', 'error',
] as const;
export type OperatorCode = typeof OPERATOR_CODES[number];

export type OperatorInput =
  | { command: 'lifecycle'; action: MinecraftLifecycleAction; serverId: string | null }
  | { command: 'request'; goal: string; maxMinutes: number; budgetYen: number }
  | { command: 'cancel'; taskId: string | null };
export interface OperatorEnvelope { v: 1; operator: string; domain: string; op: string; args: Record<string, unknown> }
export type OperatorParse = { ok: true; operator: string; input: OperatorInput } | { ok: false; operator: string; code: OperatorCode; message: string };
export interface OperatorReply {
  operationId: string; outcome: 'accepted' | 'refused'; code: OperatorCode; message: string;
  taskId?: string; lifecycleId?: string; actionId?: string; deadlineAt?: string; budgetYen?: number;
}

const OPERATOR_LABEL = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/u;
const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const refuse = (operator: string, code: OperatorCode, message: string): OperatorParse => ({ ok: false, operator, code, message });

/** The operator label as written into the audit, or `unknown` when it cannot be one. It is a label, not a credential. */
export function operatorLabel(value: unknown): string {
  return typeof value === 'string' && OPERATOR_LABEL.test(value) ? value : 'unknown';
}

function integer(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null) return fallback;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function lifecycle(operator: string, op: string, args: Record<string, unknown>): OperatorParse {
  const action = MINECRAFT_LIFECYCLE_ACTIONS.find(candidate => candidate === op);
  if (!action) return refuse(operator, 'out_of_scope', `minecraft ${op.slice(0, 40)} is not an operator operation`);
  const serverId = args.serverId ?? null;
  if (serverId !== null && (typeof serverId !== 'string' || !SERVER_ID.test(serverId))) return refuse(operator, 'invalid_input', 'serverId is invalid');
  return { ok: true, operator, input: { command: 'lifecycle', action, serverId } };
}

function request(operator: string, args: Record<string, unknown>): OperatorParse {
  const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
  if (!goal || goal.length > OPERATOR_LIMITS.goalCharacters || /\p{Cc}/u.test(goal)) {
    return refuse(operator, 'invalid_input', `the request must be 1..${OPERATOR_LIMITS.goalCharacters} characters without control characters`);
  }
  const maxMinutes = integer(args.maxMinutes, OPERATOR_LIMITS.defaultMinutes);
  if (maxMinutes === null || maxMinutes < 1 || maxMinutes > OPERATOR_LIMITS.maxMinutes) {
    return refuse(operator, 'invalid_input', `--max-minutes must be 1..${OPERATOR_LIMITS.maxMinutes}`);
  }
  const budgetYen = integer(args.budgetYen, OPERATOR_LIMITS.maxBudgetYen);
  if (budgetYen === null || budgetYen < 1) return refuse(operator, 'invalid_input', '--budget-yen must be a positive integer');
  if (budgetYen > OPERATOR_LIMITS.maxBudgetYen) {
    return refuse(operator, 'budget_above_cap', `--budget-yen may not exceed the Minecraft request cap of ${OPERATOR_LIMITS.maxBudgetYen} yen`);
  }
  return { ok: true, operator, input: { command: 'request', goal, maxMinutes, budgetYen } };
}

function cancel(operator: string, args: Record<string, unknown>): OperatorParse {
  if (args.latest === true && args.taskId === undefined) return { ok: true, operator, input: { command: 'cancel', taskId: null } };
  if (typeof args.taskId !== 'string' || !TASK_ID.test(args.taskId)) return refuse(operator, 'invalid_input', 'cancel takes a task id or --latest');
  return { ok: true, operator, input: { command: 'cancel', taskId: args.taskId } };
}

/** Reads one envelope. Anything outside the Minecraft operations is `out_of_scope`, and the audit records it as such. */
export function parseOperatorEnvelope(value: unknown): OperatorParse {
  if (!record(value)) return refuse('unknown', 'invalid_input', 'a JSON object is required');
  const operator = operatorLabel(value.operator);
  if (value.v !== 1 || operator === 'unknown') return refuse(operator, 'invalid_input', 'v must be 1 and operator a label of [A-Za-z0-9._@-]');
  const unknown = Object.keys(value).find(key => !['v', 'operator', 'domain', 'op', 'args'].includes(key));
  if (unknown !== undefined) return refuse(operator, 'invalid_input', 'unknown field');
  const args = value.args ?? {};
  if (!record(args) || typeof value.domain !== 'string' || typeof value.op !== 'string') {
    return refuse(operator, 'invalid_input', 'domain, op and args are required');
  }
  if (value.domain !== 'minecraft') return refuse(operator, 'out_of_scope', 'only minecraft operations are offered to an operator');
  const allowed: Record<string, readonly string[]> = { request: ['goal', 'maxMinutes', 'budgetYen'], cancel: ['taskId', 'latest'] };
  const extra = Object.keys(args).find(key => !(allowed[value.op as string] ?? ['serverId']).includes(key));
  if (extra !== undefined) {
    return refuse(operator, 'invalid_input', `${extra.slice(0, 40).replace(/[^\x20-\x7e]/gu, '?')} is not an argument of this operation`);
  }
  if (value.op === 'request') return request(operator, args);
  if (value.op === 'cancel') return cancel(operator, args);
  return lifecycle(operator, value.op, args);
}

/** What the audit keeps of the arguments: the envelope's own fields, bounded, never anything else of the process. */
export function auditedArguments(value: unknown): string {
  if (!record(value)) return '{}';
  const kept = { domain: value.domain, op: value.op, args: value.args };
  const text = JSON.stringify(kept, (_key, item) => typeof item === 'string' ? item.slice(0, OPERATOR_LIMITS.goalCharacters) : item);
  return (text ?? '{}').slice(0, 4000);
}

/** The Talk note when the operator starts or stops something for the owner: plain, attributed to the operator, never his words. */
/**
 * The Talk notes are notices, not her words: the conversation store keeps only `user` and `assistant` messages (a CHECK of
 * `conversation_messages`), so a note is stored as `assistant` with note kind `operator-note`, and its words are a neutral,
 * marked notice in the third person, never in her voice and never as his request.
 */
export const OPERATOR_NOTE_MARK = '［運用者の操作のお知らせ］';
const TALK_NOTES = {
  request: (quoted: string) => `${OPERATOR_NOTE_MARK}運用者がライ氏の代わりに Minecraft の依頼「${quoted}」を始めました。`,
  cancel: (quoted: string) => `${OPERATOR_NOTE_MARK}運用者が、代わりに始めた Minecraft の依頼「${quoted}」を止めました。`,
  time_limit: (quoted: string) => `${OPERATOR_NOTE_MARK}運用者が代わりに始めた Minecraft の依頼「${quoted}」は、決められた時間に達したので止めました。`,
  lifecycle: (quoted: string) => `${OPERATOR_NOTE_MARK}運用者がライ氏の代わりに Minecraft の操作（${quoted}）を頼みました。`,
} as const;
export function operatorTalkNote(kind: keyof typeof TALK_NOTES, subject: string): string {
  return TALK_NOTES[kind](subject.replace(/\s+/gu, ' ').slice(0, 80));
}

/** The title and the first inbox line of an operator's request: whoever reads the task sees who handed it over. */
export const OPERATOR_TITLE_PREFIX = '（運用者経由）';

export function operatorRequestContext(operator: string): string {
  return `この依頼は運用者（${operator}）がライ氏の代わりに渡したものです。ライ氏が直接言った言葉ではありません。`;
}
