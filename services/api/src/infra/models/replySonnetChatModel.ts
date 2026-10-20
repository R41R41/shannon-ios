import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult, ShannonVoiceModelRequest } from './chatModel.js';
import type { AnthropicChatModel } from './anthropic/anthropicChatModel.js';
import { TieredChatModel } from './tieredChatModel.js';
import { VOICE_SONNET_FIRST_TOKEN } from '../../mind/action/respond/turnRouting.js';

/**
 * Her replies on Sonnet (owner 2026-10-21, 「声は全部 Sonnet」 then 「文字も全部 Sonnet」; `SHANNON_REPLY_SONNET`). Core: response path.
 *
 * Every reply of hers, spoken or written, from every entry (the apps' and Windows' voice and Talk, a Talk read aloud, Discord's voice
 * and text, her game chat) and before anyone, is Sonnet 5.5's: the plain spoken stream (`generateVoiceStreaming`, `generateVoice`), a
 * voice turn's structured request (`spokenReply`) and every conversation turn's reply (`conversationReply`, its check's rewrite
 * included). What is not a reply (the router, the small helpers, anything else asking this model) is the model's of before.
 *
 * - The day's cap (`SonnetReplyCap`, `SHANNON_REPLY_SONNET_DAILY_CAP`): voice and text together; past it a reply is Haiku's until the
 *   day turns. A reply Sonnet did not serve does not count. The wiring keeps the count in the database (kept across restarts).
 * - The first word: a spoken stream waits for Sonnet's first word or tool call at most `VOICE_SONNET_FIRST_TOKEN.maximumMs` (and
 *   never into the room the turn keeps); past it, or when Sonnet fails before anything was said or done, Haiku answers the turn
 *   (`TieredChatModel`). Once a word went out or a tool ran, a failure ends with her fixed line, never a second answer.
 * - Its prefix is cached: the wiring builds the Sonnet model with the cache plans (`anthropicCachePlan.ts`, `anthropicVoicePlan.ts`):
 *   one fixed system and tool set for every turn, the turn's own lines after the words.
 */
export interface SonnetReplyCap {
  readonly cap: number;
  /** One more Sonnet reply today, or false past the cap. */
  take(): boolean;
  /** A reply that Sonnet did not serve after all (it failed, or Haiku answered in its place). */
  release(): void;
  /** Today's count (diagnosis and tests). */
  count(): number;
}

export interface ReplySonnetOptions {
  sonnet: AnthropicChatModel;
  day: SonnetReplyCap;
  log?: (line: string) => void;
}

/** The day's count in this process only (the bench and tests; the server keeps it in its database, `SQLiteReplySonnetDays`). */
export class MemorySonnetReplyCap implements SonnetReplyCap {
  private day = '';
  private used = 0;

  constructor(readonly cap: number, private readonly today: () => string) {}

  take(): boolean {
    const day = this.today();
    if (day !== this.day) {
      this.day = day;
      this.used = 0;
    }
    if (this.used >= this.cap) return false;
    this.used += 1;
    return true;
  }

  release(): void {
    if (this.used > 0) this.used -= 1;
  }

  count(): number {
    return this.day === this.today() ? this.used : 0;
  }
}

export class ReplySonnetChatModel implements ShannonChatModel {  readonly mode: ShannonChatModel['mode'];
  readonly model: string;
  readonly searchWeb?: ShannonChatModel['searchWeb'];
  readonly readWeb?: ShannonChatModel['readWeb'];
  private readonly tiered: TieredChatModel;

  constructor(private readonly inner: ShannonChatModel, private readonly options: ReplySonnetOptions) {
    this.mode = inner.mode;
    this.model = inner.model;
    if (inner.searchWeb) this.searchWeb = inner.searchWeb;
    if (inner.readWeb) this.readWeb = inner.readWeb;
    this.tiered = new TieredChatModel(inner, options.sonnet, options.log);
  }

  /** The turn's model of before (its pinned mode), with her replies still on Sonnet. */
  forTurn(scopeKey: string): ShannonChatModel {
    return new ReplySonnetChatModel(this.inner.forTurn?.(scopeKey) ?? this.inner, this.options);
  }

  generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    if (!isReply(request) || !this.options.day.take()) return this.inner.generate(request);
    return this.counted(this.tiered.generate(onSonnet(request)));
  }

  generateStreaming(request: ShannonChatModelRequest, onReplyText: (text: string) => void | Promise<void>): Promise<ShannonChatModelResult> {
    if (isReply(request) && this.options.day.take()) return this.counted(this.tiered.generateStreaming(onSonnet(request), onReplyText));
    return this.inner.generateStreaming ? this.inner.generateStreaming(request, onReplyText) : this.inner.generate(request);
  }

  generateVoice(request: ShannonVoiceModelRequest): Promise<ShannonChatModelResult> {
    if (this.options.day.take()) return this.counted(this.tiered.generateVoice(onSonnet(request)));
    return this.innerVoice(request);
  }

  generateVoiceStreaming(request: ShannonVoiceModelRequest, onTextDelta: (delta: string) => void | Promise<void>, signal?: AbortSignal)
    : Promise<ShannonChatModelResult> {
    const asked = voiceOnSonnet(request);
    if (asked && this.options.day.take()) return this.counted(this.tiered.generateVoiceStreaming(asked, onTextDelta, signal));
    if (this.inner.generateVoiceStreaming) return this.inner.generateVoiceStreaming(request, onTextDelta, signal);
    return this.innerVoice(request);
  }

  private innerVoice(request: ShannonVoiceModelRequest): Promise<ShannonChatModelResult> {
    return this.inner.generateVoice ? this.inner.generateVoice(request) : this.inner.generate({ ...request, generateThreadTitle: false });
  }

  /** Counted only when Sonnet served it: a failure, or Haiku in its place, gives the day's count back. */
  private async counted(answer: Promise<ShannonChatModelResult>): Promise<ShannonChatModelResult> {
    try {
      const result = await answer;
      if (result.servedTier !== 'sonnet') this.options.day.release();
      return result;
    } catch (error) {
      this.options.day.release();
      throw error;
    }
  }
}

/** A reply of hers: a voice turn's structured request, or a conversation turn's reply (typed, read aloud, or a platform's). */
function isReply(request: ShannonChatModelRequest): boolean {
  return request.spokenReply === true || request.conversationReply === true;
}

/** The tiered model answers `tier: sonnet` with Sonnet; its fallback strips the tier, so the model of before answers as it would. */
function onSonnet<T extends ShannonChatModelRequest | ShannonVoiceModelRequest>(request: T): T {
  return { ...request, tier: 'sonnet' };
}

/** Below this, a spoken stream's turn has no room for Sonnet's first word: Haiku answers it without asking Sonnet first. */
export const VOICE_SONNET_MINIMUM_FIRST_TOKEN_MS = 1_000;

/**
 * A spoken stream's Sonnet waits for its first word at most `VOICE_SONNET_FIRST_TOKEN.maximumMs`, and never into the room the rest of
 * the turn keeps (the turn's deadline less the margin), as the owner's Sonnet mode does (`primaryModeChatModel.ts`); null when the
 * turn has no room for it.
 */
function voiceOnSonnet(request: ShannonVoiceModelRequest): ShannonVoiceModelRequest | null {
  const { maximumMs, marginMs } = VOICE_SONNET_FIRST_TOKEN;
  const left = request.tools?.deadline.left() ?? maximumMs + marginMs;
  const firstTokenBudgetMs = request.firstTokenBudgetMs ?? Math.max(0, Math.min(left - marginMs, maximumMs));
  return firstTokenBudgetMs < VOICE_SONNET_MINIMUM_FIRST_TOKEN_MS ? null : { ...onSonnet(request), firstTokenBudgetMs };
}
