import Anthropic from '@anthropic-ai/sdk';
import type { BetaRequestToolAdditionBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { observerHandoff } from '../../observer/observerContext.js';
import {
  MINIMUM_ANSWER_MILLISECONDS, MINIMUM_ROUND_MILLISECONDS, PartialAnswerError, timedOut, type RoundTime,
} from '../../../mind/action/respond/turnDeadline.js';
import { CUT_OFF_CALL_NOTE, TIMED_OUT_ROUND_NOTE, TOOLS_GONE_NOTE, type ShannonModelToolSession } from '../chatModelTools.js';
import { parallelToolsEnabled, runToolStep, type ToolStepState } from '../chatModelToolStep.js';
import { claudeTools } from '../anthropic/anthropicRequest.js';
import { observedToolName } from '../anthropic/observerProjection.js';
import { isAppendOnlyAnthropicModel } from '../anthropic/haikuConfig.js';
import { isAnthropicUsageEvidenceError } from '../anthropic/haikuCache.js';
import { nonStrictTool, strictGrammarFits, TOOL_CALL_PROVIDER_NAME } from '../anthropic/anthropicToolCapacity.js';
import { bridgedAnthropicSession } from '../anthropic/anthropicToolBridge.js';
import { activeAnthropicToolNames, nonStrictUnacceptedTail } from '../anthropic/anthropicForegroundMenu.js';
import { carriesOffer, offerRefusal, recoverableRefusal, reportOfferRefusal, reportRejection } from '../anthropic/anthropicRejection.js';
import type { ClaudeSend } from './claudeTransport.js';
import {
  declinedCalls, fellBack, plainMessages, READ_RECOVERY_NOTE, SonnetRefusalError, toolResults, toolUses, TOOLS_FAILED_NOTE, withNote,
} from './claudeToolLoopParts.js';

export { declinedCalls, NOT_OFFERED_IN_TURN, READ_RECOVERY_NOTE, SonnetRefusalError } from './claudeToolLoopParts.js';

/**
 * The one tool loop of every Claude request (Syzygy ADR-0009 stage 1, M7): the text and voice turns of any Claude model, the
 * native web search and page read (their `pause_turn` continuations), and the FCA step (one request: its runner executes the
 * calls). Core: response path. What it keeps, at parity with the OpenAI adapter's `withToolRounds` (`chatModelTools.ts`):
 *
 * - Every round and call takes its time from the turn's one deadline; a round that would get too little is not started and
 *   the answer comes without tools (`tool_choice: none`); an answer that cannot be had in time is her fixed line.
 * - The calls of one response run through `runToolStep` (the same session, gate, runner, parallel rule, time per call, refusal
 *   of a name the turn does not offer, the tool menu's `tool_open`), and all their results go back in one user message.
 * - The assistant turn is appended whole (thinking blocks included, unchanged), so the history is append-only; a native 5.5
 *   session adds an opened tool's definition inline (`tool_addition`), and an acknowledged grammar refusal turns the unaccepted
 *   tail into the bridge's quoted data once.
 * - A response cut off at its ceiling runs none of its calls; a round that ran out of time runs none: the model is told (a
 *   deadline note), and answers without tools. A response the server paused (`pause_turn`) is resumed, at most three times.
 * - `refusal` before any word and before any tool ran is `SonnetRefusalError` (the tiered model answers with Haiku instead);
 *   after a tool ran, or once words went out, the turn ends with her fixed line like any other failure then. A caller that
 *   reads the refusal itself (`refusal: 'final'`: the web search, FCA) gets it as the last response.
 * - Under the cache plan a call in a turn that offers no tool is declined once, and a refused first request falls back to the
 *   shape without the plan.
 */
type Body = Anthropic.MessageCreateParamsNonStreaming;
type Message = Anthropic.Message;

export interface ClaudeToolLoopOptions {
  /** The executor of the calls: the turn's tool session. Without one the loop runs no tool. */
  session: ShannonModelToolSession | undefined;
  send: ClaudeSend;
  /** The caller's own cancellation. */
  signal?: AbortSignal;
  /** A response that is already the whole answer (text: a structured turn that parses). */
  isAnswer: (message: Message) => boolean;
  /** Before a step's calls run, with their names (voice: her waiting phrase). */
  onCalls?: (names: readonly string[]) => Promise<void>;
  /**
   * A round that ran out of time before any tool ran: `answer` (default) asks for the answer without tools; `fail` throws, so
   * the tiered model answers with Haiku instead of asking Sonnet again (voice, review H3).
   */
  timedOutRound?: 'answer' | 'fail';
  /**
   * Haiku and native Sonnet 5.5 retain one recovery from an explicit 4xx refusal of the offered schemas; which 4xx count is
   * `SHANNON_ANTHROPIC_STRICT_REJECTIONS` (`anthropicRejection.ts`). Every 4xx is counted and logged.
   */
  plainBody?: Body;
  /** A selected external read is unfinished until its server-owned receipt exists. One bounded recovery, never a replay. */
  missingRequiredRead?: (message: Message) => boolean;
  /**
   * The cache plan sends the fixed tool pair also when the turn offers no tool. A call in such a turn runs nothing: it is
   * answered once with the refusal of a name the turn does not offer, and the model answers (`declinedCalls`).
   */
  declineUnofferedCalls?: boolean;
  /**
   * The cache plan's way back (M4 review F1): the turn's request in the shape without the plan. When the first request of a
   * turn without tools is refused with a 400 about the offered tools or schemas, the turn is asked once more with this body;
   * nothing ran and no word went out. A turn with tools has its tool-less answer (`plainBody`).
   */
  planFallback?: Body;
  /** What the cache plan's turn met, for `GET /v1/ops` (`cacheWarmTurns.ts`); only given under the plan. */
  onPlanEvent?: (event: PlanRoundEvent) => void;
  /** `throw` (default): a refusal before any tool ran is `SonnetRefusalError`; `final`: it is the last response. */
  refusal?: 'throw' | 'final';
  /** The requests a loop without a session may send (FCA: 1, its runner executes the calls); unset: until it ends. */
  maxRounds?: number;
}

export type PlanRoundEvent = 'fallback' | 'plain_recovery' | 'grammar_bridge' | 'declined';

export interface ClaudeToolLoopResult {
  /** The last response; null when she ran out of time (`outOfTime`). */
  final: Message | null;
  /** Every assistant turn of the turn, in order (for her spoken words and the web sources). */
  turns: readonly Message[];
  /** Calls that ran. */
  used: number;
  outOfTime?: { sent?: string };
}

const MAXIMUM_PAUSES = 3;

export async function claudeToolLoop(body: Body, options: ClaudeToolLoopOptions): Promise<ClaudeToolLoopResult> {
  return new ToolLoop(body, options).run();
}

class ToolLoop {
  private readonly messages: Anthropic.MessageParam[];
  private readonly turns: Message[] = [];
  private readonly appendOnly: boolean;
  /** Every native tool name of the request, strict or not (strict ones within `ANTHROPIC_GRAMMAR_BUDGET`). */
  private readonly visible: Set<string>;
  private readonly session: ShannonModelToolSession | undefined;
  private readonly turn: ToolStepState = { used: 0, toolsOff: false };
  private round = 0;
  private pauses = 0;
  private readRecovery = false;
  private bridgeOnly = false;
  private acceptedLength = 0;

  constructor(private readonly body: Body, private readonly options: ClaudeToolLoopOptions) {
    this.messages = [...body.messages];
    this.appendOnly = isAppendOnlyAnthropicModel(body.model);
    // The request already appended the initially selected schemas after its stable opener and history. Opening another tool
    // appends only its new definition, preserving signed tools/system/history and the original execution gate.
    this.visible = new Set(activeAnthropicToolNames(body));
    const bridged = this.appendOnly && options.session?.menu && this.visible.has(TOOL_CALL_PROVIDER_NAME);
    this.session = bridged ? bridgedAnthropicSession(options.session!, this.visible) : options.session;
  }

  run(): Promise<ClaudeToolLoopResult> {
    return this.session ? this.withTools(this.session) : this.withoutTools();
  }

  // --- Without tools: one answer, resumed when the server paused (a web search, a page read) -----------------------------------

  private async withoutTools(): Promise<ClaudeToolLoopResult> {
    let declined = !this.options.declineUnofferedCalls;
    let choice: Partial<Body> = {};
    for (;;) {
      let message: Message;
      try {
        message = await this.send(this.request(choice), null);
      } catch (error) {
        return this.fallBack(error);
      }
      const stop = this.refused(message);
      if (stop) return stop;
      if (this.paused(message)) continue;
      if (declined || message.stop_reason !== 'tool_use' || this.lastRound()) return this.final(message);
      declined = true;
      // A second stray call cannot end the turn: the answer after the decline is asked for without tools.
      choice = { tool_choice: { type: 'none' } };
      this.messages.push(...declinedCalls(message));
      this.options.onPlanEvent?.('declined');
    }
  }

  /** A refused first request of a plan turn without tools is asked again in the shape without the plan; anything else is thrown. */
  private async fallBack(error: unknown): Promise<ClaudeToolLoopResult> {
    if (this.round !== 1 || this.callerStopped() || !fellBack(error, this.options)) throw error;
    return claudeToolLoop(this.options.planFallback!, { ...this.options, planFallback: undefined, declineUnofferedCalls: false });
  }

  private lastRound(): boolean {
    return this.options.maxRounds !== undefined && this.round >= this.options.maxRounds;
  }

  // --- With tools -----------------------------------------------------------------------------------------------------------

  private async withTools(session: ShannonModelToolSession): Promise<ClaudeToolLoopResult> {
    const parallel = parallelToolsEnabled();
    for (;;) {
      const step = this.stepTime(session);
      if (step === null) return this.answer(session);
      const ended = await this.toolRound(session, step, parallel);
      if (ended) return ended;
    }
  }

  /** The time of the next round, or null when no round may start (tools off, the calls used up, too little time). */
  private stepTime(session: ShannonModelToolSession): number | null {
    const deadline = session.deadline;
    const cap = this.turn.used === 0 ? deadline.plan.firstRoundMilliseconds : deadline.plan.laterRoundMilliseconds;
    const step = deadline.forStep(cap);
    if (this.turn.toolsOff || this.turn.used >= session.maximumCalls || step < MINIMUM_ROUND_MILLISECONDS) return null;
    return step;
  }

  /** One round: the result when the turn ends with it, null to go on. */
  private async toolRound(session: ShannonModelToolSession, step: number, parallel: boolean): Promise<ClaudeToolLoopResult | null> {
    let message: Message;
    try {
      message = await this.send(this.request(), this.time(session, step));
    } catch (error) {
      return this.roundFailed(session, error);
    }
    this.acceptedLength = this.messages.length;
    const stop = this.refused(message);
    if (stop) return stop;
    if (this.paused(message)) return null;
    const uses = toolUses(message);
    if (this.recoveredRead(message, uses)) return null;
    if (!uses.length || (this.options.isAnswer(message) && !this.options.missingRequiredRead?.(message))) return this.final(message);
    if (message.stop_reason === 'max_tokens') {
      // Cut off at its ceiling: a call may carry half its input. Nothing runs; the turn answers without tools.
      this.toolsOff(CUT_OFF_CALL_NOTE);
      return null;
    }
    await this.runCalls(session, message, uses, parallel);
    return null;
  }

  private async roundFailed(session: ShannonModelToolSession, error: unknown): Promise<ClaudeToolLoopResult | null> {
    if (this.callerStopped()) throw error;
    if (error instanceof PartialAnswerError) return this.out(error.sent);
    if (isAnthropicUsageEvidenceError(error)) return this.evidenceFailed(error);
    reportRejection(error, carriesOffer(this.request()));
    if (this.recoverGrammar(error)) return null;
    if (this.plainRecovery(error)) return this.answer(session, true);
    if (this.turn.used === 0 && (!timedOut(error) || this.options.timedOutRound === 'fail')) throw error;
    this.toolsOff(TIMED_OUT_ROUND_NOTE);
    return null;
  }

  /** The bounded read recovery: the owner's side of the turn, a user message after her end_turn (quick fix 1). */
  private recoveredRead(message: Message, uses: readonly Anthropic.ToolUseBlock[]): boolean {
    if (uses.length || message.stop_reason !== 'end_turn' || !this.options.missingRequiredRead?.(message) || this.readRecovery) return false;
    this.readRecovery = true;
    this.messages.push({ role: 'assistant', content: message.content });
    this.messages.push({ role: 'user', content: READ_RECOVERY_NOTE });
    return true;
  }

  private async runCalls(session: ShannonModelToolSession, message: Message, uses: readonly Anthropic.ToolUseBlock[], parallel: boolean): Promise<void> {
    this.messages.push({ role: 'assistant', content: message.content });
    await this.options.onCalls?.(uses.map(use => use.name));
    const calls = uses.map(use => ({ callId: use.id, name: use.name, arguments: JSON.stringify(use.input ?? {}) }));
    const signal = this.options.signal ? { signal: this.options.signal } : {};
    const results = toolResults(await runToolStep(calls, session, this.turn, { parallel, ...signal }));
    this.messages.push({ role: 'user', content: results });
    observerHandoff('tools', 'llm', { resultCount: results.length, selectedTools: uses.map(use => observedToolName(use.name)) });
    this.addInlineTools();
  }

  /**
   * The definitions of tools opened in this step, inline (`tool_addition`): strict while the grammar budget allows (never after a
   * grammar refusal), otherwise native non-strict. The stable Messages types do not yet include beta inline blocks: their schema
   * is checked by the SDK's beta type, sent through the same transport.
   */
  private addInlineTools(): void {
    if (!this.appendOnly || !this.session?.menu) return;
    const admitted: Anthropic.Tool[] = [];
    const additions: BetaRequestToolAdditionBlock[] = claudeTools(this.options.session).flatMap(tool => {
      if (this.visible.has(tool.name)) return [];
      const strict = !this.bridgeOnly && strictGrammarFits(this.request(), [...admitted, tool]);
      if (strict) admitted.push(tool);
      this.visible.add(tool.name);
      return [{ type: 'tool_addition', tool: { type: 'tool_definition', definition: strict ? tool : nonStrictTool(tool) } }];
    });
    if (additions.length) this.messages.push({ role: 'system', content: additions as unknown as Anthropic.ContentBlockParam[] });
  }

  // --- The answer without tools -----------------------------------------------------------------------------------------------

  /**
   * After tools/thinking, the original declarations and every result stay intact. Ask once for an answer with no further
   * calls rather than replaying thinking against a different system/tools prefix or a rewritten history.
   */
  private async answer(session: ShannonModelToolSession, plain = false): Promise<ClaudeToolLoopResult> {
    const left = session.deadline.forAnswer();
    if (left < MINIMUM_ANSWER_MILLISECONDS) return this.out();
    const retained = plain && this.appendOnly && this.turns.length > 0;
    if (retained) this.note(TOOLS_GONE_NOTE);
    try {
      const request = plain && !retained ? this.plainRequest() : this.request({ tool_choice: { type: 'none' } });
      const message = await this.send(request, this.time(session, left));
      return this.refused(message) ?? this.final(message);
    } catch (error) {
      return this.answerFailed(session, error, plain);
    }
  }

  private plainRequest(): Body {
    const { tools: _tools, tool_choice: _choice, ...plainBody } = this.options.plainBody ?? this.body;
    // Never silently without tools: she is told they failed for this reply, so she does not invent a reason.
    if (this.turn.used === 0) return { ...plainBody, messages: withNote(plainBody.messages, TOOLS_FAILED_NOTE) };
    return { ...plainBody, messages: [...plainMessages(this.messages), { role: 'system' as const, content: TOOLS_GONE_NOTE }] };
  }

  private async answerFailed(session: ShannonModelToolSession, error: unknown, plain: boolean): Promise<ClaudeToolLoopResult> {
    if (this.callerStopped()) throw error;
    if (error instanceof PartialAnswerError) return this.out(error.sent);
    if (isAnthropicUsageEvidenceError(error)) return this.evidenceFailed(error);
    reportRejection(error, !plain && carriesOffer(this.request()));
    if (!plain && this.recoverGrammar(error)) return this.answer(session);
    if (!plain && this.plainRecovery(error)) return this.answer(session, true);
    if (this.turn.used === 0 && (!timedOut(error) || error instanceof SonnetRefusalError)) throw error;
    return this.out();
  }

  // --- Recoveries -------------------------------------------------------------------------------------------------------------

  /** The one tool-less answer after a refusal of the offered schemas (quick fix 2, canary form). */
  private plainRecovery(error: unknown): boolean {
    if (!this.options.plainBody || !recoverableRefusal(error)) return false;
    reportOfferRefusal(error, this.request(), offerRefusal(error) ?? 'offered_request_rejected');
    this.options.onPlanEvent?.('plain_recovery');
    return true;
  }

  /** An acknowledged grammar refusal: the unaccepted tail's definitions lose strict decoding (they stay native tools), once. */
  private recoverGrammar(error: unknown): boolean {
    if (!this.appendOnly || !this.session?.menu || !this.visible.has(TOOL_CALL_PROVIDER_NAME) || this.bridgeOnly) return false;
    if (offerRefusal(error) !== 'strict_grammar_capacity') return false;
    const before = this.request();
    const tail = nonStrictUnacceptedTail(this.messages, this.acceptedLength);
    if (JSON.stringify(tail) === JSON.stringify(this.messages)) return false;
    reportOfferRefusal(error, before, 'strict_grammar_capacity');
    this.options.onPlanEvent?.('grammar_bridge');
    this.messages.splice(0, this.messages.length, ...tail);
    this.visible.clear();
    for (const name of activeAnthropicToolNames(this.request())) this.visible.add(name);
    this.bridgeOnly = true;
    return true;
  }

  private evidenceFailed(error: unknown): ClaudeToolLoopResult {
    if (this.turn.used === 0) throw error;
    return this.out();
  }

  // --- Requests and results ---------------------------------------------------------------------------------------------------

  private request(extra: Partial<Body> = {}): Body {
    const tools = !this.appendOnly && this.session ? { tools: claudeTools(this.session) } : {};
    return { ...this.body, ...tools, messages: [...this.messages], ...extra };
  }

  private async send(body: Body, time: RoundTime | null): Promise<Message> {
    const message = await this.options.send(body, time, this.round++);
    this.turns.push(message);
    return message;
  }

  private time(session: ShannonModelToolSession, milliseconds: number): RoundTime {
    return { milliseconds, answer: () => session.deadline.forAnswer() };
  }

  /** Native 5.5 sessions append every note; legacy lanes may join the system message the turn already ends with. */
  private note(text: string): void {
    const last = this.messages.at(-1) as { role: string; content: unknown } | undefined;
    if (this.appendOnly || last?.role !== 'system' || typeof last.content !== 'string') {
      this.messages.push({ role: 'system', content: text } as unknown as Anthropic.MessageParam);
      return;
    }
    this.messages[this.messages.length - 1] = { role: 'system', content: `${last.content}\n\n${text}` } as unknown as Anthropic.MessageParam;
  }

  private toolsOff(note: string): void {
    this.note(note);
    this.turn.toolsOff = true;
  }

  private paused(message: Message): boolean {
    if (message.stop_reason !== 'pause_turn' || this.lastRound() || this.pauses++ >= MAXIMUM_PAUSES) return false;
    this.messages.push({ role: 'assistant', content: message.content });
    return true;
  }

  private refused(message: Message): ClaudeToolLoopResult | null {
    if (message.stop_reason !== 'refusal') return null;
    if (this.options.refusal === 'final') return this.final(message);
    if (this.turn.used === 0) throw new SonnetRefusalError(message.stop_details?.category ?? null);
    return this.out();
  }

  private callerStopped(): boolean {
    return this.options.signal?.aborted === true;
  }

  private final(message: Message): ClaudeToolLoopResult {
    return { final: message, turns: this.turns, used: this.turn.used };
  }

  private out(sent?: string): ClaudeToolLoopResult {
    return { final: null, turns: this.turns, used: this.turn.used, outOfTime: sent ? { sent } : {} };
  }
}
