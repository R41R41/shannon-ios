import type Anthropic from '@anthropic-ai/sdk';
import {
  MINIMUM_ANSWER_MILLISECONDS, MINIMUM_ROUND_MILLISECONDS, PartialAnswerError, timedOut, type RoundTime,
} from '../../../mind/action/respond/turnDeadline.js';
import { CUT_OFF_CALL_NOTE, TIMED_OUT_ROUND_NOTE, type ShannonModelToolSession } from '../chatModelTools.js';
import { parallelToolsEnabled, runToolStep, type ToolStepState } from '../chatModelToolStep.js';
import { sonnetTools } from './anthropicRequest.js';

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
  const turn: ToolStepState = { used: 0, toolsOff: false };
  let round = 0;
  let pauses = 0;
  const callerStopped = () => options.signal?.aborted === true;
  const request = (extra: Partial<Anthropic.MessageCreateParamsNonStreaming> = {}): Anthropic.MessageCreateParamsNonStreaming => ({
    ...body, ...(session ? { tools: sonnetTools(session) } : {}), messages: [...messages], ...extra,
  });
  // A note to the model joins the system message the turn already ends with, or follows the last user turn.
  const note = (text: string) => {
    const last = messages.at(-1);
    if (last?.role === 'system' && typeof last.content === 'string') messages[messages.length - 1] = { role: 'system', content: `${last.content}\n\n${text}` };
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
  const answer = async (): Promise<SonnetRoundResult> => {
    const left = deadline.forAnswer();
    if (left < MINIMUM_ANSWER_MILLISECONDS) return out();
    try {
      const message = await options.send(request({ tool_choice: { type: 'none' } }), time(left), round++);
      turns.push(message);
      return refused(message) ?? { final: message, turns, used: turn.used };
    } catch (error) {
      if (callerStopped()) throw error;
      if (error instanceof PartialAnswerError) return out(error.sent);
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
      if (!timedOut(error) && turn.used === 0) throw error;
      note(TIMED_OUT_ROUND_NOTE);
      turn.toolsOff = true;
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
  }
}

function failed(output: string | undefined): boolean {
  try { return (JSON.parse(output ?? '{}') as { ok?: unknown }).ok === false; } catch { return false; }
}
