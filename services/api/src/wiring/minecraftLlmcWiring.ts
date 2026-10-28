import type Anthropic from '@anthropic-ai/sdk';
import { anthropicApiKey } from '../infra/models/anthropic/anthropicConfig.js';
import { createAnthropicFcaModel, type AnthropicFcaOptions, type AnthropicFcaUsage } from '../infra/models/anthropic/anthropicFcaModel.js';
import { createAnthropicFcaSummarizer } from '../infra/models/anthropic/anthropicFcaSummary.js';
import { DEFAULT_HAIKU_MODEL, isHaikuModel, OPUS_MODEL } from '../infra/models/anthropic/haikuConfig.js';
import { claudeClient } from '../infra/models/claude/claudeClient.js';
import { structuredBody } from '../infra/models/claude/claudeStructured.js';
import { closedUsage, estimatedAnthropicCostUsd, knownCount, unknownCostUpperBound } from '../infra/models/claude/claudeUsage.js';
import type { FcaExternalTools, FcaModel } from '../mind/action/fca/fcaPorts.js';
import type { FcaHistoryAhead, FcaHistoryPolicy } from '../mind/action/fca/fcaHistoryPorts.js';
import { createFcaHistoryAhead } from '../mind/action/fca/fcaHistory.js';
import type { FcaToolSelector } from '../mind/selectors/selectorsPorts.js';
import type { TaskStep } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import { createFcaPlanTools } from '../mind/action/fca/fcaPlanTools.js';
import { firstPlanInbox, planGoal, startFirstPlan } from '../surfaces/minecraft/minecraftFirstPlan.js';
import { COMPLETION_WAY, observedCompletion, withCompletionRule, type LlmcCompletion } from '../surfaces/minecraft/minecraftLlmcCompletion.js';
import type { FcaBodyLifecycle } from '../mind/action/fca/fcaPorts.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import { createLlmcEvents, urgentDecision, withLlmcBody } from '../surfaces/minecraft/minecraftLlmcBody.js';
import { LLMC_STALE_FRAME_MS } from '../surfaces/minecraft/minecraftLlmcLive.js';
import { createLlmcQueue } from '../surfaces/minecraft/minecraftLlmcQueue.js';
import { anthropicFcaHistoryCodecV2 } from '../infra/models/anthropic/anthropicFcaHistory.js';
import { minecraftV2Hooks, v2MenuTool } from '../surfaces/minecraft/minecraftLlmcV2.js';
import { ownFirstPlanSystem } from '../surfaces/minecraft/minecraftStrategy.js';
import { FIRST_PLAN, FIRST_PLAN_SCHEMA_R4 } from '../surfaces/minecraft/minecraftFirstPlan.js';
import { doneFacts, seenDoneUpdate, undergroundInOverworld, withChestsDone } from '../surfaces/minecraft/minecraftPlanDone.js';
import { chestNodesDone, followNode, noteChestsOpened } from '../surfaces/minecraft/minecraftLlmcNode.js';
import { amendAnthropicControl } from '../infra/models/anthropic/anthropicFcaControl.js';
import type { FcaCompletionMistake } from '../mind/action/fca/fcaCompletionMistake.js';
import { LLMC_PROBE } from '../surfaces/minecraft/minecraftLlmcProbe.js';
import { MC_PROBE_SKILL, type ProbeInput } from '../contracts/minecraftProbeContract.js';
import { abortedRouteUsage } from './minecraftRouteWiring.js';
import { minecraftTaskContext } from './fcaMinecraftTools.js';
import { minecraftBodyVersion } from '../surfaces/minecraft/minecraftBodyVersion.js';
import { recordedClient } from '../infra/decisionRecords/decisionRecordClient.js';
import { recordedPlanner } from '../infra/decisionRecords/decisionRecordNotes.js';
import { createHash } from 'node:crypto';
import { actionResource } from '../contracts/actionThreadContract.js';
import { currentActionExecution } from '../infra/context/actionExecution.js';
import { driftWords, incidentHoldPort, incidentOfResult } from './minecraftIncidentHold.js';
import { randomUUID } from 'node:crypto';
import { MC_ACT_TOOL } from '../contracts/minecraftActContract.js';
import type { BodyTaskContext } from '../contracts/bodyControlContract.js';

/**
 * The models of a Minecraft body task's decisions (design mb-llm-centric; owner 2026-10-21: the main model is chosen after replaying scenes with
 * Haiku, Sonnet and Opus, so each may be set by the environment):
 * - `SHANNON_MINECRAFT_LLMC_MODEL`: the main model of a decision (default claude-opus-5-5, the model of every run since run 30).
 * - `SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL`: the model a decision is raised to while the task is stuck (`LLMC_ESCALATE_FAILURES` failed
 *   steps in a row): a model's name, or `next` (`on`) for the next one up (Haiku → Sonnet, Sonnet → Opus). r5 (run 28: raised 9 times,
 *   23% of the cost, and the same stops went on: they were the body's faults): unset or `none`, never.
 * - `SHANNON_MINECRAFT_LLMC_PLAN_MODEL`: the first plan's model (default claude-opus-5-5).
 * Each decision model carries the mode's instructions and knowledge in its cached instructions (`minecraftV2Hooks`).
 */
export const LLMC_MAIN_MODEL = OPUS_MODEL;
export const LLMC_ESCALATE_FAILURES = 2;
/** One lease grant serves the step (`FcaStepPorts.permitWindowMs`): the body tools and the commit check it on their own. */
export const LLMC_PERMIT_WINDOW_MS = 30_000;
/** A summary about every 40 small steps (design 2.3), by Haiku: the newest 6 kept whole. */
export const LLMC_HISTORY_POLICY: Readonly<Partial<FcaHistoryPolicy>> = Object.freeze({
  maximumRounds: 46, recentRounds: 6, maximumConversationTokens: 40_000, compactedConversationTokens: 8_000,
});
/**
 * r3 (run 27: eight summaries waited for in their steps, 169 s, up to 36 s): past `LLMC_HISTORY_POLICY` the summary is asked beside the
 * steps and installed when ready; a step waits for it (at most 30 s) only past these bounds.
 */
export const LLMC_HISTORY_HARD: Readonly<Partial<FcaHistoryPolicy>> = Object.freeze({ maximumRounds: 70, maximumConversationTokens: 56_000 });
/** The summarizer's output ceiling (run 27: three summaries cut at 4,000 tokens, `FCA_MODEL_TRUNCATED`, each a fallback epoch). */
export const LLMC_SUMMARY_OUTPUT_TOKENS = 8_000;

/**
 * A body task's tools in the mode: six, fixed (mc.act, mc.probe, mc.view, plan.update and the model's two controls; `v2MenuTool`), no skill index,
 * and the goal progress without its list of failed calls (run 27: the list grew with every failed act and the whole progress was stated again in
 * the history each time, about 2,800 characters a round; each act's own result says how it failed).
 */
export function llmcTools(tools: FcaExternalTools, completion?: LlmcCompletion): FcaExternalTools {
  const { skillIndex: _index, ...rest } = tools;
  const progress = tools.progress;
  return { ...rest, definitions: tools.definitions.filter(tool => v2MenuTool(tool)),
    ...(progress ? { progress: { ...progress, context: () => withCompletionRule({ ...progress.context(), failures: [], replans: [] }, completion),
      // A completion of a task bound to no goal is checked by its plan and the new frame (`minecraftLlmcCompletion.ts`), not by conditions
      // the model would set with a tool the mode does not offer.
      ...(completion ? { async verifyCompletion(call, permit) {
        const result = await progress.verifyCompletion(call, permit);
        return result.status === 'not_verified' && result.bindingId === null ? observedCompletion(result, completion) : result;
      } } : {}) } } : {}) };
}

const MODELS = new Set([DEFAULT_HAIKU_MODEL, 'claude-sonnet-5-5', OPUS_MODEL]);
const known = (value: string | undefined, fallback: string) => {
  const model = value?.trim();
  return model && MODELS.has(model) ? model : fallback;
};
const nextUp = (model: string) => isHaikuModel(model) ? 'claude-sonnet-5-5' : model === 'claude-sonnet-5-5' ? OPUS_MODEL : null;

export interface LlmcModelNames { main: string; escalate: string | null; plan: string }
/** The three models from the environment; an unknown name falls back to the default (and is logged without its value by the caller). */
export function llmcModelNames(values: Readonly<Record<string, string | undefined>>): LlmcModelNames {
  const main = known(values.SHANNON_MINECRAFT_LLMC_MODEL, LLMC_MAIN_MODEL);
  const raised = values.SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL?.trim();
  const escalate = raised === 'next' || raised === 'on' ? nextUp(main) : raised && MODELS.has(raised) && raised !== main ? raised : null;
  return { main, escalate, plan: known(values.SHANNON_MINECRAFT_LLMC_PLAN_MODEL, OPUS_MODEL) };
}

/** The key for a model (Haiku may have its own). */
function keyFor(values: Readonly<Record<string, string | undefined>>, model: string): string | null {
  return isHaikuModel(model) ? values.SHANNON_HAIKU_API_KEY?.trim() || anthropicApiKey(values) : anthropicApiKey(values);
}

/**
 * Picks the model of one decision: the escalation model while the task's failed steps in a row (`consecutiveToolFailures` of the step's
 * checkpoint) are `LLMC_ESCALATE_FAILURES` or more, else the main one. Each model keeps its own cache; a raised decision reads the history
 * without the main model's thinking (blocks are bound to their model) and writes its own prefix once.
 */
export function llmcModelRouter(models: { main: FcaModel; escalate: FcaModel | null }, checkpoint: unknown, log?: (line: string) => void,
  taskId = ''): FcaModel {
  const failures = Number((checkpoint as { consecutiveToolFailures?: unknown } | null)?.consecutiveToolFailures ?? 0);
  const raised = models.escalate && Number.isSafeInteger(failures) && failures >= LLMC_ESCALATE_FAILURES;
  if (raised) {
    try { log?.(`Shannon Minecraft model raised task=${taskId} failures=${failures}`); } catch { /* logging never fails a step */ }
  }
  return raised ? models.escalate! : models.main;
}

/**
 * r5: the one line a turned-back completion is answered with (`FcaStepPorts.completionMistake`; run 28: the receipt said only "received", and
 * the next decisions asked again, three in 11 s): what it was, what a completion is for this goal, and to go on.
 */
export function llmcCompletionMistake(goal: string): FcaCompletionMistake {
  const seen = planGoal(goal) === 'dragon' ? 'ドラゴンの死を見た時だけ' : planGoal(goal) === 'nether' ? 'ネザーに入った時だけ' : '依頼の目的を観測した時だけ';
  return { line: (inARow, reason) => reason ? `完了の誤り（続けて ${inARow} 回目）: ${reason}。${COMPLETION_WAY}`
    : `完了の誤り（続けて ${inARow} 回目）: 依頼の達成は、まだ観測で確かめられない。完了は${seen}。`
    + '時間や遠さで区切らない。届かないと思ったら、計画を見直して続ける（時間と費用の上限は運用者が止める）。', amend: amendAnthropicControl };
}

/** The mode's menu is fixed (the body's tools of the mode, plan, goal and task tools): no selector call between decisions. */
export const LLMC_CATALOG_SELECTOR: FcaToolSelector = {
  async select(request) {
    request.signal.throwIfAborted();
    return { names: request.tools.map(tool => tool.name), source: 'catalog' };
  },
};

/**
 * The mode of a Minecraft body task (owner 2026-10-24: 「切り替える仕組みもいらない。常に最新版を使っていい」): one mode, no switch. The probe of a
 * surprise and `mc.probe`, the task's own words, the act preflight and the six fixed tools with the mode's live state and guards are always on.
 */
export interface LlmcWiring {
  names: LlmcModelNames;
  models: { main: FcaModel; escalate: FcaModel | null };
  summarizer: ReturnType<typeof createAnthropicFcaSummarizer> | null;
  policy: Readonly<Partial<FcaHistoryPolicy>>;
  planner?: (system: string, input: string, signal: AbortSignal) => Promise<unknown>;
  /** r3: the summaries made beside the steps, by task. */
  historyAhead: FcaHistoryAhead;
}

/**
 * The mode's models, made once (each with the mode's instructions), its Haiku summarizer and its first-plan planner. Null only without a key for
 * the main model (logged).
 */
export function configuredMinecraftLlmc(values: Readonly<Record<string, string | undefined>>,
  base: Omit<AnthropicFcaOptions, 'model' | 'apiKey' | 'systemAppendix'>, parts: { log?(line: string): void; client?: PlanClient } = {}): LlmcWiring | null {
  const names = llmcModelNames(values), log = parts.log ?? (line => console.info(line));
  const make = (model: string) => {
    const apiKey = keyFor(values, model);
    return apiKey || base.client ? createAnthropicFcaModel({ ...base, model, ...(apiKey ? { apiKey } : {}),
      minecraftOwnPrompt: true, minecraftV2: minecraftV2Hooks() }) : null;
  };
  const main = make(names.main);
  if (!main) {
    log('Shannon Minecraft LLM-centric off: no key for its main model');
    return null;
  }
  const haikuKey = keyFor(values, DEFAULT_HAIKU_MODEL);
  log(`Shannon Minecraft LLM-centric models main=${names.main} escalate=${names.escalate ?? 'none'} plan=${names.plan}`);
  return { names, models: { main, escalate: names.escalate ? make(names.escalate) : null },
    summarizer: haikuKey || base.client
      ? createAnthropicFcaSummarizer({ ...base, model: DEFAULT_HAIKU_MODEL, ...(haikuKey ? { apiKey: haikuKey } : {}), body: true,
        minecraftOwnPrompt: true, minecraftV2Facts: true, maximumOutputTokens: LLMC_SUMMARY_OUTPUT_TOKENS }) : null,
    policy: LLMC_HISTORY_POLICY, historyAhead: createFcaHistoryAhead(),
    ...firstPlanner(values, names.plan, base.recordUsage, log, parts.client) };
}

/**
 * r4: the way to send one fixed probe of a surprise to the task's body, or null while the body is not there or has no `probe` (its
 * catalog). The command goes in the step's lease with the body's resource, as every body command does (the control refuses a lease
 * without it; the body itself runs a probe beside an act), its deadline `LLMC_PROBE.commandMs`; an answer that does not come is null (the
 * investigation waits less than that and goes on).
 */
export function llmcProbeRunner(control: MinecraftControl, step: TaskStep): () => ((input: ProbeInput, index: number) => Promise<string | null>) | null {
  return () => {
    const bodyId = control.store.body(step.taskId) ?? '';
    const frame = bodyId ? control.frame(bodyId) : null;
    if (!frame?.poll.skills?.some(skill => skill.name === MC_PROBE_SKILL)) return null;
    return async (input, index) => {
      const active = currentActionExecution();
      if (!active || active.lease.id !== step.lease.id
        || !await active.permit([actionResource(control.configuration.deviceId, 'minecraft-body')], AbortSignal.timeout(LLMC_PROBE.commandMs))) return null;
      const receipt = await control.command({ id: `probe:${createHash('sha256').update(`${step.id}:${index}`).digest('hex')}`,
        context: minecraftTaskContext(step, bodyId), lease: step.lease, kind: 'skill', skill: MC_PROBE_SKILL,
        arguments: input as unknown as Record<string, unknown>, milliseconds: LLMC_PROBE.commandMs });
      return receipt.outcome === 'completed' ? receipt.result ?? null : null;
    };
  };
}

/** The hold a body named when it refused an act as held (「保留中（<id>: <why>）…」), or null. */
export function bodyHoldOf(result: string | undefined): { incident: string; why: string } | null {
  const found = /保留中（([^:：）]+)[:：]\s*([^）]*)）/u.exec(result ?? '');
  return found ? { incident: found[1]!.trim(), why: found[2]!.trim() } : null;
}
/** Run 44: the held act sent again once the step has begun (inside its execution, where its lease may take the body), then the step as ever. */
function withResend(lifecycle: FcaBodyLifecycle, resend: ((signal: AbortSignal) => Promise<void>) | null, log: (line: string) => void, taskId: string): FcaBodyLifecycle {
  if (!resend) return lifecycle;
  const start = lifecycle.start.bind(lifecycle);
  let sent = false;
  return Object.assign(lifecycle, { start(signal: AbortSignal) {
    start(signal);
    if (sent) return;
    sent = true;
    void resend(signal).catch(error => log(`Shannon Minecraft incident resend failed task=${taskId} ${String(error)}`));
  } });
}

/** The command context with the fix run's incident fields (`minecraftIncidentHold.ts`): unchanged when there is nothing to say. */
export function withIncident(context: BodyTaskContext, hold: boolean, resume: string | null): BodyTaskContext {
  if (!hold && !resume) return context;
  return { ...context, incident: { ...(hold ? { hold: true } : {}), ...(resume ? { resume } : {}) } };
}

/**
 * One body task's parts in the mode: its plan (the tool, the port, the first plan asked at its first decision), the body's and the body
 * tools' options, and the step ports that make its steps small (the model router, the plan, the lease window, the
 * fixed menu, the history policy).
 */
export function llmcStepParts(llmc: LlmcWiring, step: TaskStep, control: MinecraftControl, log: (line: string) => void = line => console.info(line)) {
  const bodyId = () => control.store.body(step.taskId) ?? '';
  const observe = () => control.observe(bodyId());
  // What a decision reads: the current frame, or one up to `LLMC_STALE_FRAME_MS` old (mc-chat-stale-frame). Commands and the watch for danger keep `observe`.
  const seen = () => control.seen(bodyId(), LLMC_STALE_FRAME_MS);
  const decided = () => seen()?.observation ?? null;
  // r5: a node whose doneWhen the frame shows is marked done before each decision reads the plan (`minecraftPlanDone.ts`).
  // Run 42: a chest node is done when an act opened the chest at its place (`chestNodesDone`), with the nodes the frame shows done.
  const plan = createFcaPlanTools({ taskId: step.taskId, checkpoint: step.snapshot.checkpoint, inbox: firstPlanInbox, log,
    rules: true, compact: true, seen: tree => withChestsDone(seenDoneUpdate(tree, observe()), chestNodesDone(step.taskId, tree)),
    follow: tree => followNode(step.taskId, tree, (facts => !!facts && undergroundInOverworld(facts))(doneFacts(observe()))) });
  const worldOf = () => {
    const world = decided()?.state.world;
    return world && typeof world === 'object' && !Array.isArray(world) ? world as Record<string, unknown> : null;
  };
  // r6: the first plan begins where she is, with what the place lacks in its input; r7: the check's forbid asked for (`FIRST_PLAN_SYSTEM_R7`);
  // r8: a gap crossed in the rock or by a walled bridge (`FIRST_PLAN_SYSTEM_R8`); r9: the done of a node by its own condition, a place with
  // its dimension, the pearls after the rods, the golden armour in the check (`FIRST_PLAN_SYSTEM_R9`).
  const planner = recordedPlanner({ taskId: step.taskId, stepId: step.id }, llmc.planner);
  startFirstPlan({ taskId: step.taskId, goal: step.snapshot.task.goal, held: plan.port.tree(), planner, log, world: worldOf(),
    r4: { world: worldOf, system: ownFirstPlanSystem(), readiness: true } });
  const display = () => plan.port.display();
  // The task queue of the step (design minebot-task-queue): every `mc.act` is an item put in it, and the step decides again while its items run.
  // 2026-10-28, the fix run (`minecraftIncidentHold.ts`): a request asked to be held on a heavy failure sends its acts with `incident.hold`; the act a
  // resume sends again carries `incident.resume` (set for that one add only). Run 44: the body's hold is ended by the operator's resume before
  // the task is queued again (`operatorMinecraftWiring.ts`), and the act goes again from the step's start, under its lease and with the body's resource.
  let resend: ((signal: AbortSignal) => Promise<void>) | null = null;
  const holds = incidentHoldPort();
  const holdOn = holds?.holdRequested(step.taskId) === true;
  let resumeOf: string | null = null;
  const queue = createLlmcQueue({ control, taskId: step.taskId, lease: step.lease, bodyId,
    context: () => withIncident(minecraftTaskContext(step, bodyId(), step.id, display()), holdOn, resumeOf), observe, log });
  queue.onRan(({ why }, result) => noteChestsOpened(step.taskId, result.text, why));
  // Run 45: the call id of the act a resume sends again (the body says when it failed for the reason it was held for: `incident.repeated`).
  let resent: string | null = null;
  // Run 45: a resume with --skip-replay: the act is not sent again, and the next decision reads so as a fact.
  const skipped = holds?.skipNote?.(step.taskId) ?? null;
  if (skipped) createLlmcEvents(step.taskId).note(skipped);
  if (holds && holdOn) {
    queue.onRan((item, _result, receipt) => {
      const incident = incidentOfResult(receipt?.result);
      if (incident?.repeated && !incident.held && receipt && resent !== null && item.call.id === resent) {
        // Run 45 (holds 3 to 5): the body did not hold again; the next decision reads the result (its receipt) and this fact.
        log(`Shannon Minecraft incident replay failed the same way task=${step.taskId} incident=${incident.id} why=${incident.why.slice(0, 80)} (no hold again)`);
        createLlmcEvents(step.taskId).note(`保留から出し直した act は同じ理由（${incident.why.slice(0, 60)}）でまた失敗した。もう保留せず、この結果から判断する`);
        holds.repeated?.(step.taskId, { ...incident, command: receipt.id });
        return;
      }
      if (incident && receipt && !incident.held && incident.notHeld) {
        // Run 44: the world could not be stopped, so the body did not hold; the task goes on and the operator reads why.
        log(`Shannon Minecraft incident not held task=${step.taskId} incident=${incident.id} why=${incident.why.slice(0, 80)} freeze=${incident.notHeld.slice(0, 80)}`);
        holds.notHeld(step.taskId, { ...incident, command: receipt.id });
        return;
      }
      // Run 44, resume 1: the body refused the act as held while the head runs the task (a hold the head had ended, or never had): the head goes
      // back to held at once, so no decision is paid for while every act is refused (once 25 in two minutes).
      const refused = receipt?.failureType === 'held' ? bodyHoldOf(receipt.result) : null;
      if (refused) {
        log(`Shannon Minecraft incident body held task=${step.taskId} incident=${refused.incident} (the head goes back to held)`);
        void holds.bodyHeld(step.taskId, { ...refused, seen: 'refused' }).catch(error => log(`Shannon Minecraft incident body held failed task=${step.taskId} ${String(error)}`));
        return;
      }
      if (!incident?.held || !receipt) return;
      log(`Shannon Minecraft incident hold task=${step.taskId} incident=${incident.id} frozen=${String(incident.frozen)} why=${incident.why.slice(0, 80)}`);
      void holds.hold(step.taskId, { ...incident, command: receipt.id }).catch(error => log(`Shannon Minecraft incident hold failed task=${step.taskId} ${String(error)}`));
    });
    const pending = holds.resumePending(step.taskId);
    // Run 44, resume 1: the act was sent while the step's ports were made, outside the step's execution and before its lease held the body: the
    // control refused it (FCA_BODY_LEASE_INVALID) and it never reached the body. It goes from the step's start now (`wrap` below), as a tool's does:
    // the task bound to the body, the body's resource permitted to the step's lease, then the queue.
    if (pending) resend = async signal => {
    const sent = pending.command ? control.store.command(pending.command) : null;
    if (!sent || sent.skill !== 'act' || !sent.arguments) {
      holds.resumeChecked(step.taskId, pending.command ? `再送できなかった: act ${pending.command} が見つからない` : '再送しなかった: 体の断りから戻した保留で、出し直す act が無い。計画の続きから判断する');
      return;
    }
    const body = bodyId(), active = currentActionExecution();
    if (!body || !control.store.bind(step.taskId, body)) { holds.resumeChecked(step.taskId, '再送できなかった: タスクに体が結び付いていない'); return; }
    if (!active || active.lease.id !== step.lease.id || !await active.permit([actionResource(control.configuration.deviceId, 'minecraft-body')], signal)) {
      holds.resumeChecked(step.taskId, '再送できなかった: この段の lease に体の使用が許されなかった');
      return;
    }
    {
      const args = sent.arguments as Record<string, unknown>;
      resent = `resume:${sent.id}`;
      resumeOf = pending.incident;
      const added = queue.add({ call: { id: `resume:${sent.id}`, name: MC_ACT_TOOL, input: args }, operationId: `resume:${randomUUID()}`, input: args as never,
        arguments: args, skill: 'act', node: sent.queue?.node ?? null, current: null, why: String(args.why ?? ''), fixes: [],
        maxMs: Number(sent.queue?.maxMs ?? 60_000) });
      resumeOf = null;
      log(`Shannon Minecraft incident resume task=${step.taskId} incident=${pending.incident} resend=${sent.id}`);
      const first = { done: false };
      // 2026-10-28: how far the body is, when the act goes again, from where it began (the operator decides what the fix includes; the body never goes back by itself).
      const at = (observe()?.state.world as { position?: { x?: number; y?: number; z?: number } } | undefined)?.position;
      const drift = driftWords(pending.start, at && typeof at.x === 'number' ? [at.x, at.y ?? 0, at.z ?? 0] : null);
      log(`Shannon Minecraft incident resume position task=${step.taskId} ${drift}`);
      queue.onRan((item, result) => {
        if (first.done || item.call.id !== `resume:${sent.id}`) return;
        first.done = true;
        holds.resumeChecked(step.taskId, `再開の確かめ（${drift}）: 同じ act を出し直した → ${result.ok ? '成功' : '失敗'}: ${result.text.replace(/\s+/gu, ' ').slice(0, 380)}`);
      });
      await added.then(answer => { if (!answer.ok) { first.done = true; holds.resumeChecked(step.taskId, `再送を列が断った: ${answer.text.slice(0, 200)}`); } },
        error => { first.done = true; holds.resumeChecked(step.taskId, `再送できなかった: ${String(error).slice(0, 200)}`); });
    }
    };
  }
  const bodyParts = { plan: display, planView: () => plan.port.view(), planTree: () => plan.port.tree() };
  // r4: the current node's place (a find-blocks far from it is a surprise) and the body's probe.
  const planWhere = () => {
    const tree = plan.port.tree();
    return tree.nodes.find(node => node.id === tree.current)?.where ?? null;
  };
  return {
    // No image reflex of the head in the mode (r2), and none offered as a tool (r3): no entry, no selector.
    body: { llmc: bodyParts, fastJudgment: false, entry: null, selector: null, openIds: () => queue.openIds() },
    tools: { llmc: { plan: display, urgent: () => urgentDecision(step.taskId), queue } },
    planTools: plan.tools,
    /** The body's lifecycle with the mode's live state and events (`withLlmcBody`). */
    wrap: (lifecycle: FcaBodyLifecycle) => withResend(withLlmcBody(lifecycle, { llmc: bodyParts, taskId: step.taskId, createdAt: step.snapshot.task.createdAt,
      observe, seen, arrival: () => ({ at: control.arrivedAt(bodyId()), kind: control.arrivalKind(bodyId()) }), log, queue,
      // r5: the fact of a surprise met the second time, noted on the current node (at most 4, the oldest goes).
      r4: { probe: llmcProbeRunner(control, step), planWhere,
        caution: (text: string) => plan.port.amend?.({ ops: [{ op: 'caution', text }] }, 'noted') === true } }), resend, log, step.taskId),
    /** The step's ports with the mode's menu (`llmcTools`). */
    menu: <T extends { tools?: FcaExternalTools }>(ports: T): T => ports.tools
      // The completion reads the frame a decision reads (the current one, or one up to `LLMC_STALE_FRAME_MS` old): a stall of the
      // API's thread must not turn a done task back.
      ? { ...ports, tools: llmcTools(ports.tools, { tree: () => plan.port.tree(), observe: decided, goal: step.snapshot.task.goal }) } : ports,
    ports: { model: llmcModelRouter(llmc.models, step.snapshot.checkpoint, log, step.taskId), plan: plan.port,
      // The decision records name the body's connection and catalog beside each request (`minecraftBodyVersion.ts`).
      versions: () => minecraftBodyVersion(control, bodyId()),
      completionMistake: llmcCompletionMistake(step.snapshot.task.goal),
      permitWindowMs: LLMC_PERMIT_WINDOW_MS, selector: LLMC_CATALOG_SELECTOR,
      history: { codec: anthropicFcaHistoryCodecV2,
        ...(llmc.summarizer ? { summarizer: llmc.summarizer } : {}), policy: llmc.policy,
        ahead: { port: llmc.historyAhead, hard: LLMC_HISTORY_HARD } },
      // r3: the old path's evidence (its expectations, appraisals and shared context) is not the mode's: in run 27 it walked the task's
      // sources 114 times (about 51 s of the API's one thread) and wrote 1,600 characters of shared context into every live state.
      evidence: undefined },
  };
}
/** A body task's lifecycle: wrapped for the mode when the task is one of it. */
export function llmcLifecycle(small: ReturnType<typeof llmcStepParts> | null, lifecycle: FcaBodyLifecycle): FcaBodyLifecycle {
  return small ? small.wrap(lifecycle) : lifecycle;
}

type PlanClient ={ messages: { create(body: Anthropic.MessageCreateParamsNonStreaming, options: { signal: AbortSignal }): PromiseLike<Anthropic.Message> } };
/** The first plan's one structured request (`minecraftFirstPlan.ts`), charged like a decision; none without a key. */
function firstPlanner(values: Readonly<Record<string, string | undefined>>, model: string, recordUsage: (usage: AnthropicFcaUsage) => void | Promise<void>,
  log: (line: string) => void, given?: PlanClient, schema: Readonly<Record<string, unknown>> = FIRST_PLAN_SCHEMA_R4): { planner?: LlmcWiring['planner'] } {
  const apiKey = keyFor(values, model);
  if (!apiKey && !given) return {};
  const client = recordedClient(given ?? claudeClient({ apiKey: apiKey!, timeoutMilliseconds: FIRST_PLAN.giveUpMs }), 'plan');
  return { planner: async (system, input, signal) => {
    const body = structuredBody(model, system, input, schema, 'low', FIRST_PLAN.outputTokens);
    const began = Date.now();
    let message: Anthropic.Message;
    try { message = await client.messages.create(body, { signal }); } catch (error) {
      void recordUsage(abortedRouteUsage(model, system.length + input.length, Date.now() - began, body.max_tokens));
      throw error;
    }
    const usage = message.usage, complete = closedUsage(usage);
    const counts = { input: knownCount(usage?.input_tokens), cacheWrite: knownCount(usage?.cache_creation_input_tokens),
      cacheRead: knownCount(usage?.cache_read_input_tokens), output: knownCount(usage?.output_tokens), searches: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    const inputTokens = counts.input + counts.cacheWrite + counts.cacheRead;
    void recordUsage({ model, usageComplete: complete, inputTokens, cachedInputTokens: counts.cacheRead, cacheCreationInputTokens: counts.cacheWrite,
      outputTokens: counts.output, totalTokens: inputTokens + counts.output,
      estimatedCostUsd: Math.max(estimatedAnthropicCostUsd(model, counts), complete ? 0 : unknownCostUpperBound(model, body.max_tokens, 0, null)) });
    log(`Shannon Minecraft first plan model model=${model} ms=${Date.now() - began} inputTokens=${inputTokens} outputTokens=${counts.output}`);
    if (message.stop_reason !== 'end_turn') throw new Error('MINECRAFT_FIRST_PLAN_INCOMPLETE');
    return JSON.parse(message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim()) as unknown;
  } };
}
