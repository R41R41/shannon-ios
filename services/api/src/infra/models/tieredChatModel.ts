import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult, ShannonVoiceModelRequest } from './chatModel.js';
import type { AnthropicChatModel } from './anthropic/anthropicChatModel.js';

/**
 * The tiers as one chat model (Syzygy ADR-0008 stage 2, step 5; `docs/skill-and-routing-contract.md`). Core: response path.
 *
 * A request the difficulty policy gave `tier: 'sonnet'` (only while the Anthropic key is present and `SHANNON_SONNET_ROUTING=on`;
 * on voice only when the turn's time can absorb Sonnet's measured first-token latency, owner answer I-2) is answered by Sonnet.
 * Every other request is luna's, passed on unchanged. A Sonnet failure or refusal before any word of hers went out and before
 * any tool ran (its rounds end every later failure with her fixed line) is answered by luna instead, as plain luna; the
 * caller's own cancellation is not retried.
 *
 * Built only while routing is available (`wiring/sonnetWiring.ts`); without it the kernel's model is luna itself.
 */
export class TieredChatModel implements ShannonChatModel {
  readonly mode: ShannonChatModel['mode'];
  readonly model: string;

  constructor(private readonly luna: ShannonChatModel, private readonly sonnet: AnthropicChatModel, private readonly log: (line: string) => void = line => console.warn(line)) {
    this.mode = luna.mode;
    this.model = luna.model;
  }

  generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    return this.route(request, () => this.sonnet.generate(request), lunaRequest => this.luna.generate(lunaRequest));
  }

  generateStreaming(request: ShannonChatModelRequest, onReplyText: (text: string) => void | Promise<void>): Promise<ShannonChatModelResult> {
    return this.route(request, () => this.sonnet.generateStreaming(request, onReplyText),
      lunaRequest => this.luna.generateStreaming ? this.luna.generateStreaming(lunaRequest, onReplyText) : this.luna.generate(lunaRequest));
  }

  generateVoice(request: ShannonVoiceModelRequest): Promise<ShannonChatModelResult> {
    return this.route(request, () => this.sonnet.generateVoice(request),
      lunaRequest => this.luna.generateVoice ? this.luna.generateVoice(lunaRequest) : this.luna.generate({ ...lunaRequest, generateThreadTitle: false }));
  }

  generateVoiceStreaming(request: ShannonVoiceModelRequest, onTextDelta: (delta: string) => void | Promise<void>, signal?: AbortSignal): Promise<ShannonChatModelResult> {
    return this.route(request, () => this.sonnet.generateVoiceStreaming(request, onTextDelta, signal),
      lunaRequest => this.luna.generateVoiceStreaming ? this.luna.generateVoiceStreaming(lunaRequest, onTextDelta, signal)
        : this.luna.generateVoice ? this.luna.generateVoice(lunaRequest) : this.luna.generate({ ...lunaRequest, generateThreadTitle: false }), signal);
  }

  /** Sonnet's measured first-token latency on streamed turns (step 5's hook for the voice policy); null until measured. */
  sonnetFirstTokenMs(): number | null { return this.sonnet.firstTokenLatency.estimate(); }

  private async route<T extends { tier?: string; escalation?: true }>(request: T, sonnet: () => Promise<ShannonChatModelResult>,
    luna: (request: T) => Promise<ShannonChatModelResult>, signal?: AbortSignal): Promise<ShannonChatModelResult> {
    if (request.tier !== 'sonnet') return luna(request);
    try {
      return await sonnet();
    } catch (error) {
      if (signal?.aborted) throw error;
      this.log(`Shannon sonnet tier fell back to luna: ${error instanceof Error ? error.name : 'unknown'}${error instanceof Error && /^SONNET_REFUSAL/u.test(error.message) ? ` ${error.message}` : ''}`);
      const { tier: _tier, escalation: _escalation, ...plain } = request;
      return luna(plain as T);
    }
  }
}
