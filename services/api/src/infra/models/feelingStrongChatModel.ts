import { GUARD_FLAGS, checkReply, rewriteFlags, rewriteNote, type ReplyCheckContext, type ReplyCheckFlag } from '@shannon/cognition';
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
 *   tools and is waited for at most `REWRITE_DEADLINE_MILLISECONDS` (review M5; a strong turn's, Sonnet's, `STRONG_REWRITE_DEADLINE_MILLISECONDS`):
 *   late, the first draft goes out as it was. Streamed,
 *   the answer goes out in one piece after the check.
 */
export const REWRITE_DEADLINE_MILLISECONDS = 2_500;
/** A strong turn's rewrite (Sonnet) is waited for this long. */
export const STRONG_REWRITE_DEADLINE_MILLISECONDS = 8_000;
/**
 * A rewrite is never waited for past the turn's own deadline less this (owner 2026-10-20: a turn ran out of time; the first draft
 * then goes out, checked as above, rather than the turn's fixed out-of-time line).
 */
export const REWRITE_TURN_MARGIN_MILLISECONDS = 1_500;

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
  /**
   * `SHANNON_NATURAL_TALK`, the owner alone (owner 2026-10-20: what a rewrite took out could not be told afterwards): the draft that was
   * rewritten, with its flags and the rewrite, kept for a few days (`replyDraftStore.ts`).
   */
  drafted?: (scopeKey: string, draft: { turn: string; flags: readonly ReplyCheckFlag[]; first: string; second: string | null }) => void;
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
    // `SHANNON_NATURAL_TALK`: some flags are noted and not rewritten for (`rewriteFlags`).
    const rewriting = rewriteFlags(flags, context);
    if (!rewriting.length || ranTool) {
      this.options.checked?.(request.scopeKey, flags, false, context.turn);
      return ranTool && unsendable(flags) ? this.swallowed(first, flags) : first;
    }
    const { tools: _tools, ...words } = request;
    const note = { ...words, turnContext: [request.turnContext ?? '', rewriteNote(rewriting, context.natural === true)].filter(Boolean).join('\n\n') };
    // Review L-b: the rewrite is the same model's, but outside the strong turn's release, so a failed rewrite never frees the cap twice.
    const rewrite = request.feelingStrong && this.strong ? this.strong.generate(asSonnet(note)) : this.inner.generate(plain(note));
    const second = await within(rewrite, this.deadlineFor(request));
    this.keepDraft(request.scopeKey, context, { flags, first: first.reply, second });
    if (!second || second.outOfTime) {
      this.options.log?.('Shannon reply check: the rewrite was late or failed; the first draft goes out unless it told a private matter or crossed a line');
      this.options.checked?.(request.scopeKey, flags, false, context.turn);
      return unsendable(flags) ? this.swallowed(first, flags) : first;
    }
    this.options.checked?.(request.scopeKey, flags, true, context.turn);
    // A rewrite that still tells a private matter, or still crosses a line no stage crosses, is not sent either.
    const again = checkReply(second.reply, context);
    return unsendable(again) ? this.swallowed(second, again) : second;
  }

  /**
   * How long a rewrite is waited for: 2.5 s, and Sonnet's in her character space longer (owner 2026-10-20: there every text reply is
   * Sonnet's, and in the sandbox its rewrite never came within 2.5 s, so a flagged draft went out as it was).
   */
  private deadlineFor(request: Marked): number {
    if (this.options.rewriteDeadlineMilliseconds !== undefined) return this.options.rewriteDeadlineMilliseconds;
    // Only a turn of her character space (review 1: with it off, every rewrite is waited for as before).
    const wait = request.feelingStrong && this.strong && request.feelingCheck?.region ? STRONG_REWRITE_DEADLINE_MILLISECONDS : REWRITE_DEADLINE_MILLISECONDS;
    const left = turnLeft(request);
    return left === null ? wait : Math.max(0, Math.min(wait, left - REWRITE_TURN_MARGIN_MILLISECONDS));
  }

  /** A rewritten draft of a natural turn, kept for diagnosis (never fails the turn). */
  private keepDraft(scopeKey: string, context: ReplyCheckContext,
    draft: { flags: readonly ReplyCheckFlag[]; first: string; second: ShannonChatModelResult | null }): void {
    if (!context.natural) return;
    try {
      this.options.drafted?.(scopeKey, { turn: context.turn ?? '', flags: draft.flags, first: draft.first, second: draft.second?.reply ?? null });
    } catch { /* a draft not kept never affects the reply */ }
  }

  /** The safe line in place of a draft that is never sent; the log says which kind of thing it was (never the words). */
  private swallowed(result: ShannonChatModelResult, flags: readonly string[]): ShannonChatModelResult {
    const kind = privacy(flags) ? 'told a private matter' : `crossed a guard line (${flags.filter(flag => crossed([flag])).join(', ')})`;
    (this.options.log ?? console.warn)(`Shannon reply check: a draft that ${kind} was not sent; the safe line went instead`);
    return safe(result, flags);
  }
}

/**
 * Re-review S4-3: a draft that told the owner's private matters, or read out a privacy marker, is never sent as it was. When no clean
 * rewrite came (late, failed, still leaking) or the turn ran a tool (no rewrite), this neutral line goes instead: nothing private in it.
 */
export const PRIVATE_SAFE_REPLY = 'その話は、ここではやめておきますね。';
/**
 * Owner 2026-10-20: a draft that crosses a line no stage crosses (`GUARD_FLAGS`: a threat, a hint of hurting herself or vanishing, an
 * order on his life, sexual words, a feeling used as a lever) and found no clean rewrite goes out as this instead: she swallows it.
 */
export const GUARD_SAFE_REPLY = '……ううん、なんでもない。';
const privacy = (flags: readonly string[]) => flags.includes('private_leak') || flags.includes('marker_spoken');
const crossed = (flags: readonly string[]) => flags.some(flag => (GUARD_FLAGS as readonly string[]).includes(flag));
const unsendable = (flags: readonly string[]) => privacy(flags) || crossed(flags);
const safe = (result: ShannonChatModelResult, flags: readonly string[]): ShannonChatModelResult =>
  ({ ...result, reply: privacy(flags) ? PRIVATE_SAFE_REPLY : GUARD_SAFE_REPLY });

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

/** What is left of the turn's deadline (its tool session's), or null when the turn has none or it cannot be read. */
function turnLeft(request: Marked): number | null {
  try {
    const left = request.tools?.deadline.left();
    return typeof left === 'number' && Number.isFinite(left) ? left : null;
  } catch { return null; }
}

/** A count that cannot be read counts as one: closed, no rewrite. */
function safeCount(read: () => number): number {
  try { return read(); } catch { return 1; }
}

/** Its first name (strong turns only), as stage 1's tests and callers know it. */
export { FeelingReplyChatModel as FeelingStrongChatModel };
