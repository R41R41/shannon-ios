import { observerHandoff } from '../../observer/observerContext.js';
import { observedToolName } from './observerProjection.js';
import Anthropic from '@anthropic-ai/sdk';
import {
  MINIMUM_ANSWER_MILLISECONDS, MINIMUM_ROUND_MILLISECONDS, PartialAnswerError, timedOut, type RoundTime,
} from '../../../mind/action/respond/turnDeadline.js';
import { CUT_OFF_CALL_NOTE, TIMED_OUT_ROUND_NOTE, TOOLS_GONE_NOTE, type ShannonModelToolSession } from '../chatModelTools.js';
import { parallelToolsEnabled, runToolStep, type ToolStepState } from '../chatModelToolStep.js';
import { sonnetTools } from './anthropicRequest.js';
import { DEFAULT_HAIKU_MODEL } from './haikuConfig.js';
import type { BetaRequestToolAdditionBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';

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
  /** The base Haiku lane retains the turn's single, pre-answer increase in reasoning effort. */
  escalate?: { allowed: () => boolean; onEscalated: () => void };
  /** Base Haiku only: retain recovery from an explicit 4xx refusal of offered schemas, once without tools. */
  plainBody?: Anthropic.MessageCreateParamsNonStreaming;
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

export async function sonnetToolRounds(body: Anthropic.MessageCreateParamsNonStreaming, options: SonnetRoundOptions): Promise<SonnetRoundResult> {
  const messages: Anthropic.MessageParam[] = [...body.messages];
  const turns: Anthropic.Message[] = [];
  const session = options.session;
  const haiku = body.model === DEFAULT_HAIKU_MODEL;
  // Every offered schema is strict, including deferred ones, and the API accepts at most 20 strict tools per request.
  // Keep only the initially visible menu in the fixed prefix. Opening another tool appends its full strict definition
  // after the result; it never changes signed tools/system/history or the session's visibility and execution gate.
  const initial = sonnetTools(session);
  const visible = new Set(initial.map(tool => tool.name));
  if (haiku && session?.menu) body = { ...body, tools: initial };
  const turn: ToolStepState = { used: 0, toolsOff: false };
  let round = 0;
  let pauses = 0;
  let escalated = false;
  const escalate = () => {
    if (escalated || !options.escalate?.allowed()) return;
    escalated = true;
    body = { ...body, output_config: { ...body.output_config, effort: 'medium' } };
    options.escalate.onEscalated();
  };
  const callerStopped = () => options.signal?.aborted === true;
  const request = (extra: Partial<Anthropic.MessageCreateParamsNonStreaming> = {}): Anthropic.MessageCreateParamsNonStreaming => ({
    ...body, ...(!haiku && session ? { tools: sonnetTools(session) } : {}), messages: [...messages], ...extra,
  });
  // Haiku appends every note; legacy lanes may join the system message the turn already ends with.
  const note = (text: string) => {
    const last = messages.at(-1);
    if (!haiku && last?.role === 'system' && typeof last.content === 'string') messages[messages.length - 1] = { role: 'system', content: `${last.content}\n\n${text}` };
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
    const retained = plain && haiku && turns.length > 0;
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
      if (!plain && options.plainBody && refusedOffer(error)) { reportRefusedOffer(error); return answer(true); }
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
    } catch (error) {
      if (callerStopped()) throw error;
      if (error instanceof PartialAnswerError) return out(error.sent);
      if (options.plainBody && refusedOffer(error)) { reportRefusedOffer(error); return answer(true); }
      if (!timedOut(error) && turn.used === 0) throw error;
      if (options.timedOutRound === 'fail' && turn.used === 0) throw error;
      note(TIMED_OUT_ROUND_NOTE);
      turn.toolsOff = true;
      escalate();
      continue;
    }
    turns.push(message);
    const stop = refused(message);
    if (stop) return stop;
    if (message.stop_reason === 'pause_turn' && pauses++ < MAXIMUM_PAUSES) { messages.push({ role: 'assistant', content: message.content }); continue; }
    const uses = message.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
    if (!uses.length || options.isAnswer(message)) return { final: message, turns, used: turn.used };
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
    if (haiku && session.menu) {
      const additions: BetaRequestToolAdditionBlock[] = sonnetTools(session).flatMap(tool => {
        if (visible.has(tool.name)) return [];
        visible.add(tool.name);
        return [{ type: 'tool_addition', tool: { type: 'tool_definition', definition: tool } }];
      });
      // The stable Messages types do not yet include beta inline blocks. Keep their schema checked by the SDK's beta
      // type, then use the same native transport with its inline-tools header (no separate client/retry/session).
      if (additions.length) messages.push({ role: 'system', content: additions as unknown as Anthropic.ContentBlockParam[] });
    }
    if (ran.some(item => failed((item as { output?: string }).output))) escalate();
  }
}

function failed(output: string | undefined): boolean {
  try { const value = JSON.parse(output ?? '{}') as { ok?: unknown; failure?: unknown }; return value.ok === false && value.failure !== 'not_offered'; } catch { return false; }
}

function refusedOffer(error: unknown): boolean {
  return error instanceof Anthropic.APIError && error.status !== undefined && error.status >= 400 && error.status < 500
    && ![401, 403, 408, 409, 429].includes(error.status);
}

/** Provider diagnostics contain no message, body, model input, identifiers or provider-supplied category. */
function reportRefusedOffer(error: unknown): void {
  if (!(error instanceof Anthropic.APIError)) return;
  console.warn(JSON.stringify({ event: 'anthropic_tool_offer_refused', status: error.status, category: 'offered_request_rejected' }));
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
