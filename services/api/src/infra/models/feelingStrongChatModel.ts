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

  constructor(private readonly inner: ShannonChatModel, sonnet: AnthropicChatModel, log?: (line: string) => void) {
    this.mode = inner.mode;
    this.model = inner.model;
    this.strong = new TieredChatModel(inner, sonnet, log);
  }

  generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    return request.feelingStrong ? this.strong.generate(asSonnet(request)) : this.inner.generate(plain(request));
  }

  generateStreaming(request: ShannonChatModelRequest, onReplyText: (text: string) => void | Promise<void>): Promise<ShannonChatModelResult> {
    if (request.feelingStrong) return this.strong.generateStreaming(asSonnet(request), onReplyText);
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
}

function plain(request: ShannonChatModelRequest): ShannonChatModelRequest {
  if (!request.feelingStrong) return request;
  const { feelingStrong: _strong, ...rest } = request;
  return rest;
}

/** The tiered model answers `tier: sonnet` with Sonnet; its fallback strips the tier, so the model of before decides as it would. */
const asSonnet = (request: ShannonChatModelRequest): ShannonChatModelRequest => ({ ...plain(request), tier: 'sonnet' });
