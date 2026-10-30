import { MINECRAFT_LIFECYCLE_ACTIONS, type MinecraftLifecycleAction } from './minecraftLifecycleContract.js';

/**
 * The operator's Minecraft path (owner decision 2026-10-14, 「Minecraft だけに限って作る」; `docs/operator-minecraft-contract.md`).
 * An operator on the production VM, as the service user, asks the running API through a socket only that user can open to do
 * one of three things on the owner's behalf: a Minecraft lifecycle operation, one Minecraft work request (the same common task
 * `minecraft.request` makes), or the cancel of such a request it started itself. Nothing else is offered: no conversation message
 * as the owner, no memory or note, no other tool, no setting, no credential.
 *
 * One addition (the coordinator's choice on the owner's behalf, 2026-10-14): `skills import`, the owner's skill-pack import
 * (`runSkillImport`, the same importer, plan hash and receipt as the paired route) for an app-owned pack, because the owner holds
 * no paired-device token outside the apps. It writes only what that route writes, and the audit names the operator.
 */
export const OPERATOR_VIA = 'operator_cli';
export const OPERATOR_DOMAINS = ['minecraft', 'skills'] as const;
export const OPERATOR_COMMANDS = ['lifecycle', 'request', 'cancel', 'budget', 'release', 'skill_import', 'resume', 'held'] as const;
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
  /**
   * The cap of an admitted Minecraft request (`MINECRAFT_TASK_CAP.yen`, owner answer of 2026-10-13); a lower cap
 * may be asked. A running
   * request's cap may be changed (`budget`) anywhere up to this, never above it.
   */
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
  'minecraft_busy', 'lease_conflict', 'unresolved_operation', 'budget_above_cap', 'budget_below_spent', 'refused', 'not_found', 'not_operator_task',
  'not_running', 'rate_limited', 'flooded', 'stopped', 'time_limit', 'settled', 'error',
  // Minecraft run 6 (2026-10-14): the body re-check (`minecraft release`) and a set_day asked before the login settled.
  'released', 'not_retained', 'not_confirmed', 'proof_refused', 'recheck_busy', 'not_settled',
  // The skill import (`skills import`): the importer's refusals, as the paired route answers them.
  'validation_failed', 'stale_plan',
  // 2026-10-28, the fix run (`request --hold-on-failure`, `resume`): a task held on a heavy failure, and its resume.
  'held', 'not_held', 'resumed',
] as const;
export type OperatorCode = typeof OPERATOR_CODES[number];

export type OperatorInput =
  /** keepWorld (--keep-world, start only): this start keeps the current world even while 「新しいワールドで始める」 is on. */
  | { command: 'lifecycle'; action: MinecraftLifecycleAction; serverId: string | null; keepWorld: boolean }
  /**
   * holdOnFailure (2026-10-28, the fix run): on a heavy failure of the body (a go stuck or out of search time, an act that lost a
   * minute, near death),
   * the task is held instead of going on: no decision, the plan, the pack and the task kept, the world stopped (`/tick freeze`, never
   * with anyone else
   * on), the box and the scene written. `resume` goes on from there.
   */
  | { command: 'request'; goal: string; maxMinutes: number; budgetYen: number; holdOnFailure?: boolean }
  /** A held request goes on: the act that failed is sent again with the same arguments first, then the decisions from the plan. */
  /** `skipReplay` (run 45, holds 3 to 5: the held act sent again failed again the same way three times): the held act is not sent again. */
  | { command: 'resume'; taskId: string | null; skipReplay: boolean; deductMinutes?: number }
  /** The held requests with where the body is now against where the held act began (read only; the CLI's status asks it). */
  | { command: 'held' }
  | { command: 'cancel'; taskId: string | null }
  /** A running request's yen cap, changed (2026-10-26, run 39): appended to the audit as a `budget` row, never written over the request's. */
  | { command: 'budget'; taskId: string | null; budgetYen: number }
  /** A request to check the Minecraft body again and release what it proves released (never a force release). */
  | { command: 'release' }
  /** The owner's skill-pack import, dry-run or apply (`runSkillImport`). */
  | { command: 'skill_import'; phase: 'dry-run' | 'apply'; packId: string; revision: string; planHash: string | null; approvalReference: string | null };
export interface OperatorEnvelope { v: 1; operator: string; domain: string; op: string; args: Record<string, unknown> }
export type OperatorParse = { ok: true; operator: string; input: OperatorInput } | { ok: false; operator: string; code: OperatorCode; message: string };
export interface OperatorReply {
  operationId: string; outcome: 'accepted' | 'refused'; code: OperatorCode; message: string;
  taskId?: string; lifecycleId?: string; actionId?: string; deadlineAt?: string; budgetYen?: number;
  /** `skills import`: the body the paired route would answer (the plan, the receipt, or the importer's refusal). */
  skillImport?: unknown;
  /** `resume` and `held` (2026-10-28): where the held act began, where the body was held, and where it is now. */
  position?: string;
  /** Run 44: `body` the body's own hold beside each (the same one, none, or another); `bodyOnly` a hold only the body keeps. */
  held?: Array<{ taskId: string; detail: string; position: string; body?: string }>;
  bodyOnly?: string;
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
  const keepWorld = args.keepWorld === undefined ? false : args.keepWorld;
  if (keepWorld !== true && keepWorld !== false) return refuse(operator, 'invalid_input', 'keepWorld must be true or false');
  if (keepWorld && action !== 'start') return refuse(operator, 'invalid_input', '--keep-world is an option of start only');
  return { ok: true, operator, input: { command: 'lifecycle', action, serverId, keepWorld } };
}

/**
 * Why a request's text looks garbled, or null (Minecraft run 17, 2026-10-19: a request written as UTF-8 and read
 * back as CP932 came
 * in as `繧ｨ繝ｳ繝峨Λ繧定ｨ惹ｼ舌＠縺ｦ縺上□縺輔＞`, was accepted, and was closed after 8 decisions as done). Closed signs only:
 * the replacement character, a kanji followed at once by half-width katakana twice or more (UTF-8 bytes read as
 * CP932: `繧ｨ`, `繝ｳ`),
 * the lead kanji such text is made of, or UTF-8 read as Latin-1. Half-width katakana written beside hiragana or apart from kanji
 * (`ﾀﾞｲﾔを3個掘って`, `｢鉄｣を集めて`) is not refused.
 */
export function garbledRequest(text: string): string | null {
  if (/�/u.test(text)) return 'replacement_character';
  if ((text.match(/[一-鿿][｡-ﾟ]/gu) ?? []).length >= 2) return 'halfwidth_kana_with_kanji';
  if ((text.match(/[繧縺繝譁蜈髢]/gu) ?? []).length >= 2) return 'cp932_lead_kanji';
  // UTF-8 read as Latin-1 or CP1252: a lead byte's letter, then a continuation byte's (in CP1252 also ‚ ƒ … € ™ and the like).
  if (/[ÃãâÂ][\x80-\xBFŒœŠšŸŽžƒˆ˜–-›€™]/u.test(text)) return 'latin1_mojibake';
  return null;
}

function request(operator: string, args: Record<string, unknown>): OperatorParse {
  const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
  if (!validRequestGoal(goal)) {
    return refuse(operator, 'invalid_input', `the request must be 1..${OPERATOR_LIMITS.goalCharacters} characters without control characters`);
  }
  const garbled = garbledRequest(goal);
  if (garbled) return refuse(operator, 'invalid_input', `the request text looks garbled (${garbled}): write it as UTF-8 and send it again`);
  const maxMinutes = integer(args.maxMinutes, OPERATOR_LIMITS.defaultMinutes);
  if (maxMinutes === null || maxMinutes < 1 || maxMinutes > OPERATOR_LIMITS.maxMinutes) {
    return refuse(operator, 'invalid_input', `--max-minutes must be 1..${OPERATOR_LIMITS.maxMinutes}`);
  }
  const budgetYen = integer(args.budgetYen, OPERATOR_LIMITS.maxBudgetYen);
  if (budgetYen === null || budgetYen < 1) return refuse(operator, 'invalid_input', '--budget-yen must be a positive integer');
  const holdOnFailure = args.holdOnFailure === undefined ? false : args.holdOnFailure;
  if (holdOnFailure !== true && holdOnFailure !== false) return refuse(operator, 'invalid_input', 'holdOnFailure must be true or false');
  if (budgetYen > OPERATOR_LIMITS.maxBudgetYen) {
    return refuse(operator, 'budget_above_cap', `--budget-yen may not exceed the Minecraft request cap of ${OPERATOR_LIMITS.maxBudgetYen} yen`);
  }
  return { ok: true, operator, input: { command: 'request', goal, maxMinutes, budgetYen, ...(holdOnFailure ? { holdOnFailure: true } : {}) } };
}

function cancel(operator: string, args: Record<string, unknown>): OperatorParse {
  if (args.latest === true && args.taskId === undefined) return { ok: true, operator, input: { command: 'cancel', taskId: null } };
  if (typeof args.taskId !== 'string' || !TASK_ID.test(args.taskId)) return refuse(operator, 'invalid_input', 'cancel takes a task id or --latest');
  return { ok: true, operator, input: { command: 'cancel', taskId: args.taskId } };
}

/** `budget`: a task id or `latest`, and a whole yen amount of 1..the request cap (anything else is refused, and
 * audited as such). */
function budget(operator: string, args: Record<string, unknown>): OperatorParse {
  const taskId = args.latest === true && args.taskId === undefined ? null : args.taskId;
  if (taskId !== null && (typeof taskId !== 'string' || !TASK_ID.test(taskId))) return refuse(operator, 'invalid_input', 'budget takes a task id or --latest');
  const budgetYen = args.budgetYen;
  if (typeof budgetYen !== 'number' || !Number.isSafeInteger(budgetYen) || budgetYen < 1) {
    return refuse(operator, 'invalid_input', 'the budget must be a positive whole number of yen');
  }
  if (budgetYen > OPERATOR_LIMITS.maxBudgetYen) {
    return refuse(operator, 'budget_above_cap', `the budget may not exceed the Minecraft request cap of ${OPERATOR_LIMITS.maxBudgetYen} yen`);
  }
  return { ok: true, operator, input: { command: 'budget', taskId, budgetYen } };
}

function release(operator: string, args: Record<string, unknown>): OperatorParse {
  const serverId = args.serverId ?? null;
  if (serverId !== null && (typeof serverId !== 'string' || !SERVER_ID.test(serverId))) return refuse(operator, 'invalid_input', 'serverId is invalid');
  return { ok: true, operator, input: { command: 'release' } };
}

const PACK_SYMBOL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u;

function skillImport(operator: string, args: Record<string, unknown>): OperatorParse {
  const extra = Object.keys(args).find(key => !['phase', 'packId', 'revision', 'planHash', 'approvalReference'].includes(key));
  if (extra !== undefined) {
    return refuse(operator, 'invalid_input', `${extra.slice(0, 40).replace(/[^\x20-\x7e]/gu, '?')} is not an argument of this operation`);
  }
  const phase = args.phase === 'dry-run' || args.phase === 'apply' ? args.phase : null;
  const symbol = (value: unknown) => typeof value === 'string' && PACK_SYMBOL.test(value);
  if (!phase || !symbol(args.packId) || !symbol(args.revision)) {
    return refuse(operator, 'invalid_input', 'skills import takes dry-run or apply, --pack and --revision');
  }
  const planHash = args.planHash ?? null, approvalReference = args.approvalReference ?? null;
  const applying = typeof planHash === 'string' && /^[a-f0-9]{64}$/u.test(planHash) && symbol(approvalReference);
  if (phase === 'apply' ? !applying : planHash !== null || approvalReference !== null) {
    return refuse(operator, 'invalid_input', 'apply needs --plan-hash (64 hex) and --approval-reference; dry-run takes neither');
  }
  return { ok: true, operator, input: { command: 'skill_import', phase, packId: args.packId as string, revision: args.revision as string,
    planHash: planHash as string | null, approvalReference: approvalReference as string | null } };
}

/** Outside Minecraft only `skills import` is offered; anything else is `out_of_scope`. */
function otherDomain(operator: string, domain: string, op: string, args: Record<string, unknown>): OperatorParse {
  if (domain === 'skills' && op === 'import') return skillImport(operator, args);
  return refuse(operator, 'out_of_scope', 'only minecraft operations and skills import are offered to an operator');
}

/** Reads one envelope. Anything outside the Minecraft operations and the skill import is `out_of_scope`, and the
 * audit says so. */
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
  if (value.domain !== 'minecraft') return otherDomain(operator, value.domain, value.op, args);
  const allowed: Record<string, readonly string[]> = {
    request: ['goal', 'maxMinutes', 'budgetYen', 'holdOnFailure'], cancel: ['taskId', 'latest'], resume: ['taskId', 'latest', 'skipReplay',
       'deductMinutes'], held: [], budget: ['taskId', 'latest', 'budgetYen'],
    start: ['serverId', 'keepWorld'],
  };
  const extra = Object.keys(args).find(key => !(allowed[value.op as string] ?? ['serverId']).includes(key));
  if (extra !== undefined) {
    return refuse(operator, 'invalid_input', `${extra.slice(0, 40).replace(/[^\x20-\x7e]/gu, '?')} is not an argument of this operation`);
  }
  return dispatchMinecraftOperation(operator, value.op, args);
}

/** What the audit keeps of the arguments: the envelope's own fields, bounded, never anything else of the process. */
export function auditedArguments(value: unknown): string {
  if (!record(value)) return '{}';
  const kept = { domain: value.domain, op: value.op, args: value.args };
  const text = JSON.stringify(kept, (_key, item) => typeof item === 'string' ? item.slice(0, OPERATOR_LIMITS.goalCharacters) : item);
  return (text ?? '{}').slice(0, 4000);
}

/** The Talk note when the operator starts or stops something for the owner: plain, attributed to the operator,
 * never his words. */
/**
 * The Talk notes are notices, not her words: the conversation store keeps only `user` and `assistant` messages (a CHECK of
 * `conversation_messages`), so a note is stored as `assistant` with note kind `operator-note`, and its words are a neutral,
 * marked notice in the third person, never in her voice and never as his request.
 */
export const OPERATOR_NOTE_MARK = '［運用者の操作のお知らせ］';
/** The note kind of the operator's lines in the owner's Talk (a stored note's turn id is `operator-note:<id>`). */
export const OPERATOR_NOTE_KIND = 'operator-note';
const TALK_NOTES = {
  request: (quoted: string) => `${OPERATOR_NOTE_MARK}運用者がライ氏の代わりに Minecraft の依頼「${quoted}」を始めました。`,
  cancel: (quoted: string) => `${OPERATOR_NOTE_MARK}運用者が、代わりに始めた Minecraft の依頼「${quoted}」を止めました。`,
  budget: (quoted: string) => `${OPERATOR_NOTE_MARK}運用者が、代わりに始めた Minecraft の依頼「${quoted}」の予算の上限を変えました。`,
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

function validRequestGoal(goal: string): boolean {
  return !(!goal || goal.length > OPERATOR_LIMITS.goalCharacters || /\p{Cc}/u.test(goal));
}

/** 再開要求の追加パラメータと、元の取消対象を確認する。 */
function resumeRequest(operator: string, args: Record<string, unknown>): OperatorParse {

    if (args.skipReplay !== undefined && args.skipReplay !== true) return refuse(operator, 'invalid_input', 'skipReplay is true or absent');
    // Amendment A-15: the minutes the body could not move that the head could not measure (the VM stopped): taken
// off the request's time (a whole number, at most a day).
    if (args.deductMinutes !== undefined && !validDeductMinutes(args.deductMinutes)) {
      return refuse(operator, 'invalid_input', 'deductMinutes is a whole number of minutes, 1 to 1440');
    }
    const { skipReplay: _skip, deductMinutes: _deduct, ...rest } = args;
    const parsed = cancel(operator, rest);
    return parsed.ok ? { ok: true, operator, input: { command: 'resume', taskId: (parsed.input as { taskId: string | null }).taskId,
       skipReplay: args.skipReplay === true,
      ...(typeof args.deductMinutes === 'number' ? { deductMinutes: args.deductMinutes } : {}) } } : parsed;
  }

function validDeductMinutes(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 1440;
}

/** 封筒と引数名を確認した後の、操作ごとの読取り。 */
function dispatchMinecraftOperation(operator: string, operation: string, args: Record<string, unknown>): OperatorParse {
  if (operation === 'request') return request(operator, args);
  if (operation === 'cancel') return cancel(operator, args);
  if (operation === 'held') return { ok: true, operator, input: { command: 'held' } };
  if (operation === 'resume') return resumeRequest(operator, args);
  if (operation === 'budget') return budget(operator, args);
  if (operation === 'release') return release(operator, args);
  return lifecycle(operator, operation, args);
}
