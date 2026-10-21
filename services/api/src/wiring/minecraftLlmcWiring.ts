import type Anthropic from '@anthropic-ai/sdk';
import { switchOn } from '@shannon/switches';
import { anthropicApiKey } from '../infra/models/anthropic/anthropicConfig.js';
import { createAnthropicFcaModel, type AnthropicFcaOptions, type AnthropicFcaUsage } from '../infra/models/anthropic/anthropicFcaModel.js';
import { createAnthropicFcaSummarizer } from '../infra/models/anthropic/anthropicFcaSummary.js';
import { DEFAULT_HAIKU_MODEL, isHaikuModel, OPUS_MODEL } from '../infra/models/anthropic/haikuConfig.js';
import { claudeClient } from '../infra/models/claude/claudeClient.js';
import { structuredBody } from '../infra/models/claude/claudeStructured.js';
import { closedUsage, estimatedAnthropicCostUsd, knownCount, unknownCostUpperBound } from '../infra/models/claude/claudeUsage.js';
import type { FcaExternalTools, FcaModel, FcaToolDefinition } from '../mind/action/fca/fcaPorts.js';
import type { FcaHistoryAhead, FcaHistoryPolicy } from '../mind/action/fca/fcaHistoryPorts.js';
import { createFcaHistoryAhead } from '../mind/action/fca/fcaHistory.js';
import type { FcaToolSelector } from '../mind/selectors/selectorsPorts.js';
import type { TaskStep } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { FcaLookahead } from '../mind/action/fca/fcaLookahead.js';
import { createFcaPlanTools } from '../mind/action/fca/fcaPlanTools.js';
import { firstPlanInbox, planGoal, startFirstPlan } from '../surfaces/minecraft/minecraftFirstPlan.js';
import type { FcaBodyLifecycle } from '../mind/action/fca/fcaPorts.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import { withLlmcBody } from '../surfaces/minecraft/minecraftLlmcBody.js';
import { createLlmcLookahead, feetOf, noteLlmcFeet } from '../surfaces/minecraft/minecraftLlmc.js';
import { anthropicFcaHistoryCodec } from '../infra/models/anthropic/anthropicFcaHistory.js';
import { llmcSystemAppendix } from '../surfaces/minecraft/minecraftKnowledge.js';
import { FIRST_PLAN, FIRST_PLAN_SCHEMA, FIRST_PLAN_SCHEMA_R4, FIRST_PLAN_SYSTEM_R5 } from '../surfaces/minecraft/minecraftFirstPlan.js';
import { seenDoneUpdate } from '../surfaces/minecraft/minecraftPlanDone.js';
import { amendAnthropicControl } from '../infra/models/anthropic/anthropicFcaControl.js';
import type { FcaCompletionMistake } from '../mind/action/fca/fcaCompletionMistake.js';
import { LLMC_PROBE } from '../surfaces/minecraft/minecraftLlmcProbe.js';
import { MC_PROBE_SKILL, type ProbeInput } from '../contracts/minecraftProbeContract.js';
import { abortedRouteUsage } from './minecraftRouteWiring.js';
import { minecraftTaskContext } from './fcaMinecraftTools.js';
import { createHash } from 'node:crypto';
import { actionResource } from '../contracts/actionThreadContract.js';
import { currentActionExecution } from '../infra/context/actionExecution.js';

/**
 * SHANNON_MINECRAFT_LLM_CENTRIC (design mb-llm-centric; owner 2026-10-21: the main model is chosen after replaying scenes with Haiku,
 * Sonnet and Opus, so each is set by the environment):
 * - `SHANNON_MINECRAFT_LLMC_MODEL`: the main model of a decision (default claude-sonnet-5-5).
 * - `SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL`: the model a decision is raised to while the task is stuck (`LLMC_ESCALATE_FAILURES` failed
 *   steps in a row): a model's name, or `next` (`on`) for the next one up (Haiku → Sonnet, Sonnet → Opus). r5 (run 28: raised 9 times,
 *   23% of the cost, and the same stops went on: they were the body's faults): unset or `none`, never.
 * - `SHANNON_MINECRAFT_LLMC_PLAN_MODEL`: the first plan's model (default claude-opus-5-5).
 * Each decision model carries the mode's rules, map legend and knowledge in its cached instructions (`LLMC_SYSTEM_APPENDIX`).
 */
export const LLMC_MAIN_MODEL = 'claude-sonnet-5-5';
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
 * The tools of the mode's menu (r3; run 27: 48 tools of her other work, study, folders, music, the web, were declared inline at every
 * epoch's start, 81,619 characters, and the catalog listed them in every full state, 8,977): the body's (`mc.*`, `minecraft.observe`),
 * the plan's and the goal's, and the memory reads. The task tools are the runner's. `minecraft.reflex` (the image reflex) and
 * `skill.read` (her skills for the old tools) are not the mode's.
 */
export function llmcMenuTool(tool: Pick<FcaToolDefinition, 'name' | 'domain'>): boolean {
  if (tool.name === 'minecraft.reflex' || tool.name === 'skill.read') return false;
  return /^(mc|plan|goal)\./u.test(tool.name) || tool.name === 'minecraft.observe' || tool.domain === 'memory_read';
}
/**
 * A body task's tools in the mode: the menu above, no skill index, and the goal progress without its list of failed calls (run 27: the
 * list grew with every failed act and the whole progress was stated again in the history each time, about 2,800 characters a round; each
 * act's own result says how it failed).
 */
export function llmcTools(tools: FcaExternalTools): FcaExternalTools {
  const { skillIndex: _index, ...rest } = tools;
  const progress = tools.progress;
  return { ...rest, definitions: tools.definitions.filter(llmcMenuTool),
    ...(progress ? { progress: { ...progress, context: () => ({ ...progress.context(), failures: [], replans: [] }) } } : {}) };
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
  return { line: inARow => `完了の誤り（続けて ${inARow} 回目）: 依頼の達成は、まだ観測で確かめられない。完了は${seen}。`
    + '時間や遠さで区切らない。届かないと思ったら、計画を見直して続ける（時間と費用の上限は運用者が止める）。', amend: amendAnthropicControl };
}

/** The mode's menu is fixed (the body's tools of the mode, plan, goal and task tools): no selector call between decisions. */
export const LLMC_CATALOG_SELECTOR: FcaToolSelector = {
  async select(request) {
    request.signal.throwIfAborted();
    return { names: request.tools.map(tool => tool.name), source: 'catalog' };
  },
};

export interface LlmcWiring {
  names: LlmcModelNames;
  /**
   * r4, SHANNON_MINECRAFT_LLMC_PROBE (owner 2026-10-22): a surprise is probed before the decision, `mc.probe` is offered, the body's scan
   * goes to the first plan and the live state, plan nodes carry forbid and caution, and the knowledge says how to look when stuck. False:
   * the mode as r3 (fc7bed7) had it, byte for byte.
   */
  probe: boolean;
  models: { main: FcaModel; escalate: FcaModel | null };
  summarizer: ReturnType<typeof createAnthropicFcaSummarizer> | null;
  policy: Readonly<Partial<FcaHistoryPolicy>>;
  planner?: (system: string, input: string, signal: AbortSignal) => Promise<unknown>;
  /** The one lookahead of the mode (kept across every task's steps): the next decision asked while a long act runs. */
  lookahead: FcaLookahead;
  /** r3: the summaries made beside the steps, by task. */
  historyAhead: FcaHistoryAhead;
}

/**
 * The mode's models, made once (each with the mode's instructions), its Haiku summarizer and its first-plan planner. Null while the
 * switch is off, or without a key for the main model (logged; the mode then does not start and every task runs as before).
 */
export function configuredMinecraftLlmc(values: Readonly<Record<string, string | undefined>>,
  base: Omit<AnthropicFcaOptions, 'model' | 'apiKey' | 'systemAppendix'>, parts: { log?(line: string): void; client?: PlanClient } = {}): LlmcWiring | null {
  if (!switchOn(values, 'SHANNON_MINECRAFT_LLM_CENTRIC')) return null;
  const names = llmcModelNames(values), log = parts.log ?? (line => console.info(line));
  const probe = switchOn(values, 'SHANNON_MINECRAFT_LLMC_PROBE');
  // Every decision model of the mode reads the same appendix (r4's with the probe on): the main one and the one it is raised to.
  const appendix = llmcSystemAppendix(probe);
  const make = (model: string) => {
    const apiKey = keyFor(values, model);
    return apiKey || base.client ? createAnthropicFcaModel({ ...base, model, ...(apiKey ? { apiKey } : {}), systemAppendix: appendix }) : null;
  };
  const main = make(names.main);
  if (!main) {
    log('Shannon Minecraft LLM-centric off: no key for its main model');
    return null;
  }
  const haikuKey = keyFor(values, DEFAULT_HAIKU_MODEL);
  log(`Shannon Minecraft LLM-centric models main=${names.main} escalate=${names.escalate ?? 'none'} plan=${names.plan}${probe ? ' probe=on' : ''}`);
  return { names, probe, models: { main, escalate: names.escalate ? make(names.escalate) : null },
    summarizer: haikuKey || base.client
      ? createAnthropicFcaSummarizer({ ...base, model: DEFAULT_HAIKU_MODEL, ...(haikuKey ? { apiKey: haikuKey } : {}), body: true,
        maximumOutputTokens: LLMC_SUMMARY_OUTPUT_TOKENS }) : null,
    policy: LLMC_HISTORY_POLICY, lookahead: createLlmcLookahead(log), historyAhead: createFcaHistoryAhead(),
    ...firstPlanner(values, names.plan, base.recordUsage, log, parts.client, probe ? FIRST_PLAN_SCHEMA_R4 : FIRST_PLAN_SCHEMA) };
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

/**
 * One body task's parts in the mode: its plan (the tool, the port, the first plan asked at its first decision), the body's and the body
 * tools' options, and the step ports that make its steps small (the model router, the plan, the lease window, the lookahead, the
 * fixed menu, the history policy).
 */
export function llmcStepParts(llmc: LlmcWiring, step: TaskStep, control: MinecraftControl, log: (line: string) => void = line => console.info(line)) {
  const bodyId = () => control.store.body(step.taskId) ?? '';
  const observe = () => control.observe(bodyId());
  noteLlmcFeet(step.taskId, () => feetOf(observe()));
  // r5: a node whose doneWhen the frame shows is marked done before each decision reads the plan (`minecraftPlanDone.ts`).
  const plan = createFcaPlanTools({ taskId: step.taskId, checkpoint: step.snapshot.checkpoint, inbox: firstPlanInbox, log,
    ...(llmc.probe ? { rules: true } : {}), seen: tree => seenDoneUpdate(tree, observe()) });
  const worldOf = () => {
    const world = observe()?.state.world;
    return world && typeof world === 'object' && !Array.isArray(world) ? world as Record<string, unknown> : null;
  };
  startFirstPlan({ taskId: step.taskId, goal: step.snapshot.task.goal, held: plan.port.tree(), planner: llmc.planner, log, world: worldOf(),
    ...(llmc.probe ? { r4: { world: worldOf, system: FIRST_PLAN_SYSTEM_R5 } } : {}) });
  const display = () => plan.port.display();
  const bodyParts = { plan: display, planView: () => plan.port.view() };
  // r4: the current node's place (a find-blocks far from it is a surprise) and the body's probe.
  const planWhere = () => {
    const tree = plan.port.tree();
    return tree.nodes.find(node => node.id === tree.current)?.where ?? null;
  };
  return {
    // No image reflex of the head in the mode (r2), and none offered as a tool (r3): no entry, no selector.
    body: { llmc: bodyParts, fastJudgment: false, entry: null, selector: null },
    tools: { llmc: { plan: display, ...(llmc.probe ? { probe: true } : {}) } },
    planTools: plan.tools,
    /** The body's lifecycle with the mode's live state and events (`withLlmcBody`). */
    wrap: (lifecycle: FcaBodyLifecycle) => withLlmcBody(lifecycle, { llmc: bodyParts, taskId: step.taskId, createdAt: step.snapshot.task.createdAt,
      observe, arrival: () => ({ at: control.arrivedAt(bodyId()), kind: control.arrivalKind(bodyId()) }), log,
      // r5: the fact of a surprise met the second time, noted on the current node (at most 4, the oldest goes).
      ...(llmc.probe ? { r4: { probe: llmcProbeRunner(control, step), planWhere,
        caution: (text: string) => plan.port.amend?.({ ops: [{ op: 'caution', text }] }, 'noted') === true } } : {}) }),
    /** The step's ports with the mode's menu (`llmcTools`). */
    menu: <T extends { tools?: FcaExternalTools }>(ports: T): T => ports.tools ? { ...ports, tools: llmcTools(ports.tools) } : ports,
    ports: { model: llmcModelRouter(llmc.models, step.snapshot.checkpoint, log, step.taskId), plan: plan.port,
      completionMistake: llmcCompletionMistake(step.snapshot.task.goal),
      permitWindowMs: LLMC_PERMIT_WINDOW_MS, lookahead: llmc.lookahead, selector: LLMC_CATALOG_SELECTOR,
      history: { codec: anthropicFcaHistoryCodec, ...(llmc.summarizer ? { summarizer: llmc.summarizer } : {}), policy: llmc.policy,
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
  log: (line: string) => void, given?: PlanClient, schema: Readonly<Record<string, unknown>> = FIRST_PLAN_SCHEMA): { planner?: LlmcWiring['planner'] } {
  const apiKey = keyFor(values, model);
  if (!apiKey && !given) return {};
  const client = given ?? claudeClient({ apiKey: apiKey!, timeoutMilliseconds: FIRST_PLAN.giveUpMs });
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
