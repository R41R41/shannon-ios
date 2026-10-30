import { randomUUID } from 'node:crypto';
import { HELD_SUMMARY } from './fcaBodyRecoveryPolicy.js';
import { BILLING_PAUSED_SUMMARY } from './taskPauseNotice.js';
import { ACTION_TERMINAL } from '@shannon/mind';
import type { ActionThreads } from '../contracts/actionThreadContract.js';
import { auditedArguments, operatorLabel, operatorTalkNote, parseOperatorEnvelope, OPERATOR_LIMITS,
  type OperatorCode, type OperatorInput, type OperatorReply } from '../contracts/operatorContract.js';
import type { OperatorAuditDraft, OperatorAuditRow, OperatorAuditStore } from '../infra/ops/store/operatorAuditStore.js';
import type { TaskView } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import { observeSync, withObserverRunSync } from '../infra/observer/observerContext.js';
import type { LifecycleSettlement } from './minecraftLifecycleRunner.js';
import { preparedWorldOfReceipt } from './freshWorldWiring.js';
import type { OperatorSocketRefusal } from '../infra/ops/operatorSocket.js';
import type { OperatorLifecycle } from './operatorLifecycleWiring.js';
import type { OperatorMinecraftRequests } from './operatorMinecraftRequests.js';
import type { MinecraftBodyRecheck } from './minecraftBodyRecheckWiring.js';
import { runSkillImport, type SkillImportCommandDeps } from '../infra/http/skillImportCommand.js';
import { driftWords, feet, headIncidentKind, HEAD_INCIDENT_WORDS, takeEnd, type Feet, type HeldAgain } from './minecraftIncidentHold.js';
import { heldAgainWords } from '../surfaces/minecraft/minecraftLlmcResultWords.js';
import { SHANNON_AUTONOMY_SYSTEM_DOMAIN } from '@shannon/cognition';

/** What the activity record (「したことの記録」, shown in 自律活動 › 記録) keeps of an operator invocation. */
export interface OperatorActivity { summary: string; tool: string; outcome: 'done' | 'refused'; reasonCode: string; detail: string; domain?: string }

export interface OperatorMinecraftParts {
  scopeKey: string; enabled(): boolean; ownerAlone(): boolean; now(): string;
  audit: OperatorAuditStore;
  lifecycle: OperatorLifecycle | null;
  requests: (OperatorMinecraftRequests & { wake(): void }) | null;
  actions: ActionThreads | null;
  /** The body re-check (`minecraftBodyRecheckWiring.ts`); absent without a configured body. */
  bodyRecheck?: Pick<MinecraftBodyRecheck, 'request'> | null;
  /** What a task has used so far in yen, confirmed and estimated (`TaskBudgetStore`): `minecraft budget` never lowers a cap below it. Absent: no lowering. */
  spentYen?(taskId: string): number;
  lifecycleUnresolved(): boolean;
  activity(at: string, entry: OperatorActivity): void;
  /** A short note in the owner's Talk, written once per id. */
  note(id: string, text: string, at: string): void;
  /** The owner's skill import (`skillImportCommand.ts`) while her skills are on; absent, `skills import` is refused. */
  skillImport?: SkillImportCommandDeps | null;
}

const FINISHED = ['stopped', 'completed', 'failed', 'stopping'];
/** A hold row's detail (`hold` below): the incident, the held act's command and where it began and ended. */
function holdDetail(detail: string | null): { incident?: string; command?: string; start?: Feet | null; end?: Feet | null; mismatch?: string; replay?: HeldAgain; take?: string; notHeld?: string; bodyHold?: string;
  frozen?: boolean | null; box?: string; scene?: string } {
  try {
    const value = JSON.parse(detail ?? '{}') as Record<string, unknown>;
    return { ...(typeof value.incident === 'string' ? { incident: value.incident } : {}), ...(typeof value.command === 'string' ? { command: value.command } : {}),
      start: feet(value.start), end: feet(value.end), ...(typeof value.mismatch === 'string' ? { mismatch: value.mismatch } : {}),
      ...(typeof value.take === 'string' ? { take: value.take } : {}), ...(typeof value.notHeld === 'string' ? { notHeld: value.notHeld } : {}), ...(typeof value.bodyHold === 'string' ? { bodyHold: value.bodyHold } : {}),
      ...(typeof value.frozen === 'boolean' || value.frozen === null ? { frozen: value.frozen as boolean | null } : {}), ...(typeof value.box === 'string' ? { box: value.box } : {}), ...(typeof value.scene === 'string' ? { scene: value.scene } : {}),
      ...(heldAgainOf(value.replay) ? { replay: heldAgainOf(value.replay)! } : {}) };
  } catch { return {}; }
}
/** A hold row's `replay` (the second try of a held act, held again), or null when it does not read. */
function heldAgainOf(value: unknown): HeldAgain | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { code?: unknown; dropped?: unknown };
  if (typeof record.code !== 'string') return null;
  const dropped = (Array.isArray(record.dropped) ? record.dropped : []).flatMap(entry =>
    entry && typeof entry === 'object' && typeof (entry as { item?: unknown }).item === 'string' ? [{ item: (entry as { item: string }).item, why: String((entry as { why?: unknown }).why ?? '') }] : []);
  return { code: record.code, dropped };
}
/**
 * The hold row's detail text (at most 600 characters, still whole JSON): the second try's record loses its dropped items one by one before anything else is cut. Amendment A-12: a hold the
 * head found carries the body's answer to its take as well (its box and scene are long paths); when that does not fit, the head's own box path, then the freeze's words, then the scene
 * and the box go, in that order (the head's box file has all of it).
 */
function holdDetailText(base: Record<string, unknown>, replay: HeldAgain | undefined): string {
  const dropped = [...(replay?.dropped ?? [])], kept = { ...base };
  for (;;) {
    const text = JSON.stringify({ ...kept, ...(replay ? { replay: { code: replay.code.slice(0, 40), dropped } } : {}) });
    if (text.length <= 600) return text;
    if (dropped.length) { dropped.pop(); continue; }
    const droppable = ['record', 'freeze', 'scene', 'box'].find(key => key in kept);
    if (!droppable) return text.slice(0, 600);
    delete kept[droppable];
  }
}
/** What the body said of the hold the head asked for, in the operator's words (the activity record, `held`). */
function takeWords(take: string | undefined, d: { notHeld?: string; bodyHold?: string; frozen?: boolean | null }): string {
  if (take === 'held') return d.frozen === false ? '体も保留したが世界は止まっていない' : '体も同じ id で保留し、世界を止め、黒箱と現場を取った';
  if (take === 'not_held') return `体は世界を止められず保留していない（${(d.notHeld ?? '理由不明').slice(0, 60)}）。黒箱と現場だけ取った。世界は動いている`;
  if (take === 'other_hold') return `体は別の保留 ${d.bodyHold ?? '?'} を持っていて、頭の保留は取っていない。世界はその保留のまま`;
  if (take === 'failed') return '体へ頼めなかった（答えが無かった）。世界は止まっていない';
  return '世界は止めていない（体は保留していない）';
}
/** The reason a hold row names (its detail's `why`), or ''. */
function holdWhy(detail: string | null): string {
  try { return String((JSON.parse(detail ?? '{}') as { why?: unknown }).why ?? ''); } catch { return ''; }
}
/** Phases after which a held request holds nothing any more. */
const FINISHED_FOR_GOOD = ['completed', 'failed'];
const HOUR_MS = 3_600_000;
const STATUS: Partial<Record<OperatorCode, number>> = { out_of_scope: 403, rate_limited: 429, flooded: 429 };
const ago = (at: string, ms: number) => new Date(Date.parse(at) - ms).toISOString();
/** Amendment A-14/A-15: a task the body's recovery paused (its step was lost): stopped, paused, waiting for the owner's resume. */
const isRecoveredPause = (task: { phase: string; status?: string; pauseReason?: string | null }): boolean =>
  task.phase === 'stopped' && task.status === 'paused' && task.pauseReason === 'fca_stopped';

const MESSAGES: Partial<Record<OperatorCode, string>> = {
  disabled: '運用者のマイクラ操作はサーバーで有効になっていません（SHANNON_OPERATOR_MINECRAFT）。',
  owner_not_alone: 'ライ氏以外の人がいる間は始めません。',
  body_unavailable: 'マイクラの体が一つに決まっていないか、接続されていません。',
  minecraft_busy: 'ほかのマイクラの作業がまだ動いています。先に止めるか終わるのを待ってください。',
  lease_conflict: 'マイクラの管理操作がまだ動いています。',
  unresolved_operation: '前のマイクラ管理操作の結果がまだ確認できていません。',
  rate_limited: `1時間に${OPERATOR_LIMITS.requestsPerHour}件までです。`,
  flooded: '呼び出しが多すぎるので、しばらく受け付けません（監査はまとめて残します）。',
  not_found: '運用者が始めた進行中のマイクラの依頼が見つかりません。',
  not_operator_task: 'このタスクは運用者が始めたものではないので止めません（ライ氏の依頼は本人の「止まって」で止めます）。',
  not_running: 'このタスクはもう終わっているか、止めている途中です。',
  lifecycle_unavailable: 'マイクラ管理が設定されていないか、新しい状態が届いていません。',
  released: 'マイクラの体が止まっていて入力も離していることを体に確かめ直し、保持を解放しました。',
  not_retained: '確認待ちで保持されているマイクラの体はありません。',
  not_confirmed: '体が停止と入力の解放を確かめられなかったので、保持したままにしました。',
  proof_refused: '体の答えを解放の証明として受け付けられなかったので、保持したままにしました。',
  recheck_busy: '体の確認をいま実行中です。',
  not_settled: 'ログイン直後で、サーバーの状態（ほかの参加者の数）をまだ確かめられません。少し待ってからもう一度頼んでください。',
  not_held: 'このタスクは保留されていません（再開は、保留された依頼と、体の取り戻しで止まった依頼だけです）。',
};
const BUDGET_NOT_RUNNING = 'このタスクはもう止まっているか、止めている途中です。予算を変えても再開はしません（止まった理由が予算でも同じです。再開はライ氏の操作で、新しく頼むこともできます）。';
const SKILL_IMPORT_MESSAGES ={ 'dry-run': '取り込みの計画です。問題が無ければ plan hash で apply します。',
  apply: 'スキルの取り込みを記録しました。', refused: 'スキルの取り込みを受け付けませんでした（skillImport に理由があります）。' };

/** The operator code of a skill import answer: the importer's own refusals by name, the route's status otherwise. */
function skillImportCode(result: { status: number; body: unknown }): OperatorCode {
  const rejected = (result.body as { rejected?: unknown } | null)?.rejected;
  if (result.status === 200) return 'accepted';
  if (rejected === 'stale_plan' || rejected === 'validation_failed') return rejected;
  return result.status === 404 ? 'not_found' : result.status === 403 ? 'disabled' : 'refused';
}
const RECHECK_UNAVAILABLE = 'マイクラの体が接続されていないので、まだ確かめられません。接続されたらサーバーが自動でも確かめます。';

/**
 * The operator's Minecraft service in the API (owner decision 2026-10-14; `docs/operator-minecraft-contract.md`). Every
 * invocation is audited before anything else (`operator_audit`), refused unless it is one of the Minecraft operations, and
 * otherwise goes through the same gates as the owner's own request: the body connected, nobody else present, no other Minecraft
 * work or lifecycle operation in flight, the request cap. An accepted one is written to the activity record and noted in Talk.
 */
export function createOperatorMinecraft(parts: OperatorMinecraftParts) {
  const stopping = new Set<string>();
  const audit = (draft: Omit<OperatorAuditDraft, 'scopeKey'>) => parts.audit.append({ ...draft, scopeKey: parts.scopeKey });
  const flood = { suppressed: 0, lastRowAt: 0 };
  /**
   * Past `invocationsPerHour` invocations in the last hour, nothing is audited one by one: one coalesced `flooded` row a minute
   * says how many were turned away, and the owner's activity record is not written at all (a runaway process cannot flood it).
   */
  function flooded(at: string, operator: string): { status: number; body: unknown } | null {
    if (parts.audit.invocationsSince(parts.scopeKey, ago(at, HOUR_MS)) < OPERATOR_LIMITS.invocationsPerHour) return null;
    flood.suppressed += 1;
    if (Date.parse(at) - flood.lastRowAt >= OPERATOR_LIMITS.floodRowMs) {
      audit({ operationId: `operator:${randomUUID()}`, at, operator, command: 'unknown', event: 'refused', code: 'flooded', argsJson: '{}',
        detail: `suppressed=${flood.suppressed}` });
      flood.suppressed = 0;
      flood.lastRowAt = Date.parse(at);
    }
    return { status: 429, body: { outcome: 'refused', code: 'flooded', message: MESSAGES.flooded } };
  }
  /** A refusal reaches the activity record only for the first few an hour; one line says the rest are in the audit only. */
  function recordRefusal(at: string, entry: OperatorActivity): void {
    const count = parts.audit.refusalsSince(parts.scopeKey, ago(at, HOUR_MS));
    if (count <= OPERATOR_LIMITS.refusalsRecordedPerHour) parts.activity(at, entry);
    else if (count === OPERATOR_LIMITS.refusalsRecordedPerHour + 1) {
      parts.activity(at, { ...entry, summary: '運用者のマイクラ操作の拒否が続いているので、この1時間の残りは監査記録だけに残します。',
        reasonCode: 'operator_refusals_coalesced' });
    }
  }
  const observed = <T>(operation: string, operationId: string, work: () => T): T => withObserverRunSync({ scopeKey: parts.scopeKey,
    surface: 'operator_cli', audience: parts.ownerAlone() ? 'owner' : 'others' }, () => observeSync('taskHub',
    { operation, via: 'operator_cli', operationId }, work, value => ({ operation, outcome: value === null ? 'none' : 'returned' })));

  async function minecraftActionLive(): Promise<boolean> {
    if (!parts.actions) return false;
    const views = await parts.actions.list(parts.scopeKey);
    return views.some(view => view.kind === 'minecraft' && !ACTION_TERMINAL.includes(view.state));
  }

  function context(value: unknown) {
    const operationId = `operator:${randomUUID()}`, at = parts.now(), parsed = parseOperatorEnvelope(value);
    const operator = parsed.ok ? parsed.operator : operatorLabel((value as { operator?: unknown } | null)?.operator);
    const command = parsed.ok ? parsed.input.command : 'unknown';
    const argsJson = auditedArguments(value);
    const reply = (outcome: OperatorReply['outcome'], code: OperatorCode, message: string, extra: Partial<OperatorReply> = {}) =>
      ({ status: outcome === 'accepted' ? 202 : STATUS[code] ?? 409, body: { operationId, outcome, code, message, ...extra } });
    const refuse = (code: OperatorCode, message = MESSAGES[code] ?? code, extra: Partial<OperatorAuditDraft> = {}) => {
      audit({ operationId, at: parts.now(), operator, command, event: 'refused', code, argsJson, detail: message, ...extra });
      recordRefusal(at, { summary: `運用者（${operator}）のマイクラ操作を受け付けませんでした。`, tool: `operator.minecraft.${command}`,
        outcome: 'refused', reasonCode: code, detail: `operation=${operationId}` });
      return reply('refused', code, message);
    };
    return { operationId, at, parsed, operator, command, argsJson, reply, refuse };
  }
  type Context = ReturnType<typeof context>;

  async function lifecycle(c: Context, input: Extract<OperatorInput, { command: 'lifecycle' }>, serverId: string | null) {
    if (!parts.lifecycle) return c.refuse('lifecycle_unavailable');
    if (!serverId) return c.refuse('invalid_input', '登録されたサーバーIDを指定してください（--server）。');
    const settled = (settlement: LifecycleSettlement) => {
      const code = settlement.receipt?.code ?? (settlement.issued ? 'unknown' : 'not_started');
      // A start that made a new world says which one, and where the old one is kept, in the audit line too (only when the command
      // asked for one); so does one whose world moved while the start could not be confirmed.
      const seen = preparedWorldOfReceipt(settlement.receipt ?? settlement.unconfirmed, settlement.command);
      const world = seen ? `  worldId=${seen.worldId ?? 'none'} movedTo=${seen.movedTo ?? 'none'}${seen.started ? '' : '  start_unconfirmed'}` : '';
      audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'settled', code, argsJson: c.argsJson,
        action: input.action, serverId, lifecycleId: c.operationId,
        detail: settlement.receipt ? `${settlement.receipt.outcome}${world}` : seen ? `unknown${world}` : null });
    };
    const asked = { id: c.operationId, serverId, action: input.action, ...(input.keepWorld ? { keepWorld: true } : {}) };
    const admission = await parts.lifecycle.execute(asked, settled);
    if (!admission.ok) return c.refuse(admission.code, admission.message, { action: input.action, serverId });
    audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'accepted', code: 'accepted',
      argsJson: c.argsJson, action: input.action, serverId, lifecycleId: admission.lifecycleId, actionId: admission.actionId });
    parts.activity(c.at, { summary: `運用者（${c.operator}）がライ氏の代わりにマイクラの ${input.action} を頼みました${input.keepWorld ? '（今のワールドのまま始めるよう指定）' : ''}。`,
      tool: `operator.minecraft.${input.action}`, outcome: 'done', reasonCode: 'operator_cli', detail: `operation=${c.operationId} server=${serverId}` });
    parts.note(`${c.operationId}:lifecycle`, operatorTalkNote('lifecycle', `${input.action}・${serverId}`), c.at);
    return c.reply('accepted', 'accepted', '受け付けました。結果は監査記録に settled として残ります。', { lifecycleId: admission.lifecycleId, actionId: admission.actionId });
  }

  async function request(c: Context, input: Extract<OperatorInput, { command: 'request' }>) {
    const requests = parts.requests;
    if (!requests) return c.refuse('body_unavailable');
    if (!parts.ownerAlone()) return c.refuse('owner_not_alone');
    if (!requests.body()) return c.refuse('body_unavailable');
    if (parts.lifecycleUnresolved()) return c.refuse('unresolved_operation');
    if (await minecraftActionLive()) return c.refuse('lease_conflict');
    // 2026-10-28: a request held on a heavy failure still holds the body and its world (stopped): a new one waits for its resume or cancel.
    if (parts.audit.heldTasks(parts.scopeKey).some(row => row.taskId && !FINISHED_FOR_GOOD.includes(requests.get(row.taskId)?.phase ?? 'completed'))) {
      return c.refuse('minecraft_busy', '保留中の依頼があります。再開（resume）か止める（cancel）までは新しく始めません。');
    }
    const admitted = observed('operator_minecraft_request', c.operationId,
      () => requests.admit({ operationId: c.operationId, goal: input.goal, operator: c.operator }));
    if (!admitted.ok) return c.refuse(admitted.code);
    const deadlineAt = new Date(Date.parse(parts.now()) + input.maxMinutes * 60_000).toISOString();
    try {
      audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'accepted', code: 'accepted',
        argsJson: c.argsJson, taskId: admitted.task.id, deadlineAt, budgetYen: input.budgetYen, detail: admitted.bodyId });
    } catch (error) {
      // Without its audit row the task would not be the operator's (no cap, no time limit, no cancel): it is stopped at once.
      await requests.stop(admitted.task.id, 'operator_audit_failed').catch(() => []);
      throw error;
    }
    parts.activity(c.at, { summary: `運用者（${c.operator}）がライ氏の代わりにマイクラの依頼を始めました。`, tool: 'operator.minecraft.request',
      outcome: 'done', reasonCode: 'operator_cli',
      detail: `operation=${c.operationId} task=${admitted.task.id} minutes=${input.maxMinutes} yen=${input.budgetYen}` });
    parts.note(`${c.operationId}:request`, operatorTalkNote('request', input.goal), c.at);
    requests.wake();
    return c.reply('accepted', 'accepted', '共通タスクとして受け付けました。まだ達成していません。',
      { taskId: admitted.task.id, deadlineAt, budgetYen: input.budgetYen });
  }

  function target(c: Context, requests: OperatorMinecraftRequests, taskId: string | null): { id: string } | { code: OperatorCode } {
    if (taskId) {
      if (parts.audit.requestOf(parts.scopeKey, taskId)) return { id: taskId };
      return { code: requests.get(taskId) ? 'not_operator_task' : 'not_found' };
    }
    const open = parts.audit.requestsSince(parts.scopeKey, ago(c.at, 48 * HOUR_MS))
      .find(row => row.taskId && !FINISHED.includes(requests.get(row.taskId)?.phase ?? 'stopped'));
    return open?.taskId ? { id: open.taskId } : { code: 'not_found' };
  }

  async function cancel(c: Context, input: Extract<OperatorInput, { command: 'cancel' }>) {
    const requests = parts.requests;
    if (!requests) return c.refuse('body_unavailable');
    const found = target(c, requests, input.taskId);
    if ('code' in found) return c.refuse(found.code, undefined, input.taskId ? { taskId: input.taskId } : {});
    const task = requests.get(found.id);
    // 2026-10-28: a held request is stopped already; its cancel ends the hold (audited as stopped). Run 44: a release naming the hold goes to the
    // body first and its receipt says whether the body ended it; a body that did not (gone, another hold) is ended when it comes back (`tick`).
    const held = parts.audit.heldOf(found.id);
    if (held && task) {
      const detail = holdDetail(held.detail);
      const moved = detail.incident ? await (requests.incident?.('cancel', detail.incident, detail.command ?? '', found.id) ?? Promise.resolve({ ok: false, words: 'no_port' }))
        : { ok: false, words: 'no_incident' };
      // Continue contract 1: the held commands of a cancelled task are ended on the hold axis (their result is left as it is).
      requests.resolveHolds?.(found.id, 'cancel');
      audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'stopped', code: 'stopped',
        argsJson: c.argsJson, taskId: found.id, detail: `held ${task.phase} body_hold_ended=${moved.ok} ${moved.words}`.slice(0, 600) });
      parts.activity(c.at, { summary: `運用者（${c.operator}）が、保留していたマイクラの依頼を止めました。`, tool: 'operator.minecraft.cancel',
        outcome: 'done', reasonCode: 'operator_cli', detail: `operation=${c.operationId} task=${found.id} held` });
      return c.reply('accepted', 'stopped', moved.ok ? `保留していた依頼を止めました。体の保留も解け、世界が動きました（${moved.words}）。`
        : `保留していた依頼を止めました。体の保留はまだ解けていません（${moved.words}）。体が戻った時に解きます。`, { taskId: found.id });
    }
    if (!task || FINISHED.includes(task.phase)) return c.refuse('not_running', undefined, { taskId: found.id });
    const stopped = await requests.stop(found.id, 'operator_minecraft_stop');
    const phase = stopped.find(item => item.id === found.id)?.phase ?? requests.get(found.id)?.phase ?? 'unknown';
    audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'stopped', code: 'stopped',
      argsJson: c.argsJson, taskId: found.id, detail: phase });
    parts.activity(c.at, { summary: `運用者（${c.operator}）が、代わりに始めたマイクラの依頼を止めました。`, tool: 'operator.minecraft.cancel',
      outcome: 'done', reasonCode: 'operator_cli', detail: `operation=${c.operationId} task=${found.id} phase=${phase}` });
    parts.note(`${c.operationId}:cancel`, operatorTalkNote('cancel', task.goal), c.at);
    return c.reply('accepted', 'stopped', '停止要求を受け付けました。身体操作の停止確認後に停止済みになります。', { taskId: found.id });
  }

  /**
   * `minecraft budget`: the cap of a running request the operator started, changed to another yen amount (up to the request cap, down to
   * what the task has used). It is a new `budget` row of the audit (who, when, which task, from what to what) and never a write over the
   * request's row; the budget check reads it through `OperatorAuditStore.budgetYen`, so it holds from the task's next decision on. A task
   * that has stopped (for its cap, its estimates, or a cancel) is not resumed by this, so a change to it is refused.
   */
  async function budget(c: Context, input: Extract<OperatorInput, { command: 'budget' }>) {
    const requests = parts.requests;
    if (!requests) return c.refuse('body_unavailable');
    const found = target(c, requests, input.taskId);
    if ('code' in found) return c.refuse(found.code, undefined, input.taskId ? { taskId: input.taskId } : {});
    const task = requests.get(found.id);
    if (!task || FINISHED.includes(task.phase)) return c.refuse('not_running', BUDGET_NOT_RUNNING, { taskId: found.id });
    const from = parts.audit.budgetYen(found.id) ?? OPERATOR_LIMITS.maxBudgetYen, spent = parts.spentYen?.(found.id) ?? null;
    if (input.budgetYen < from && (spent === null || input.budgetYen < spent)) {
      const reason = spent === null ? '使った額を確かめられないので、下げることはできません。' : `もう${spent}円使っているので、それより低くはできません。`;
      return c.refuse('budget_below_spent', reason, { taskId: found.id, budgetYen: input.budgetYen });
    }
    audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'accepted', code: 'accepted',
      argsJson: c.argsJson, taskId: found.id, budgetYen: input.budgetYen, detail: `from=${from} to=${input.budgetYen} spent=${spent ?? 'unknown'}` });
    parts.activity(c.at, { summary: `運用者（${c.operator}）が、代わりに始めたマイクラの依頼の予算の上限を${from}円から${input.budgetYen}円に変えました。`,
      tool: 'operator.minecraft.budget', outcome: 'done', reasonCode: 'operator_cli',
      detail: `operation=${c.operationId} task=${found.id} yen=${from}->${input.budgetYen}` });
    parts.note(`${c.operationId}:budget`, operatorTalkNote('budget', task.goal), c.at);
    return c.reply('accepted', 'accepted', `予算の上限を${from}円から${input.budgetYen}円にしました。走っているタスクの次の判断から効きます。`,
      { taskId: found.id, budgetYen: input.budgetYen });
  }

  /**
   * Amendment A-14: a task the body's recovery paused (`fca_stopped`: its step was lost to a restart or a stale gap) is resumed by the operator as a held one is, without a hold row.
   * The body is told to move the world (a release naming `recovered:<task>`: a body that holds nothing unfreezes and answers `done`), then the runtime's resume queues the task again; the
   * recovery pays what the task is owed before its first step (the notice of the lost step: its operations may or may not have taken effect, read the observation).
   */
  async function resumeRecovered(c: Context, taskId: string, deductMinutes: number, reopened = '') {
    const requests = parts.requests!;
    // A request the time limit stopped goes on only when its limit, with the time the body could not move taken off (the pauses of the recovery written by the tick, and the minutes the
    // operator names), is not reached now.
    if (parts.audit.hasEvent(taskId, 'time_limit')) {
      const request = parts.audit.requestOf(parts.scopeKey, taskId);
      const now = parts.now();
      const deadline = request?.deadlineAt ? Date.parse(request.deadlineAt) + parts.audit.heldMs(taskId, now) + deductMinutes * 60_000 : NaN;
      if (!(Date.parse(now) < deadline)) {
        return c.refuse('refused', `時間の上限を過ぎています（止まっていた時間を引いても）。体が動けなかった時間が分かるなら --deduct-minutes <分> で引いて、もう一度 resume してください。`, { taskId });
      }
    }
    const unheld = await (requests.incident?.('resume', `recovered:${taskId.slice(0, 12)}`, '', taskId) ?? Promise.resolve({ ok: false, words: 'no_port' }));
    if (!unheld.ok) {
      audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'refused', code: 'not_held', argsJson: c.argsJson,
        taskId, detail: `recovered body_unreleased ${unheld.words}`.slice(0, 600) });
      return c.refuse('refused', `体の世界を動かせなかったので、再開しませんでした（${unheld.words}）。体がつながっているか確かめて、もう一度 resume してください。`, { taskId });
    }
    audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'accepted', code: 'accepted', argsJson: c.argsJson,
      taskId, detail: `recovered=fca_stopped${reopened ? ` reopened=${reopened}` : ''}${deductMinutes ? ` deduct=${deductMinutes * 60_000}` : ''} body=${unheld.words}`.slice(0, 600) });
    // Amendment A-15 1: there is no held act to send again (the hold the earlier resume closed stays closed): the resume's check is written at once, so that no step reads an older hold as pending.
    audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'settled', code: 'skipped', argsJson: c.argsJson,
      taskId, detail: '取り戻しで止まっていたタスクの再開: 出し直す act は無い' });
    // Amendment A-15 2: what the lost step leaves is told to the first decision in its live (once, with the results it reads), beside the notice the recovery stores in the inbox.
    const lost = requests.lostActWords?.(taskId);
    skipNotes.set(taskId, `体が動けなかった間に失われた操作${lost ? `（${lost}）` : ''}の結果は分からない。観測で確かめる`);
    const resumed = requests.resume(taskId);
    if (!resumed) {
      skipNotes.delete(taskId);
      audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'settled', code: 'refused', argsJson: c.argsJson,
        taskId, detail: 'runtime_resume_refused' });
      return c.refuse('refused', 'タスクを再開できませんでした（実行時の再開が断られた）。体の世界は動いています。もう一度 resume してください。', { taskId });
    }
    requests.resolveHolds?.(taskId, 'resume');
    afterResume.set(taskId, Date.parse(parts.now()));
    parts.activity(c.at, { summary: `運用者（${c.operator}）が、体の取り戻しで止まっていたマイクラの依頼を再開しました。`, tool: 'operator.minecraft.resume',
      outcome: 'done', reasonCode: 'operator_cli', detail: `operation=${c.operationId} task=${taskId} recovered=fca_stopped` });
    requests.wake();
    return c.reply('accepted', 'resumed', '再開しました。止まっていた間に失われた操作の知らせ（結果は分からない。観測で確かめる）を先に届けてから、計画の続きから判断します。', { taskId });
  }

  /**
   * `minecraft resume` (2026-10-28, the fix run): a request held on a heavy failure is queued again (the runtime's resume). Its first step sends the
   * act that failed again, with the same arguments and the hold's id (the body moves the world again and runs it), writes what it did (`resume`
   * `settled`), and then the decisions go on from the plan. The held time is not counted against the request's time limit.
   */
  async function resume(c: Context, input: Extract<OperatorInput, { command: 'resume' }>) {
    const requests = parts.requests;
    if (!requests) return c.refuse('body_unavailable');
    // Amendment A-14: a task the body's recovery paused (its step was lost: a restart, a stale gap; `fca_stopped`, resumable, waiting for the owner) has no hold row, and is resumed the
    // same way: `--latest` is the newer of the open hold and such a task, and an id names either.
    // A request the time limit stopped is one too when the time the body could not move, taken off, leaves it inside its limit (A-15).
    const recovered = (id: string): boolean => {
      const task = requests.get(id);
      return !!task && (isRecoveredPause(task) || (task.phase === 'stopped' && parts.audit.hasEvent(id, 'time_limit')));
    };
    const found = input.taskId ? { id: input.taskId } : (() => {
      const held = parts.audit.heldTasks(parts.scopeKey)[0];
      const lost = parts.audit.requestsSince(parts.scopeKey, ago(c.at, 48 * HOUR_MS)).flatMap(row => row.taskId && recovered(row.taskId) ? [row.taskId] : [])
        .map(id => ({ id, at: Date.parse(requests.get(id)!.updatedAt) })).sort((left, right) => right.at - left.at)[0];
      if (held?.taskId && (!lost || Date.parse(held.at) >= lost.at)) return { id: held.taskId };
      return lost ? { id: lost.id } : null;
    })();
    if (!found) return c.refuse('not_held');
    if (!parts.audit.requestOf(parts.scopeKey, found.id)) return c.refuse(requests.get(found.id) ? 'not_operator_task' : 'not_found', undefined, { taskId: found.id });
    const hold = parts.audit.heldOf(found.id);
    // A-20 (run 47: the credit ran out, a refused decision failed the request with the world running): a request named by its id, failed by its own step's refused decision, is stopped
    // again (the state machine's `reopen`) and resumed as a request the recovery paused. Any other failed task stays failed.
    if (!hold && input.taskId && requests.get(found.id)?.phase === 'failed') {
      if (requests.reopenRejected?.(found.id, BILLING_PAUSED_SUMMARY) == null) return c.refuse('not_held', '失敗した依頼ですが、判断が断られて止まった物ではないので戻せません。', { taskId: found.id });
      return resumeRecovered(c, found.id, input.deductMinutes ?? 0, 'rejected_step');
    }
    if (!hold && !recovered(found.id)) return c.refuse('not_held', undefined, { taskId: found.id });
    if (!hold) return resumeRecovered(c, found.id, input.deductMinutes ?? 0);
    // A-17 (run 46): the unknown exit failed a request whose hold stood open (the hold is the owner's to resume, the exit did not see it). Only a task that exit failed (its events say so)
    // is stopped again; any other failed task stays failed and is refused below.
    let reopened = false;
    if (requests.get(found.id)?.phase === 'failed') reopened = requests.reopenRetired?.(found.id, HELD_SUMMARY) != null;
    const task = requests.get(found.id);
    if (!task || task.phase !== 'stopped') return c.refuse('not_running', '保留した依頼がまだ止まりきっていないか、もう終わっています。', { taskId: found.id });
    // Run 44, resume 1: the body ends its hold first (a release naming it: the hold ends and the world moves), and the task is resumed only when
    // the body says so. Once a body restarted in between kept refusing every act (its hold was to end with the act sent again, and that act never
    // reached it): the head ran, the body held, and decisions were paid for nothing. Neither goes on without the other.
    const detail = holdDetail(hold.detail);
    let unheld = detail.incident ? await (requests.incident?.('resume', detail.incident, detail.command ?? '', found.id) ?? Promise.resolve({ ok: false, words: 'no_port' }))
      : { ok: false, words: 'no_incident' };
    // Amendment A-12: a hold the head found itself is not the body's, and a body that holds nothing answers `done` to a release naming it. One that holds another hold of this task
    // (it died or failed on its own meanwhile) says so and keeps it: that hold is ended too, so that neither side goes on without the other.
    if (!unheld.ok && headIncidentKind(detail.incident)) {
      const other = requests.bodyHold?.();
      if (other && other.task === found.id && other.id !== detail.incident) unheld = await (requests.incident?.('resume', other.id, '', found.id) ?? Promise.resolve(unheld));
    }
    if (!unheld.ok) {
      audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'refused', code: 'not_held', argsJson: c.argsJson,
        taskId: found.id, detail: `body_hold_kept ${unheld.words}`.slice(0, 600) });
      return c.refuse('refused', `体の保留を解けなかったので、再開しませんでした（${unheld.words}）。頭も体も保留のままです。体がつながっているか確かめて、もう一度 resume してください。`,
        { taskId: found.id });
    }
    audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'accepted', code: 'accepted', argsJson: c.argsJson,
      taskId: found.id, detail: `hold=${hold.sequence} body=${unheld.words}${reopened ? ' reopened=retire_unknown' : ''}`.slice(0, 600) });
    // Run 45 (holds 3 to 5: the same go sent again stopped the same way, three times): with --skip-replay the held act is not sent again; its result
    // goes to the next decision as a fact (set before the task is queued again: its step reads it when made), and the resume's check is written now.
    const skipLine = input.skipReplay ? requests.heldActWords?.(detail.command ?? '', holdWhy(hold.detail)) ?? '保留した act は出し直さなかった' : null;
    if (skipLine) skipNotes.set(found.id, skipLine);
    // Chapter 8's 再開 9 → 保留 10: the hold being resumed was a held act's second try, held again: the first decision after this resume reads that first.
    const againLine = detail.replay ? heldAgainWords({ replayCode: detail.replay.code, dropped: detail.replay.dropped }) : null;
    if (againLine) againNotes.set(found.id, againLine);
    const resumed = requests.resume(found.id);
    if (!resumed) { skipNotes.delete(found.id); againNotes.delete(found.id); }
    // Continue contract 1: the commands a cleanup left held (their result unknown, the release not proved) move on the hold axis only; nothing is sent again.
    else requests.resolveHolds?.(found.id, 'resume');
    if (resumed && skipLine) {
      const line = skipLine;
      audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'settled', code: 'skipped', argsJson: c.argsJson,
        taskId: found.id, detail: `出し直さなかった（--skip-replay）: ${line}`.slice(0, 600) });
    }
    if (!resumed) {
      audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'settled', code: 'refused', argsJson: c.argsJson,
        taskId: found.id, detail: 'runtime_resume_refused' });
      return c.refuse('refused', 'タスクを再開できませんでした（実行時の再開が断られた）。体の保留は解け、世界は動いています。cancel するか、もう一度 resume してください。', { taskId: found.id });
    }
    afterResume.set(found.id, Date.parse(parts.now()));
    parts.activity(c.at, { summary: `運用者（${c.operator}）が、保留していたマイクラの依頼を再開しました。`, tool: 'operator.minecraft.resume',
      outcome: 'done', reasonCode: 'operator_cli', detail: `operation=${c.operationId} task=${found.id}` });
    requests.wake();
    // 2026-10-28: how far the body is from where the held act began (the act is sent again from here; the body never goes back by itself).
    const position = driftWords(detail.start, requests.position?.() ?? null, detail.end);
    return c.reply('accepted', 'resumed', input.skipReplay ? `再開しました。保留した act は出し直さず、次の判断にその結果を伝えて、計画の続きから判断します。${position}`
      : `再開しました。まず保留した act を同じ引数で出し直し、その後に計画の続きから判断します。${position}`, { taskId: found.id, position });
  }

  /**
   * A heavy failure of a request that asked to be held (2026-10-28; `minecraftIncidentHold.ts` calls it when the body's receipt says so): the hold
   * is audited (why, the incident's id: its box and scene have it, whether the world stopped, the act's command id) and the task is stopped through the
   * owner's stop path (the plan, the pack and the task stay; no decision, no model). False when the task is not the operator's or asked for no hold.
   */
  async function hold(taskId: string, incident: { id: string; why: string; frozen: boolean | null; freeze?: string; command: string; start?: Feet | null; end?: Feet | null;
    replay?: HeldAgain; record?: string; take?: string; box?: string | null; scene?: string | null; notHeld?: string; bodyHold?: string; again?: boolean }): Promise<boolean> {
    const requests = parts.requests;
    const request = parts.audit.requestOf(parts.scopeKey, taskId);
    if (!requests || !request || !parts.audit.holdOnFailure(taskId) || parts.audit.heldOf(taskId)) return false;
    const detail = holdDetailText({ incident: incident.id, why: incident.why.slice(0, 160), frozen: incident.frozen, ...(incident.freeze ? { freeze: incident.freeze.slice(0, 80) } : {}),
      command: incident.command, ...(incident.take ? { take: incident.take } : {}), ...(incident.notHeld ? { notHeld: incident.notHeld.slice(0, 80) } : {}),
      ...(incident.bodyHold ? { bodyHold: incident.bodyHold.slice(0, 150) } : {}), ...(incident.again ? { again: true } : {}),
      ...(incident.box ? { box: incident.box.slice(0, 200) } : {}), ...(incident.scene ? { scene: incident.scene.slice(0, 200) } : {}),
      ...(incident.record ? { record: incident.record.slice(0, 120) } : {}),
      ...(incident.start ? { start: incident.start } : {}), ...(incident.end ? { end: incident.end } : {}) }, incident.replay);
    audit({ operationId: request.operationId, at: parts.now(), operator: request.operator, command: 'hold', event: 'settled', code: 'held', argsJson: request.argsJson,
      taskId, detail });
    // Amendment A-12: a stall the head found itself says what it found and that the world was not stopped (the body holds nothing for it); the reason is in the audit's detail too.
    const kind = headIncidentKind(incident.id);
    parts.activity(parts.now(), kind
      ? { summary: `運用者が代わりに始めたマイクラの依頼を、頭が見つけた詰まり（${HEAD_INCIDENT_WORDS[kind] ?? kind}）で保留しました（${takeWords(incident.take, { frozen: incident.frozen, ...(incident.notHeld ? { notHeld: incident.notHeld } : {}), ...(incident.bodyHold ? { bodyHold: incident.bodyHold } : {}) })}。理由と判断の記録の直近の行は頭の黒箱にあります）。`,
        tool: 'operator.minecraft.hold', outcome: 'done', reasonCode: 'operator_hold_head',
        detail: `task=${taskId} incident=${incident.id} take=${incident.take ?? '-'} why=${incident.why.slice(0, 120)}${incident.box ? ` box=${incident.box}` : ''}${incident.scene ? ` scene=${incident.scene}` : ''}${incident.record ? ` record=${incident.record}` : ''}` }
      : { summary: '運用者が代わりに始めたマイクラの依頼を、重い失敗で保留しました（世界を止め、記録を取りました）。', tool: 'operator.minecraft.hold',
        outcome: 'done', reasonCode: 'operator_hold', detail: `task=${taskId} incident=${incident.id}` });
    await requests.stop(taskId, 'operator_hold').catch(() => []);
    return true;
  }
  /**
   * A heavy failure of a request that asked to be held, not held because the body could not stop the world (run 44, the coordinator's choice of
   * 2026-10-28: someone else on the server; holding in a moving world left the body standing at night with no act, and it died). Its box and
   * scene were taken; the request goes on. Written as `hold_skipped` (not a hold: nothing waits for a resume).
   */
  function notHeld(taskId: string, incident: { id: string; why: string; notHeld?: string; command: string; start?: Feet | null; end?: Feet | null }): void {
    const request = parts.audit.requestOf(parts.scopeKey, taskId);
    if (!request || !parts.audit.holdOnFailure(taskId)) return;
    const detail = JSON.stringify({ incident: incident.id, why: incident.why.slice(0, 160), freeze: String(incident.notHeld ?? '').slice(0, 80), command: incident.command,
      ...(incident.start ? { start: incident.start } : {}), ...(incident.end ? { end: incident.end } : {}) });
    audit({ operationId: request.operationId, at: parts.now(), operator: request.operator, command: 'hold_skipped', event: 'settled', code: 'not_held', argsJson: request.argsJson,
      taskId, detail: detail.slice(0, 600) });
    parts.activity(parts.now(), { summary: '運用者が代わりに始めたマイクラの依頼で重い失敗がありましたが、世界を止められないため保留せずに続けました（記録は取りました）。',
      tool: 'operator.minecraft.hold', outcome: 'done', reasonCode: 'operator_hold_skipped', detail: `task=${taskId} incident=${incident.id} freeze=${String(incident.notHeld ?? '').slice(0, 60)}` });
  }
  /**
   * Run 44, resume 1: the body refused an act as held (or says in its frame it holds a hold of a running task) while the head had no hold: the
   * head goes back to held (a hold row naming the body's hold, `mismatch`, and the owner's stop path), so that no decision is paid for while the
   * body refuses every act, and the operator sees it in `status` and resumes or cancels it as any hold. False when there is nothing to do.
   */
  async function bodyHeld(taskId: string, body: { incident: string; why: string; seen: 'refused' | 'frame' }): Promise<boolean> {
    const requests = parts.requests;
    const request = parts.audit.requestOf(parts.scopeKey, taskId);
    if (!requests || !request || parts.audit.heldOf(taskId)) return false;
    const before = holdDetail(parts.audit.lastHoldOf(taskId)?.detail ?? null);
    const same = before.incident === body.incident;
    // Run 45 (+929): the body holds on its own for a death or near death outside an act: not a disagreement, the head follows it.
    const outside = /^(?:death|near_death)/u.test(body.why);
    // Run 47 (resume 9: the head went back to held and the world moved on for four and a half minutes): the body is asked to hold as well, so that the world stops. What it answers is in the row.
    const taken = await (requests.take?.(taskId, body.incident, `頭が保留に戻した（${body.seen}）: ${body.why}`.slice(0, 280)) ?? Promise.resolve(null)).catch(() => null);
    const detail = JSON.stringify({ incident: body.incident, why: body.why.slice(0, 160), frozen: taken ? taken.frozen : null, ...(taken ? { take: takeEnd(taken), ...(taken.freeze ? { freeze: taken.freeze.slice(0, 80) } : {}) } : {}), command: same ? before.command ?? '' : '',
      ...(same && before.start ? { start: before.start } : {}), ...(same && before.end ? { end: before.end } : {}),
      mismatch: outside ? `outside_act:${body.seen}` : `body_held:${body.seen}` });
    audit({ operationId: request.operationId, at: parts.now(), operator: request.operator, command: 'hold', event: 'settled', code: 'held', argsJson: request.argsJson,
      taskId, detail: detail.slice(0, 600) });
    parts.activity(parts.now(), { summary: outside ? `体が act の外の${body.why.startsWith('death') ? '死亡' : '瀕死'}で保留したので、運用者が代わりに始めたマイクラの依頼も保留しました。判断は止めています。`
      : '体がまだ保留していたので（頭との食い違い）、運用者が代わりに始めたマイクラの依頼を保留に戻しました。判断は止めています。',
      tool: 'operator.minecraft.hold', outcome: 'done', reasonCode: outside ? 'operator_hold' : 'operator_hold_mismatch', detail: `task=${taskId} incident=${body.incident} seen=${body.seen}` });
    await requests.stop(taskId, 'operator_hold').catch(() => []);
    return true;
  }
  /** Run 45: the lines a resume with --skip-replay left for each task's next decision (taken once). */
  const skipNotes = new Map<string, string>();
  /** Chapter 8: the lines a resume left for each task's first decision when the hold it resumed was a held act's second try, held again (taken once). */
  const againNotes = new Map<string, string>();
  const heldMs = (taskId: string): number => { try { return parts.audit.heldMs(taskId, parts.now()); } catch { return 0; } };
  function heldAgainNote(taskId: string): string | null {
    const line = againNotes.get(taskId) ?? null;
    againNotes.delete(taskId);
    return line;
  }
  function skipNote(taskId: string): string | null {
    const line = skipNotes.get(taskId) ?? null;
    skipNotes.delete(taskId);
    return line;
  }
  /**
   * Run 45 (holds 3 to 5): the act a resume sent again failed for the reason it was held for, and the body did not hold again. The operator fixed
   * what was thought the cause and it did not help: that is written down, and the decisions go on with the result.
   */
  function repeated(taskId: string, incident: { id: string; why: string; command: string; repeated?: string }): void {
    const request = parts.audit.requestOf(parts.scopeKey, taskId);
    if (request) {
      audit({ operationId: request.operationId, at: parts.now(), operator: request.operator, command: 'resume', event: 'settled', code: 'replay_failed_same',
        argsJson: request.argsJson, taskId, detail: `出し直しは同じ理由で失敗、保留せず判断へ（${incident.why.slice(0, 80)}、incident ${incident.id}、出し直した保留 ${incident.repeated ?? '-'}、act ${incident.command}）`.slice(0, 600) });
    }
    parts.activity(parts.now(), { summary: '保留から出し直した act が同じ理由で失敗したので、もう一度は保留せずに判断を続けました。', tool: 'operator.minecraft.resume',
      outcome: 'done', reasonCode: 'operator_replay_failed_same', detail: `task=${taskId} incident=${incident.id}` });
  }
  /** After a resume: the act that failed, sent again, and what it did (written once). */
  function resumeChecked(taskId: string, line: string): void {
    const request = parts.audit.requestOf(parts.scopeKey, taskId);
    if (!request) return;
    audit({ operationId: request.operationId, at: parts.now(), operator: request.operator, command: 'resume', event: 'settled', code: 'replayed', argsJson: request.argsJson,
      taskId, detail: line.slice(0, 600) });
  }

  /** Amendment A-12: how a hold the head found stands against the body's own (its frame): the body's answer to the take, and a disagreement only when it keeps a hold the head's take did not make. */
  function headAgree(detail: ReturnType<typeof holdDetail>, body: { id: string; task: string } | null): string {
    const words = takeWords(detail.take, { ...(detail.frozen !== undefined ? { frozen: detail.frozen } : {}), ...(detail.notHeld ? { notHeld: detail.notHeld } : {}), ...(detail.bodyHold ? { bodyHold: detail.bodyHold } : {}) });
    if (!body) return `頭が見つけた詰まりの保留（${words}）`;
    if (body.id === detail.incident) return `頭が見つけた詰まりの保留。体も同じ保留（${words}）`;
    if (body.id === detail.bodyHold) return `頭が見つけた詰まりの保留。体は別の保留 ${body.id} を持つ（頭の take は取られていない。resume で両方解く）`;
    return `食い違い: 頭が見つけた保留の他に、体の保留 ${body.id}（task ${body.task}）がある`;
  }
  /** `held` (read only, the CLI's status): the held requests, each with where the body is now against where the held act began. */
  function heldNow(c: Context) {
    const now = parts.requests?.position?.() ?? null;
    const body = parts.requests?.bodyHold?.() ?? null;
    const held = parts.audit.heldTasks(parts.scopeKey).filter(row => row.taskId).map(row => {
      const detail = holdDetail(row.detail);
      // Run 44: the body's own hold beside the head's, so that a disagreement shows.
      // Amendment A-12: a stall the head found is the head's alone (the body holds nothing for it); only a body hold beside it is a disagreement.
      const agree = headIncidentKind(detail.incident) ? headAgree(detail, body)
        : !body ? '体は保留していない（食い違い: 頭だけ保留）' : body.id === detail.incident ? '体も同じ保留' : `食い違い: 体の保留は ${body.id}（task ${body.task}）`;
      return { taskId: row.taskId!, detail: row.detail ?? '', position: driftWords(detail.start, now, detail.end),
        body: `${agree}${detail.mismatch?.startsWith('outside_act') ? '。体が act の外（死亡・瀕死）で保留し、頭も保留した' : detail.mismatch ? '。体が act を断ったので頭が保留に戻した' : ''}` };
    });
    const loose = body && !held.some(entry => holdDetail(entry.detail).incident === body.id)
      ? `食い違い: 体は保留 ${body.id}（task ${body.task}、${body.why}）を持つが、頭には開いた保留が無い` : null;
    audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'settled', code: 'held', argsJson: c.argsJson,
      detail: `held=${held.length}${loose ? ' body_only' : ''}` });
    return c.reply('accepted', 'held', `保留中の依頼 ${held.length} 件${loose ? `。${loose}` : ''}`, { held, ...(loose ? { bodyOnly: loose } : {}) });
  }

  /** `minecraft release`: the body is asked again whether it is stopped with every input released (a request, never a force). */
  async function release(c: Context) {
    if (!parts.bodyRecheck) return c.refuse('body_unavailable');
    audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'accepted', code: 'accepted',
      argsJson: c.argsJson });
    const result = await parts.bodyRecheck.request('operator');
    audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'settled', code: result.code, argsJson: c.argsJson,
      ...(result.actionIds[0] ? { actionId: result.actionIds[0] } : {}), detail: result.detail.slice(0, 200) });
    parts.activity(c.at, { summary: `運用者（${c.operator}）の依頼で、マイクラの体が止まっているかを確かめ直しました。`, tool: 'operator.minecraft.release',
      outcome: result.code === 'released' ? 'done' : 'refused', reasonCode: result.code,
      detail: `operation=${c.operationId} actions=${result.actionIds.join(',')}` });
    const message = result.code === 'body_unavailable' ? RECHECK_UNAVAILABLE : MESSAGES[result.code] ?? result.code;
    return c.reply(result.code === 'released' ? 'accepted' : 'refused', result.code, message, result.actionIds[0] ? { actionId: result.actionIds[0] } : {});
  }

  /**
   * `skills import`: exactly the paired route's import (`runSkillImport`). The audit names the operator; an applied pack is written to
   * the activity record as adopted through the operator with its approval reference, and its receipt keeps that reference.
   */
  function skillImport(c: Context, input: Extract<OperatorInput, { command: 'skill_import' }>) {
    if (!parts.skillImport) return c.refuse('disabled', 'シャノンのスキルがこのサーバーで有効になっていないので、取り込めません。');
    const result = runSkillImport(parts.skillImport, parts.scopeKey, input.phase, { packId: input.packId, revision: input.revision,
      ...(input.phase === 'apply' ? { planHash: input.planHash, approvalReference: input.approvalReference } : {}) });
    const body = (result.body ?? {}) as { planHash?: unknown; receipt?: { receiptId?: unknown } };
    const code = skillImportCode(result);
    const detail = `${input.packId}/${input.revision} ${input.phase} plan=${String(body.planHash ?? '')} receipt=${String(body.receipt?.receiptId ?? '')}`;
    audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: code === 'accepted' ? 'accepted' : 'refused', code,
      argsJson: c.argsJson, detail: detail.slice(0, 200) });
    if (result.applied) {
      const summary = `運用者（${c.operator}）経由で、運用作成のスキル（${input.packId}/${input.revision}）を取り込みました。`
        + `承認: ${input.approvalReference}。利用と成功の実績はまだありません。`;
      parts.activity(result.at, { summary, tool: 'operator.skills.import', outcome: 'done', reasonCode: 'skills_import', detail: result.applied.receiptId,
        domain: SHANNON_AUTONOMY_SYSTEM_DOMAIN.id });
    }
    return c.reply(code === 'accepted' ? 'accepted' : 'refused', code, SKILL_IMPORT_MESSAGES[code === 'accepted' ? input.phase : 'refused'],
      { skillImport: result.body });
  }

  async function handle(value: unknown): Promise<{ status: number; body: unknown }> {
    const turnedAway = flooded(parts.now(), operatorLabel((value as { operator?: unknown } | null)?.operator));
    if (turnedAway) return turnedAway;
    const c = context(value);
    const input = c.parsed.ok ? c.parsed.input : null;
    const serverId = input?.command === 'lifecycle' ? parts.lifecycle?.server(input.serverId) ?? input.serverId : null;
    audit({ operationId: c.operationId, at: c.at, operator: c.operator, command: c.command, event: 'invoked', code: 'invoked', argsJson: c.argsJson,
      ...(input?.command === 'lifecycle' ? { action: input.action, serverId } : {}) });
    if (!c.parsed.ok) return c.refuse(c.parsed.code, c.parsed.message);
    if (!parts.enabled()) return c.refuse('disabled');
    if (parts.audit.acceptedSince(parts.scopeKey, new Date(Date.parse(c.at) - 3600_000).toISOString()) >= OPERATOR_LIMITS.requestsPerHour) {
      return c.refuse('rate_limited');
    }
    const parsed = c.parsed.input;
    if (parsed.command === 'lifecycle') return lifecycle(c, parsed, serverId);
    if (parsed.command === 'request') return request(c, parsed);
    if (parsed.command === 'budget') return budget(c, parsed);
    if (parsed.command === 'release') return release(c);
    if (parsed.command === 'skill_import') return skillImport(c, parsed);
    if (parsed.command === 'resume') return resume(c, parsed);
    if (parsed.command === 'held') return heldNow(c);
    return cancel(c, parsed);
  }

  /** A refusal at the socket itself (unknown path, a forwarded request, an unreadable body): audited without its content. */
  function socketRefused(reason: OperatorSocketRefusal): void {
    const at = parts.now();
    if (flooded(at, 'unknown')) return;
    audit({ operationId: `operator:${randomUUID()}`, at, operator: 'unknown', command: 'socket', event: 'refused', code: `socket_${reason}`,
      argsJson: '{}' });
  }

  /** The first time a request is stopped at its limit: audited, recorded and noted once, however often the stop is asked again. */
  function timeLimitReached(row: OperatorAuditRow, task: TaskView, phase: string | null, now: string): void {
    if (parts.audit.hasEvent(task.id, 'time_limit')) return;
    audit({ operationId: row.operationId, at: parts.now(), operator: row.operator, command: 'request', event: 'time_limit', code: 'time_limit',
      argsJson: row.argsJson, taskId: task.id, deadlineAt: row.deadlineAt, detail: phase });
    parts.activity(now, { summary: '運用者が代わりに始めたマイクラの依頼を、決められた時間に達したので止めました。', tool: 'operator.minecraft.time_limit',
      outcome: 'done', reasonCode: 'operator_time_limit', detail: `operation=${row.operationId} task=${task.id}` });
    parts.note(`${row.operationId}:time_limit`, operatorTalkNote('time_limit', task.goal), now);
  }

  /**
   * The operator's time limit: a request past its deadline is stopped by the same stop path. It is enforced until the task's
   * phase is terminal, not until a stop was audited (a cancel's stop may not have taken), and stopping it again is not noted again.
   * It holds with the switch off too, so turning the switch off never leaves an operator's request without its limit.
   */
  function tick(): void {
    if (!parts.requests) return;
    const requests = parts.requests, now = parts.now();
    reconcile(requests, now);
    for (const row of parts.audit.requestsSince(parts.scopeKey, ago(now, 48 * HOUR_MS))) {
      const task = row.taskId ? requests.get(row.taskId) : null;
      // Amendment A-15: a pause the body's recovery made is a time the body could not move: written once (at the time the task was paused), and not counted like a hold.
      if (task && isRecoveredPause(task) && !parts.audit.pausedOpen(task.id)) {
        audit({ operationId: `${row.operationId}:paused:${task.revision}`, at: task.updatedAt, operator: row.operator, command: 'paused', event: 'settled', code: 'paused',
          argsJson: row.argsJson, taskId: task.id, detail: `recovered=fca_stopped revision=${task.revision}` });
      }
      // 2026-10-28: the time a request was held does not count: its deadline moves by it.
      const deadline = row.deadlineAt && task ? Date.parse(row.deadlineAt) + parts.audit.heldMs(task.id, now) : NaN;
      if (!task || !row.deadlineAt || Date.parse(now) < deadline || FINISHED.includes(task.phase) || stopping.has(task.id)) continue;
      stopping.add(task.id);
      void requests.stop(task.id, 'operator_time_limit')
        .then(stopped => timeLimitReached(row, task, stopped.find(item => item.id === task.id)?.phase ?? null, now))
        .catch(() => {}).finally(() => { stopping.delete(task.id); });
    }
  }

  /**
   * Run 44: the body's hold (its frame) against the head's. A hold of a task that is running and not held here is taken back as held
   * (`bodyHeld`); a hold of a task that is gone (finished, failed, unknown here) is ended: a release naming it, with the task's last lease
   * (a body restarted with the file of a task that ended). At most once a minute for the same hold; what was done is in the audit.
   */
  const reconciled = new Map<string, number>();
  /** When each task was resumed (ms): the frame the body's hold is judged on must be one after the body had its release (see `reconcile`). Cleared when a frame shows no hold. */
  const afterResume = new Map<string, number>();
  const RESUME_FRAME_WAIT_MS = 20_000;
  function reconcile(requests: NonNullable<OperatorMinecraftParts['requests']>, now: string): void {
    const body = requests.bodyHold?.();
    // Run 47 (resume 9): after a resume the first frame may still show the hold the resume is ending (the body had not read the release yet): the head waits for a frame that has lost it
    // (`incidentHold` gone) before it judges a disagreement, at most `RESUME_FRAME_WAIT_MS`. A body that still holds after that is a real disagreement.
    if (!body) {
      afterResume.clear();
      return;
    }
    const resumedAt = afterResume.get(body.task);
    if (resumedAt !== undefined && Date.parse(now) - resumedAt < RESUME_FRAME_WAIT_MS) return;
    if (parts.audit.heldOf(body.task)) return;
    if (Date.parse(now) - (reconciled.get(body.id) ?? 0) < 60_000) return;
    reconciled.set(body.id, Date.parse(now));
    const task = requests.get(body.task);
    const request = parts.audit.requestOf(parts.scopeKey, body.task);
    if (task && request && !FINISHED.includes(task.phase)) { void bodyHeld(body.task, { incident: body.id, why: body.why, seen: 'frame' }).catch(() => false); return; }
    const before = holdDetail(parts.audit.lastHoldOf(body.task)?.detail ?? null);
    void (requests.incident?.('cancel', body.id, before.incident === body.id ? before.command ?? '' : '', body.task) ?? Promise.resolve({ ok: false, words: 'no_port' }))
      .then(answer => {
        audit({ operationId: request?.operationId ?? `operator:stale:${body.id}`.slice(0, 120), at: parts.now(), operator: request?.operator ?? 'system',
          command: 'hold_stale', event: 'settled', code: answer.ok ? 'released' : 'not_held', argsJson: request?.argsJson ?? '{}', taskId: body.task,
          detail: `body_hold=${body.id} task_phase=${task?.phase ?? 'unknown'} ${answer.words}`.slice(0, 600) });
        if (answer.ok) parts.activity(parts.now(), { summary: '終わったマイクラの依頼の保留が体に残っていたので、解いて世界を動かしました。', tool: 'operator.minecraft.hold',
          outcome: 'done', reasonCode: 'operator_hold_stale', detail: `task=${body.task} incident=${body.id}` });
      }, () => undefined);
  }

  return { handle, tick, socketRefused, hold, notHeld, bodyHeld, resumeChecked, skipNote, heldAgainNote, heldMs, repeated };
}
export type OperatorMinecraft = ReturnType<typeof createOperatorMinecraft>;
