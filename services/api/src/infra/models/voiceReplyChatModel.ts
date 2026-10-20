import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult, ShannonVoiceModelRequest } from './chatModel.js';
import type { AnthropicChatModel } from './anthropic/anthropicChatModel.js';
import { TieredChatModel } from './tieredChatModel.js';
import { VOICE_SONNET_FIRST_TOKEN } from '../../mind/action/respond/turnRouting.js';

/**
 * Her spoken replies on Sonnet (owner 2026-10-21, 「声は全部 Sonnet」; `SHANNON_VOICE_SONNET`). Core: response path.
 *
 * Every voice reply, from every entry (the apps' and Windows' voice, Discord's voice channel) and before anyone, is Sonnet 5.5's:
 * the plain spoken stream (`generateVoiceStreaming`, `generateVoice`), a voice turn's structured request (`spokenReply`) and a
 * platform's voice turn answered as a typed turn (`voiceReply`, dc-voice). A typed reply, the router and the small helpers are
 * the model's of before, unchanged.
 *
 * - The day's cap (`VoiceSonnetDay`, `SHANNON_VOICE_SONNET_DAILY_CAP`): past it a voice reply is Haiku's until the day turns (the
 *   server's own day, counted in this process: a restart counts from zero). A reply Sonnet did not serve does not count.
 * - The first word: a spoken stream waits for Sonnet's first word or tool call at most `VOICE_SONNET_FIRST_TOKEN.maximumMs` (and
 *   never into the room the turn keeps); past it, or when Sonnet fails before anything was said, Haiku answers the turn
 *   (`TieredChatModel`). Once a word went out a failure ends with her fixed line, never a second voice.
 * - Its prefix is cached: the wiring builds the Sonnet model with the voice cache plan (`anthropicVoicePlan.ts`): one fixed system
 *   and tool pair for every voice turn of a Talk, the turn's own lines after the words.
 */
export interface VoiceReplyOptions {
  sonnet: AnthropicChatModel;
  day: VoiceSonnetDay;
  log?: (line: string) => void;
}

/** The day's count of spoken replies served by Sonnet: a cap a day, counted again when the day changes. */
export class VoiceSonnetDay {
  private day = '';
  private used = 0;
  private warned = '';

  constructor(readonly cap: number, private readonly today: () => string, private readonly log: (line: string) => void = line => console.warn(line)) {}

  /** One more Sonnet reply today, or false past the cap (said once a day). */
  take(): boolean {
    const day = this.today();
    if (day !== this.day) {
      this.day = day;
      this.used = 0;
    }
    if (this.used < this.cap) {
      this.used += 1;
      return true;
    }
    if (this.warned !== day) this.log(`Shannon voice replies: the day's cap of ${this.cap} Sonnet replies is reached; voice stays on Haiku today`);
    this.warned = day;
    return false;
  }

  /** A reply that Sonnet did not serve after all (it failed, or Haiku answered in its place). */
  release(): void {
    if (this.used > 0) this.used -= 1;
  }

  /** Today's count (diagnosis and tests). */
  count(): number {
    return this.day === this.today() ? this.used : 0;
  }
}

export class VoiceReplyChatModel implements ShannonChatModel {
  readonly mode: ShannonChatModel['mode'];
  readonly model: string;
  readonly searchWeb?: ShannonChatModel['searchWeb'];
  readonly readWeb?: ShannonChatModel['readWeb'];
  private readonly tiered: TieredChatModel;

  constructor(private readonly inner: ShannonChatModel, private readonly options: VoiceReplyOptions) {
    this.mode = inner.mode;
    this.model = inner.model;
    if (inner.searchWeb) this.searchWeb = inner.searchWeb;
    if (inner.readWeb) this.readWeb = inner.readWeb;
    this.tiered = new TieredChatModel(inner, options.sonnet, options.log);
  }

  /** The turn's model of before (its pinned mode), with her voice still on Sonnet. */
  forTurn(scopeKey: string): ShannonChatModel {
    return new VoiceReplyChatModel(this.inner.forTurn?.(scopeKey) ?? this.inner, this.options);
  }

  generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    if (!spoken(request) || !this.options.day.take()) return this.inner.generate(request);
    return this.counted(this.tiered.generate(onSonnet(request)));
  }

  generateStreaming(request: ShannonChatModelRequest, onReplyText: (text: string) => void | Promise<void>): Promise<ShannonChatModelResult> {
    if (spoken(request) && this.options.day.take()) return this.counted(this.tiered.generateStreaming(onSonnet(request), onReplyText));
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

/** A reply that is spoken: a voice turn's structured request, or a platform's voice turn answered as a typed turn. */
function spoken(request: ShannonChatModelRequest): boolean {
  return request.spokenReply === true || request.voiceReply === true;
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
