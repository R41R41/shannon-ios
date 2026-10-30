import { createOperatorContext } from './operatorMinecraftContext.js';
import type { OperatorMinecraftParts } from './operatorMinecraftWords.js';
import type { OperatorContext as Context } from './operatorMinecraftContext.js';
export function createRecoveredResume(
  parts: OperatorMinecraftParts,
  shared: { audit: ReturnType<typeof createOperatorContext>['audit']; skipNotes: Map<string, string>; afterResume: Map<string, number> },
) {
  const { audit, skipNotes, afterResume } = shared;

  /**
   * Amendment A-14: a task the body's recovery paused (`fca_stopped`: its step was lost to a restart or a stale
   * gap) is resumed by the operator as a held one is, without a hold row.
   * The body is told to move the world (a release naming `recovered:<task>`: a body that holds nothing unfreezes
   * and answers `done`), then the runtime's resume queues the task again; the
   * recovery pays what the task is owed before its first step (the notice of the lost step: its operations may or
   * may not have taken effect, read the observation).
   */
  async function resumeRecovered(c: Context, taskId: string, deductMinutes: number, reopened = '') {
    const requests = parts.requests!;
    // A request the time limit stopped goes on only when its limit, with the time the body could not move taken off
    // (the pauses of the recovery written by the tick, and the minutes the
    // operator names), is not reached now.
    if (parts.audit.hasEvent(taskId, 'time_limit')) {
      const request = parts.audit.requestOf(parts.scopeKey, taskId);
      const now = parts.now();
      const deadline = request?.deadlineAt
        ? Date.parse(request.deadlineAt) + parts.audit.heldMs(taskId, now) + deductMinutes * 60_000
        : NaN;
      if (!(Date.parse(now) < deadline)) {
        return c.refuse(
          'refused',
          `時間の上限を過ぎています（止まっていた時間を引いても）。体が動けなかった時間が分かるなら --deduct-minutes <分> で引いて、もう一度 resume してください。`,
          { taskId },
        );
      }
    }
    const unheld = await (requests.incident?.('resume', `recovered:${taskId.slice(0, 12)}`, '', taskId) ??
      Promise.resolve({ ok: false, words: 'no_port' }));
    if (!unheld.ok) {
      audit({
        operationId: c.operationId,
        at: parts.now(),
        operator: c.operator,
        command: c.command,
        event: 'refused',
        code: 'not_held',
        argsJson: c.argsJson,
        taskId,
        detail: `recovered body_unreleased ${unheld.words}`.slice(0, 600),
      });
      return c.refuse(
        'refused',
        `体の世界を動かせなかったので、再開しませんでした（${unheld.words}）。体がつながっているか確かめて、もう一度 resume してください。`,
        { taskId },
      );
    }
    audit({
      operationId: c.operationId,
      at: parts.now(),
      operator: c.operator,
      command: c.command,
      event: 'accepted',
      code: 'accepted',
      argsJson: c.argsJson,
      taskId,
      detail: `recovered=fca_stopped${
        reopened ? ` reopened=${reopened}` : ''
      }${deductMinutes ? ` deduct=${deductMinutes * 60_000}` : ''} body=${unheld.words}`.slice(0, 600),
    });
    // Amendment A-15 1: there is no held act to send again (the hold the earlier resume closed stays closed): the
    // resume's check is written at once, so that no step reads an older hold as pending.
    audit({
      operationId: c.operationId,
      at: parts.now(),
      operator: c.operator,
      command: c.command,
      event: 'settled',
      code: 'skipped',
      argsJson: c.argsJson,
      taskId,
      detail: '取り戻しで止まっていたタスクの再開: 出し直す act は無い',
    });
    // Amendment A-15 2: what the lost step leaves is told to the first decision in its live (once, with the results
    // it reads), beside the notice the recovery stores in the inbox.
    const lost = requests.lostActWords?.(taskId);
    skipNotes.set(taskId, `体が動けなかった間に失われた操作${lost ? `（${lost}）` : ''}の結果は分からない。観測で確かめる`);
    const resumed = requests.resume(taskId);
    if (!resumed) {
      skipNotes.delete(taskId);
      audit({
        operationId: c.operationId,
        at: parts.now(),
        operator: c.operator,
        command: c.command,
        event: 'settled',
        code: 'refused',
        argsJson: c.argsJson,
        taskId,
        detail: 'runtime_resume_refused',
      });
      return c.refuse(
        'refused',
        'タスクを再開できませんでした（実行時の再開が断られた）。体の世界は動いています。もう一度 resume してください。',
        { taskId },
      );
    }
    requests.resolveHolds?.(taskId, 'resume');
    afterResume.set(taskId, Date.parse(parts.now()));
    parts.activity(c.at, {
      summary: `運用者（${c.operator}）が、体の取り戻しで止まっていたマイクラの依頼を再開しました。`,
      tool: 'operator.minecraft.resume',
      outcome: 'done',
      reasonCode: 'operator_cli',
      detail: `operation=${c.operationId} task=${taskId} recovered=fca_stopped`,
    });
    requests.wake();
    return c.reply(
      'accepted',
      'resumed',
      '再開しました。止まっていた間に失われた操作の知らせ（結果は分からない。観測で確かめる）を先に届けてから、計画の続きから判断します。',
      { taskId },
    );
  }
  return { resumeRecovered };
}
