import { randomUUID } from 'node:crypto';
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
import { driftWords, feet, type Feet } from './minecraftIncidentHold.js';
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
function holdDetail(detail: string | null): { incident?: string; command?: string; start?: Feet | null; end?: Feet | null } {
  try {
    const value = JSON.parse(detail ?? '{}') as Record<string, unknown>;
    return { ...(typeof value.incident === 'string' ? { incident: value.incident } : {}), ...(typeof value.command === 'string' ? { command: value.command } : {}),
      start: feet(value.start), end: feet(value.end) };
  } catch { return {}; }
}
/** Phases after which a held request holds nothing any more. */
const FINISHED_FOR_GOOD = ['completed', 'failed'];
const HOUR_MS = 3_600_000;
const STATUS: Partial<Record<OperatorCode, number>> = { out_of_scope: 403, rate_limited: 429, flooded: 429 };
const ago = (at: string, ms: number) => new Date(Date.parse(at) - ms).toISOString();

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
  not_held: 'このタスクは保留されていません（再開は、重い失敗で保留された依頼だけです）。',
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
    // 2026-10-28: a held request is stopped already; its cancel ends the hold (audited as stopped: the world is moved again by the body at the next task's act).
    const held = parts.audit.heldOf(found.id);
    if (held && task) {
      // The world the hold stopped moves again: a release naming the hold goes to the body (2026-10-28).
      const detail = holdDetail(held.detail);
      const moved = detail.incident && detail.command ? await (requests.unfreeze?.(detail.incident, detail.command) ?? Promise.resolve('no_port')) : 'no_incident';
      audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'stopped', code: 'stopped',
        argsJson: c.argsJson, taskId: found.id, detail: `held ${task.phase} unfreeze=${moved}` });
      parts.activity(c.at, { summary: `運用者（${c.operator}）が、保留していたマイクラの依頼を止めました。`, tool: 'operator.minecraft.cancel',
        outcome: 'done', reasonCode: 'operator_cli', detail: `operation=${c.operationId} task=${found.id} held` });
      return c.reply('accepted', 'stopped', `保留していた依頼を止めました。世界を動かすよう体に頼みました（${moved}）。`, { taskId: found.id });
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
   * `minecraft resume` (2026-10-28, the fix run): a request held on a heavy failure is queued again (the runtime's resume). Its first step sends the
   * act that failed again, with the same arguments and the hold's id (the body moves the world again and runs it), writes what it did (`resume`
   * `settled`), and then the decisions go on from the plan. The held time is not counted against the request's time limit.
   */
  async function resume(c: Context, input: Extract<OperatorInput, { command: 'resume' }>) {
    const requests = parts.requests;
    if (!requests) return c.refuse('body_unavailable');
    const found = input.taskId ? { id: input.taskId } : (() => {
      const held = parts.audit.heldTasks(parts.scopeKey)[0];
      return held?.taskId ? { id: held.taskId } : null;
    })();
    if (!found) return c.refuse('not_held');
    if (!parts.audit.requestOf(parts.scopeKey, found.id)) return c.refuse(requests.get(found.id) ? 'not_operator_task' : 'not_found', undefined, { taskId: found.id });
    const hold = parts.audit.heldOf(found.id);
    if (!hold) return c.refuse('not_held', undefined, { taskId: found.id });
    const task = requests.get(found.id);
    if (!task || task.phase !== 'stopped') return c.refuse('not_running', '保留した依頼がまだ止まりきっていないか、もう終わっています。', { taskId: found.id });
    audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'accepted', code: 'accepted', argsJson: c.argsJson,
      taskId: found.id, detail: `hold=${hold.sequence}` });
    const resumed = requests.resume(found.id);
    if (!resumed) {
      audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'settled', code: 'refused', argsJson: c.argsJson,
        taskId: found.id, detail: 'runtime_resume_refused' });
      return c.refuse('refused', 'タスクを再開できませんでした（実行時の再開が断られた）。', { taskId: found.id });
    }
    parts.activity(c.at, { summary: `運用者（${c.operator}）が、保留していたマイクラの依頼を再開しました。`, tool: 'operator.minecraft.resume',
      outcome: 'done', reasonCode: 'operator_cli', detail: `operation=${c.operationId} task=${found.id}` });
    requests.wake();
    // 2026-10-28: how far the body is from where the held act began (the act is sent again from here; the body never goes back by itself).
    const detail = holdDetail(hold.detail);
    const position = driftWords(detail.start, requests.position?.() ?? null, detail.end);
    return c.reply('accepted', 'resumed', `再開しました。まず保留した act を同じ引数で出し直し、その後に計画の続きから判断します。${position}`, { taskId: found.id, position });
  }

  /**
   * A heavy failure of a request that asked to be held (2026-10-28; `minecraftIncidentHold.ts` calls it when the body's receipt says so): the hold
   * is audited (why, the incident's id: its box and scene have it, whether the world stopped, the act's command id) and the task is stopped through the
   * owner's stop path (the plan, the pack and the task stay; no decision, no model). False when the task is not the operator's or asked for no hold.
   */
  async function hold(taskId: string, incident: { id: string; why: string; frozen: boolean | null; freeze?: string; command: string; start?: Feet | null; end?: Feet | null }): Promise<boolean> {
    const requests = parts.requests;
    const request = parts.audit.requestOf(parts.scopeKey, taskId);
    if (!requests || !request || !parts.audit.holdOnFailure(taskId) || parts.audit.heldOf(taskId)) return false;
    const detail = JSON.stringify({ incident: incident.id, why: incident.why.slice(0, 160), frozen: incident.frozen, ...(incident.freeze ? { freeze: incident.freeze.slice(0, 80) } : {}),
      command: incident.command, ...(incident.start ? { start: incident.start } : {}), ...(incident.end ? { end: incident.end } : {}) });
    audit({ operationId: request.operationId, at: parts.now(), operator: request.operator, command: 'hold', event: 'settled', code: 'held', argsJson: request.argsJson,
      taskId, detail: detail.slice(0, 600) });
    parts.activity(parts.now(), { summary: '運用者が代わりに始めたマイクラの依頼を、重い失敗で保留しました（世界を止め、記録を取りました）。', tool: 'operator.minecraft.hold',
      outcome: 'done', reasonCode: 'operator_hold', detail: `task=${taskId} incident=${incident.id}` });
    await requests.stop(taskId, 'operator_hold').catch(() => []);
    return true;
  }
  /** After a resume: the act that failed, sent again, and what it did (written once). */
  function resumeChecked(taskId: string, line: string): void {
    const request = parts.audit.requestOf(parts.scopeKey, taskId);
    if (!request) return;
    audit({ operationId: request.operationId, at: parts.now(), operator: request.operator, command: 'resume', event: 'settled', code: 'replayed', argsJson: request.argsJson,
      taskId, detail: line.slice(0, 600) });
  }

  /** `held` (read only, the CLI's status): the held requests, each with where the body is now against where the held act began. */
  function heldNow(c: Context) {
    const now = parts.requests?.position?.() ?? null;
    const held = parts.audit.heldTasks(parts.scopeKey).filter(row => row.taskId).map(row => {
      const detail = holdDetail(row.detail);
      return { taskId: row.taskId!, detail: row.detail ?? '', position: driftWords(detail.start, now, detail.end) };
    });
    audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'settled', code: 'held', argsJson: c.argsJson,
      detail: `held=${held.length}` });
    return c.reply('accepted', 'held', `保留中の依頼 ${held.length} 件`, { held });
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
    for (const row of parts.audit.requestsSince(parts.scopeKey, ago(now, 48 * HOUR_MS))) {
      const task = row.taskId ? requests.get(row.taskId) : null;
      // 2026-10-28: the time a request was held does not count: its deadline moves by it.
      const deadline = row.deadlineAt && task ? Date.parse(row.deadlineAt) + parts.audit.heldMs(task.id, now) : NaN;
      if (!task || !row.deadlineAt || Date.parse(now) < deadline || FINISHED.includes(task.phase) || stopping.has(task.id)) continue;
      stopping.add(task.id);
      void requests.stop(task.id, 'operator_time_limit')
        .then(stopped => timeLimitReached(row, task, stopped.find(item => item.id === task.id)?.phase ?? null, now))
        .catch(() => {}).finally(() => { stopping.delete(task.id); });
    }
  }

  return { handle, tick, socketRefused, hold, resumeChecked };
}
export type OperatorMinecraft = ReturnType<typeof createOperatorMinecraft>;
