import type Anthropic from '@anthropic-ai/sdk';
import type { ActionExecution } from '../../context/actionExecution.js';
import { estimatedAnthropicTokens } from './anthropicFcaHistory.js';
import type { AnthropicFcaUsage } from './anthropicFcaModel.js';
import type { FcaModelInput } from '../../../mind/action/fca/fcaPorts.js';
import { isFcaClearAtMessage } from './anthropicFcaTransient.js';
import { fcaTaskTelemetry, type FcaCallKind } from '../../../mind/action/fca/fcaTaskTelemetry.js';
import { llmcTokens } from '../../../surfaces/minecraft/minecraftLlmcLive.js';

type Metrics = NonNullable<ActionExecution['modelMetrics']>;
/**
 * Observation redesign P1: what one decision's request weighed, for the journal's `fca_decision_metrics` line (written by the runner,
 * which also has the timings). Counts only: the replayed (stored) history and this turn's messages as token estimates
 * (`estimatedAnthropicTokens`, the same estimate the compaction uses), the provider's usage split into new input, cache reads and
 * cache writes, and how many ways the decision message was reduced before sending (parts left out as unchanged, plus a shortening).
 */
export function decisionRequestMetrics(history: readonly Anthropic.MessageParam[], turn: readonly Anthropic.MessageParam[], usage: AnthropicFcaUsage,
  built: { level: number | null; elidedParts: readonly string[] },
  transient?: { providerTransformations: number; cuts?: Metrics['cuts'] }): Metrics {
  const read = usage.cachedInputTokens, write = usage.cacheCreationInputTokens;
  // mb-llmc r8: the live state is the only part of a transient request after the last cache breakpoint (a turn-scoped system message may
  // carry no marker); its estimate beside `inputNew` says how much of the input that is not cached is that state.
  const live = transient ? turn.find(isFcaClearAtMessage) : undefined;
  // A turn-scoped system message that a later message follows is stored but never rendered: not part of the stored tokens.
  return { storedTokens: estimatedAnthropicTokens(history.filter(message => !isFcaClearAtMessage(message))), tailTokens: estimatedAnthropicTokens(turn),
    inputNew: Math.max(0, usage.inputTokens - read - write), inputRead: read, inputWrite: write, outputTokens: usage.outputTokens,
    inputTransformations: built.elidedParts.length + (built.level === null ? 0 : 1) + (transient?.providerTransformations ?? 0),
    ...(live ? { liveTokens: estimatedAnthropicTokens([live]) } : {}),
    ...(transient ? { obsMode: 'transient' as const } : {}), ...(transient?.cuts ? { cuts: transient.cuts } : {}) };
}

type Layers = NonNullable<Metrics['layers']>;
/**
 * Syzygy ADR-0014 D8 (measurement only): the input of one decision by layer, as token estimates (`llmcTokens`, the fitted count of the
 * Minecraft live state) of pieces the request already holds. No call is made and nothing is stored or sent:
 *   policy: the system blocks (fixed instructions); tools: the tool definitions; history: the replayed (stored) turns;
 *   task: this turn's message minus the two below (the task, its messages, the plan, waiting, the skill index);
 *   live: the state of the moment (a transient request's turn-scoped state message; a legacy request's body, observations, progress and wait);
 *   retrieved: the recall packet and the shared context.
 * An estimate, not the provider's count: the provider's own counts are `in` of the line. Never a text.
 */
export function requestLayers(request: { system?: unknown; tools?: unknown }, history: readonly Anthropic.MessageParam[],
  turn: readonly Anthropic.MessageParam[], input: { body?: unknown; observations?: unknown; progress?: unknown; waiting?: unknown; recall?: unknown;
    sharedContext?: unknown }, transient: boolean): Layers {
  const tokens = (value: unknown) => value === undefined || value === null ? 0 : llmcTokens(JSON.stringify(value) ?? '');
  const liveMessage = transient ? turn.find(isFcaClearAtMessage) : undefined;
  const legacyLive = { body: input.body, observations: input.observations, progress: input.progress, waiting: input.waiting };
  const live = liveMessage ? tokens(liveMessage) : transient ? 0 : tokens(legacyLive);
  const retrieved = tokens(input.recall) + tokens(input.sharedContext);
  return { policy: tokens(request.system), tools: tokens(request.tools), history: tokens(history.filter(message => !isFcaClearAtMessage(message))),
    task: Math.max(0, tokens(turn.filter(message => message !== liveMessage)) - (liveMessage ? 0 : live) - retrieved), live, retrieved };
}

/**
 * Syzygy ADR-0014 D8 (measurement only; never fails or changes the decision): what a call that has just been answered adds to the
 * measurements. The model that answered, the first-token time (null: this transport does not stream, so there is none to measure, and
 * never 0) and the input's layers go onto the step's metrics (`fca_decision_metrics`); a body task's counters take the call
 * (`fca_task_summary`); a call that is not the step's own decision (asked ahead, or a history summary) writes its own line,
 * `fca_aux_call`, since it belongs to no decision number. Numbers, enums and ids only.
 */
export function measuredCall(call: { execution: ActionExecution | undefined; input: FcaModelInput; message: Anthropic.Message; usage: AnthropicFcaUsage;
  body: Anthropic.MessageCreateParamsNonStreaming; history: readonly Anthropic.MessageParam[]; turn: readonly Anthropic.MessageParam[];
  transient: boolean; model: string; milliseconds: number }): void {
  try {
    const { execution, input, usage } = call;
    if (!execution) return;
    const answered = (call.message as { model?: unknown }).model;
    const model = typeof answered === 'string' && /^[A-Za-z0-9._:/-]{1,80}$/u.test(answered) ? answered : call.model;
    const layers = requestLayers(call.body, call.history, call.turn, input, call.transient);
    if (execution.modelMetrics) Object.assign(execution.modelMetrics, { model, ttftMs: null, layers });
    const kind: FcaCallKind | undefined = input.task.id === 'fca-history-summary' ? 'summary' : execution.telemetry?.kind;
    const out = usage.outputTokens, read = usage.cachedInputTokens, write = usage.cacheCreationInputTokens;
    if (execution.telemetry && kind) fcaTaskTelemetry.call(execution.telemetry.taskId, kind, { out, uncached: Math.max(0, usage.inputTokens - read) });
    if (kind !== 'lookahead' && kind !== 'summary') return;
    const counts = { new: Math.max(0, usage.inputTokens - read - write), read, write };
    console.info(JSON.stringify({ event: 'fca_aux_call', task: execution.telemetry?.taskId ?? null, kind, model, ttftMs: null,
      llmMs: Math.round(call.milliseconds), in: counts, out, layers }));
  } catch { /* measuring never fails a decision */ }
}
