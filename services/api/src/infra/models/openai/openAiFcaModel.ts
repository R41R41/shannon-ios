import { shannonIdentityPrompt, SHANNON_FCA_PROGRESS_CAPABILITY, SHANNON_FCA_TASK_CAPABILITY } from '@shannon/cognition';
import type Anthropic from '@anthropic-ai/sdk';
import type { FcaModel, FcaModelInput, FcaModelOutput } from '../../../mind/action/fca/fcaPorts.js';
import { FcaProviderError, FCA_MODEL_BILLING, retryableStatus } from '../../../mind/action/fca/fcaProviderRetry.js';
import { currentActionExecution } from '../../context/actionExecution.js';
import { recordRequest, recordResponse } from '../../decisionRecords/decisionRecordNotes.js';
import { FCA_WAIT_RULE as WAIT_RULE } from '../anthropic/anthropicFcaControl.js';
import { FCA_CONTEXT_INSTRUCTIONS, FCA_CONTEXT_NAME, FCA_CONTEXT_TOOL, decodeFcaContext, fcaContextNotProvided } from '../anthropic/anthropicFcaContext.js';
import { FCA_CORE_MENU_INSTRUCTIONS, transientFcaTools } from '../anthropic/anthropicFcaCoreTools.js';
import { answeredTurn, decodeDecision } from '../anthropic/anthropicFcaDecision.js';
import { FCA_COMPACT_ABOVE_TOKENS } from '../anthropic/anthropicFcaCompaction.js';
import { classifyDispatchFailure, failureError, failureMayHaveBeenCharged, missingDecision } from '../anthropic/anthropicFcaFailure.js';
import { OWNER_CLOCK_RULE, BODY_RULE, stepInstructions } from '../anthropic/anthropicFcaInstructions.js';
import { decisionRequestMetrics } from '../anthropic/anthropicFcaMetrics.js';
import { minecraftProfile, type MinecraftProfile, type MinecraftV2Hooks } from '../anthropic/anthropicFcaMinecraftSystem.js';
import { FCA_MENU_INSTRUCTIONS } from '../anthropic/anthropicFcaTools.js';
import { appendixOf, FCA_TRANSIENT_BODY_RULE, FCA_TRANSIENT_CURRENT, FCA_TRANSIENT_READING, isFcaClearAtMessage, renderedRequest } from '../anthropic/anthropicFcaTransient.js';
import { transientRequest } from '../anthropic/anthropicFcaTransientRequest.js';
import { decisionFields, graceAfter, MENUS, nonempty, positiveInteger, type RequestBuilt } from '../anthropic/anthropicFcaSupport.js';
import { estimatedAnthropicTokens } from '../anthropic/anthropicFcaHistory.js';
import type { AnthropicFcaUsage } from '../anthropic/anthropicFcaModel.js';
import { HAIKU_PROTOCOL_PREFIX } from '../anthropic/haikuCache.js';
import { classifyOpenAiTransport } from './openAiFailure.js';
import { failedAnswer, messageShaped, openAiCostUsd, openAiCounts, openAiUnknownCostUsd, parsedRound, responsesRequest, type OpenAiCounts } from './openAiFcaWire.js';
import { DEFAULT_OPENAI_EFFORT, OPENAI_TOKEN_SCALE, isOpenAiModel, type OpenAiEffort } from './openAiModels.js';
import { billingRefusal, OpenAiHttpError, postResponses } from './openAiResponsesTransport.js';

export interface OpenAiFcaOptions {
  model: string;
  /** Already selected by the caller's provider/credential policy (`OPENAI_API_KEY`). No ambient environment lookup. */
  apiKey?: string;
  /** Tests: recorded responses. */
  fetcher?: typeof fetch;
  endpoint?: string;
  /** The reasoning effort of the decisions (default `medium`; sol and astra take no `none`). */
  effort?: OpenAiEffort;
  maximumOutputTokens?: number;
  timeoutMilliseconds?: number;
  /** In the units of `estimatedAnthropicTokens` before the model's own count is applied (`OPENAI_TOKEN_SCALE`): the request's ceiling is this over the scale. */
  compactAboveTokens?: number;
  /** Required, and awaited before the answer is read, including unknown paid outcomes. */
  recordUsage: (usage: AnthropicFcaUsage) => void | Promise<void>;
  clock?(): { localTime: string; timeZone: string };
  /** How long a request already sent may still finish after the step is stopped (default 0). */
  stopGraceMilliseconds?: number;
  systemAppendix?: string;
  minecraftOwnPrompt?: boolean;
  minecraftV2?: MinecraftV2Hooks;
  /**
   * Whether the model's reasoning items (`reasoning.encrypted_content`) are kept in the task's history and sent back (default on): the
   * reasoning of every earlier round is then read, and paid as input (at the cache's price while the prefix holds), by each later one.
   */
  replayReasoning?: boolean;
}

/**
 * One Responses request per decision (the OpenAI counterpart of `AnthropicFcaModel`, for a Minecraft body task's transient mode). The
 * request is built by the same code (`transientRequest`: the stored state, the cuts, the fixed menu, the live state last), then sent as
 * function tools with `tool_choice: auto`, `store: false`, a `prompt_cache_key` fixed for the task and `reasoning.effort` of the role;
 * the answer's items are kept as blocks (`openAiFcaWire.ts`). Nothing here is Anthropic's: no cache marker, no one-hour cache contract
 * (its receipt is not asked of an OpenAI answer), no beta header. Scheduling, execution and authority stay with the caller. No second
 * judgment by another model (`redecide` is absent): OpenAI roles use one model.
 */
export class OpenAiFcaModel implements FcaModel {
  readonly model: string;
  private readonly maximumOutputTokens: number;
  private readonly timeoutMilliseconds: number;
  private readonly compactAboveTokens: number;
  private readonly effort: OpenAiEffort;
  private readonly replayReasoning: boolean;
  private readonly transientSystem: string;
  private readonly minecraft: MinecraftProfile | null;

  constructor(private readonly options: OpenAiFcaOptions) {
    this.model = options.model;
    this.maximumOutputTokens = options.maximumOutputTokens ?? 4_000;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 90_000;
    this.compactAboveTokens = Math.floor((options.compactAboveTokens ?? FCA_COMPACT_ABOVE_TOKENS) / OPENAI_TOKEN_SCALE);
    this.effort = options.effort ?? DEFAULT_OPENAI_EFFORT;
    this.replayReasoning = options.replayReasoning !== false;
    if (!isOpenAiModel(this.model) || !positiveInteger(this.maximumOutputTokens) || this.maximumOutputTokens > 128_000
      || !positiveInteger(this.timeoutMilliseconds) || !positiveInteger(this.compactAboveTokens)
      || typeof options.recordUsage !== 'function') throw new Error('FCA_MODEL_CONFIG_INVALID');
    if (!options.apiKey?.trim()) throw new Error('OPENAI_API_KEY_REQUIRED');
    this.transientSystem = `${shannonIdentityPrompt()}\n\n${SHANNON_FCA_TASK_CAPABILITY.text}\n\n`
      + `${stepInstructions(FCA_TRANSIENT_CURRENT, FCA_TRANSIENT_READING)}\n\nownerClock: ${OWNER_CLOCK_RULE}\nwaiting: ${WAIT_RULE}\nbody: ${BODY_RULE}\n`
      + `${FCA_TRANSIENT_BODY_RULE}\n\n${FCA_CONTEXT_INSTRUCTIONS}\n\n${SHANNON_FCA_PROGRESS_CAPABILITY.text}${appendixOf(options)}`;
    this.minecraft = minecraftProfile(options);
  }

  async decide(input: FcaModelInput, signal: AbortSignal): Promise<FcaModelOutput> {
    const timeout = AbortSignal.timeout(this.timeoutMilliseconds), combined = AbortSignal.any([signal, timeout]);
    if (combined.aborted) throw new Error('FCA_MODEL_ABORTED');
    // The mode is transient only (`fcaCoreTools.ts`): a legacy decision's catalog and shared context are Anthropic's inline-tool protocol.
    if (input.coreTools === undefined) throw new Error('FCA_MODEL_OPENAI_TRANSIENT_ONLY');
    const history = this.history(input.history);
    const menu = transientFcaTools(input, history, MENUS[String(this.v2() !== null)]!.controls, [FCA_CONTEXT_TOOL], MENUS[String(this.v2() !== null)]!.names);
    const clock = this.options.clock?.(), ownerClock = clock ? { ...clock, rule: OWNER_CLOCK_RULE } : undefined;
    const own = this.minecraft;
    const supplied = own ? decisionFields({ ...input, sharedContext: undefined }, undefined, true) : decisionFields(input, ownerClock, true);
    const protocol = own?.protocol ?? HAIKU_PROTOCOL_PREFIX;
    // The inline tool additions are declared with the request's tools (`responsesRequest`), never stored as a message of the history.
    const built = transientRequest({ model: this.model, maximumOutputTokens: this.maximumOutputTokens, compactAboveTokens: this.compactAboveTokens,
      systemText: own?.transient ?? `${this.transientSystem}\n\n${FCA_MENU_INSTRUCTIONS}\n${FCA_CORE_MENU_INSTRUCTIONS}`, input, history,
      menu: { tools: menu.tools, appended: [] }, supplied, protocol, ...this.v2Parts() });
    const request = { ...built.body, tools: [...built.body.tools ?? [], ...inlineAdditions(menu.appended)] } as Anthropic.MessageCreateParamsNonStreaming;
    const wire = responsesRequest(request, { model: this.model, effort: this.effort, taskKey: input.task.id,
      maximumOutputTokens: this.maximumOutputTokens, replayReasoning: this.replayReasoning }, protocol);
    const requestTokens = Math.ceil(estimatedAnthropicTokens(renderedRequest(request)) * OPENAI_TOKEN_SCALE);
    console.info(JSON.stringify({ event: 'fca_request_size', model: this.model, historyCharacters: JSON.stringify(history).length,
      requestCharacters: JSON.stringify(wire).length, estimatedInputTokens: requestTokens, provider: 'openai' }));
    const execution = currentActionExecution();
    const grace = this.options.stopGraceMilliseconds && this.options.stopGraceMilliseconds > 0 ? graceAfter(signal, this.options.stopGraceMilliseconds) : null;
    const transport = grace ? AbortSignal.any([timeout, grace.signal]) : combined;
    let answer: unknown, dispatched = false, recorded: string | null = null;
    try {
      // The runner just rechecked audience, sources and its awaited lease permit. Keep dispatch synchronous.
      combined.throwIfAborted();
      dispatched = true;
      recorded = recordRequest('decision', request as unknown as Readonly<Record<string, unknown>>);
      try { this.v2()?.requestSent?.(input.task.id, request); } catch { /* a record of delivery never fails a request */ }
      if (execution) { execution.modelOutcome = 'unknown'; delete execution.modelUsage; }
      answer = await postResponses({ apiKey: this.options.apiKey!, body: wire, signal: transport, ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}),
        ...(this.options.endpoint ? { endpoint: this.options.endpoint } : {}) });
    } catch (error) {
      // No hidden resend, including after an abort: this adapter never sends twice. Never expose provider error text.
      if (recorded) recordResponse(recorded, { error, signal });
      if (!dispatched) throw new Error(combined.aborted ? 'FCA_MODEL_ABORTED' : 'FCA_MODEL_NOT_DISPATCHED');
      if (error instanceof OpenAiHttpError) {
        // The provider answered: no decision and no charge for any status, as for a 4xx of Anthropic's. Credit is not the request's fault.
        if (execution) { execution.modelOutcome = 'acknowledged'; execution.modelUsage = { inputTokens: 0, outputTokens: 0 }; }
        if (billingRefusal(error.code, error.type)) throw new Error(FCA_MODEL_BILLING);
        throw retryableStatus(error.status) ? new FcaProviderError(error.status, error.retryAfterMs) : new Error(`FCA_MODEL_HTTP_${error.status}`);
      }
      const failure = classifyOpenAiTransport(error, { stopped: signal.aborted, deadline: timeout.aborted });
      if ((failure.kind === 'server' || failure.kind === 'not_sent') && execution) {
        execution.modelOutcome = 'acknowledged';
        execution.modelUsage = { inputTokens: 0, outputTokens: 0 };
      } else if (failureMayHaveBeenCharged(failure)) await this.options.recordUsage(this.usage(undefined, requestTokens));
      throw failureError(failure);
    } finally { grace?.dispose(); }
    const failed = failedAnswer(answer);
    const counts = openAiCounts((answer as { usage?: unknown } | null)?.usage);
    const usage = this.usage((answer as { usage?: unknown } | null)?.usage, undefined, counts);
    await this.options.recordUsage(usage);
    if (failed) {
      if (recorded) recordResponse(recorded, { error: new Error(`OPENAI_RESPONSE_${failed.code ?? 'failed'}`), signal });
      if (execution) { execution.modelOutcome = 'acknowledged'; execution.modelUsage = { inputTokens: 0, outputTokens: 0 }; }
      if (billingRefusal(failed.code)) throw new Error(FCA_MODEL_BILLING);
      throw failed.code === 'server_error' || failed.code === 'rate_limit_exceeded' ? new FcaProviderError(failed.code === 'server_error' ? 500 : 429) : new Error('FCA_MODEL_RESPONSE_UNKNOWN');
    }
    if (!usage.usageComplete) throw new Error('OPENAI_RESPONSE_USAGE_INVALID');
    if (execution) { execution.modelOutcome = 'acknowledged';
      execution.modelUsage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }; }
    let round: ReturnType<typeof parsedRound>;
    try { round = parsedRound(answer, this.replayReasoning); } catch (error) {
      if (recorded) recordResponse(recorded, { error, signal });
      throw error;
    }
    const message = messageShaped(this.model, round, counts);
    if (recorded) { try { recordResponse(recorded, { message: message as unknown as Readonly<Record<string, unknown>> }); } catch { /* a record never fails a decision */ } }
    if (execution) {
      try { execution.modelMetrics = decisionRequestMetrics(history, built.turn, usage, built.built as RequestBuilt, { providerTransformations: 0,
        cuts: (built.built as RequestBuilt).sent?.stages }); } catch { delete execution.modelMetrics; }
    }
    if (combined.aborted) throw new Error('FCA_MODEL_ABORTED');
    if (round.stop === 'max_tokens') throw new Error('FCA_MODEL_TRUNCATED');
    if (round.stop === 'refusal') throw new Error('FCA_MODEL_REFUSED');
    if (round.stop !== 'tool_use') throw missingDecision(message, input.task.id);
    const { decision: decided, set_aside: setAside } = decodeDecision(round.blocks, menu.names, history, FCA_CONTEXT_NAME);
    const hooks = this.v2();
    const decision = hooks && decided.kind === 'tools' ? { ...decided, calls: decided.calls.map(call => ({ ...call,
      input: hooks.callInput(call.name, call.input) as typeof call.input })) } : decided;
    // the own prompt: a body task is shown no shared context, so its fca_context is answered as not provided.
    const unshared = !input.sharedContext || this.minecraft !== null;
    const context = unshared ? fcaContextNotProvided(round.blocks) : decodeFcaContext(round.blocks, decision, input);
    // The live state of this turn is never stored: only the newest is read, and OpenAI bills every one that is sent.
    const stored = built.turn.filter(entry => !isFcaClearAtMessage(entry));
    const appended = answeredTurn({ turn: stored, content: round.blocks, decision, setAside, context, toolResults: results => this.toolResults(results) });
    return { decision, history: appended, ...context, ...((built.built as RequestBuilt).sent ? { stateCut: (built.built as RequestBuilt).sent!.cut } : {}) };
  }

  /** The stored history as the request reads it: messages of blocks. An entry that is not one is refused. */
  private history(entries: readonly unknown[]): Anthropic.MessageParam[] {
    return entries.map(entry => {
      const message = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as { role?: unknown; content?: unknown } : null;
      if (!message || !['user', 'assistant'].includes(String(message.role)) && !isFcaClearAtMessage(message)
        || !(typeof message.content === 'string' || Array.isArray(message.content))) throw new Error('FCA_MODEL_HISTORY_INVALID');
      return entry as Anthropic.MessageParam;
    });
  }

  private v2Parts(): { rewriteLive?: MinecraftV2Hooks['rewriteLive']; stageKnowledge?: MinecraftV2Hooks['stageKnowledge'];
    progress?: NonNullable<MinecraftV2Hooks['progress']> } {
    const hooks = this.v2();
    return hooks ? { rewriteLive: hooks.rewriteLive, stageKnowledge: hooks.stageKnowledge, ...(hooks.progress ? { progress: hooks.progress } : {}) } : {};
  }
  private v2(): MinecraftV2Hooks | null { return this.minecraft && this.options.minecraftV2 ? this.options.minecraftV2 : null; }

  /** The results of a round's calls: one user message of `tool_result` blocks (sent as `function_call_output` items). */
  toolResults(results: readonly { id: string; text: string; ok: boolean }[]): Anthropic.MessageParam {
    const ids = new Set<string>();
    if (!results.length) throw new Error('FCA_MODEL_RESULTS_INVALID');
    return { role: 'user', content: results.map(result => {
      if (!nonempty(result.id) || ids.has(result.id) || typeof result.text !== 'string' || typeof result.ok !== 'boolean') throw new Error('FCA_MODEL_RESULTS_INVALID');
      ids.add(result.id);
      return { type: 'tool_result' as const, tool_use_id: result.id, content: result.text, is_error: !result.ok };
    }) };
  }

  /**
   * The usage as the ledger keeps it: `inputTokens` all the input, `cachedInputTokens` what the cache read (`input_tokens_details.cached_tokens`),
   * `outputTokens` with the reasoning. With no usage at all (a request whose bill is unknown) the estimate of the request bounds what it may have cost.
   */
  private usage(raw: unknown, requestTokens?: number, known?: OpenAiCounts): AnthropicFcaUsage {
    const counts = known ?? openAiCounts(raw);
    const total = counts.input + counts.output;
    const bound = counts.complete ? 0 : openAiUnknownCostUsd(this.model, requestTokens ?? 200_000, this.maximumOutputTokens);
    return { model: this.model, usageComplete: counts.complete && Number.isSafeInteger(total), inputTokens: counts.input, cachedInputTokens: counts.cached,
      cacheCreationInputTokens: counts.cacheWrite, outputTokens: counts.output, totalTokens: total,
      estimatedCostUsd: Math.max(openAiCostUsd(this.model, counts), bound) };
  }
}

/** The definitions the inline additions of a request declare (`transientFcaTools`: a tool other than the core ones). */
function inlineAdditions(appended: readonly Anthropic.MessageParam[]): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];
  for (const message of appended) {
    for (const change of Array.isArray(message.content) ? message.content as unknown as { type?: string; tool?: { type?: string; definition?: Anthropic.Tool } }[] : []) {
      if (change.type === 'tool_addition' && change.tool?.type === 'tool_definition' && change.tool.definition) tools.push(change.tool.definition);
    }
  }
  return tools;
}

export function createOpenAiFcaModel(options: OpenAiFcaOptions): FcaModel { return new OpenAiFcaModel(options); }
