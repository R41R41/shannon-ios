import { randomUUID } from 'node:crypto';
import { ACTION_TERMINAL } from '@shannon/mind';
import type { ActionThreads } from '../contracts/actionThreadContract.js';
import { auditedArguments, operatorLabel, operatorTalkNote, parseOperatorEnvelope, OPERATOR_LIMITS,
  type OperatorCode, type OperatorInput, type OperatorReply } from '../contracts/operatorContract.js';
import type { OperatorAuditDraft, OperatorAuditStore } from '../infra/ops/store/operatorAuditStore.js';
import { observeSync, withObserverRunSync } from '../infra/observer/observerContext.js';
import type { LifecycleSettlement } from './minecraftLifecycleRunner.js';
import type { OperatorLifecycle } from './operatorLifecycleWiring.js';
import type { OperatorMinecraftRequests } from './operatorMinecraftRequests.js';

/** What the activity record (「したことの記録」, shown in 自律活動 › 記録) keeps of an operator invocation. */
export interface OperatorActivity { summary: string; tool: string; outcome: 'done' | 'refused'; reasonCode: string; detail: string }

export interface OperatorMinecraftParts {
  scopeKey: string; enabled(): boolean; ownerAlone(): boolean; now(): string;
  audit: OperatorAuditStore;
  lifecycle: OperatorLifecycle | null;
  requests: (OperatorMinecraftRequests & { wake(): void }) | null;
  actions: ActionThreads | null;
  lifecycleUnresolved(): boolean;
  activity(at: string, entry: OperatorActivity): void;
  /** A short note in the owner's Talk, written once per id. */
  note(id: string, text: string, at: string): void;
}

const FINISHED = ['stopped', 'completed', 'failed', 'stopping'];
const MESSAGES: Partial<Record<OperatorCode, string>> = {
  disabled: '運用者のマイクラ操作はサーバーで有効になっていません（SHANNON_OPERATOR_MINECRAFT）。',
  owner_not_alone: 'ライ氏以外の人がいる間は始めません。',
  body_unavailable: 'マイクラの体が一つに決まっていないか、接続されていません。',
  minecraft_busy: 'ほかのマイクラの作業がまだ動いています。先に止めるか終わるのを待ってください。',
  lease_conflict: 'マイクラの管理操作がまだ動いています。',
  unresolved_operation: '前のマイクラ管理操作の結果がまだ確認できていません。',
  rate_limited: `1時間に${OPERATOR_LIMITS.requestsPerHour}件までです。`,
  not_found: '運用者が始めた進行中のマイクラの依頼が見つかりません。',
  not_operator_task: 'このタスクは運用者が始めたものではないので止めません（ライ氏の依頼は本人の「止まって」で止めます）。',
  not_running: 'このタスクはもう終わっているか、止めている途中です。',
  lifecycle_unavailable: 'マイクラ管理が設定されていないか、新しい状態が届いていません。',
};

/**
 * The operator's Minecraft service in the API (owner decision 2026-10-14; `docs/operator-minecraft-contract.md`). Every
 * invocation is audited before anything else (`operator_audit`), refused unless it is one of the Minecraft operations, and
 * otherwise goes through the same gates as the owner's own request: the body connected, nobody else present, no other Minecraft
 * work or lifecycle operation in flight, the request cap. An accepted one is written to the activity record and noted in Talk.
 */
export function createOperatorMinecraft(parts: OperatorMinecraftParts) {
  const stopping = new Set<string>();
  const audit = (draft: Omit<OperatorAuditDraft, 'scopeKey'>) => parts.audit.append({ ...draft, scopeKey: parts.scopeKey });
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
      ({ status: outcome === 'accepted' ? 202 : code === 'out_of_scope' ? 403 : 409, body: { operationId, outcome, code, message, ...extra } });
    const refuse = (code: OperatorCode, message = MESSAGES[code] ?? code, extra: Partial<OperatorAuditDraft> = {}) => {
      audit({ operationId, at: parts.now(), operator, command, event: 'refused', code, argsJson, detail: message, ...extra });
      parts.activity(at, { summary: `運用者（${operator}）のマイクラ操作を受け付けませんでした。`, tool: `operator.minecraft.${command}`,
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
      audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'settled', code, argsJson: c.argsJson,
        action: input.action, serverId, lifecycleId: c.operationId, detail: settlement.receipt?.outcome ?? null });
    };
    const admission = await parts.lifecycle.execute({ id: c.operationId, serverId, action: input.action }, settled);
    if (!admission.ok) return c.refuse(admission.code, admission.message, { action: input.action, serverId });
    audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'accepted', code: 'accepted',
      argsJson: c.argsJson, action: input.action, serverId, lifecycleId: admission.lifecycleId, actionId: admission.actionId });
    parts.activity(c.at, { summary: `運用者（${c.operator}）がライ氏の代わりにマイクラの ${input.action} を頼みました。`,
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
    const since = new Date(Date.parse(c.at) - 48 * 3600_000).toISOString();
    const open = parts.audit.openRequests(parts.scopeKey, since).find(row => row.taskId && !FINISHED.includes(requests.get(row.taskId)?.phase ?? 'stopped'));
    return open?.taskId ? { id: open.taskId } : { code: 'not_found' };
  }

  async function cancel(c: Context, input: Extract<OperatorInput, { command: 'cancel' }>) {
    const requests = parts.requests;
    if (!requests) return c.refuse('body_unavailable');
    const found = target(c, requests, input.taskId);
    if ('code' in found) return c.refuse(found.code, undefined, input.taskId ? { taskId: input.taskId } : {});
    const task = requests.get(found.id);
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

  async function handle(value: unknown): Promise<{ status: number; body: unknown }> {
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
    return cancel(c, parsed);
  }

  /**
   * The operator's time limit: a request past its deadline is stopped by the same stop path, once, and noted. It holds with the
   * switch off too, so turning the switch off never leaves an operator's request without its limit.
   */
  function tick(): void {
    if (!parts.requests) return;
    const requests = parts.requests, now = parts.now(), since = new Date(Date.parse(now) - 48 * 3600_000).toISOString();
    for (const row of parts.audit.openRequests(parts.scopeKey, since)) {
      const task = row.taskId ? requests.get(row.taskId) : null;
      if (!task || !row.deadlineAt || Date.parse(now) < Date.parse(row.deadlineAt) || FINISHED.includes(task.phase) || stopping.has(task.id)) continue;
      stopping.add(task.id);
      void requests.stop(task.id, 'operator_time_limit').then(stopped => {
        audit({ operationId: row.operationId, at: parts.now(), operator: row.operator, command: 'request', event: 'time_limit', code: 'time_limit',
          argsJson: row.argsJson, taskId: task.id, deadlineAt: row.deadlineAt, detail: stopped.find(item => item.id === task.id)?.phase ?? null });
        parts.activity(now, { summary: '運用者が代わりに始めたマイクラの依頼を、決められた時間に達したので止めました。', tool: 'operator.minecraft.time_limit',
          outcome: 'done', reasonCode: 'operator_time_limit', detail: `operation=${row.operationId} task=${task.id}` });
        parts.note(`${row.operationId}:time_limit`, operatorTalkNote('time_limit', task.goal), now);
      }).catch(() => {}).finally(() => { stopping.delete(task.id); });
    }
  }

  return { handle, tick };
}
export type OperatorMinecraft = ReturnType<typeof createOperatorMinecraft>;
