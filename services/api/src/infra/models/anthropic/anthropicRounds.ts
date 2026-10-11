import { observerHandoff } from '../../observer/observerContext.js';
import { observedToolName } from './observerProjection.js';
import Anthropic from '@anthropic-ai/sdk';
import {
  MINIMUM_ANSWER_MILLISECONDS, MINIMUM_ROUND_MILLISECONDS, PartialAnswerError, timedOut, type RoundTime,
} from '../../../mind/action/respond/turnDeadline.js';
import { CUT_OFF_CALL_NOTE, TIMED_OUT_ROUND_NOTE, TOOLS_GONE_NOTE, type ShannonModelToolSession } from '../chatModelTools.js';
import { parallelToolsEnabled, runToolStep, type ToolStepState } from '../chatModelToolStep.js';
import { sonnetTools } from './anthropicRequest.js';
import { isAppendOnlyAnthropicModel } from './haikuConfig.js';
import { isAnthropicUsageEvidenceError } from './haikuCache.js';
import type { BetaRequestToolAdditionBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { requestStrictTools, strictRequestFits, TOOL_CALL_PROVIDER_NAME } from './anthropicToolCapacity.js';
import { bridgedAnthropicSession } from './anthropicToolBridge.js';
import { bridgeOnlyUnacceptedTail } from './anthropicForegroundMenu.js';
import { offerRefusal, reportOfferRefusal, reportRejection } from './anthropicRejection.js';

/**
 * The tool rounds of a Sonnet turn (Syzygy ADR-0008 stage 2, step 5), at parity with luna's `withToolRounds`
 * (`chatModelTools.ts`). Core: response path.
 *
 * - Every round and call takes its time from the turn's one deadline; a round that would get too little is not started and
 *   the answer comes without tools (`tool_choice: none`); an answer that cannot be had in time is her fixed line.
 * - The calls of one response run through `runToolStep` (the same session, gate, runner, parallel rule, time per call, refusal
 *   of a name the turn does not offer, the tool menu's `tool_open`), and all their results go back in one user message.
 * - The assistant turn is appended whole (thinking blocks included, unchanged), so the history is append-only.
 * - A response cut off at its ceiling runs none of its calls; a round that ran out of time runs none: the model is told, and
 *   answers without tools. A web search the server paused (`pause_turn`) is resumed, at most three times.
 * - `refusal` before any word and before any tool ran is `SonnetRefusalError` (the tiered model answers with luna instead); after
 *   a tool ran, or once words went out, the turn ends with her fixed line like any other failure then.
 */
export class SonnetRefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`SONNET_REFUSAL${category ? `:${category}` : ''}`);
    this.name = 'SonnetRefusalError';
  }
}

export type SonnetSend = (body: Anthropic.MessageCreateParamsNonStreaming, time: RoundTime | null, round: number) => Promise<Anthropic.Message>;

export interface SonnetRoundOptions {
  session: ShannonModelToolSession | undefined;
  send: SonnetSend;
  /** The caller's own cancellation. */
  signal?: AbortSignal;
  /** A response that is already the whole answer (text: a structured turn that parses). */
  isAnswer: (message: Anthropic.Message) => boolean;
  /** Before a step's calls run, with their names (voice: her waiting phrase). */
  onCalls?: (names: readonly string[]) => Promise<void>;
  /**
   * A round that ran out of time before any tool ran: `answer` (default) asks for the answer without tools; `fail` throws, so
   * the tiered model answers with luna instead of asking Sonnet again (voice, review H3).
   */
  timedOutRound?: 'answer' | 'fail';
  /**
   * Haiku and native Sonnet 5.5 retain one recovery from an explicit 400 refusal of the offered tools or schemas
   * (`anthropicRejection.ts`); any other 4xx is counted and handled as any other error.
   */
  plainBody?: Anthropic.MessageCreateParamsNonStreaming;
  /** A selected external read is unfinished until its server-owned receipt exists. One bounded recovery, never a replay. */
  missingRequiredRead?: (message: Anthropic.Message) => boolean;
}

export interface SonnetRoundResult {
  /** The last response; null when she ran out of time (`outOfTime`). */
  final: Anthropic.Message | null;
  /** Every assistant turn of the turn, in order (for her spoken words and the web sources). */
  turns: readonly Anthropic.Message[];
  /** Calls that ran. */
  used: number;
  outOfTime?: { sent?: string };
}

const MAXIMUM_PAUSES = 3;

/**
 * The bounded read recovery is the owner's side of the turn: a user message after her end_turn (a mid-conversation system
 * message may not follow an assistant end_turn; ADR-0009 stage 1, quick fix 1).
 */
export const READ_RECOVERY_NOTE = '依頼されたWeb検索はまだ実行されていない。調べる約束だけでは完了しない。'
  + '必要な地域や対象が分かっているならweb_searchを使ってから答える。不明なら必要なことだけを短く聞く。';

export async function sonnetToolRounds(body: Anthropic.MessageCreateParamsNonStreaming, options: SonnetRoundOptions): Promise<SonnetRoundResult> {
  const messages: Anthropic.MessageParam[] = [...body.messages];
  const turns: Anthropic.Message[] = [];
  const appendOnly = isAppendOnlyAnthropicModel(body.model);
  // Every offered schema is strict, including deferred ones, and the API accepts at most 20 strict tools per request.
  // The request already appended the initially selected schemas after its stable opener and history. Opening another
  // tool appends only its new definition, preserving signed tools/system/history and the original execution gate.
  const visible = new Set(requestStrictTools(body).map(tool => tool.name));
  const session = appendOnly && options.session?.menu && visible.has(TOOL_CALL_PROVIDER_NAME)
    ? bridgedAnthropicSession(options.session, visible) : options.session;
  const turn: ToolStepState = { used: 0, toolsOff: false };
  let round = 0;
  let pauses = 0;
  let readRecovery = false;
  let bridgeOnly = false;
  let acceptedLength = 0;
  let acceptedVisible = new Set((body.tools ?? []).flatMap(tool => 'name' in tool ? [tool.name] : []));
  const callerStopped = () => options.signal?.aborted === true;
  // Only a known 400 about the offered tools or schemas earns the one tool-less answer (ADR-0009 stage 1, quick fix 2).
  const plainRecovery = (error: unknown): boolean => {
    const category = options.plainBody ? offerRefusal(error) : null;
    if (!category) return false;
    reportOfferRefusal(error, request(), category);
    return true;
  };
  const request = (extra: Partial<Anthropic.MessageCreateParamsNonStreaming> = {}): Anthropic.MessageCreateParamsNonStreaming => ({
    ...body, ...(!appendOnly && session ? { tools: sonnetTools(session) } : {}), messages: [...messages], ...extra,
  });
  const recoverGrammar = (error: unknown): boolean => {
    if (!appendOnly || !session?.menu || !visible.has(TOOL_CALL_PROVIDER_NAME) || bridgeOnly) return false;
    if (offerRefusal(error) !== 'strict_grammar_capacity') return false;
    const before = request();
    const tail = bridgeOnlyUnacceptedTail(messages, acceptedLength);
    if (JSON.stringify(tail) === JSON.stringify(messages)) return false;
    reportOfferRefusal(error, before, 'strict_grammar_capacity');
    messages.splice(0, messages.length, ...tail);
    visible.clear(); for (const name of acceptedVisible) visible.add(name);
    bridgeOnly = true;
    return true;
  };
  // Native 5.5 sessions append every note; legacy lanes may join the system message the turn already ends with.
  const note = (text: string) => {
    const last = messages.at(-1);
    if (!appendOnly && last?.role === 'system' && typeof last.content === 'string') messages[messages.length - 1] = { role: 'system', content: `${last.content}\n\n${text}` };
    else messages.push({ role: 'system', content: text });
  };
  const refused = (message: Anthropic.Message): SonnetRoundResult | null => {
    if (message.stop_reason !== 'refusal') return null;
    if (turn.used === 0) throw new SonnetRefusalError(message.stop_details?.category ?? null);
    return { final: null, turns, used: turn.used, outOfTime: {} };
  };
  const out = (sent?: string): SonnetRoundResult => ({ final: null, turns, used: turn.used, outOfTime: sent ? { sent } : {} });

  // Without tools: one answer, resumed when the server paused a web search.
  if (!session) {
    for (;;) {
      const message = await options.send(request(), null, round++);
      turns.push(message);
      const stop = refused(message);
      if (stop) return stop;
      if (message.stop_reason === 'pause_turn' && pauses++ < MAXIMUM_PAUSES) { messages.push({ role: 'assistant', content: message.content }); continue; }
      return { final: message, turns, used: 0 };
    }
  }

  const deadline = session.deadline;
  const time = (milliseconds: number): RoundTime => ({ milliseconds, answer: () => deadline.forAnswer() });
  const answer = async (plain = false): Promise<SonnetRoundResult> => {
    const left = deadline.forAnswer();
    if (left < MINIMUM_ANSWER_MILLISECONDS) return out();
    // After tools/thinking, the original declarations and every result stay intact. Ask once for an answer with no
    // further calls rather than replaying thinking against a different system/tools prefix or a rewritten history.
    const retained = plain && appendOnly && turns.length > 0;
    if (retained) note(TOOLS_GONE_NOTE);
    try {
      const { tools: _tools, tool_choice: _choice, ...plainBody } = options.plainBody ?? body;
      const plainRequest = turn.used === 0 ? plainBody : { ...plainBody, messages: [
        ...plainMessages(messages), { role: 'system' as const, content: TOOLS_GONE_NOTE },
      ] };
      const message = await options.send(plain && !retained ? plainRequest : request({ tool_choice: { type: 'none' } }), time(left), round++);
      turns.push(message);
      return refused(message) ?? { final: message, turns, used: turn.used };
    } catch (error) {
      if (callerStopped()) throw error;
      if (error instanceof PartialAnswerError) return out(error.sent);
      if (isAnthropicUsageEvidenceError(error)) { if (turn.used === 0) throw error; return out(); }
      if (!plain && recoverGrammar(error)) return answer();
      if (!plain && plainRecovery(error)) return answer(true);
      reportRejection(error);
      if (turn.used === 0 && !timedOut(error) && !(error instanceof SonnetRefusalError)) throw error;
      if (error instanceof SonnetRefusalError && turn.used === 0) throw error;
      return out();
    }
  };
  const parallel = parallelToolsEnabled();
  for (;;) {
    const cap = turn.used === 0 ? deadline.plan.firstRoundMilliseconds : deadline.plan.laterRoundMilliseconds;
    const step = deadline.forStep(cap);
    if (turn.toolsOff || turn.used >= session.maximumCalls || step < MINIMUM_ROUND_MILLISECONDS) return answer();
    let message: Anthropic.Message;
    try {
      message = await options.send(request(), time(step), round++);
      acceptedLength = messages.length;
      acceptedVisible = new Set(visible);
    } catch (error) {
      if (callerStopped()) throw error;
      if (error instanceof PartialAnswerError) return out(error.sent);
      if (isAnthropicUsageEvidenceError(error)) { if (turn.used === 0) throw error; return out(); }
      if (recoverGrammar(error)) continue;
      if (plainRecovery(error)) return answer(true);
      reportRejection(error);
      if (!timedOut(error) && turn.used === 0) throw error;
      if (options.timedOutRound === 'fail' && turn.used === 0) throw error;
      note(TIMED_OUT_ROUND_NOTE);
      turn.toolsOff = true;
      continue;
    }
    turns.push(message);
    const stop = refused(message);
    if (stop) return stop;
    if (message.stop_reason === 'pause_turn' && pauses++ < MAXIMUM_PAUSES) { messages.push({ role: 'assistant', content: message.content }); continue; }
    const uses = message.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
    if (!uses.length && message.stop_reason === 'end_turn' && options.missingRequiredRead?.(message) && !readRecovery) {
      readRecovery = true;
      messages.push({ role: 'assistant', content: message.content });
      messages.push({ role: 'user', content: READ_RECOVERY_NOTE });
      continue;
    }
    if (!uses.length || (options.isAnswer(message) && !options.missingRequiredRead?.(message))) return { final: message, turns, used: turn.used };
    if (message.stop_reason === 'max_tokens') {
      // Cut off at its ceiling: a call may carry half its input. Nothing runs; the turn answers without tools.
      note(CUT_OFF_CALL_NOTE);
      turn.toolsOff = true;
      continue;
    }
    messages.push({ role: 'assistant', content: message.content });
    await options.onCalls?.(uses.map(use => use.name));
    const ran = await runToolStep(uses.map(use => ({ callId: use.id, name: use.name, arguments: JSON.stringify(use.input ?? {}) })), session, turn,
      { parallel, ...(options.signal ? { signal: options.signal } : {}) });
    const results: Anthropic.ToolResultBlockParam[] = ran.flatMap(item => {
      const value = item as { type?: string; call_id?: string; output?: string };
      if (value.type !== 'function_call_output' || !value.call_id) return [];
      return [{ type: 'tool_result' as const, tool_use_id: value.call_id, content: value.output ?? '', ...(failed(value.output) ? { is_error: true } : {}) }];
    });
    messages.push({ role: 'user', content: results });
    observerHandoff('tools', 'llm', { resultCount: results.length, selectedTools: uses.map(use => observedToolName(use.name)) });
    if (appendOnly && session.menu && !bridgeOnly) {
      const admitted: Anthropic.Tool[] = [];
      const additions: BetaRequestToolAdditionBlock[] = sonnetTools(options.session).flatMap(tool => {
        if (visible.has(tool.name)) return [];
        if (!strictRequestFits(request(), [...admitted, tool])) return [];
        admitted.push(tool);
        visible.add(tool.name);
        return [{ type: 'tool_addition', tool: { type: 'tool_definition', definition: tool } }];
      });
      // The stable Messages types do not yet include beta inline blocks. Keep their schema checked by the SDK's beta
      // type, then use the same native transport with its inline-tools header (no separate client/retry/session).
      if (additions.length) messages.push({ role: 'system', content: additions as unknown as Anthropic.ContentBlockParam[] });
    }
  }
}

function failed(output: string | undefined): boolean {
  try { const value = JSON.parse(output ?? '{}') as { ok?: unknown; failure?: unknown }; return value.ok === false && value.failure !== 'not_offered'; } catch { return false; }
}

/** Keep original results as quoted data while removing tool references that a plain request cannot declare. */
function plainMessages(messages: readonly Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return messages.flatMap(message => {
    if (!Array.isArray(message.content)) return [message];
    const content = message.content.flatMap<Anthropic.ContentBlockParam>(block => block.type === 'tool_use' ? [] : block.type === 'tool_result'
      ? [{ type: 'text' as const, text: `[道具の結果] ${typeof block.content === 'string' ? block.content.slice(0, 8_000) : JSON.stringify(block.content ?? []).slice(0, 8_000)}` }]
      : [block]);
    return content.length ? [{ ...message, content }] : [];
  });
}
