import type Anthropic from '@anthropic-ai/sdk';
import { switchOn } from '@shannon/switches';
import { anthropicApiKey } from '../infra/models/anthropic/anthropicConfig.js';
import { createAnthropicFcaModel, type AnthropicFcaOptions, type AnthropicFcaUsage } from '../infra/models/anthropic/anthropicFcaModel.js';
import { createAnthropicFcaSummarizer } from '../infra/models/anthropic/anthropicFcaSummary.js';
import { DEFAULT_HAIKU_MODEL, isHaikuModel, OPUS_MODEL } from '../infra/models/anthropic/haikuConfig.js';
import { claudeClient } from '../infra/models/claude/claudeClient.js';
import { structuredBody } from '../infra/models/claude/claudeStructured.js';
import { closedUsage, estimatedAnthropicCostUsd, knownCount, unknownCostUpperBound } from '../infra/models/claude/claudeUsage.js';
import type { FcaModel } from '../mind/action/fca/fcaPorts.js';
import type { FcaHistoryPolicy } from '../mind/action/fca/fcaHistoryPorts.js';
import type { FcaToolSelector } from '../mind/selectors/selectorsPorts.js';
import type { TaskStep } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { FcaLookahead } from '../mind/action/fca/fcaLookahead.js';
import { createFcaPlanTools } from '../mind/action/fca/fcaPlanTools.js';
import { firstPlanInbox, startFirstPlan } from '../surfaces/minecraft/minecraftFirstPlan.js';
import type { FcaBodyLifecycle } from '../mind/action/fca/fcaPorts.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import { withLlmcBody } from '../surfaces/minecraft/minecraftLlmcBody.js';
import { createLlmcLookahead, feetOf, noteLlmcFeet } from '../surfaces/minecraft/minecraftLlmc.js';
import { anthropicFcaHistoryCodec } from '../infra/models/anthropic/anthropicFcaHistory.js';
import { LLMC_SYSTEM_APPENDIX } from '../surfaces/minecraft/minecraftKnowledge.js';
import { FIRST_PLAN, FIRST_PLAN_SCHEMA } from '../surfaces/minecraft/minecraftFirstPlan.js';
import { abortedRouteUsage } from './minecraftRouteWiring.js';

/**
 * SHANNON_MINECRAFT_LLM_CENTRIC (design mb-llm-centric; owner 2026-10-21: the main model is chosen after replaying scenes with Haiku,
 * Sonnet and Opus, so each is set by the environment):
 * - `SHANNON_MINECRAFT_LLMC_MODEL`: the main model of a decision (default claude-sonnet-5-5).
 * - `SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL`: the model a decision is raised to while the task is stuck (`LLMC_ESCALATE_FAILURES` failed
 *   steps in a row); default the next one up (Haiku → Sonnet, Sonnet → Opus), `none` for never.
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
  const escalate = raised === 'none' ? null : raised && MODELS.has(raised) && raised !== main ? raised : nextUp(main);
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

/** The mode's menu is fixed (the body's tools of the mode, plan, goal and task tools): no selector call between decisions. */
export const LLMC_CATALOG_SELECTOR: FcaToolSelector = {
  async select(request) {
    request.signal.throwIfAborted();
    return { names: request.tools.map(tool => tool.name), source: 'catalog' };
  },
};

export interface LlmcWiring {
  names: LlmcModelNames;
  models: { main: FcaModel; escalate: FcaModel | null };
  summarizer: ReturnType<typeof createAnthropicFcaSummarizer> | null;
  policy: Readonly<Partial<FcaHistoryPolicy>>;
  planner?: (system: string, input: string, signal: AbortSignal) => Promise<unknown>;
  /** The one lookahead of the mode (kept across every task's steps): the next decision asked while a long act runs. */
  lookahead: FcaLookahead;
}

/**
 * The mode's models, made once (each with the mode's instructions), its Haiku summarizer and its first-plan planner. Null while the
 * switch is off, or without a key for the main model (logged; the mode then does not start and every task runs as before).
 */
export function configuredMinecraftLlmc(values: Readonly<Record<string, string | undefined>>,
  base: Omit<AnthropicFcaOptions, 'model' | 'apiKey' | 'systemAppendix'>, parts: { log?(line: string): void; client?: PlanClient } = {}): LlmcWiring | null {
  if (!switchOn(values, 'SHANNON_MINECRAFT_LLM_CENTRIC')) return null;
  const names = llmcModelNames(values), log = parts.log ?? (line => console.info(line));
  const make = (model: string) => {
    const apiKey = keyFor(values, model);
    return apiKey || base.client ? createAnthropicFcaModel({ ...base, model, ...(apiKey ? { apiKey } : {}), systemAppendix: LLMC_SYSTEM_APPENDIX }) : null;
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
      ? createAnthropicFcaSummarizer({ ...base, model: DEFAULT_HAIKU_MODEL, ...(haikuKey ? { apiKey: haikuKey } : {}), body: true }) : null,
    policy: LLMC_HISTORY_POLICY, lookahead: createLlmcLookahead(log), ...firstPlanner(values, names.plan, base.recordUsage, log, parts.client) };
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
  const plan = createFcaPlanTools({ taskId: step.taskId, checkpoint: step.snapshot.checkpoint, inbox: firstPlanInbox, log });
  const world = observe()?.state.world;
  startFirstPlan({ taskId: step.taskId, goal: step.snapshot.task.goal, held: plan.port.tree(), planner: llmc.planner, log,
    world: world && typeof world === 'object' && !Array.isArray(world) ? world as Record<string, unknown> : null });
  const display = () => plan.port.display();
  const bodyParts = { plan: display, planView: () => plan.port.view() };
  return {
    body: { llmc: bodyParts, fastJudgment: false },
    tools: { llmc: { plan: display } },
    planTools: plan.tools,
    /** The body's lifecycle with the mode's live state and events (`withLlmcBody`). */
    wrap: (lifecycle: FcaBodyLifecycle) => withLlmcBody(lifecycle, { llmc: bodyParts, taskId: step.taskId, createdAt: step.snapshot.task.createdAt,
      observe, arrival: () => ({ at: control.arrivedAt(bodyId()), kind: control.arrivalKind(bodyId()) }) }),
    ports: { model: llmcModelRouter(llmc.models, step.snapshot.checkpoint, log, step.taskId), plan: plan.port,
      permitWindowMs: LLMC_PERMIT_WINDOW_MS, lookahead: llmc.lookahead, selector: LLMC_CATALOG_SELECTOR,
      history: { codec: anthropicFcaHistoryCodec, ...(llmc.summarizer ? { summarizer: llmc.summarizer } : {}), policy: llmc.policy } },
  };
}
/** A body task's lifecycle: wrapped for the mode when the task is one of it. */
export function llmcLifecycle(small: ReturnType<typeof llmcStepParts> | null, lifecycle: FcaBodyLifecycle): FcaBodyLifecycle {
  return small ? small.wrap(lifecycle) : lifecycle;
}

type PlanClient ={ messages: { create(body: Anthropic.MessageCreateParamsNonStreaming, options: { signal: AbortSignal }): PromiseLike<Anthropic.Message> } };
/** The first plan's one structured request (`minecraftFirstPlan.ts`), charged like a decision; none without a key. */
function firstPlanner(values: Readonly<Record<string, string | undefined>>, model: string, recordUsage: (usage: AnthropicFcaUsage) => void | Promise<void>,
  log: (line: string) => void, given?: PlanClient): { planner?: LlmcWiring['planner'] } {
  const apiKey = keyFor(values, model);
  if (!apiKey && !given) return {};
  const client = given ?? claudeClient({ apiKey: apiKey!, timeoutMilliseconds: FIRST_PLAN.giveUpMs });
  return { planner: async (system, input, signal) => {
    const body = structuredBody(model, system, input, FIRST_PLAN_SCHEMA, 'low', FIRST_PLAN.outputTokens);
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
