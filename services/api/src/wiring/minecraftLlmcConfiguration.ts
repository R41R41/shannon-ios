import type Anthropic from '@anthropic-ai/sdk';
import { anthropicApiKey } from '../infra/models/anthropic/anthropicConfig.js';
import { createAnthropicFcaModel, type AnthropicFcaOptions, type AnthropicFcaUsage } from '../infra/models/anthropic/anthropicFcaModel.js';
import { createAnthropicFcaSummarizer } from '../infra/models/anthropic/anthropicFcaSummary.js';
import { DEFAULT_HAIKU_MODEL, isHaikuModel, OPUS_MODEL } from '../infra/models/anthropic/haikuConfig.js';
import { claudeClient } from '../infra/models/claude/claudeClient.js';
import { structuredBody } from '../infra/models/claude/claudeStructured.js';
import { closedUsage, estimatedAnthropicCostUsd, knownCount, unknownCostUpperBound } from '../infra/models/claude/claudeUsage.js';
import type { FcaExternalTools, FcaModel } from '../mind/action/fca/fcaPorts.js';
import { FCA_MODEL_BILLING } from '../mind/action/fca/fcaProviderRetry.js';
import type { FcaHistoryAhead, FcaHistoryPolicy } from '../mind/action/fca/fcaHistoryPorts.js';
import { createFcaHistoryAhead } from '../mind/action/fca/fcaHistory.js';
import type { FcaToolSelector } from '../mind/selectors/selectorsPorts.js';
import type { TaskStep } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import { readPlanTree, type PlanKind } from '@shannon/mind';
import { planGoal } from '../surfaces/minecraft/minecraftFirstPlan.js';
import { kindOf } from '../surfaces/minecraft/minecraftPlanFacts.js';
import {
  COMPLETION_WAY,
  observedCompletion,
  withCompletionRule,
  type LlmcCompletion,
} from '../surfaces/minecraft/minecraftLlmcCompletion.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import { minecraftV2Hooks, v2MenuTool } from '../surfaces/minecraft/minecraftLlmcV2.js';
import { FIRST_PLAN, FIRST_PLAN_SCHEMA_R4 } from '../surfaces/minecraft/minecraftFirstPlan.js';
import { REPLAN, REPLAN_SCHEMA } from '../surfaces/minecraft/minecraftLlmcReplan.js';
import { CURRENT_FIRST_PLAN_SCHEMA } from '../surfaces/minecraft/minecraftFirstPlanPrompts.js';
import { amendAnthropicControl } from '../infra/models/anthropic/anthropicFcaControl.js';
import type { FcaCompletionMistake } from '../mind/action/fca/fcaCompletionMistake.js';
import { LLMC_PROBE } from '../surfaces/minecraft/minecraftLlmcProbe.js';
import { MC_PROBE_SKILL, type ProbeInput } from '../contracts/minecraftProbeContract.js';
import { abortedRouteUsage } from './minecraftRouteWiring.js';
import { minecraftTaskContext } from './fcaMinecraftTools.js';
import { recordedClient } from '../infra/decisionRecords/decisionRecordClient.js';
import { createHash } from 'node:crypto';
import { actionResource } from '../contracts/actionThreadContract.js';
import { currentActionExecution } from '../infra/context/actionExecution.js';

/**
 * The models of a Minecraft body task's decisions (design mb-llm-centric; owner 2026-10-21: the main model is
 * chosen after replaying scenes with
 * Haiku, Sonnet and Opus, so each may be set by the environment):
 * - `SHANNON_MINECRAFT_LLMC_MODEL`: the main model of a decision (default claude-opus-5-5, the model of every run since run 30).
 * - `SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL`: the model a decision is raised to while the task is stuck
 * (`LLMC_ESCALATE_FAILURES` failed
 *   steps in a row): a model's name, or `next` (`on`) for the next one up (Haiku → Sonnet, Sonnet → Opus). r5 (run
 * 28: raised 9 times,
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
  maximumRounds: 46,
  recentRounds: 6,
  maximumConversationTokens: 40_000,
  compactedConversationTokens: 8_000,
});

/**
 * r3 (run 27: eight summaries waited for in their steps, 169 s, up to 36 s): past `LLMC_HISTORY_POLICY` the
 * summary is asked beside the
 * steps and installed when ready; a step waits for it (at most 30 s) only past these bounds.
 */
export const LLMC_HISTORY_HARD: Readonly<Partial<FcaHistoryPolicy>> = Object.freeze({
  maximumRounds: 70,
  maximumConversationTokens: 56_000,
});

/** The summarizer's output ceiling (run 27: three summaries cut at 4,000 tokens, `FCA_MODEL_TRUNCATED`, each a
 * fallback epoch). */
export const LLMC_SUMMARY_OUTPUT_TOKENS = 8_000;

/**
 * A body task's tools in the mode: six, fixed (mc.act, mc.probe, mc.view, plan.update and the model's two
 * controls; `v2MenuTool`), no skill index,
 * and the goal progress without its list of failed calls (run 27: the list grew with every failed act and the
 * whole progress was stated again in
 * the history each time, about 2,800 characters a round; each act's own result says how it failed).
 */
export function llmcTools(tools: FcaExternalTools, completion?: LlmcCompletion): FcaExternalTools {
  const { skillIndex: _index, ...rest } = tools;
  const progress = tools.progress;
  return {
    ...rest,
    definitions: tools.definitions.filter((tool) => v2MenuTool(tool)),
    ...(progress
      ? {
          progress: {
            ...progress,
            context: () => withCompletionRule({ ...progress.context(), failures: [], replans: [] }, completion),
            // A completion of a task bound to no goal is checked by its plan and the new frame
            // (`minecraftLlmcCompletion.ts`), not by conditions
            // the model would set with a tool the mode does not offer.
            ...(completion
              ? {
                  async verifyCompletion(call, permit) {
                    const result = await progress.verifyCompletion(call, permit);
                    return result.status === 'not_verified' && result.bindingId === null ? observedCompletion(result, completion) : result;
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

export const MODELS = new Set([DEFAULT_HAIKU_MODEL, 'claude-sonnet-5-5', OPUS_MODEL]);

export const known = (value: string | undefined, fallback: string) => {
  const model = value?.trim();
  return model && MODELS.has(model) ? model : fallback;
};

/** The name of a model as the note to the stronger one says it (`redecideNote`). */
export const redecideLabel = (name: string): string => (/sonnet/iu.test(name) ? 'Sonnet' : /haiku/iu.test(name) ? 'Haiku' : '前の判断');

export const nextUp = (model: string) => (isHaikuModel(model) ? 'claude-sonnet-5-5' : model === 'claude-sonnet-5-5' ? OPUS_MODEL : null);

export interface LlmcModelNames {
  main: string;
  escalate: string | null;
  plan: string;
}

/** The three models from the environment; an unknown name falls back to the default (and is logged without its
 * value by the caller). */
export function llmcModelNames(values: Readonly<Record<string, string | undefined>>): LlmcModelNames {
  const main = known(values.SHANNON_MINECRAFT_LLMC_MODEL, LLMC_MAIN_MODEL);
  const raised = values.SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL?.trim();
  const escalate = raised === 'next' || raised === 'on' ? nextUp(main) : raised && MODELS.has(raised) && raised !== main ? raised : null;
  return { main, escalate, plan: known(values.SHANNON_MINECRAFT_LLMC_PLAN_MODEL, OPUS_MODEL) };
}

/** The key for a model (Haiku may have its own). */
export function keyFor(values: Readonly<Record<string, string | undefined>>, model: string): string | null {
  return isHaikuModel(model) ? values.SHANNON_HAIKU_API_KEY?.trim() || anthropicApiKey(values) : anthropicApiKey(values);
}

/**
 * The kinds of the plan's current node in which a decision is made by the strong model (the plan's: `names.plan`, Opus unless the
 * environment says otherwise) and not by the main one (owner 2026-11-02: Opus where it matters, the late game; the coordinator, 2026-11-03, after the scene
 * replays: the End and the dragon only, since the Nether and the eyes were as good with Sonnet and the filming is a race). It is read from the plan the
 * last step committed (`fcaPlanTree` of the checkpoint), so a restart picks the same model. No new setting: with the main model the same as the
 * plan's, nothing is raised. Which stages: the End and the dragon (the scene replay of Sonnet against Opus,
 * `docs/minecraft-endgame-head-2026-11.md`: the End scenes Opus 4 of 4, Sonnet 1 of 4; the Nether and eye scenes the same quality). The plan's own
 * model also makes the first plan and the new plans of the supervision.
 */
export const LLMC_STRONG_KINDS: ReadonlySet<PlanKind> = new Set<PlanKind>(['end', 'dragon']);

/** The strong kind of the plan node the task is on, or of the nearest node above it that has one (a node the strong model's own plan added
 * under the stage keeps the stage), from the plan in its checkpoint; null in any other stage and without a readable plan. */
export function strongStage(checkpoint: unknown): PlanKind | null {
  const tree = readPlanTree((checkpoint as { fcaPlanTree?: unknown } | null)?.fcaPlanTree);
  const byId = new Map((tree?.nodes ?? []).map(item => [item.id, item]));
  let node = byId.get(tree?.current ?? '');
  for (let up = 0; node && up < 8; up += 1) {
    if (LLMC_STRONG_KINDS.has(kindOf(node))) return kindOf(node);
    node = byId.get(node.parentId ?? '');
  }
  return null;
}

/**
 * Picks the model of one decision: the escalation model while the task's failed steps in a row
 * (`consecutiveToolFailures` of the step's checkpoint) are `LLMC_ESCALATE_FAILURES` or more; else the strong one in a stage of
 * `LLMC_STRONG_KINDS`; else the main one. Each model keeps its own cache; a raised
 * decision reads the history without the main model's thinking (blocks are bound to their model) and writes its own prefix once.
 */
export function llmcModelRouter(
  models: { main: FcaModel; escalate: FcaModel | null; strong?: FcaModel | null },
  checkpoint: unknown,
  log?: (line: string) => void,
  taskId = '',
): FcaModel {
  const failures = Number((checkpoint as { consecutiveToolFailures?: unknown } | null)?.consecutiveToolFailures ?? 0);
  const raised = models.escalate && Number.isSafeInteger(failures) && failures >= LLMC_ESCALATE_FAILURES;
  const stage = raised || !models.strong ? null : strongStage(checkpoint);
  if (raised || stage) {
    try {
      log?.(raised ? `Shannon Minecraft model raised task=${taskId} failures=${failures}` : `Shannon Minecraft model strong task=${taskId} stage=${stage}`);
    } catch {
      /* logging never fails a step */
    }
  }
  return raised ? models.escalate! : stage ? models.strong! : models.main;
}

/** The name of the model that decided a step, as the router chose it: the escalation, the strong one, or the main one. */
export function decidedBy(llmc: Pick<LlmcWiring, 'names' | 'models'>, model: FcaModel): string {
  if (model === llmc.models.escalate && llmc.names.escalate) return llmc.names.escalate;
  return model === llmc.models.strong ? llmc.names.plan : llmc.names.main;
}

/**
 * r5: the one line a turned-back completion is answered with (`FcaStepPorts.completionMistake`; run 28: the
 * receipt said only "received", and
 * the next decisions asked again, three in 11 s): what it was, what a completion is for this goal, and to go on.
 */
export function llmcCompletionMistake(goal: string): FcaCompletionMistake {
  const seen =
    planGoal(goal) === 'dragon'
      ? 'ドラゴンの死を見た時だけ'
      : planGoal(goal) === 'nether'
        ? 'ネザーに入った時だけ'
        : '依頼の目的を観測した時だけ';
  return {
    line: (inARow, reason) =>
      reason
        ? `完了の誤り（続けて ${inARow} 回目）: ${reason}。${COMPLETION_WAY}`
        : `完了の誤り（続けて ${inARow} 回目）: 依頼の達成は、まだ観測で確かめられない。完了は${seen}。` +
          '時間や遠さで区切らない。届かないと思ったら、計画を見直して続ける（時間と費用の上限は運用者が止める）。',
    amend: amendAnthropicControl,
  };
}

/** The mode's menu is fixed (the body's tools of the mode, plan, goal and task tools): no selector call between decisions. */
export const LLMC_CATALOG_SELECTOR: FcaToolSelector = {
  async select(request) {
    request.signal.throwIfAborted();
    return { names: request.tools.map((tool) => tool.name), source: 'catalog' };
  },
};

/**
 * The mode of a Minecraft body task (owner 2026-10-24: 「切り替える仕組みもいらない。常に最新版を使っていい」): one mode, no switch. The probe of a
 * surprise and `mc.probe`, the task's own words, the act preflight and the six fixed tools with the mode's live
 * state and guards are always on.
 */
export interface LlmcWiring {
  names: LlmcModelNames;
  models: { main: FcaModel; escalate: FcaModel | null; strong?: FcaModel | null };
  summarizer: ReturnType<typeof createAnthropicFcaSummarizer> | null;
  policy: Readonly<Partial<FcaHistoryPolicy>>;
  planner?: (system: string, input: string, signal: AbortSignal) => Promise<unknown>;
  /** The strong model that makes the plan again when the body stands still (`minecraftLlmcReplan.ts`); none without a key. */
  replanner?: (system: string, input: string, signal: AbortSignal) => Promise<unknown>;
  /** r3: the summaries made beside the steps, by task. */
  historyAhead: FcaHistoryAhead;
}

/**
 * The mode's models, made once (each with the mode's instructions), its Haiku summarizer and its first-plan
 * planner. Null only without a key for
 * the main model (logged).
 */
export function configuredMinecraftLlmc(
  values: Readonly<Record<string, string | undefined>>,
  base: Omit<AnthropicFcaOptions, 'model' | 'apiKey' | 'systemAppendix'>,
  parts: { log?(line: string): void; client?: PlanClient } = {},
): LlmcWiring | null {
  const names = llmcModelNames(values),
    log = parts.log ?? ((line) => console.info(line));
  const make = (model: string) => {
    const apiKey = keyFor(values, model);
    return apiKey || base.client
      ? createAnthropicFcaModel({
          ...base,
          model,
          ...(apiKey ? { apiKey } : {}),
          minecraftOwnPrompt: true,
          minecraftV2: minecraftV2Hooks(),
        })
      : null;
  };
  const main = make(names.main);
  if (!main) {
    log('Shannon Minecraft LLM-centric off: no key for its main model');
    return null;
  }
  const haikuKey = keyFor(values, DEFAULT_HAIKU_MODEL);
  log(`Shannon Minecraft LLM-centric models main=${names.main} escalate=${names.escalate ?? 'none'} plan=${names.plan}`);
  const escalate = names.escalate ? make(names.escalate) : null;
  // The plan's model also decides in the stages of `LLMC_STRONG_KINDS`; when it is the main one, or the escalation, no second copy is made.
  const strong = names.plan === names.main ? null : names.plan === names.escalate ? escalate : make(names.plan);
  return {
    names,
    models: { main, escalate, strong },
    summarizer:
      haikuKey || base.client
        ? createAnthropicFcaSummarizer({
            ...base,
            model: DEFAULT_HAIKU_MODEL,
            ...(haikuKey ? { apiKey: haikuKey } : {}),
            body: true,
            minecraftOwnPrompt: true,
            minecraftV2Facts: true,
            maximumOutputTokens: LLMC_SUMMARY_OUTPUT_TOKENS,
          })
        : null,
    policy: LLMC_HISTORY_POLICY,
    historyAhead: createFcaHistoryAhead(),
    ...firstPlanner(values, names.plan, base.recordUsage, log, parts.client, CURRENT_FIRST_PLAN_SCHEMA),
    ...replannerPart(values, names.plan, base.recordUsage, log, parts.client),
  };
}

/**
 * r4: the way to send one fixed probe of a surprise to the task's body, or null while the body is not there or
 * has no `probe` (its
 * catalog). The command goes in the step's lease with the body's resource, as every body command does (the
 * control refuses a lease
 * without it; the body itself runs a probe beside an act), its deadline `LLMC_PROBE.commandMs`; an answer that
 * does not come is null (the
 * investigation waits less than that and goes on).
 */
export function llmcProbeRunner(
  control: MinecraftControl,
  step: TaskStep,
): () => ((input: ProbeInput, index: number) => Promise<string | null>) | null {
  return () => {
    const bodyId = control.store.body(step.taskId) ?? '';
    const frame = bodyId ? control.frame(bodyId) : null;
    if (!frame?.poll.skills?.some((skill) => skill.name === MC_PROBE_SKILL)) return null;
    return async (input, index) => {
      const active = currentActionExecution();
      if (
        !active ||
        active.lease.id !== step.lease.id ||
        !(await active.permit(
          [actionResource(control.configuration.deviceId, 'minecraft-body')],
          AbortSignal.timeout(LLMC_PROBE.commandMs),
        ))
      )
        return null;
      const receipt = await control.command({
        id: `probe:${createHash('sha256').update(`${step.id}:${index}`).digest('hex')}`,
        context: minecraftTaskContext(step, bodyId),
        lease: step.lease,
        kind: 'skill',
        skill: MC_PROBE_SKILL,
        arguments: input as unknown as Record<string, unknown>,
        milliseconds: LLMC_PROBE.commandMs,
      });
      return receipt.outcome === 'completed' ? (receipt.result ?? null) : null;
    };
  };
}

/** A-20: the model, with a refusal for the account's credit (`FCA_MODEL_BILLING`) told to `onBilling` before it
 * is thrown on; everything else of the model as it is. */
export function billingGuarded(model: FcaModel, onBilling: () => void): FcaModel {
  const decide: FcaModel['decide'] = async (input, signal) => {
    try {
      return await model.decide(input, signal);
    } catch (error) {
      if (error instanceof Error && error.message === FCA_MODEL_BILLING) {
        try {
          onBilling();
        } catch {
          /* the hold is asked for; a failure of asking never changes the error */
        }
      }
      throw error;
    }
  };
  return new Proxy(model, {
    get(target, property) {
      if (property === 'decide') return decide;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

interface PlannerLimits {
  outputTokens: number;
  giveUpMs: number;
  label: string;
  effort: 'low' | 'medium';
}

export type PlanClient = {
  messages: { create(body: Anthropic.MessageCreateParamsNonStreaming, options: { signal: AbortSignal }): PromiseLike<Anthropic.Message> };
};

/** The strong model's request for the plan made again: the same route and charge as the first plan's, its own schema and bounds. */
function replannerPart(values: Readonly<Record<string, string | undefined>>, model: string, recordUsage: (usage: AnthropicFcaUsage) => void | Promise<void>,
  log: (line: string) => void, given?: PlanClient): { replanner?: LlmcWiring['planner'] } {
  const limits: PlannerLimits = { outputTokens: REPLAN.outputTokens, giveUpMs: REPLAN.giveUpMs, label: 'replan', effort: 'medium' };
  const made = firstPlanner(values, model, recordUsage, log, given, REPLAN_SCHEMA, limits);
  return made.planner ? { replanner: made.planner } : {};
}

/** The first plan's one structured request (`minecraftFirstPlan.ts`), charged like a decision; none without a key. */
export function firstPlanner(
  values: Readonly<Record<string, string | undefined>>,
  model: string,
  recordUsage: (usage: AnthropicFcaUsage) => void | Promise<void>,
  log: (line: string) => void,
  given?: PlanClient,
  schema: Readonly<Record<string, unknown>> = FIRST_PLAN_SCHEMA_R4,
  limits: PlannerLimits = { outputTokens: FIRST_PLAN.outputTokens, giveUpMs: FIRST_PLAN.giveUpMs, label: 'first plan', effort: 'low' },
): { planner?: LlmcWiring['planner'] } {
  const apiKey = keyFor(values, model);
  if (!apiKey && !given) return {};
  const client = recordedClient(given ?? claudeClient({ apiKey: apiKey!, timeoutMilliseconds: limits.giveUpMs }), 'plan');
  return {
    planner: async (system, input, signal) => {
      const body = structuredBody(model, system, input, schema, limits.effort, limits.outputTokens);
      const began = Date.now();
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(body, { signal });
      } catch (error) {
        void recordUsage(abortedRouteUsage(model, system.length + input.length, Date.now() - began, body.max_tokens));
        throw error;
      }
      const usage = message.usage,
        complete = closedUsage(usage);
      const counts = {
        input: knownCount(usage?.input_tokens),
        cacheWrite: knownCount(usage?.cache_creation_input_tokens),
        cacheRead: knownCount(usage?.cache_read_input_tokens),
        output: knownCount(usage?.output_tokens),
        searches: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      };
      const inputTokens = counts.input + counts.cacheWrite + counts.cacheRead;
      void recordUsage({
        model,
        usageComplete: complete,
        inputTokens,
        cachedInputTokens: counts.cacheRead,
        cacheCreationInputTokens: counts.cacheWrite,
        outputTokens: counts.output,
        totalTokens: inputTokens + counts.output,
        estimatedCostUsd: Math.max(
          estimatedAnthropicCostUsd(model, counts),
          complete ? 0 : unknownCostUpperBound(model, body.max_tokens, 0, null),
        ),
      });
      log(
        `Shannon Minecraft ${limits.label} model model=${model} ms=${Date.now() - began} inputTokens=${inputTokens} outputTokens=${counts.output}`,
      );
      if (message.stop_reason !== 'end_turn') throw new Error(`MINECRAFT_${limits.label.toUpperCase().replace(' ', '_')}_INCOMPLETE`);
      return JSON.parse(
        message.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('')
          .trim(),
      ) as unknown;
    },
  };
}
