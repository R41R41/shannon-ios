import { CONTROL_TOOLS,MENUS,ONE_HOUR,graceAfter,observedFcaToolName,observedFcaRequest,observedFcaResponse,logRequestSize,skillCounts,decisionFields,markedHistory,nativeHistory,nonempty,positiveInteger } from './anthropicFcaSupport.js';
import type { SentRequest,RequestBuilt } from './anthropicFcaSupport.js';
import Anthropic from '@anthropic-ai/sdk';
import { shannonIdentityPrompt,SHANNON_FCA_TASK_CAPABILITY,SHANNON_FCA_PROGRESS_CAPABILITY } from '@shannon/cognition';
import type { FcaModel,FcaModelInput,FcaModelOutput,FcaRedecided } from '../../../mind/action/fca/fcaPorts.js';
import { FCA_WAIT_RULE as WAIT_RULE } from './anthropicFcaControl.js';
import { estimatedAnthropicCostUsd,knownCount,knownInput,tokenCount,unknownCostUpperBound } from '../claude/claudeUsage.js';
import { claudeClient } from '../claude/claudeClient.js';
import { sendClaudeOnce } from '../claude/claudeOnce.js';
import { claudeToolLoop } from '../claude/claudeToolLoop.js';
import type { ClaudeSend } from '../claude/claudeTransport.js';
import { AnthropicUsageEvidenceError,cacheHaikuRequest,cacheOneShotRequest,validateHaikuCacheUsage } from './haikuCache.js';
import { DEFAULT_HAIKU_MODEL,isAppendOnlyAnthropicModel,OPUS_MODEL,usesOneHourAnthropicCache } from './haikuConfig.js';
import { observeSync } from '../../observer/observerContext.js';
import { FCA_MENU_INSTRUCTIONS,nativeFcaTools } from './anthropicFcaTools.js';
import { answeredTurn,decodeDecision } from './anthropicFcaDecision.js';
import { FCA_CORE_MENU_INSTRUCTIONS,transientFcaTools } from './anthropicFcaCoreTools.js';
import { decodeFcaContext,FCA_CONTEXT_INSTRUCTIONS,FCA_CONTEXT_NAME,FCA_CONTEXT_TOOL,fcaContextNotProvided } from './anthropicFcaContext.js';
import { currentActionExecution } from '../../context/actionExecution.js';
import { recordedClient } from '../../decisionRecords/decisionRecordClient.js';
import { elidedDecision,estimatedAnthropicTokens,restatedKnowledge,unchangedParts } from './anthropicFcaHistory.js';
import { BODY_RULE,OWNER_CLOCK_RULE,STEP_INSTRUCTIONS,stepInstructions } from './anthropicFcaInstructions.js';
import { reportDispatchFailure,reportRejection } from './anthropicRejection.js';
import { classifyDispatchFailure,failureError,failureMayHaveBeenCharged,missingDecision,refusalError } from './anthropicFcaFailure.js';
import { compactedDecision,FCA_COMPACT_ABOVE_TOKENS } from './anthropicFcaCompaction.js';
import { decisionRequestMetrics } from './anthropicFcaMetrics.js';
import { transientRequest } from './anthropicFcaTransientRequest.js';
import { FCA_TRANSIENT_UNSUPPORTED } from '../../../mind/action/fca/fcaTransientFallback.js';
import { minecraftProfile,type MinecraftProfile,type MinecraftV2Hooks } from './anthropicFcaMinecraftSystem.js';
import { FCA_TRANSIENT_BETAS,FCA_TRANSIENT_BODY_RULE,FCA_TRANSIENT_CURRENT,FCA_TRANSIENT_READING,inputTransformations,appendixOf,notedMessages,transientBetaRefused } from './anthropicFcaTransient.js';

/** Only content-free accounting leaves this adapter; signed history belongs to the task's private replay. */
export interface AnthropicFcaUsage {
  model: string;
  usageComplete: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface AnthropicFcaClient {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming, options: { signal: AbortSignal; maxRetries: number; headers?: Record<string,
       string> }): PromiseLike<Anthropic.Message>;
  };
}

export interface AnthropicFcaOptions {
  model?: string;
  /** Already selected by the caller's provider/credential policy. No ambient environment lookup. */
  apiKey?: string;
  client?: AnthropicFcaClient;
  fetcher?: typeof fetch;
  maximumOutputTokens?: number;
  timeoutMilliseconds?: number;
  /** Required, and awaited before usage/cache/output validation, including unknown paid outcomes. */
  recordUsage: (usage: AnthropicFcaUsage) => void | Promise<void>;
  /** The owner's clock at each decision, so that 今日 and 明日 are his days (2026-10-13: a child read them in UTC). */
  clock?(): { localTime: string; timeZone: string };
  /**
   * Whether a later request continues this one's conversation (a task decision, whose turn the next decision replays: the
   * default). A request that nothing continues (the history summary, `anthropicFcaSummary.ts`) caches only its fixed prefix and
   * writes no conversation tail, which no later request could read and which costs twice the uncached price at the one-hour
   * write (Minebot lane, 2026-10-14, task 788da00a: 22 summaries of 16–26k tokens each wrote all but 1,792 of them).
   */
  continued?: boolean;
  /**
   * Above this estimate of the whole request's input tokens the decision message is shortened before it is sent
   * (`anthropicFcaCompaction.ts`; `SHANNON_FCA_COMPACT_ABOVE_TOKENS`, default 95,000: under the 100,000-token price step).
   */
  compactAboveTokens?: number;
  /**
   * How long a request already sent may still finish after the step is stopped (default 0: the stop aborts it at once). Minecraft
   * run 10 (2026-10-14, task 74a32315): the owner's cancel aborted a decision in flight; its outcome and spend became unknown (a
   * $1.01 upper bound in the usage ledger for a ~73k-token request), the step was left unknown and the body lease
 * was held until the
   * unknown exit three minutes later. Its answer is still discarded; only its usage is recorded and the step can stop as known.
   */
  stopGraceMilliseconds?: number;
  /** Words after a transient body task's instructions (the LLM-centric body's rules, `minecraftKnowledge.ts`). */ systemAppendix?: string;
  /**
   * the own prompt (Syzygy ADR-0014 D3): a Minecraft body task (a transient task, or a legacy decision with a body) reads
   * its own instructions (`anthropicFcaMinecraftSystem.ts`, with `systemAppendix` as its knowledge) behind its own
 * transport block, and its
   * live state carries no owner clock and no shared affect. Absent: a model that serves no body task (the plain summarizer).
   */
  minecraftOwnPrompt?: boolean;
  /** mb-llmc v2 (needs `minecraftOwnPrompt`): six fixed tools, the mode's instructions and live state (`MinecraftV2Hooks`). */
  minecraftV2?: MinecraftV2Hooks;
  /**
   * mb-llmc v2 (needs `minecraftOwnPrompt`; the history summary only, `anthropicFcaSummary.ts`): the summary's instructions are
   * its header alone, without the step instructions that name the task tools (`task.replan`, `fca_context`) the
 * summarizer is not given.
   */
  minecraftSummaryFacts?: boolean;
}
/** How many tasks' last requests a model keeps. */
const SENT_KEPT = 8;

/** One native Messages request per decision. Scheduling, execution and authority stay with the caller. */
export class AnthropicFcaModel implements FcaModel {
  readonly model: string;
  private readonly client: AnthropicFcaClient;
  private readonly maximumOutputTokens: number;
  private readonly timeoutMilliseconds: number;
  private readonly system: string;
  /** The instructions of a transient body task (`anthropicFcaTransient.ts`): what the delta and live-state messages
 * mean, and the rules
 * their fields had. */
  private readonly transientSystem: string;
  private readonly compactAboveTokens: number;
  /** the own prompt: a body task's own instructions and transport block; null for a model that serves no body task. */
  private readonly minecraft: MinecraftProfile | null;
  /** Amendment A-10: the same provider client for a decision asked again (its requests are written to the decision
 * records as `redecide`). */
  private readonly redecideClient: AnthropicFcaClient;
  /** Amendment A-10: each task's last request as it went out (the newest eight tasks), so that one call of its
 * decision can be asked again. */
  private readonly sent = new Map<string, SentRequest>();

  constructor(private readonly options: AnthropicFcaOptions) {
    this.model = options.model ?? DEFAULT_HAIKU_MODEL;
    this.maximumOutputTokens = options.maximumOutputTokens ?? 4_000;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 90_000;
    this.compactAboveTokens = options.compactAboveTokens ?? FCA_COMPACT_ABOVE_TOKENS;
    if (!usesOneHourAnthropicCache(this.model) || !positiveInteger(this.maximumOutputTokens) || this.maximumOutputTokens > 128_000
      || !positiveInteger(this.timeoutMilliseconds) || !positiveInteger(this.compactAboveTokens)
      || typeof options.recordUsage !== 'function') throw new Error('FCA_MODEL_CONFIG_INVALID');
    if (!options.client && !options.apiKey?.trim()) throw new Error('ANTHROPIC_API_KEY_REQUIRED');
    // The request that goes out and its answer are written first to the decision records (a body task's steps only;
// `decisionRecordClient.ts`).
    const provider = options.client ?? claudeClient({ apiKey: options.apiKey!, timeoutMilliseconds: this.timeoutMilliseconds, fetch: options.fetcher });
    this.client = recordedClient(provider, options.continued === false ? 'summary' : 'decision');
    this.redecideClient = recordedClient(provider, 'redecide');
    this.system = `${shannonIdentityPrompt()}\n\n${SHANNON_FCA_TASK_CAPABILITY.text}\n\n${STEP_INSTRUCTIONS}`;
    this.transientSystem = `${shannonIdentityPrompt()}\n\n${SHANNON_FCA_TASK_CAPABILITY.text}\n\n`
      + ("" +
`${stepInstructions(FCA_TRANSIENT_CURRENT, FCA_TRANSIENT_READING)}` +
"\n\nownerClock: " +
`${OWNER_CLOCK_RULE}` +
"\nwaiting: " +
`${WAIT_RULE}` +
"\nbody: " +
`${BODY_RULE}` +
"\n")
      + `${FCA_TRANSIENT_BODY_RULE}\n\n${FCA_CONTEXT_INSTRUCTIONS}\n\n${SHANNON_FCA_PROGRESS_CAPABILITY.text}${appendixOf(options)}`;
    this.minecraft = minecraftProfile(options);
  }

  async decide(input: FcaModelInput, signal: AbortSignal): Promise<FcaModelOutput> {
    const timeout = AbortSignal.timeout(this.timeoutMilliseconds), combined = AbortSignal.any([signal, timeout]);
    if (combined.aborted) throw new Error('FCA_MODEL_ABORTED');
    const history = nativeHistory(input.history);
    if (input.catalog && !isAppendOnlyAnthropicModel(this.model)) throw new Error('FCA_MODEL_INLINE_TOOLS_UNSUPPORTED');
    // Transient mode (`fcaCoreTools.ts`) declares `fca_context` at the top level, so it needs no selected menu to carry it.
    const transient = input.coreTools !== undefined;
    if (input.sharedContext && !input.catalog && !transient) throw new Error('FCA_CONTEXT_REQUIRES_SELECTED_MODE');
    const { turn, body, menu, built } = observeSync('native', {
      model: this.model, historyMessageCount: history.length, deliveredMessageCount: input.messages.length,
      offeredTools: input.tools.map(tool => observedFcaToolName(tool.name)),
    }, () => {
      const menu = transient
        ? transientFcaTools(input, history, MENUS[String(this.v2() !== null)]!.controls, [FCA_CONTEXT_TOOL], MENUS[String(this.v2() !== null)]!.names)
        // mb-llmc v2's history summary is offered its one summary tool and no control tool: asked to "name no tool
// except … fca_complete" it
        // sometimes called the summary tool and fca_complete together (FCA_MODEL_CONTROL_MIXED, 2 of 32 summaries in the
// replay bench of 8607283).
        : nativeFcaTools(input, history, this.options.minecraftSummaryFacts ? [] : CONTROL_TOOLS, input.sharedContext ? [FCA_CONTEXT_TOOL] : []);
      const clock = this.options.clock?.(), ownerClock = clock ? { ...clock, rule: OWNER_CLOCK_RULE } : undefined;
      if (transient) return this.transientRequest(input, history, menu, ownerClock);
      // A part this epoch's replay already showed in full is not restated (`anthropicFcaHistory.ts`,
// `elidedDecision`); the message is stored as sent.
      const supplied = decisionFields(input, ownerClock, transient);
      const fields = elidedDecision(supplied, restatedKnowledge(history));
      // A system message holding tool changes must immediately follow a user turn and be either the last message or
      // immediately followed by an assistant turn: it may not open the conversation (a live 400, 2026-10-12), nor sit between
      // two user messages (a live 400, 2026-10-14, Minebot lane run 3: tasks a5ad9996 and the root fd99df55 sent a public
      // epoch as [bootstrap, tool changes, decision]). The inline definitions therefore always follow the current decision
      // message and end the request; the stored round keeps them before the assistant's answer.
      const turnOf = (sent: Record<string, unknown>): Anthropic.MessageParam[] => [{ role: 'user', content: JSON.stringify(sent) }, ...menu.appended];
      // The fixed instructions end with their own breakpoint, so that every decision and every task reads them from the cache
      // even when its conversation starts a new public epoch (Minebot lane, 2026-10-14, task 788da00a: every step was a new
      // epoch and read only the tools and the protocol prefix, 1,792–1,798 tokens, writing the instructions again each time).
      const menuInstructions = transient ? `${FCA_MENU_INSTRUCTIONS}\n${FCA_CORE_MENU_INSTRUCTIONS}` : FCA_MENU_INSTRUCTIONS;
      // the own prompt: a legacy decision that carries a body reads the body task's header instead of the persona, and a body
      // summary (a one-shot model, `continued: false`, given the own prompt only for a body: `anthropicFcaSummary.ts`)
// the summary's header.
      const own = this.minecraft, oneShot = this.options.continued === false;
      const base = own && oneShot ? own.summary : own && input.body !== undefined ? own.legacy : this.system;
      const system = [{ type: 'text' as const, text: input.catalog ? `${base}\n\n${menuInstructions}` : base, cache_control: ONE_HOUR }];
      const continued = this.options.continued !== false, replay = continued ? markedHistory(history) : history;
      const bodyOf = (turn: Anthropic.MessageParam[]) => {
        const request = {
          model: this.model, max_tokens: this.maximumOutputTokens, system,
          messages: [...replay, ...turn], tools: menu.tools, tool_choice: { type: 'auto' as const },
          thinking: { type: 'adaptive' as const }, output_config: { effort: 'low' as const },
        };
        return continued ? cacheHaikuRequest(request) : cacheOneShotRequest(request);
      };
      // Above the threshold the decision message is shortened before it is sent (`anthropicFcaCompaction.ts`), never the replay.
      const compacted = compactedDecision(fields, estimatedAnthropicTokens(bodyOf(turnOf(fields))), this.compactAboveTokens);
      if (compacted.level !== null) {
        console.info(JSON.stringify({ event: 'fca_request_compacted', model: this.model, level: compacted.level, maximumTokens: this.compactAboveTokens }));
      }
      const turn = turnOf(compacted.fields);
      // What the caller handed over, counted before elision and shortening, so that the log can tell "none was built"
// from "none was sent".
      const built = { taskId: input.task.id, bodyAttached: supplied.body !== undefined, level: compacted.level, ...skillCounts(supplied.body),
        elidedParts: unchangedParts(fields) };
      return { turn, menu, body: bodyOf(turn), built };
    }, value => observedFcaRequest(value.body), { model: this.model });
    const requestTokens = logRequestSize(this.model, history, body, turn, built);
    let message: Anthropic.Message, dispatched = false;
    const execution = currentActionExecution();
    // Once sent, a stop lets the request finish within its grace (`stopGraceMilliseconds`); the timeout still applies.
    const grace = this.options.stopGraceMilliseconds && this.options.stopGraceMilliseconds > 0 ? graceAfter(signal, this.options.stopGraceMilliseconds) : null;
    const transport = grace ? AbortSignal.any([timeout, grace.signal]) : combined;
    try {
      // The one tool loop, one request: the runner executes the calls and returns their results in the next decision.
      const headers = transient ? { 'anthropic-beta': FCA_TRANSIENT_BETAS } : input.catalog ? { 'anthropic-beta': 'inline-tools-2026-09-15' } : undefined;
      const send: ClaudeSend = request => sendClaudeOnce({
        body: request, receipt: 'fca', message: value => value,
        span: { handoff: { model: this.model }, input: observedFcaRequest(request), project: observedFcaResponse, model: this.model },
        dispatching: () => {
          // The runner just rechecked audience, sources and its awaited lease permit. Keep dispatch synchronous.
          combined.throwIfAborted();
          dispatched = true;
          this.remember(input.task.id, { body: request, headers, names: menu.names, history, requestTokens });
          // Chapter 8: the facts said once whose words this request's last message holds are delivered with it.
          try { this.v2()?.requestSent?.(input.task.id, request); } catch { /* a record of delivery never fails a request */ }
          if (!execution) return;
          execution.modelOutcome = 'unknown';
          delete execution.modelUsage;
        },
        dispatch: () => this.client.messages.create(request, { signal: transport, maxRetries: 0, ...(headers ? { headers } : {}) }),
      });
      message = (await claudeToolLoop(body, { session: undefined, send, isAnswer: () => true, refusal: 'final', maxRounds: 1 })).final!;
    } catch (error) {
      // No hidden resend, including after an abort: this adapter never sends twice. The visible, logged retries of a request that
      // carried no decision belong to the runner (`decideWithRetry`). Never expose provider error text containing request material.
      if (!dispatched) throw new Error(combined.aborted ? 'FCA_MODEL_ABORTED' : 'FCA_MODEL_NOT_DISPATCHED');
      if (error instanceof Anthropic.APIError && error.status !== undefined && error.status >= 400 && error.status < 500) {
        // Content-free: status, provider error type and a closed message class (`anthropicRejection.ts`).
        reportRejection(error, true);
        if (execution) { execution.modelOutcome = 'acknowledged';
          execution.modelUsage = { inputTokens: 0, outputTokens: 0 }; }
        // The very first decision of a transient task, refused for its betas: nothing ran and no signed history exists, so the runner may
        // start the task again in the legacy shape (`fcaTransientFallback.ts`).
        if (transient && history.length === 0 && transientBetaRefused(error.status, error.message)) throw new Error(FCA_TRANSIENT_UNSUPPORTED);
        throw refusalError(error.status, error);
      }
      reportDispatchFailure('fca', error);
      const failure = classifyDispatchFailure(error, { stopped: signal.aborted, deadline: timeout.aborted });
      // The provider's own server error (5xx, 529) carries no decision and no charge: the step's outcome is known (2026-10-13: such a
      // step sat unknown for ten minutes holding a research slot), and nothing is booked, as for a 4xx. Any other failure may have been
      // processed and charged by the provider: booked at an upper bound sized by this request, never as a whole context (an outage's
      // retries would otherwise book the cap away). One that never left this machine (refused, unresolved) is booked as nothing.
      if (failure.kind === 'server' && execution) {
        execution.modelOutcome = 'acknowledged';
        execution.modelUsage = { inputTokens: 0, outputTokens: 0 };
      } else if (failureMayHaveBeenCharged(failure)) await this.options.recordUsage(this.usage(undefined, requestTokens));
      throw failureError(failure);
    } finally { grace?.dispose(); }
    const usage = this.usage(message.usage);
    await this.options.recordUsage(usage);
    if (!usage.usageComplete) throw new AnthropicUsageEvidenceError('HAIKU_RESPONSE_USAGE_INVALID');
    if (execution) { execution.modelOutcome = 'acknowledged';
      execution.modelUsage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }; }
    // Measurement only: the response is already received and billed, so nothing here may fail the decision.
    const transformed = transient ? inputTransformations(message) : { count: 0, reasons: [] };
    if (transformed.count) {
      console.warn(JSON.stringify({ event: 'fca_input_transformations', task: input.task.id, count: transformed.count, reasons: transformed.reasons }));
    }
    if (execution) {
      const extra = transient ? { providerTransformations: transformed.count, cuts: (built as RequestBuilt).sent?.stages } : undefined;
      try { execution.modelMetrics = decisionRequestMetrics(history, turn, usage, built, extra); } catch { delete execution.modelMetrics; }
    }
    validateHaikuCacheUsage(message.usage);
    if (combined.aborted) throw new Error('FCA_MODEL_ABORTED');
    if (message.stop_reason === 'max_tokens') throw new Error('FCA_MODEL_TRUNCATED');
    if (message.stop_reason === 'refusal') throw new Error('FCA_MODEL_REFUSED');
    if (message.stop_reason !== 'tool_use') throw missingDecision(message, input.task.id);
    const { decision: decided, set_aside: setAside } = decodeDecision(message.content, menu.names, history, input.sharedContext ||
       transient ? FCA_CONTEXT_NAME : undefined);
    const hooks = this.v2();
    const decision = hooks && decided.kind === 'tools' ? { ...decided, calls: decided.calls.map(call => ({ ...call, input: hooks.callInput(
      call.name, call.input) as typeof call.input })) } : decided;
    // the own prompt: a transient body task is shown no shared context, so its fca_context is answered as not provided.
    const unshared = !input.sharedContext || this.minecraft !== null;
    const context = unshared && transient ? fcaContextNotProvided(message.content) : decodeFcaContext(message.content, decision, input);
    const appended = answeredTurn({ turn, content: message.content, decision, setAside, context, toolResults: results => this.toolResults(results) });
    // A transient request whose state was cut, and could be whole in a new epoch, says so: the runner may start the
// next epoch earlier (`fcaStateCut`).
    return { decision, history: appended, ...context, ...((built as RequestBuilt).sent ? { stateCut: (built as RequestBuilt).sent!.cut } : {}) };
  }

  private remember(taskId: string, sent: SentRequest): void {
    this.sent.delete(taskId);
    this.sent.set(taskId, sent);
    if (this.sent.size > SENT_KEPT) this.sent.delete(this.sent.keys().next().value as string);
  }

  /**
   * Amendment A-10: the task's last request sent again to Opus, once, with the note after its live state and
 * nothing else changed (the same system, tools, history, settings and
   * thinking: only `model`), and answered like a decision. The answer is decoded and shaped by the mode's hooks as
 * a decision's is, but it is not the task's history: the caller uses it
   * for the one call it was asked about. Its cost is booked like a decision's (`recordUsage`, the budget's). Null:
 * this model is Opus already. Throws: nothing remembered, a request the note
   * cannot be added to, a request that failed or timed out (booked at its upper bound when it may have been
 * charged), an answer that cannot be read.
   */
  async redecide(parts: { taskId: string; note: string; signal: AbortSignal; timeoutMs: number }): Promise<FcaRedecided | null> {
    if (this.model === OPUS_MODEL) return null;
    const sent = this.sent.get(parts.taskId);
    if (!sent) throw new Error('FCA_REDECIDE_NO_REQUEST');
    const messages = notedMessages(sent.body.messages, parts.note);
    if (!messages) throw new Error('FCA_REDECIDE_NOT_EXTENDABLE');
    const timeout = AbortSignal.timeout(parts.timeoutMs), combined = AbortSignal.any([parts.signal, timeout]);
    combined.throwIfAborted();
    const body = { ...sent.body, model: OPUS_MODEL, messages } as Anthropic.MessageCreateParamsNonStreaming;
    const began = Date.now();
    let message: Anthropic.Message;
    try {
      message = await this.redecideClient.messages.create(body, { signal: combined, maxRetries: 0, ...(sent.headers ? { headers: sent.headers } : {}) });
    } catch (error) {
      const failure = classifyDispatchFailure(error, { stopped: parts.signal.aborted, deadline: timeout.aborted });
      if (failureMayHaveBeenCharged(failure)) await this.options.recordUsage(this.usage(undefined, sent.requestTokens, OPUS_MODEL));
      throw new Error(`FCA_REDECIDE_${timeout.aborted ? 'TIMEOUT' : parts.signal.aborted ? 'ABORTED' : 'FAILED'}: ${String((error as Error |
         undefined)?.message ?? error).slice(0, 160)}`);
    }
    const usage = this.usage(message.usage, undefined, OPUS_MODEL);
    await this.options.recordUsage(usage);
    const spent = { complete: usage.usageComplete, inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens, outputTokens: usage.outputTokens, costUsd: usage.estimatedCostUsd };
    const answered = { model: OPUS_MODEL, ms: Date.now() - began, stopReason: message.stop_reason ?? null, usage: spent };
    if (message.stop_reason !== 'tool_use') throw new Error(`FCA_REDECIDE_NO_CALL: stop_reason=${String(message.stop_reason)}`);
    const { decision } = decodeDecision(message.content, sent.names, sent.history, FCA_CONTEXT_NAME);
    if (decision.kind !== 'tools') return { ...answered, calls: [], control: decision.kind };
    const hooks = this.v2();
    return { ...answered, calls: decision.calls.map(call => ({ name: call.name, input: hooks ? hooks.callInput(call.name, call.input) : call.input })) };
  }

  /** A transient body task's request: see `transientRequest` (`anthropicFcaTransientRequest.ts`). */
  private transientRequest(input: FcaModelInput, history: readonly Anthropic.MessageParam[], menu: ReturnType<typeof transientFcaTools>,
    ownerClock: Record<string, unknown> | undefined) {
    // the own prompt: the body task's own instructions and transport block; no owner clock and no shared affect in its live state.
    const own = this.minecraft;
    const supplied = own ? decisionFields({ ...input, sharedContext: undefined }, undefined, true) : decisionFields(input, ownerClock, true);
    const built = transientRequest({ model: this.model, maximumOutputTokens: this.maximumOutputTokens, compactAboveTokens: this.compactAboveTokens,
      systemText: own?.transient ?? `${this.transientSystem}\n\n${FCA_MENU_INSTRUCTIONS}\n${FCA_CORE_MENU_INSTRUCTIONS}`, input, history, menu,
      supplied, ...(own ? { protocol: own.protocol } : {}), ...this.v2Parts() });
    return { ...built, menu, built: built.built as RequestBuilt };
  }
  /** The mode's hooks, only with the own prompt (a body task of the mode reads no other instructions). */
  private v2Parts(): { rewriteLive?: MinecraftV2Hooks['rewriteLive']; stageKnowledge?: MinecraftV2Hooks['stageKnowledge'];
    progress?: NonNullable<MinecraftV2Hooks['progress']> } {
    const hooks = this.v2();
    return hooks ? { rewriteLive: hooks.rewriteLive, stageKnowledge: hooks.stageKnowledge, ...(hooks.progress ? { progress: hooks.progress } : {}) } : {};
  }
  private v2(): MinecraftV2Hooks | null { return this.minecraft && this.options.minecraftV2 ? this.options.minecraftV2 : null; }
  toolResults(results: readonly { id: string; text: string; ok: boolean }[]): Anthropic.MessageParam {
    const ids = new Set<string>();
    if (!results.length) throw new Error('FCA_MODEL_RESULTS_INVALID');
    return { role: 'user', content: results.map(result => {
      if (!nonempty(result.id) || ids.has(result.id) || typeof result.text !== 'string' || typeof result.ok !== 'boolean') {
        throw new Error('FCA_MODEL_RESULTS_INVALID');
      }
      ids.add(result.id);
      return { type: 'tool_result', tool_use_id: result.id, content: result.text, is_error: !result.ok };
    }) };
  }

  /**
   * `requestTokens`: with no usage at all (a request whose bill is unknown), the estimate of the request's input
 * tokens bounds what it
   * may have cost: the whole request written to the one-hour cache, with a quarter more for the estimate's error,
 * and its output ceiling.
   */
  private usage(native: Anthropic.Message['usage'] | undefined, requestTokens?: number, model: string = this.model): AnthropicFcaUsage {
    const counts = {
      input: knownCount(native?.input_tokens), output: knownCount(native?.output_tokens),
      cacheWrite: knownCount(native?.cache_creation_input_tokens), cacheRead: knownCount(native?.cache_read_input_tokens), searches: 0,
      ...(native?.cache_creation ? { cacheWrite5m: native.cache_creation.ephemeral_5m_input_tokens, cacheWrite1h:
         native.cache_creation.ephemeral_1h_input_tokens } : {}),
    };
    const input = counts.input + counts.cacheWrite + counts.cacheRead;
    const total = input + counts.output;
    const complete = [native?.input_tokens, native?.output_tokens, native?.cache_creation_input_tokens, native?.cache_read_input_tokens].every(tokenCount)
      && Number.isSafeInteger(total);
    const sized = !native && requestTokens !== undefined ? { input: 0, cacheWrite: Math.ceil(requestTokens * 1.25), cacheRead: 0 } : null;
    const bound = complete ? 0 : unknownCostUpperBound(model, this.maximumOutputTokens, 0, sized ?? knownInput(native));
    return { model, usageComplete: complete, inputTokens: input, cachedInputTokens: counts.cacheRead,
      cacheCreationInputTokens: counts.cacheWrite, outputTokens: counts.output, totalTokens: total,
      estimatedCostUsd: Math.max(estimatedAnthropicCostUsd(model, counts), bound),
    };
  }
}

export function createAnthropicFcaModel(options: AnthropicFcaOptions): FcaModel { return new AnthropicFcaModel(options); }
