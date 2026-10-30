import { createRecoveredResume } from './operatorRecoveredResume.js';
import { createOperatorRequests } from './operatorMinecraftCommandRequests.js';
import { createOperatorContext } from './operatorMinecraftContext.js';
import { FINISHED,holdDetail,holdDetailText,takeWords,holdWhy,HOUR_MS,ago,isRecoveredPause,MESSAGES,SKILL_IMPORT_MESSAGES,skillImportCode,
  RECHECK_UNAVAILABLE } from './operatorMinecraftWords.js';
import type { OperatorActivity,OperatorMinecraftParts } from './operatorMinecraftWords.js';
import { randomUUID } from 'node:crypto';
import { HELD_SUMMARY } from './fcaBodyRecoveryPolicy.js';
import { BILLING_PAUSED_SUMMARY } from './taskPauseNotice.js';
import { operatorLabel,operatorTalkNote,OPERATOR_LIMITS,type OperatorInput } from '../contracts/operatorContract.js';
import type { OperatorAuditRow } from '../infra/ops/store/operatorAuditStore.js';
import type { TaskView } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { OperatorSocketRefusal } from '../infra/ops/operatorSocket.js';
import { runSkillImport } from '../infra/http/skillImportCommand.js';
import { driftWords,headIncidentKind,HEAD_INCIDENT_WORDS,takeEnd,type Feet,type HeldAgain } from './minecraftIncidentHold.js';
import { heldAgainWords } from '../surfaces/minecraft/minecraftLlmcResultWords.js';
import { SHANNON_AUTONOMY_SYSTEM_DOMAIN } from '@shannon/cognition';
export type { OperatorActivity, OperatorMinecraftParts } from './operatorMinecraftWords.js';

const stopControl = (input: OperatorInput): boolean => input.command === 'cancel'
  || (input.command === 'lifecycle' && (input.action === 'logout' || input.action === 'stop'));

/**
 * The operator's Minecraft service in the API (owner decision 2026-10-14; `docs/operator-minecraft-contract.md`). Every
 * invocation is audited before anything else (`operator_audit`), refused unless it is one of the Minecraft operations, and
 * otherwise goes through the same gates as the owner's own request: the body connected, nobody else present, no other Minecraft
 * work or lifecycle operation in flight, the request cap. An accepted one is written to the activity record and noted in Talk.
 */
export function createOperatorMinecraft(parts: OperatorMinecraftParts) {
  const stopping = new Set<string>();
const { audit, flood, flooded, recordRefusal, observed, minecraftActionLive, context } = createOperatorContext(parts);

  type Context = ReturnType<typeof context>;
const { lifecycle, request, target, cancel, budget } = createOperatorRequests(parts, { audit, minecraftActionLive, observed }, stopping);



  /**
   * `minecraft resume` (2026-10-28, the fix run): a request held on a heavy failure is queued again (the runtime's
 * resume). Its first step sends the
   * act that failed again, with the same arguments and the hold's id (the body moves the world again and runs it),
 * writes what it did (`resume`
   * `settled`), and then the decisions go on from the plan. The held time is not counted against the request's time limit.
   */
  async function resume(c: Context, input: Extract<OperatorInput, { command: 'resume' }>) {
    const requests = parts.requests;
    if (!requests) return c.refuse('body_unavailable');
    // Amendment A-14: a task the body's recovery paused (its step was lost: a restart, a stale gap; `fca_stopped`,
// resumable, waiting for the owner) has no hold row, and is resumed the
    // same way: `--latest` is the newer of the open hold and such a task, and an id names either.
    // A request the time limit stopped is one too when the time the body could not move, taken off, leaves it inside
// its limit (A-15).
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
    if (!parts.audit.requestOf(parts.scopeKey, found.id)) return c.refuse(requests.get(found.id) ? 'not_operator_task' : 'not_found',
       undefined, { taskId: found.id });
    const hold = parts.audit.heldOf(found.id);
    // A-20 (run 47: the credit ran out, a refused decision failed the request with the world running): a request
// named by its id, failed by its own step's refused decision, is stopped
    // again (the state machine's `reopen`) and resumed as a request the recovery paused. Any other failed task stays failed.
    const resumeWithoutHold = () => {
if (!hold && input.taskId && requests.get(found.id)?.phase === 'failed') {
      if (requests.reopenRejected?.(found.id, BILLING_PAUSED_SUMMARY) == null) return c.refuse('not_held',
         '失敗した依頼ですが、判断が断られて止まった物ではないので戻せません。', { taskId: found.id });
      return resumeRecovered(c, found.id, input.deductMinutes ?? 0, 'rejected_step');
    }
    if (!hold && !recovered(found.id)) return c.refuse('not_held', undefined, { taskId: found.id });


};
const recoveryReply = await resumeWithoutHold();
if (recoveryReply) return recoveryReply;
const deductedMinutes = () => (input.deductMinutes ?? 0);
if (!hold) return resumeRecovered(c, found.id, deductedMinutes());
    // A-17 (run 46): the unknown exit failed a request whose hold stood open (the hold is the owner's to resume, the
// exit did not see it). Only a task that exit failed (its events say so)
    // is stopped again; any other failed task stays failed and is refused below.
    let reopened = false;
    const failedHeldTask = () => (requests.get(found.id)?.phase === 'failed');
    if (failedHeldTask()) reopened = requests.reopenRetired?.(found.id, HELD_SUMMARY) != null;
    const task = requests.get(found.id);
    if (!task || task.phase !== 'stopped') return c.refuse('not_running', '保留した依頼がまだ止まりきっていないか、もう終わっています。', { taskId: found.id });
    // Run 44, resume 1: the body ends its hold first (a release naming it: the hold ends and the world moves), and
// the task is resumed only when
    // the body says so. Once a body restarted in between kept refusing every act (its hold was to end with the act
// sent again, and that act never
    // reached it): the head ran, the body held, and decisions were paid for nothing. Neither goes on without the other.
    const detail = holdDetail(hold.detail);
    const releaseHeldWorld = async () => {
let unheld = detail.incident ? await (requests.incident?.('resume', detail.incident, detail.command ?? '', found.id) ?? Promise.resolve(
      { ok: false, words: 'no_port' }))
      : { ok: false, words: 'no_incident' };
    // Amendment A-12: a hold the head found itself is not the body's, and a body that holds nothing answers `done`
// to a release naming it. One that holds another hold of this task
    // (it died or failed on its own meanwhile) says so and keeps it: that hold is ended too, so that neither side
// goes on without the other.
    if (!unheld.ok && headIncidentKind(detail.incident)) {
      const other = requests.bodyHold?.();
      if (other && other.task === found.id && other.id !== detail.incident) unheld = await (requests.incident?.('resume', other.id, '',
         found.id) ?? Promise.resolve(unheld));
    }
return unheld;
};
const unheld = await releaseHeldWorld();
    if (!unheld.ok) {
      audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'refused', code: 'not_held', argsJson: c.argsJson,
        taskId: found.id, detail: `body_hold_kept ${unheld.words}`.slice(0, 600) });
      return c.refuse('refused', `体の保留を解けなかったので、再開しませんでした（${unheld.words}）。頭も体も保留のままです。体がつながっているか確かめて、もう一度 resume してください。`,
        { taskId: found.id });
    }
    audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'accepted', code: 'accepted', argsJson: c.argsJson,
      taskId: found.id, detail: `hold=${hold.sequence} body=${unheld.words}${reopened ? ' reopened=retire_unknown' : ''}`.slice(0, 600) });
    // Run 45 (holds 3 to 5: the same go sent again stopped the same way, three times): with --skip-replay the held
// act is not sent again; its result
    // goes to the next decision as a fact (set before the task is queued again: its step reads it when made), and
// the resume's check is written now.
    const resumeHeldTask = () => {
const skipLine = input.skipReplay ? requests.heldActWords?.(detail.command ?? '', holdWhy(hold.detail)) ?? '保留した act は出し直さなかった' : null;
    if (skipLine) skipNotes.set(found.id, skipLine);
    // Chapter 8's 再開 9 → 保留 10: the hold being resumed was a held act's second try, held again: the first decision
// after this resume reads that first.
    const againLine = detail.replay ? heldAgainWords({ replayCode: detail.replay.code, dropped: detail.replay.dropped }) : null;
    if (againLine) againNotes.set(found.id, againLine);
    const resumed = requests.resume(found.id);
    if (!resumed) { skipNotes.delete(found.id);
      againNotes.delete(found.id); }
    // Continue contract 1: the commands a cleanup left held (their result unknown, the release not proved) move on the hold axis only; nothing is sent again.
    else requests.resolveHolds?.(found.id, 'resume');
    if (resumed && skipLine) {
      const line = skipLine;
      audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'settled', code: 'skipped', argsJson: c.argsJson,
        taskId: found.id, detail: `出し直さなかった（--skip-replay）: ${line}`.slice(0, 600) });
    }
return resumed;
};
const resumed = resumeHeldTask();
    if (!resumed) {
      audit({ operationId: c.operationId, at: parts.now(), operator: c.operator, command: c.command, event: 'settled', code: 'refused', argsJson: c.argsJson,
        taskId: found.id, detail: 'runtime_resume_refused' });
      return c.refuse('refused', 'タスクを再開できませんでした（実行時の再開が断られた）。体の保留は解け、世界は動いています。cancel するか、もう一度 resume してください。', { taskId: found.id });
    }
    afterResume.set(found.id, Date.parse(parts.now()));
    parts.activity(c.at, { summary: `運用者（${c.operator}）が、保留していたマイクラの依頼を再開しました。`, tool: 'operator.minecraft.resume',
      outcome: 'done', reasonCode: 'operator_cli', detail: `operation=${c.operationId} task=${found.id}` });
    requests.wake();
    // 2026-10-28: how far the body is from where the held act began (the act is sent again from here; the body never
// goes back by itself).
    const position = driftWords(detail.start, requests.position?.() ?? null, detail.end);
    const resumeWords = () => (input.skipReplay ? `再開しました。保留した act は出し直さず、次の判断にその結果を伝えて、計画の続きから判断します。${position}`
      : `再開しました。まず保留した act を同じ引数で出し直し、その後に計画の続きから判断します。${position}`);
    return c.reply('accepted', 'resumed', resumeWords(), { taskId: found.id, position });
  }

  /**
   * A heavy failure of a request that asked to be held (2026-10-28; `minecraftIncidentHold.ts` calls it when the
 * body's receipt says so): the hold
   * is audited (why, the incident's id: its box and scene have it, whether the world stopped, the act's command
 * id) and the task is stopped through the
   * owner's stop path (the plan, the pack and the task stay; no decision, no model). False when the task is not
 * the operator's or asked for no hold.
   */
  async function hold(taskId: string, incident: { id: string; why: string; frozen: boolean | null; freeze?: string; command: string; start?:
     Feet | null; end?: Feet | null;
    replay?: HeldAgain; record?: string; take?: string; box?: string | null; scene?: string | null; notHeld?: string; bodyHold?: string;
       again?: boolean }): Promise<boolean> {
    const requests = parts.requests;
    const request = parts.audit.requestOf(parts.scopeKey, taskId);
    if (!requests || !request || !parts.audit.holdOnFailure(taskId) || parts.audit.heldOf(taskId)) return false;
    const incidentDetail = () => (holdDetailText({ incident: incident.id, why: incident.why.slice(0, 160), frozen: incident.frozen, ...(incident.freeze ? {
       freeze: incident.freeze.slice(0, 80) } : {}),
      command: incident.command, ...(incident.take ? { take: incident.take } : {}), ...(incident.notHeld ? { notHeld: incident.notHeld.slice(0, 80) } : {}),
      ...(incident.bodyHold ? { bodyHold: incident.bodyHold.slice(0, 150) } : {}), ...(incident.again ? { again: true } : {}),
      ...(incident.box ? { box: incident.box.slice(0, 200) } : {}), ...(incident.scene ? { scene: incident.scene.slice(0, 200) } : {}),
      ...(incident.record ? { record: incident.record.slice(0, 120) } : {}),
      ...(incident.start ? { start: incident.start } : {}), ...(incident.end ? { end: incident.end } : {}) }, incident.replay));
    const detail = incidentDetail();
    audit({ operationId: request.operationId, at: parts.now(), operator: request.operator, command: 'hold', event: 'settled', code: 'held',
       argsJson: request.argsJson,
      taskId, detail });
    // Amendment A-12: a stall the head found itself says what it found and that the world was not stopped (the body
// holds nothing for it); the reason is in the audit's detail too.
    const kind = headIncidentKind(incident.id);
    const holdActivity = (): OperatorActivity => (kind
      ? { summary: `運用者が代わりに始めたマイクラの依頼を、頭が見つけた詰まり（${HEAD_INCIDENT_WORDS[kind] ?? kind}）で保留しました（${takeWords(incident.take, { frozen:
         incident.frozen, ...(incident.notHeld ? { notHeld: incident.notHeld } : {}), ...(incident.bodyHold ? { bodyHold:
            incident.bodyHold } : {}) })}。理由と判断の記録の直近の行は頭の黒箱にあります）。`,
        tool: 'operator.minecraft.hold', outcome: 'done', reasonCode: 'operator_hold_head',
        detail: `task=${taskId} incident=${incident.id} take=${incident.take ?? '-'} why=${incident.why.slice(0,
           120)}${incident.box ? ` box=${incident.box}` : ''}${incident.scene ? ` scene=${incident.scene}` :
              ''}${incident.record ? ` record=${incident.record}` : ''}` }
      : { summary: '運用者が代わりに始めたマイクラの依頼を、重い失敗で保留しました（世界を止め、記録を取りました）。', tool: 'operator.minecraft.hold',
        outcome: 'done', reasonCode: 'operator_hold', detail: `task=${taskId} incident=${incident.id}` });
    parts.activity(parts.now(), holdActivity());
    await requests.stop(taskId, 'operator_hold').catch(() => []);
    return true;
  }
  /**
   * A heavy failure of a request that asked to be held, not held because the body could not stop the world (run
 * 44, the coordinator's choice of
   * 2026-10-28: someone else on the server; holding in a moving world left the body standing at night with no act,
 * and it died). Its box and
   * scene were taken; the request goes on. Written as `hold_skipped` (not a hold: nothing waits for a resume).
   */
  function notHeld(taskId: string, incident: { id: string; why: string; notHeld?: string; command: string; start?: Feet | null; end?: Feet | null }): void {
    const request = parts.audit.requestOf(parts.scopeKey, taskId);
    if (!request || !parts.audit.holdOnFailure(taskId)) return;
    const detail = JSON.stringify({ incident: incident.id, why: incident.why.slice(0, 160), freeze: String(incident.notHeld ?? '').slice(0,
       80), command: incident.command,
      ...(incident.start ? { start: incident.start } : {}), ...(incident.end ? { end: incident.end } : {}) });
    audit({ operationId: request.operationId, at: parts.now(), operator: request.operator, command: 'hold_skipped', event: 'settled', code:
       'not_held', argsJson: request.argsJson,
      taskId, detail: detail.slice(0, 600) });
    parts.activity(parts.now(), { summary: '運用者が代わりに始めたマイクラの依頼で重い失敗がありましたが、世界を止められないため保留せずに続けました（記録は取りました）。',
      tool: 'operator.minecraft.hold', outcome: 'done', reasonCode: 'operator_hold_skipped', detail:
         `task=${taskId} incident=${incident.id} freeze=${String(incident.notHeld ?? '').slice(0, 60)}` });
  }
  /**
   * Run 44, resume 1: the body refused an act as held (or says in its frame it holds a hold of a running task)
 * while the head had no hold: the
   * head goes back to held (a hold row naming the body's hold, `mismatch`, and the owner's stop path), so that no
 * decision is paid for while the
   * body refuses every act, and the operator sees it in `status` and resumes or cancels it as any hold. False when
 * there is nothing to do.
   */
  async function bodyHeld(taskId: string, body: { incident: string; why: string; seen: 'refused' | 'frame' }): Promise<boolean> {
    const requests = parts.requests;
    const request = parts.audit.requestOf(parts.scopeKey, taskId);
    if (!requests || !request || parts.audit.heldOf(taskId)) return false;
    const before = holdDetail(parts.audit.lastHoldOf(taskId)?.detail ?? null);
    const same = before.incident === body.incident;
    // Run 45 (+929): the body holds on its own for a death or near death outside an act: not a disagreement, the head follows it.
    const outside = /^(?:death|near_death)/u.test(body.why);
    // Run 47 (resume 9: the head went back to held and the world moved on for four and a half minutes): the body is
// asked to hold as well, so that the world stops. What it answers is in the row.
    const taken = await (requests.take?.(taskId, body.incident, `頭が保留に戻した（${body.seen}）: ${body.why}`.slice(0, 280)) ?? Promise.resolve(
      null)).catch(() => null);
    const heldAuditDetail = () => (JSON.stringify({ incident: body.incident, why: body.why.slice(0, 160), frozen: taken ? taken.frozen : null, ...(taken ? {
       take: takeEnd(taken), ...(taken.freeze ? { freeze: taken.freeze.slice(0, 80) } : {}) } : {}), command: same ? before.command ?? '' : '',
      ...(same && before.start ? { start: before.start } : {}), ...(same && before.end ? { end: before.end } : {}),
      mismatch: outside ? `outside_act:${body.seen}` : `body_held:${body.seen}` }));
    const detail = heldAuditDetail();
    audit({ operationId: request.operationId, at: parts.now(), operator: request.operator, command: 'hold', event: 'settled', code: 'held',
       argsJson: request.argsJson,
      taskId, detail: detail.slice(0, 600) });
    parts.activity(parts.now(), { summary: outside ? `体が act の外の${body.why.startsWith('death') ? '死亡' : '瀕死'}で保留したので、運用者が代わりに始めたマイクラの依頼も保留しました。判断は止めています。`
      : '体がまだ保留していたので（頭との食い違い）、運用者が代わりに始めたマイクラの依頼を保留に戻しました。判断は止めています。',
      tool: 'operator.minecraft.hold', outcome: 'done', reasonCode: outside ? 'operator_hold' : 'operator_hold_mismatch', detail:
         `task=${taskId} incident=${body.incident} seen=${body.seen}` });
    await requests.stop(taskId, 'operator_hold').catch(() => []);
    return true;
  }
  /** Run 45: the lines a resume with --skip-replay left for each task's next decision (taken once). */
  const skipNotes = new Map<string, string>();
  /** Chapter 8: the lines a resume left for each task's first decision when the hold it resumed was a held act's
 * second try, held again (taken once). */
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
   * Run 45 (holds 3 to 5): the act a resume sent again failed for the reason it was held for, and the body did not
 * hold again. The operator fixed
   * what was thought the cause and it did not help: that is written down, and the decisions go on with the result.
   */
  function repeated(taskId: string, incident: { id: string; why: string; command: string; repeated?: string }): void {
    const request = parts.audit.requestOf(parts.scopeKey, taskId);
    if (request) {
      audit({ operationId: request.operationId, at: parts.now(), operator: request.operator, command: 'resume', event: 'settled', code: 'replay_failed_same',
        argsJson: request.argsJson, taskId, detail: `出し直しは同じ理由で失敗、保留せず判断へ（${incident.why.slice(0,
           80)}、incident ${incident.id}、出し直した保留 ${incident.repeated ?? '-'}、act ${incident.command}）`.slice(0, 600) });
    }
    parts.activity(parts.now(), { summary: '保留から出し直した act が同じ理由で失敗したので、もう一度は保留せずに判断を続けました。', tool: 'operator.minecraft.resume',
      outcome: 'done', reasonCode: 'operator_replay_failed_same', detail: `task=${taskId} incident=${incident.id}` });
  }
  /** After a resume: the act that failed, sent again, and what it did (written once). */
  function resumeChecked(taskId: string, line: string): void {
    const request = parts.audit.requestOf(parts.scopeKey, taskId);
    if (!request) return;
    audit({ operationId: request.operationId, at: parts.now(), operator: request.operator, command: 'resume', event: 'settled', code:
       'replayed', argsJson: request.argsJson,
      taskId, detail: line.slice(0, 600) });
  }

  /** Amendment A-12: how a hold the head found stands against the body's own (its frame): the body's answer to the
 * take, and a disagreement only when it keeps a hold the head's take did not make. */
  function headAgree(detail: ReturnType<typeof holdDetail>, body: { id: string; task: string } | null): string {
    const words = takeWords(detail.take, { ...(detail.frozen !== undefined ? { frozen: detail.frozen } : {}), ...(detail.notHeld ? {
       notHeld: detail.notHeld } : {}), ...(detail.bodyHold ? { bodyHold: detail.bodyHold } : {}) });
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
      // Amendment A-12: a stall the head found is the head's alone (the body holds nothing for it); only a body hold
// beside it is a disagreement.
      const agree = headIncidentKind(detail.incident) ? headAgree(detail, body)
        : !body ? '体は保留していない（食い違い: 頭だけ保留）' : body.id === detail.incident ? '体も同じ保留' : `食い違い: 体の保留は ${body.id}（task ${body.task}）`;
      return { taskId: row.taskId!, detail: row.detail ?? '', position: driftWords(detail.start, now, detail.end),
        body: ("" +
`${agree}` +
"" +
`${detail.mismatch?.startsWith('outside_act') ? '。体が act の外（死亡・瀕死）で保留し、頭も保留した' : detail.mismatch ? '。体が act を断ったので頭が保留に戻した' : ''}` +
"") };
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
   * `skills import`: exactly the paired route's import (`runSkillImport`). The audit names the operator; an
 * applied pack is written to
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
    const lifecycleServer = () => (input?.command === 'lifecycle' ? parts.lifecycle?.server(input.serverId) ?? input.serverId : null);
    const serverId = lifecycleServer();
    audit({ operationId: c.operationId, at: c.at, operator: c.operator, command: c.command, event: 'invoked', code: 'invoked', argsJson: c.argsJson,
      ...(input?.command === 'lifecycle' ? { action: input.action, serverId } : {}) });
    if (!c.parsed.ok) return c.refuse(c.parsed.code, c.parsed.message);
    if (!parts.enabled()) return c.refuse('disabled');
    const parsed = c.parsed.input;
    // Run53: repeated holds filled the admission quota; stopping an existing run must still use its normal checks and audit.
    if (!stopControl(parsed)
      && parts.audit.acceptedSince(parts.scopeKey, new Date(Date.parse(c.at) - 3600_000).toISOString()) >= OPERATOR_LIMITS.requestsPerHour) {
      return c.refuse('rate_limited');
    }
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
   * phase is terminal, not until a stop was audited (a cancel's stop may not have taken), and stopping it again is
 * not noted again.
   * It holds with the switch off too, so turning the switch off never leaves an operator's request without its limit.
   */
  function tick(): void {
    if (!parts.requests) return;
    const requests = parts.requests, now = parts.now();
    reconcile(requests, now);
    for (const row of parts.audit.requestsSince(parts.scopeKey, ago(now, 48 * HOUR_MS))) {
      const task = row.taskId ? requests.get(row.taskId) : null;
      // Amendment A-15: a pause the body's recovery made is a time the body could not move: written once (at the time
// the task was paused), and not counted like a hold.
      if (task && isRecoveredPause(task) && !parts.audit.pausedOpen(task.id)) {
        audit({ operationId: `${row.operationId}:paused:${task.revision}`, at: task.updatedAt, operator: row.operator, command: 'paused',
           event: 'settled', code: 'paused',
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
   * Run 44: the body's hold (its frame) against the head's. A hold of a task that is running and not held here is
 * taken back as held
   * (`bodyHeld`); a hold of a task that is gone (finished, failed, unknown here) is ended: a release naming it,
 * with the task's last lease
   * (a body restarted with the file of a task that ended). At most once a minute for the same hold; what was done
 * is in the audit.
   */
  const reconciled = new Map<string, number>();
  /** When each task was resumed (ms): the frame the body's hold is judged on must be one after the body had its
 * release (see `reconcile`). Cleared when a frame shows no hold. */
  const afterResume = new Map<string, number>();
const { resumeRecovered } = createRecoveredResume(parts, { audit, skipNotes, afterResume });
  const RESUME_FRAME_WAIT_MS = 20_000;
  function reconcile(requests: NonNullable<OperatorMinecraftParts['requests']>, now: string): void {
    const body = requests.bodyHold?.();
    // Run 47 (resume 9): after a resume the first frame may still show the hold the resume is ending (the body had
// not read the release yet): the head waits for a frame that has lost it
    // (`incidentHold` gone) before it judges a disagreement, at most `RESUME_FRAME_WAIT_MS`. A body that still holds
// after that is a real disagreement.
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
    if (task && request && !FINISHED.includes(task.phase)) { void bodyHeld(body.task, { incident: body.id, why: body.why, seen:
       'frame' }).catch(() => false); return; }
    const before = holdDetail(parts.audit.lastHoldOf(body.task)?.detail ?? null);
    void (requests.incident?.('cancel', body.id, before.incident === body.id ? before.command ?? '' : '', body.task) ?? Promise.resolve({
       ok: false, words: 'no_port' }))
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
