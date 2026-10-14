import { checkReply, rewriteNote, type ReplyCheckContext, type ReplyCheckFlag } from '@shannon/cognition';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult, ShannonVoiceModelRequest } from './chatModel.js';
import type { AnthropicChatModel } from './anthropic/anthropicChatModel.js';
import { TieredChatModel } from './tieredChatModel.js';
import { turnToolResults } from '../../mind/tools/toolsPorts.js';

/**
 * Her feeling turns at the reply model (Syzygy ADR-0013). Core: response path. Built only while a feeling switch asks for it
 * (`wiring/feelingWiring.ts`); every request without the marks goes to the model of before exactly as it came.
 *
 * - Strong turns on Sonnet (`SHANNON_FEELING_STRONG_REPLY_MODEL`; owner decision 2026-10-14: 「気持ちが強い時だけSonnet」): a text
 *   request marked `feelingStrong` is answered by Sonnet through the tiered model's rules (its failure before any word or tool falls back
 *   to the model of before, as plain). The owner's model mode and the difficulty routing stay inside that model, untouched.
 * - The check before sending (`SHANNON_REPLY_CHECK`, stage 2 items 5 and 8): a text request marked `feelingCheck` (a strong turn, a
 *   feeling order, or one in front of others) is written in full, checked (`checkReply`), and when something is off written once more
 *   with a note of what was off after everything else; the second draft is the answer, checked or not. A draft whose turn already ran a
 *   tool is never rewritten (a write must not run twice): its flags go to the next feeling turn instead. The rewrite is offered no
 *   tools and is waited for at most `REWRITE_DEADLINE_MILLISECONDS` (review M5): late, the first draft goes out as it was. Streamed,
 *   the answer goes out in one piece after the check.
 */
export const REWRITE_DEADLINE_MILLISECONDS = 2_500;

export interface FeelingReplyOptions {
  sonnet?: AnthropicChatModel | null;
  /** Told of each checked draft: its flags and whether it was rewritten (the next feeling turn and the Observer read them). */
  checked?: (scopeKey: string, flags: readonly ReplyCheckFlag[], rewritten: boolean, turn?: string) => void;
  /** Tests: the rewrite's deadline. */
  rewriteDeadlineMilliseconds?: number;
  /** Whether the turn ran a tool (the turn's tool results; tests hand their own). */
  ranTool?: (request: ShannonChatModelRequest) => boolean;
  /** A strong turn that failed (review P3a): it no longer counts against the day's cap. */
  released?: (scopeKey: string) => void;
  log?: (line: string) => void;
}

type Marked = ShannonChatModelRequest;

export class FeelingReplyChatModel implements ShannonChatModel {
  readonly mode: ShannonChatModel['mode'];
  readonly model: string;
  private readonly strong: TieredChatModel | null;

  constructor(private readonly inner: ShannonChatModel, private readonly options: FeelingReplyOptions = {}) {
    this.mode = inner.mode;
    this.model = inner.model;
    this.strong = options.sonnet ? new TieredChatModel(inner, options.sonnet, options.log) : null;
  }

  /**
   * The model of one turn (review P2-1): the model of before pins the owner's model mode at the turn's admission (`PrimaryModeChatModel`);
   * the turn's own wrapper keeps that pin.
   */
  forTurn(scopeKey: string): ShannonChatModel {
    return new FeelingReplyChatModel(this.inner.forTurn?.(scopeKey) ?? this.inner, this.options);
  }

  async generate(request: Marked): Promise<ShannonChatModelResult> {
    const first = await this.answer(request);
    if (!request.feelingCheck) return first;
    return this.checked(request, request.feelingCheck, first);
  }

  async generateStreaming(request: Marked, onReplyText: (text: string) => void | Promise<void>): Promise<ShannonChatModelResult> {
    if (request.feelingCheck) {
      // Checked before sending: written in full, then out in one piece.
      const result = await this.generate(request);
      await onReplyText(result.reply);
      return result;
    }
    if (request.feelingStrong && this.strong) return this.released(request, this.strong.generateStreaming(asSonnet(request), onReplyText));
    return this.inner.generateStreaming ? this.inner.generateStreaming(plain(request), onReplyText) : this.inner.generate(plain(request));
  }

  generateVoice(request: ShannonVoiceModelRequest): Promise<ShannonChatModelResult> {
    return this.inner.generateVoice ? this.inner.generateVoice(request) : this.inner.generate({ ...request, generateThreadTitle: false });
  }

  generateVoiceStreaming(request: ShannonVoiceModelRequest, onTextDelta: (delta: string) => void | Promise<void>, signal?: AbortSignal)
    : Promise<ShannonChatModelResult> {
    if (this.inner.generateVoiceStreaming) return this.inner.generateVoiceStreaming(request, onTextDelta, signal);
    return this.generateVoice(request);
  }

  private answer(request: Marked): Promise<ShannonChatModelResult> {
    return request.feelingStrong && this.strong ? this.released(request, this.strong.generate(asSonnet(request))) : this.inner.generate(plain(request));
  }

  /** A strong turn that fails no longer counts against the day's cap; the error goes on as it was. */
  private async released(request: Marked, answer: Promise<ShannonChatModelResult>): Promise<ShannonChatModelResult> {
    try { return await answer; } catch (error) {
      this.options.released?.(request.scopeKey);
      throw error;
    }
  }

  private async checked(request: Marked, context: ReplyCheckContext, first: ShannonChatModelResult): Promise<ShannonChatModelResult> {
    const flags = first.outOfTime ? [] : checkReply(first.reply, context);
    const ranTool = this.options.ranTool ? this.options.ranTool(request) : safeCount(() => turnToolResults(request.tools).length) > 0;
    if (!flags.length || ranTool) {
      this.options.checked?.(request.scopeKey, flags, false, context.turn);
      return first;
    }
    const { tools: _tools, ...words } = request;
    const note = { ...words, turnContext: [request.turnContext ?? '', rewriteNote(flags)].filter(Boolean).join('\n\n') };
    // Review L-b: the rewrite is the same model's, but outside the strong turn's release, so a failed rewrite never frees the cap twice.
    const rewrite = request.feelingStrong && this.strong ? this.strong.generate(asSonnet(note)) : this.inner.generate(plain(note));
    const second = await within(rewrite, this.options.rewriteDeadlineMilliseconds ?? REWRITE_DEADLINE_MILLISECONDS);
    if (!second || second.outOfTime) {
      this.options.log?.('Shannon reply check: the rewrite was late or failed; the first draft goes out');
      this.options.checked?.(request.scopeKey, flags, false, context.turn);
      return first;
    }
    this.options.checked?.(request.scopeKey, flags, true, context.turn);
    return second;
  }
}

function plain(request: Marked): ShannonChatModelRequest {
  if (!request.feelingStrong && !request.feelingCheck) return request;
  const { feelingStrong: _strong, feelingCheck: _check, ...rest } = request;
  return rest;
}

/** The tiered model answers `tier: sonnet` with Sonnet; its fallback strips the tier, so the model of before decides as it would. */
const asSonnet = (request: Marked): ShannonChatModelRequest => ({ ...plain(request), tier: 'sonnet' });

/** The answer if it comes within the deadline; null when it is late or fails (a late one is dropped). */
async function within<T>(answer: Promise<T>, milliseconds: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), milliseconds); });
  try {
    return await Promise.race([answer.catch(() => null), late]);
  } finally { clearTimeout(timer); }
}

/** A count that cannot be read counts as one: closed, no rewrite. */
function safeCount(read: () => number): number {
  try { return read(); } catch { return 1; }
}

/** Its first name (strong turns only), as stage 1's tests and callers know it. */
export { FeelingReplyChatModel as FeelingStrongChatModel };
