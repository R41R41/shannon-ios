import { createOperatorContext } from './operatorMinecraftContext.js';
import { FINISHED, holdDetail, FINISHED_FOR_GOOD, HOUR_MS, ago, BUDGET_NOT_RUNNING } from './operatorMinecraftWords.js';
import type { OperatorMinecraftParts } from './operatorMinecraftWords.js';
import { operatorTalkNote, OPERATOR_LIMITS, type OperatorCode, type OperatorInput } from '../contracts/operatorContract.js';
import type { LifecycleSettlement } from './minecraftLifecycleRunner.js';
import { preparedWorldOfReceipt } from './freshWorldWiring.js';
import type { OperatorMinecraftRequests } from './operatorMinecraftRequests.js';
import type { OperatorContext as Context } from './operatorMinecraftContext.js';
export function createOperatorRequests(
  parts: OperatorMinecraftParts,
  shared: Pick<ReturnType<typeof createOperatorContext>, 'audit' | 'minecraftActionLive' | 'observed'>,
  stopping: Set<string>,
) {
  const { audit, minecraftActionLive, observed } = shared;

  async function lifecycle(c: Context, input: Extract<OperatorInput, { command: 'lifecycle' }>, serverId: string | null) {
    if (!parts.lifecycle) return c.refuse('lifecycle_unavailable');
    if (!serverId) return c.refuse('invalid_input', '登録されたサーバーIDを指定してください（--server）。');
    const settled = (settlement: LifecycleSettlement) => {
      const code = settlement.receipt?.code ?? (settlement.issued ? 'unknown' : 'not_started');
      // A start that made a new world says which one, and where the old one is kept, in the audit line too (only when the command
      // asked for one); so does one whose world moved while the start could not be confirmed.
      const seen = preparedWorldOfReceipt(settlement.receipt ?? settlement.unconfirmed, settlement.command);
      const world = seen
        ? `  worldId=${seen.worldId ?? 'none'} movedTo=${seen.movedTo ?? 'none'}${seen.started ? '' : '  start_unconfirmed'}`
        : '';
      audit({
        operationId: c.operationId,
        at: parts.now(),
        operator: c.operator,
        command: c.command,
        event: 'settled',
        code,
        argsJson: c.argsJson,
        action: input.action,
        serverId,
        lifecycleId: c.operationId,
        detail: settlement.receipt ? `${settlement.receipt.outcome}${world}` : seen ? `unknown${world}` : null,
      });
    };
    const asked = { id: c.operationId, serverId, action: input.action, ...(input.keepWorld ? { keepWorld: true } : {}) };
    const admission = await parts.lifecycle.execute(asked, settled);
    if (!admission.ok) return c.refuse(admission.code, admission.message, { action: input.action, serverId });
    audit({
      operationId: c.operationId,
      at: parts.now(),
      operator: c.operator,
      command: c.command,
      event: 'accepted',
      code: 'accepted',
      argsJson: c.argsJson,
      action: input.action,
      serverId,
      lifecycleId: admission.lifecycleId,
      actionId: admission.actionId,
    });
    parts.activity(c.at, {
      summary: `運用者（${c.operator}）がライ氏の代わりにマイクラの ${input.action} を頼みました${input.keepWorld ? '（今のワールドのまま始めるよう指定）' : ''}。`,
      tool: `operator.minecraft.${input.action}`,
      outcome: 'done',
      reasonCode: 'operator_cli',
      detail: `operation=${c.operationId} server=${serverId}`,
    });
    parts.note(`${c.operationId}:lifecycle`, operatorTalkNote('lifecycle', `${input.action}・${serverId}`), c.at);
    return c.reply('accepted', 'accepted', '受け付けました。結果は監査記録に settled として残ります。', {
      lifecycleId: admission.lifecycleId,
      actionId: admission.actionId,
    });
  }

  async function request(c: Context, input: Extract<OperatorInput, { command: 'request' }>) {
    const requests = parts.requests;
    if (!requests) return c.refuse('body_unavailable');
    if (!parts.ownerAlone() && parts.gameOnlyAvailable?.() !== true) return c.refuse('owner_not_alone');
    if (!requests.body()) return c.refuse('body_unavailable');
    if (parts.lifecycleUnresolved()) return c.refuse('unresolved_operation');
    if (await minecraftActionLive()) return c.refuse('lease_conflict');
    // 2026-10-28: a request held on a heavy failure still holds the body and its world (stopped): a new one waits
    // for its resume or cancel.
    if (
      parts.audit
        .heldTasks(parts.scopeKey)
        .some((row) => row.taskId && !FINISHED_FOR_GOOD.includes(requests.get(row.taskId)?.phase ?? 'completed'))
    ) {
      return c.refuse('minecraft_busy', '保留中の依頼があります。再開（resume）か止める（cancel）までは新しく始めません。');
    }
    const admitted = observed('operator_minecraft_request', c.operationId, () =>
      requests.admit({ operationId: c.operationId, goal: input.goal, operator: c.operator }),
    );
    if (!admitted.ok) return c.refuse(admitted.code);
    const deadlineAt = new Date(Date.parse(parts.now()) + input.maxMinutes * 60_000).toISOString();
    try {
      audit({
        operationId: c.operationId,
        at: parts.now(),
        operator: c.operator,
        command: c.command,
        event: 'accepted',
        code: 'accepted',
        argsJson: c.argsJson,
        taskId: admitted.task.id,
        deadlineAt,
        budgetYen: input.budgetYen,
        detail: admitted.bodyId,
      });
    } catch (error) {
      // Without its audit row the task would not be the operator's (no cap, no time limit, no cancel): it is stopped at once.
      await requests.stop(admitted.task.id, 'operator_audit_failed').catch(() => []);
      throw error;
    }
    parts.activity(c.at, {
      summary: `運用者（${c.operator}）がライ氏の代わりにマイクラの依頼を始めました。`,
      tool: 'operator.minecraft.request',
      outcome: 'done',
      reasonCode: 'operator_cli',
      detail: `operation=${c.operationId} task=${admitted.task.id} minutes=${input.maxMinutes} yen=${input.budgetYen}`,
    });
    parts.note(`${c.operationId}:request`, operatorTalkNote('request', input.goal), c.at);
    requests.wake();
    return c.reply('accepted', 'accepted', '共通タスクとして受け付けました。まだ達成していません。', {
      taskId: admitted.task.id,
      deadlineAt,
      budgetYen: input.budgetYen,
    });
  }

  function target(c: Context, requests: OperatorMinecraftRequests, taskId: string | null): { id: string } | { code: OperatorCode } {
    if (taskId) {
      if (parts.audit.requestOf(parts.scopeKey, taskId)) return { id: taskId };
      return { code: requests.get(taskId) ? 'not_operator_task' : 'not_found' };
    }
    const open = parts.audit
      .requestsSince(parts.scopeKey, ago(c.at, 48 * HOUR_MS))
      .find((row) => row.taskId && !FINISHED.includes(requests.get(row.taskId)?.phase ?? 'stopped'));
    return open?.taskId ? { id: open.taskId } : { code: 'not_found' };
  }

  async function cancel(c: Context, input: Extract<OperatorInput, { command: 'cancel' }>) {
    const requests = parts.requests;
    if (!requests) return c.refuse('body_unavailable');
    const found = target(c, requests, input.taskId);
    if ('code' in found) return c.refuse(found.code, undefined, input.taskId ? { taskId: input.taskId } : {});
    const task = requests.get(found.id);
    // 2026-10-28: a held request is stopped already; its cancel ends the hold (audited as stopped). Run 44: a
    // release naming the hold goes to the
    // body first and its receipt says whether the body ended it; a body that did not (gone, another hold) is ended
    // when it comes back (`tick`).
    const held = parts.audit.heldOf(found.id);
    if (held && task) {
      const detail = holdDetail(held.detail);
      const moved = detail.incident
        ? await (requests.incident?.('cancel', detail.incident, detail.command ?? '', found.id) ??
            Promise.resolve({ ok: false, words: 'no_port' }))
        : { ok: false, words: 'no_incident' };
      // Continue contract 1: the held commands of a cancelled task are ended on the hold axis (their result is left as it is).
      requests.resolveHolds?.(found.id, 'cancel');
      audit({
        operationId: c.operationId,
        at: parts.now(),
        operator: c.operator,
        command: c.command,
        event: 'stopped',
        code: 'stopped',
        argsJson: c.argsJson,
        taskId: found.id,
        detail: `held ${task.phase} body_hold_ended=${moved.ok} ${moved.words}`.slice(0, 600),
      });
      parts.activity(c.at, {
        summary: `運用者（${c.operator}）が、保留していたマイクラの依頼を止めました。`,
        tool: 'operator.minecraft.cancel',
        outcome: 'done',
        reasonCode: 'operator_cli',
        detail: `operation=${c.operationId} task=${found.id} held`,
      });
      return c.reply(
        'accepted',
        'stopped',
        moved.ok
          ? `保留していた依頼を止めました。体の保留も解け、世界が動きました（${moved.words}）。`
          : `保留していた依頼を止めました。体の保留はまだ解けていません（${moved.words}）。体が戻った時に解きます。`,
        { taskId: found.id },
      );
    }
    if (!task || FINISHED.includes(task.phase)) return c.refuse('not_running', undefined, { taskId: found.id });
    const stopped = await requests.stop(found.id, 'operator_minecraft_stop');
    const phase = stopped.find((item) => item.id === found.id)?.phase ?? requests.get(found.id)?.phase ?? 'unknown';
    audit({
      operationId: c.operationId,
      at: parts.now(),
      operator: c.operator,
      command: c.command,
      event: 'stopped',
      code: 'stopped',
      argsJson: c.argsJson,
      taskId: found.id,
      detail: phase,
    });
    parts.activity(c.at, {
      summary: `運用者（${c.operator}）が、代わりに始めたマイクラの依頼を止めました。`,
      tool: 'operator.minecraft.cancel',
      outcome: 'done',
      reasonCode: 'operator_cli',
      detail: `operation=${c.operationId} task=${found.id} phase=${phase}`,
    });
    parts.note(`${c.operationId}:cancel`, operatorTalkNote('cancel', task.goal), c.at);
    return c.reply('accepted', 'stopped', '停止要求を受け付けました。身体操作の停止確認後に停止済みになります。', { taskId: found.id });
  }

  /**
   * `minecraft budget`: the cap of a running request the operator started, changed to another yen amount (up to
   * the request cap, down to
   * what the task has used). It is a new `budget` row of the audit (who, when, which task, from what to what) and
   * never a write over the
   * request's row; the budget check reads it through `OperatorAuditStore.budgetYen`, so it holds from the task's
   * next decision on. A task
   * that has stopped (for its cap, its estimates, or a cancel) is not resumed by this, so a change to it is refused.
   */
  async function budget(c: Context, input: Extract<OperatorInput, { command: 'budget' }>) {
    const requests = parts.requests;
    if (!requests) return c.refuse('body_unavailable');
    const found = target(c, requests, input.taskId);
    if ('code' in found) return c.refuse(found.code, undefined, input.taskId ? { taskId: input.taskId } : {});
    const task = requests.get(found.id);
    if (!task || FINISHED.includes(task.phase)) return c.refuse('not_running', BUDGET_NOT_RUNNING, { taskId: found.id });
    const from = parts.audit.budgetYen(found.id) ?? OPERATOR_LIMITS.maxBudgetYen,
      spent = parts.spentYen?.(found.id) ?? null;
    if (input.budgetYen < from && (spent === null || input.budgetYen < spent)) {
      const reason =
        spent === null
          ? '使った額を確かめられないので、下げることはできません。'
          : `もう${spent}円使っているので、それより低くはできません。`;
      return c.refuse('budget_below_spent', reason, { taskId: found.id, budgetYen: input.budgetYen });
    }
    audit({
      operationId: c.operationId,
      at: parts.now(),
      operator: c.operator,
      command: c.command,
      event: 'accepted',
      code: 'accepted',
      argsJson: c.argsJson,
      taskId: found.id,
      budgetYen: input.budgetYen,
      detail: `from=${from} to=${input.budgetYen} spent=${spent ?? 'unknown'}`,
    });
    parts.activity(c.at, {
      summary: `運用者（${c.operator}）が、代わりに始めたマイクラの依頼の予算の上限を${from}円から${input.budgetYen}円に変えました。`,
      tool: 'operator.minecraft.budget',
      outcome: 'done',
      reasonCode: 'operator_cli',
      detail: `operation=${c.operationId} task=${found.id} yen=${from}->${input.budgetYen}`,
    });
    parts.note(`${c.operationId}:budget`, operatorTalkNote('budget', task.goal), c.at);
    return c.reply(
      'accepted',
      'accepted',
      `予算の上限を${from}円から${input.budgetYen}円にしました。走っているタスクの次の判断から効きます。`,
      { taskId: found.id, budgetYen: input.budgetYen },
    );
  }
  return { lifecycle, request, target, cancel, budget };
}
