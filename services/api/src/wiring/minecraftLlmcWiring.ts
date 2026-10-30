import { bodyHoldOf,withResend,withIncident,withStalls } from './minecraftLlmcLifecycle.js';
import {
LLMC_PERMIT_WINDOW_MS,LLMC_HISTORY_HARD,llmcTools,redecideLabel,llmcModelRouter,llmcCompletionMistake,LLMC_CATALOG_SELECTOR,
llmcProbeRunner,billingGuarded
} from './minecraftLlmcConfiguration.js';
import type { LlmcWiring } from './minecraftLlmcConfiguration.js';
import type { FcaExternalTools,FcaToolCall } from '../mind/action/fca/fcaPorts.js';
import type { TaskStep } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import { createFcaPlanTools,PLAN_UPDATE_TOOL } from '../mind/action/fca/fcaPlanTools.js';
import { toolOk,type ToolResult } from '../mind/tools/shannonTools.js';
import { REDECIDE_GIVE_UP_MS,type RedecidePort } from '../surfaces/minecraft/minecraftLlmcRedecide.js';
import { firstPlanInbox,startFirstPlan } from '../surfaces/minecraft/minecraftFirstPlan.js';
import type { FcaBodyLifecycle } from '../mind/action/fca/fcaPorts.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import { createLlmcEvents,urgentDecision,withLlmcBody } from '../surfaces/minecraft/minecraftLlmcBody.js';
import { offerOnce } from '../surfaces/minecraft/minecraftLlmcFacts.js';
import { LLMC_STALE_FRAME_MS } from '../surfaces/minecraft/minecraftLlmcLive.js';
import { createLlmcQueue } from '../surfaces/minecraft/minecraftLlmcQueue.js';
import { snapshotUses } from '../surfaces/minecraft/minecraftLlmcPromises.js';
import { meterParts,reachedMilestoneNames } from '../surfaces/minecraft/minecraftLlmcRoad.js';
import {
deathCounterOf,noteDeath,noteProgress,noteRan,noteRefusal,resumeStalls,stallIncidentId,watchStalls,
type Stall
} from '../surfaces/minecraft/minecraftLlmcStalls.js';
import { anthropicFcaHistoryCodecV2 } from '../infra/models/anthropic/anthropicFcaHistory.js';
import { ownFirstPlanSystem } from '../surfaces/minecraft/minecraftStrategy.js';
import { doneFacts,seenDoneUpdate,undergroundInOverworld,withChestsDone } from '../surfaces/minecraft/minecraftPlanDone.js';
import { preparationCompletionProblem } from '../surfaces/minecraft/minecraftPlanCompletion.js';
import { chestNodesDone,followNode,noteChestsOpened,workingNode } from '../surfaces/minecraft/minecraftLlmcNode.js';
import { minecraftTaskContext } from './fcaMinecraftTools.js';
import { minecraftBodyVersion } from '../surfaces/minecraft/minecraftBodyVersion.js';
import { recordedLedger } from '../surfaces/minecraft/minecraftLedgerRows.js';
import { noteHeadHold,noteHeadTail,noteHistoryChange,noteStageRow } from '../infra/decisionRecords/decisionRecordNotes.js';
import { recordedPlanner } from '../infra/decisionRecords/decisionRecordNotes.js';
import { actionResource } from '../contracts/actionThreadContract.js';
import { currentActionExecution } from '../infra/context/actionExecution.js';
import { driftWords,feet,headIncidentKind,incidentHoldPort,incidentOfResult,takeEnd,type Feet,type IncidentNote } from './minecraftIncidentHold.js';
import { headTake } from './minecraftHeadTake.js';
import { randomUUID } from 'node:crypto';
import { MC_ACT_TOOL,type ActKeep } from '../contracts/minecraftActContract.js';
import type { MadeIn } from '../contracts/continueContract.js';
import { reflexCappedWords } from '../surfaces/minecraft/minecraftLlmcBodyEvents.js';
import { heldAgainRecord,resendLimitMs,stopLineOf } from './minecraftResumeOrder.js';
export { bodyHoldOf, withResend, withIncident, HOLD_SETTLE_MS, withStalls } from './minecraftLlmcLifecycle.js';
export { LLMC_MAIN_MODEL, LLMC_ESCALATE_FAILURES, LLMC_PERMIT_WINDOW_MS, LLMC_HISTORY_POLICY, LLMC_HISTORY_HARD, LLMC_SUMMARY_OUTPUT_TOKENS,
   llmcTools, llmcModelNames, llmcModelRouter, llmcCompletionMistake, LLMC_CATALOG_SELECTOR, configuredMinecraftLlmc, llmcProbeRunner,
      billingGuarded } from './minecraftLlmcConfiguration.js';
export type { LlmcModelNames, LlmcWiring } from './minecraftLlmcConfiguration.js';

/**
 * One body task's parts in the mode: its plan (the tool, the port, the first plan asked at its first decision),
 * the body's and the body
 * tools' options, and the step ports that make its steps small (the model router, the plan, the lease window, the
 * fixed menu, the history policy).
 */
export function llmcStepParts(llmc: LlmcWiring, step: TaskStep, control: MinecraftControl, log: (line: string) => void = line => console.info(line)) {
  const bodyId = () => control.store.body(step.taskId) ?? '';
  const observe = () => control.observe(bodyId());
  // What a decision reads: the current frame, or one up to `LLMC_STALE_FRAME_MS` old (mc-chat-stale-frame).
// Commands and the watch for danger keep `observe`.
  const seen = () => control.seen(bodyId(), LLMC_STALE_FRAME_MS);
  const decided = () => seen()?.observation ?? null;
  // r5: a node whose doneWhen the frame shows is marked done before each decision reads the plan (`minecraftPlanDone.ts`).
  // Run 42: a chest node is done when an act opened the chest at its place (`chestNodesDone`), with the nodes the frame shows done.
  const plan = createFcaPlanTools({ taskId: step.taskId, checkpoint: step.snapshot.checkpoint, inbox: firstPlanInbox, log,
    validateUpdate: (before, after) => preparationCompletionProblem(before, after, observe()),
    rules: true, compact: true, onCheckpoint: () => queue.checkpointed(), onCommitted: () => queue.committed(), seen:
       tree => withChestsDone(seenDoneUpdate(tree, observe()), chestNodesDone(step.taskId, tree)),
    follow: tree => followNode(step.taskId, tree, (facts => !!facts && undergroundInOverworld(facts))(doneFacts(observe()))) });
  const worldOf = () => {
    const world = decided()?.state.world;
    return world && typeof world === 'object' && !Array.isArray(world) ? world as Record<string, unknown> : null;
  };
  // r6: the first plan begins where she is, with what the place lacks in its input; r7: the check's forbid asked
// for (`FIRST_PLAN_SYSTEM_R7`);
  // r8: a gap crossed in the rock or by a walled bridge (`FIRST_PLAN_SYSTEM_R8`); r9: the done of a node by its
// own condition, a place with
  // its dimension, the pearls after the rods, the golden armour in the check (`FIRST_PLAN_SYSTEM_R9`).
  const planner = recordedPlanner({ taskId: step.taskId, stepId: step.id }, llmc.planner);
  startFirstPlan({ taskId: step.taskId, goal: step.snapshot.task.goal, held: plan.port.tree(), planner, log, world: worldOf(),
    r4: { world: worldOf, system: ownFirstPlanSystem(), readiness: true } });
  const display = () => plan.port.display();
  // The task queue of the step (design minebot-task-queue): every `mc.act` is an item put in it, and the step
// decides again while its items run.
  // 2026-10-28, the fix run (`minecraftIncidentHold.ts`): a request asked to be held on a heavy failure sends its
// acts with `incident.hold`; the act a
  // resume sends again carries `incident.resume` (set for that one add only). Run 44: the body's hold is ended by
// the operator's resume before
  // the task is queued again (`operatorMinecraftWiring.ts`), and the act goes again from the step's start, under
// its lease and with the body's resource.
  let resend: ((signal: AbortSignal) => Promise<void>) | null = null;
  const holds = incidentHoldPort();
  const holdOn = holds?.holdRequested(step.taskId) === true;
  let resumeOf: string | null = null;
  // Continue contract 5: the observation the decision now running read (its life, dimension, body and connection):
// the acts it chooses carry it, not the newest frame's.
  let read: MadeIn | null = null;
  const events = createLlmcEvents(step.taskId);
  // Continue contract 2 and 3: the queue is named by the step; the events of a result go to the plan's one way
// into the ledger, and the promises an act says it uses
  // are kept as they are now with the command. A cleanup that did not prove the release asks the operator's hold
// (the incident port) for the task.
  const queue = createLlmcQueue({ control, taskId: step.taskId, lease: step.lease, bodyId, step: step.id,
    holdPending: () => stalls?.look() ?? false,
    context: () => withIncident(minecraftTaskContext(step, bodyId(), step.id, display()), holdOn, resumeOf), observe, log,
    applyLedger: input => recordedLedger(plan.port, input, { run: step.taskId, headBoot: control.headBoot(), record: row => noteStageRow(
      row) }), snapshotUses: ids => snapshotUses(plan.port.tree().promises, ids),
    onReflexCapped: info => events.note(reflexCappedWords(info)),
    onHeld: info => { void holds?.hold(step.taskId, { id: `cleanup:${info.command}`, heavy: true, why: `結果が不明で、解放を確かめられなかった（${info.why}）`,
       held: true, frozen: null, command: info.command })
      .catch(error => log(`Shannon Minecraft cleanup hold failed task=${step.taskId} ${String(error)}`)); } });
  queue.onRan(({ why }, result) => noteChestsOpened(step.taskId, result.text, why));
  // Run 45: the call id of the act a resume sends again (the body says when it failed for the reason it was held
// for: `incident.repeated`).
  let resent: string | null = null;
  // Chapter 8's 再開の契約: what a resume leaves for the first decision, in this order and as the first of the results
// it reads: the hold that came again (the act sent
  // again was held again; `heldAgainWords`), then the held act itself (run 45: a resume with --skip-replay does
// not send it again and the decision reads so as a fact; a
  // second try's result is added when it ends, below). The decision itself is asked after them (`beforeDecision`).
  const again = holds?.heldAgainNote?.(step.taskId) ?? null;
  if (again) offerOnce(step.taskId, 'resume', `again:${again.slice(0, 60)}`, again);
  const skipped = holds?.skipNote?.(step.taskId) ?? null;
  if (skipped) offerOnce(step.taskId, 'resume', `skipped:${skipped.slice(0, 60)}`, skipped);
  // The second try: its mark in the queue, when it was added, its longest run, and whether it was held again (then
// its result is the hold's record, not a line).
  const replay = { item: null as string | null, at: 0, maxMs: 60_000, heldAgain: false };
  if (holds && holdOn) {
    const noteIncidentResult: Parameters<typeof queue.onRan>[0] = (item, result, receipt) => {
      const incident = incidentOfResult(receipt?.result);
      if (incident?.repeated && !incident.held && receipt && resent !== null && item.call.id === resent) {
        // Run 45 (holds 3 to 5): the body did not hold again; the next decision reads the result (its receipt) and this fact.
        log(`Shannon Minecraft incident replay failed the same way task=${step.taskId} incident=${incident.id} why=${incident.why.slice(0,
           80)} (no hold again)`);
        createLlmcEvents(step.taskId).note(`保留から出し直した act は同じ理由（${incident.why.slice(0, 60)}）でまた失敗した。もう保留せず、この結果から判断する`);
        holds.repeated?.(step.taskId, { ...incident, command: receipt.id });
        return;
      }
      if (incident && receipt && !incident.held && incident.notHeld) {
        // Run 44: the world could not be stopped, so the body did not hold; the task goes on and the operator reads why.
        log(`Shannon Minecraft incident not held task=${step.taskId} incident=${incident.id} why=${incident.why.slice(0,
           80)} freeze=${incident.notHeld.slice(0, 80)}`);
        holds.notHeld(step.taskId, { ...incident, command: receipt.id });
        return;
      }
      // Run 44, resume 1: the body refused the act as held while the head runs the task (a hold the head had ended, or
// never had): the head goes
      // back to held at once, so no decision is paid for while every act is refused (once 25 in two minutes).
      const refusedHold = () => (receipt?.failureType === 'held' ? bodyHoldOf(receipt.result) : null);
      const refused = refusedHold();
      if (refused) {
        log(`Shannon Minecraft incident body held task=${step.taskId} incident=${refused.incident} (the head goes back to held)`);
        void holds.bodyHeld(step.taskId, { ...refused, seen: 'refused' }).catch(error => log(
          `Shannon Minecraft incident body held failed task=${step.taskId} ${String(error)}`));
        return;
      }
      if (!incident?.held || !receipt) return;
      log(("Shannon Minecraft incident hold task=" +
`${step.taskId}` +
" incident=" +
`${incident.id}` +
" frozen=" +
`${String(incident.frozen)}` +
" why=" +
`${incident.why.slice(0, 80)}` +
""));
      // Chapter 8's 再開 9 → 保留 10: the act a resume sent again was held again; the record says how it ended and what
// the queue lost meanwhile.
      const isResentItem = () => (resent !== null && item.call.id === resent);
      const second = isResentItem();
      if (second) replay.heldAgain = true;
      const replayRecord = () => (second ? heldAgainRecord({ resultText: stopLineOf(receipt.result) || result.text, why: incident.why, replayItem:
         replay.item, dropped: queue.droppedSince(replay.at), open: queue.openItems() }) : null);
      const record = replayRecord();
      void holds.hold(step.taskId, { ...incident, command: receipt.id, ...(record ? { replay: record } : {}) })
        .catch(error => log(`Shannon Minecraft incident hold failed task=${step.taskId} ${String(error)}`));
    };
queue.onRan(noteIncidentResult);
    const pending = holds.resumePending(step.taskId);
    // Amendment A-12: a task resumed from a hold counts its stalls again from nothing.
    if (pending) resumeStalls(step.taskId);
    // Continue contract 8: the history of this step's first decision comes from a hold's resume (the record says so,
// apart from the experiment's own changes).
    if (pending) noteHistoryChange(step.taskId, 'resume');
    // Run 44, resume 1: the act was sent while the step's ports were made, outside the step's execution and before
// its lease held the body: the
    // control refused it (FCA_BODY_LEASE_INVALID) and it never reached the body. It goes from the step's start now
// (`wrap` below), as a tool's does:
    // the task bound to the body, the body's resource permitted to the step's lease, then the queue.
    if (pending) resend = async signal => {
    const sent = pending.command ? control.store.command(pending.command) : null;
    if (!sent || sent.skill !== 'act' || !sent.arguments) {
      const missingResendWords = () => (pending.command ? `再送できなかった: act ${pending.command} が見つからない`
        : headIncidentKind(pending.incident) ? `再送しなかった: 頭が見つけた詰まり（${headIncidentKind(pending.incident)}）の保留で、出し直す act が無い。計画の続きから判断する`
          : '再送しなかった: 体の断りから戻した保留で、出し直す act が無い。計画の続きから判断する');
      holds.resumeChecked(step.taskId, missingResendWords());
      return;
    }
    // Boundary 8 (continue contract 1): an act whose result is not known is never sent again, by the head or by a
// resume; the hold is ended and the next decision looks at the world.
    if (control.store.resultUnknown(sent.id)) { holds.resumeChecked(step.taskId,
       `再送しなかった: act ${sent.id} の結果が不明（解放を確かめていない、または不明のまま）。不明の項目は出し直さない。世界を見て判断する`); return; }
    const body = bodyId(), active = currentActionExecution();
    if (!body || !control.store.bind(step.taskId, body)) { holds.resumeChecked(step.taskId, '再送できなかった: タスクに体が結び付いていない');
      return; }
    if (!active || active.lease.id !== step.lease.id || !await active.permit([actionResource(control.configuration.deviceId, 'minecraft-body')], signal)) {
      holds.resumeChecked(step.taskId, '再送できなかった: この段の lease に体の使用が許されなかった');
      return;
    }
    {
      const args = sent.arguments as Record<string, unknown>;
      resent = `resume:${sent.id}`;
      replay.at = Date.now();
      const replayedMaxMs = () => (Number(sent.queue?.maxMs ?? 60_000));
      replay.maxMs = replayedMaxMs();
      resumeOf = pending.incident;
      const resumedQueueItem = (): Parameters<typeof queue.add>[0] => ({ call: { id: `resume:${sent.id}`, name: MC_ACT_TOOL, input: args },
         operationId: `resume:${randomUUID()}`, input: args as never,
        arguments: args, skill: 'act', node: sent.queue?.node ?? null, current: null, why: String(args.why ?? ''), fixes: [],
        maxMs: Number(sent.queue?.maxMs ?? 60_000), resumeOf: { item: sent.queue?.item ?? sent.id, command: sent.id } });
      const added = queue.add(resumedQueueItem());
      resumeOf = null;
      log(`Shannon Minecraft incident resume task=${step.taskId} incident=${pending.incident} resend=${sent.id}`);
      const first = { done: false };
      // 2026-10-28: how far the body is, when the act goes again, from where it began (the operator decides what the
// fix includes; the body never goes back by itself).
      const at = (observe()?.state.world as { position?: { x?: number; y?: number; z?: number } } | undefined)?.position;
      const drift = driftWords(pending.start, at && typeof at.x === 'number' ? [at.x, at.y ?? 0, at.z ?? 0] : null);
      log(`Shannon Minecraft incident resume position task=${step.taskId} ${drift}`);
      queue.onRan((item, result) => {
        if (first.done || item.call.id !== `resume:${sent.id}`) return;
        first.done = true;
        // The second try's result is the first line the decision reads (after the hold that came again), unless it was
// held again: then the hold's record has it.
        if (!replay.heldAgain) events.keep(result.text);
        holds.resumeChecked(step.taskId, `再開の確かめ（${drift}）: 同じ act を出し直した → ${result.ok ? '成功' : '失敗'}: ${result.text.replace(/\s+/gu, ' ').slice(0, 380)}`);
      });
      await added.then(answer => { if (answer.ok) replay.item = answer.item;
        if (!answer.ok) { first.done = true;
        holds.resumeChecked(
        step.taskId, `再送を列が断った: ${answer.text.slice(0, 200)}`); } },
        error => { first.done = true;
          holds.resumeChecked(step.taskId, `再送できなかった: ${String(error).slice(0, 200)}`); });
    }
    };
  }
  // Amendment A-12: the stalls the head finds itself hold a request that asked to be held, as the body's heavy
// failures do (`minecraftLlmcStalls.ts`). The body holds nothing for them
  // (its box and scene are not taken and the world is not stopped): the head writes its own box (the reason and
// the last rows of the decision record) and the hold's audit line names it.
  const stalls = holds && holdOn ? (() => {
    const feetNow = (): Feet | null => {
      const at = (observe()?.state.world as { position?: { x?: unknown; y?: unknown; z?: unknown } } | undefined)?.position;
      return feet([at?.x, at?.y, at?.z]);
    };
    let holding: Promise<void> | null = null;
    let commitHold: (() => Promise<boolean>) | null = null;
    const headHold = (stall: Stall, byBody: IncidentNote | null = null, deferStop = false): void => {
      if (holding) return;
      // The body decided about this very result (it holds, or it did not hold on purpose, or the same act failed the
// same way again): its incident is the one.
      if (byBody && (byBody.held || byBody.notHeld || byBody.repeated)) {
        log(`Shannon Minecraft head stall left to the body task=${step.taskId} kind=${stall.kind} incident=${byBody.id}`);
        if (!byBody.held) resumeStalls(step.taskId);
        return;
      }
      // The body's frame shows a hold of its own: the head follows it (`bodyHeld`); two holds would disagree at the resume.
      if ((observe()?.state as { incidentHold?: unknown } | undefined)?.incidentHold) {
        log(`Shannon Minecraft head stall left to the body's hold task=${step.taskId} kind=${stall.kind}`);
        return;
      }
      const id = stallIncidentId(stall, Date.now()), at = feetNow(), tree = plan.port.tree();
      // Amendment A-12: the body is asked to hold too (a release carrying `incident.take`: the world stopped, the scene, a box with the
// last rows of the decision record as notes); what it
      // answers is in the head's box and in the hold's audit line. Whatever it answers, the head holds: a world it did not stop
// (`notHeld`), another hold it keeps, no answer at all are told.
      // The hold itself is asked for, not waited for (its stop waits for this step).
      holding = (async () => {
        const asked = await headTake({ control, step, bodyId: bodyId(), id, why: stall.why, notes: noteHeadTail(step.taskId) });
        const take = asked.sent ? asked.take : null, end = take ? takeEnd(take) : 'failed';
        const record = noteHeadHold(step.taskId, { id, kind: stall.kind, why: stall.why, detail: { current: tree.current, ...(at ? { feet:
           at } : {}), ...(stall.at ? { stoppedAt: stall.at } : {}),
          ...(stall.command ? { command: stall.command } : {}), take: end, body: take ?? { unanswered: asked.sent ? '' : asked.why } } });
        log(("Shannon Minecraft head stall task=" +
`${step.taskId}` +
" kind=" +
`${stall.kind}` +
" incident=" +
`${id}` +
" why=" +
`${stall.why.slice(0,
           100)}` +
" take=" +
`${end}` +
"" +
`${take?.notHeld ? ` notHeld=${take.notHeld.slice(0, 60)}` : ''}` +
"" +
`${take &&
              end === 'other_hold' ? ` bodyHold=${take.hold}` : ''}` +
"" +
`${asked.sent ? '' : ` unanswered=${asked.why}`}` +
" record=" +
`${record ?? '-'}` +
""));
        const hold = () => holds.hold(step.taskId, { id, heavy: true, why: stall.why, held: true, frozen:
           end === 'held' ? take?.frozen ?? true : false, command: stall.command ?? '', take: end,
          ...(take?.freeze ? { freeze: take.freeze } : {}), ...(take?.notHeld ? { notHeld: take.notHeld } : {}), ...(take?.box ? { box:
             take.box } : {}), ...(take?.scene ? { scene: take.scene } : {}),
          ...(end === 'other_hold' && take?.hold ? { bodyHold: take.hold } : {}), ...(take?.again ? { again: true } : {}), ...(record ? {
             record } : {}), ...(at ? { start: at, end: at } : {}) })
          .catch(error => { log(`Shannon Minecraft head stall hold failed task=${step.taskId} ${String(error)}`);
            return false; });
        if (deferStop) commitHold = hold;
        else void hold(); // stop waits for this step to close; the audit and stop request are published synchronously.
      })().catch(error => log(`Shannon Minecraft head stall take failed task=${step.taskId} ${String(error)}`));
    };
    const look = (): boolean => {
      if (holding) return true;
      try {
        const frame = observe(), tree = plan.port.tree(), current = workingNode(step.taskId, tree.current) ?? tree.current, node =
           tree.nodes.find(item => item.id === current);
        const counts = doneFacts(frame)?.counts;
        const stall = noteDeath(step.taskId, deathCounterOf(frame)) ?? noteProgress(step.taskId, { node: current, state: node?.state ?? null,
          milestone: meterParts(tree, frame, 0)?.next ?? null, reached: reachedMilestoneNames(tree, frame) ?? [],
          inventory: counts ? Object.fromEntries(counts) : {}, items: counts ? [...counts.values()].reduce((sum, count) => sum + count, 0) :
             0 }, Date.now() - (holds.heldMs?.(step.taskId) ?? 0));
        if (stall) headHold(stall);
        return stall !== null;
      } catch (error) {
        log(`Shannon Minecraft head stall look failed task=${step.taskId} ${String(error)}`);
        return false;
      }
    };
    const noteQueueResult: Parameters<typeof queue.onRan>[0] = (item, _result, receipt) => {
      try {
        const input = item.call.input as { hands?: unknown } | null;
        const stall = noteRan(step.taskId, { hands: Array.isArray(input?.hands) ? input.hands : [], result: receipt?.result, ...(
          receipt?.id ? { command: receipt.id } : {}) });
        if (stall) headHold(stall, incidentOfResult(receipt?.result));
        else look();
      } catch (error) { log(`Shannon Minecraft head stall ran failed task=${step.taskId} ${String(error)}`); }
    };
queue.onRan(noteQueueResult);
    // The `redecide` rows of the decision record (a failure, a refusal) come from inside the tools: they reach this step by the task.
    watchStalls(step.taskId, stall => headHold(stall));
    // `mc.act` refused before sending, `STALL.refusals` times in a row (`noteRefusal`); true when the answer was
// about a stall (nothing more to look at).
    const refused = (call: FcaToolCall, result: ToolResult): boolean => {
      if (call.name !== MC_ACT_TOOL || (!result.ok && result.failure !== 'refused' && result.failure !== 'invalid_input')) return false;
      // A-18 (runs 46: a wait asked again beside its twin; a wait asked past the urgent limit, twice): only an act
// that could not be sent for its FORM or a VALUE (`invalid_input`: a
      // word not read, out of range, missing, the wrong type) is the model's mistake and counts. Every `refused` is
// the world's or the queue's answer (the same work is in the
      // queue, the urgent limit, the queue is full, the body is stopped, a precondition does not hold, a fight guard):
// the model reads it and decides again; a request that does
      // not move for it is found by node_stalled, wait_loop and same_spot_stops. Such an answer ends the run of wrong
// forms, as an accepted act does.
      const wrong = !result.ok && result.failure === 'invalid_input';
      const stall = noteRefusal(step.taskId, wrong ? { accepted: false, why: result.text.split('\n').find(line => line.trim(
        )) ?? result.text } : { accepted: true });
      if (stall) headHold(stall);
      return stall !== null;
    };
    // A-20 (run 47: the credit ran out): the decision was refused for the account's credit. The request is held (the
// body is asked to hold, the audit's hold row, the owner's stop path) with
    // the reason billing, and the runner pauses it (`pauseForBilling`); the operator resumes it when the balance is filled.
    const billing = (): void => headHold({ kind: 'decide_error', key: 'billing', why: 'Anthropic の利用残高が足りず（課金・残高の誤り）、判断を頼めなかった。理由 billing。補充の後に resume で続ける' });
    return { look, refused, billing, settled: () => holding ?? Promise.resolve(),
      prepareStop: async (reason: string) => {
        headHold({ kind: 'decide_error', key: reason, why: `判断の失敗停止（${reason}）。世界と現場を保全して、修正後の resume を待つ` }, null, true);
        await holding;
        return { committed: async () => { await commitHold?.(); } };
      } };
  })() : null;
  const bodyParts = { plan: display, planView: () => plan.port.view(), planTree: () => plan.port.tree() };
  // Amendment A-10: the model that decided this step (the main one, or the escalation while the task is stuck); an
// act of it that would break a promise is decided again by Opus
  // (`FcaModel.redecide`: the step's last request with the act and the promise line added). Opus's plan.update
// goes through the plan's own tool, and one the model already
  // made in this step (the same input) is not made twice.
  const model = llmcModelRouter(llmc.models, step.snapshot.checkpoint, log, step.taskId);
  const planned = new Set<string>();
  const planTools: typeof plan.tools = { ...plan.tools, execute: call => {
    if (call.name === PLAN_UPDATE_TOOL) planned.add(JSON.stringify(call.input));
    return plan.tools.execute(call);
  } };
  const redecide: RedecidePort | undefined = model.redecide ? { label: redecideLabel(model === llmc.models.escalate &&
     llmc.names.escalate ? llmc.names.escalate : llmc.names.main),
    ask: (note, signal) => model.redecide!({ taskId: step.taskId, note, signal, timeoutMs: REDECIDE_GIVE_UP_MS }),
    planUpdate: async (input, signal, operationId) => {
      const key = JSON.stringify(input);
      if (planned.has(key)) return toolOk('同じ plan.update はこの段で通してある');
      planned.add(key);
      return plan.tools.execute({ scopeKey: step.scopeKey, taskId: step.taskId, operationId, name: PLAN_UPDATE_TOOL, input, signal });
    },
    log } : undefined;
  // r4: the current node's place (a find-blocks far from it is a surprise) and the body's probe.
  const planWhere = () => {
    const tree = plan.port.tree();
    return tree.nodes.find(node => node.id === tree.current)?.where ?? null;
  };
  const stepPorts = () => ({
    // No image reflex of the head in the mode (r2), and none offered as a tool (r3): no entry, no selector.
    body: { llmc: bodyParts, fastJudgment: false, entry: null, selector: null, openIds: () => queue.openIds() },
    tools: { llmc: { plan: display, urgent: () => urgentDecision(step.taskId), queue, madeIn: () => read,
      // Amendment A-7 1: an act's `keep` becomes promises of the plan, by the plan's own handling (the same as
// `plan.update`'s promise op).
      keep: (entry: ActKeep) => plan.port.keepPromise?.(entry) ?? { problem: 'この計画には約束を書けない' },
      promises: () => plan.port.tree().promises, ...(redecide ? { redecide } : {}) } },
    planTools,
    /** The body's lifecycle with the mode's live state and events (`withLlmcBody`). */
    wrap: (lifecycle: FcaBodyLifecycle) => withStalls(withResend(withLlmcBody(lifecycle, { llmc: bodyParts, taskId: step.taskId, createdAt:
       step.snapshot.task.createdAt,
      observe, seen, arrival: () => ({ at: control.arrivedAt(bodyId()), kind: control.arrivalKind(bodyId()) }), log, queue,
      // Continue contract 5: each decision's context names the frame it read; the acts it chooses carry it, and its
// answer is checked against the newest frame.
      headBoot: () => control.headBoot(), onRead: value => { read = value; }, heldMs: () => holds?.heldMs?.(step.taskId) ?? 0,
      // r5: the fact of a surprise met the second time, noted on the current node (at most 4, the oldest goes).
      r4: { probe: llmcProbeRunner(control, step), planWhere,
        caution: (text: string) => plan.port.amend?.({ ops: [{ op: 'caution', text }] }, 'noted') === true } }), resend, log, step.taskId,
      { open: () => queue.open(), limitMs: () => resendLimitMs(replay.maxMs) }), stalls),
    /** The step's ports with the mode's menu (`llmcTools`). */
    menu: <T extends { tools?: FcaExternalTools }>(ports: T): T => ports.tools
      // The completion reads the frame a decision reads (the current one, or one up to `LLMC_STALE_FRAME_MS` old): a stall of the
      // API's thread must not turn a done task back.
      ? { ...ports, tools: llmcTools(ports.tools, { tree: () => plan.port.tree(), observe: decided, goal: step.snapshot.task.goal }) } : ports,
    ports: { model: stalls ? billingGuarded(model, stalls.billing) : model, plan: plan.port,
      ...(stalls ? { prepareStop: stalls.prepareStop } : {}),
      // The decision records name the body's connection and catalog beside each request (`minecraftBodyVersion.ts`).
      versions: () => minecraftBodyVersion(control, bodyId(), read),
      completionMistake: llmcCompletionMistake(step.snapshot.task.goal),
      permitWindowMs: LLMC_PERMIT_WINDOW_MS, selector: LLMC_CATALOG_SELECTOR,
      history: { codec: anthropicFcaHistoryCodecV2,
        ...(llmc.summarizer ? { summarizer: llmc.summarizer } : {}), policy: llmc.policy,
        ahead: { port: llmc.historyAhead, hard: LLMC_HISTORY_HARD } },
      // r3: the old path's evidence (its expectations, appraisals and shared context) is not the mode's: in run 27 it walked the task's
      // sources 114 times (about 51 s of the API's one thread) and wrote 1,600 characters of shared context into every live state.
      evidence: undefined },
  });
  return stepPorts();
}
/** A body task's lifecycle: wrapped for the mode when the task is one of it. */
export function llmcLifecycle(small: ReturnType<typeof llmcStepParts> | null, lifecycle: FcaBodyLifecycle): FcaBodyLifecycle {
  return small ? small.wrap(lifecycle) : lifecycle;
}
