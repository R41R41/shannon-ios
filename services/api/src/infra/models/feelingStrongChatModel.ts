import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult, ShannonVoiceModelRequest } from './chatModel.js';
import type { AnthropicChatModel } from './anthropic/anthropicChatModel.js';
import { TieredChatModel } from './tieredChatModel.js';

/**
 * Her strong feeling turns on Sonnet (Syzygy ADR-0013; owner decision 2026-10-14, form: 「気持ちが強い時だけSonnet」). Core: response
 * path. Built only while `SHANNON_FEELING_STRONG_REPLY_MODEL` is on and the Anthropic key is present (`wiring/feelingWiring.ts`).
 *
 * A text request marked `feelingStrong` (the feeling turn decided it, within the day's cap) is answered by Sonnet through the tiered
 * model's own rules (its failure before any word or tool falls back to the model of before, as plain); every other request, and every
 * voice request, goes to the model of before exactly as it came (the mark removed). The owner's model mode and the difficulty
 * routing stay inside that model, untouched.
 */
export class FeelingStrongChatModel implements ShannonChatModel {
  readonly mode: ShannonChatModel['mode'];
  readonly model: string;
  private readonly strong: TieredChatModel;

  constructor(private readonly inner: ShannonChatModel, private readonly sonnet: AnthropicChatModel,
    private readonly options: { log?: (line: string) => void; released?: (scopeKey: string) => void } = {}) {
    this.mode = inner.mode;
    this.model = inner.model;
    this.strong = new TieredChatModel(inner, sonnet, options.log);
  }

  /**
   * The model of one turn (review P2-1): the model of before pins the owner's model mode at the turn's admission (`PrimaryModeChatModel`);
   * the turn's own wrapper keeps that pin.
   */
  forTurn(scopeKey: string): ShannonChatModel {
    return new FeelingStrongChatModel(this.inner.forTurn?.(scopeKey) ?? this.inner, this.sonnet, this.options);
  }

  generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    return request.feelingStrong ? this.released(request, this.strong.generate(asSonnet(request))) : this.inner.generate(plain(request));
  }

  generateStreaming(request: ShannonChatModelRequest, onReplyText: (text: string) => void | Promise<void>): Promise<ShannonChatModelResult> {
    if (request.feelingStrong) return this.released(request, this.strong.generateStreaming(asSonnet(request), onReplyText));
    return this.inner.generateStreaming ? this.inner.generateStreaming(plain(request), onReplyText) : this.inner.generate(plain(request));
  }

  /** A strong turn that fails (review P3a) no longer counts against the day's cap; the error goes on as it was. */
  private async released(request: ShannonChatModelRequest, answer: Promise<ShannonChatModelResult>): Promise<ShannonChatModelResult> {
    try { return await answer; } catch (error) {
      this.options.released?.(request.scopeKey);
      throw error;
    }
  }

  generateVoice(request: ShannonVoiceModelRequest): Promise<ShannonChatModelResult> {
    return this.inner.generateVoice ? this.inner.generateVoice(request) : this.inner.generate({ ...request, generateThreadTitle: false });
  }

  generateVoiceStreaming(request: ShannonVoiceModelRequest, onTextDelta: (delta: string) => void | Promise<void>, signal?: AbortSignal)
    : Promise<ShannonChatModelResult> {
    if (this.inner.generateVoiceStreaming) return this.inner.generateVoiceStreaming(request, onTextDelta, signal);
    return this.generateVoice(request);
  }
}

function plain(request: ShannonChatModelRequest): ShannonChatModelRequest {
  if (!request.feelingStrong) return request;
  const { feelingStrong: _strong, ...rest } = request;
  return rest;
}

/** The tiered model answers `tier: sonnet` with Sonnet; its fallback strips the tier, so the model of before decides as it would. */
const asSonnet = (request: ShannonChatModelRequest): ShannonChatModelRequest => ({ ...plain(request), tier: 'sonnet' });
