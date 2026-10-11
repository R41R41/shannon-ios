import type { ModelModeStore, PrimaryModelMode } from '../../contracts/modelModeContract.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest, ShannonChatModelResult } from './chatModel.js';
import { VOICE_SONNET_FIRST_TOKEN } from '../../mind/action/respond/turnRouting.js';

type Request = ShannonChatModelRequest | ShannonVoiceModelRequest;
/** A fixed view is captured at turn admission, before recall/Jev awaits; each round and fallback uses that same view. */
export class PrimaryModeChatModel implements ShannonChatModel {
  readonly mode;
  readonly model;
  constructor(private readonly modes: Pick<ModelModeStore, 'read'>, private readonly haiku: ShannonChatModel,
    private readonly sonnet: ShannonChatModel | null, private readonly sonnetName = sonnet?.model) { this.mode = haiku.mode; this.model = haiku.model; }
  forTurn(scope: string): ShannonChatModel {
    return new PinnedPrimaryModel(this.modes.read(scope).mode, this.haiku, this.sonnet, this.sonnetName);
  }
  generate(request: ShannonChatModelRequest) { return this.forTurn(request.scopeKey).generate(request); }
  generateStreaming(request: ShannonChatModelRequest, listener: (text: string) => void | Promise<void>) {
    return this.forTurn(request.scopeKey).generateStreaming!(request, listener);
  }
  generateVoice(request: ShannonVoiceModelRequest) { return this.forTurn(request.scopeKey).generateVoice!(request); }
  generateVoiceStreaming(request: ShannonVoiceModelRequest, listener: (text: string) => void | Promise<void>, signal?: AbortSignal) {
    return this.forTurn(request.scopeKey).generateVoiceStreaming!(request, listener, signal);
  }
}
class PinnedPrimaryModel implements ShannonChatModel {
  readonly mode;
  readonly model;
  private readonly primary: ShannonChatModel;
  constructor(private readonly requested: PrimaryModelMode, haiku: ShannonChatModel, sonnet: ShannonChatModel | null, sonnetName?: string) {
    if (requested === 'sonnet' && !sonnet) throw new Error('MODEL_MODE_UNAVAILABLE');
    this.primary = requested === 'sonnet' ? sonnet! : haiku;
    this.mode = this.primary.mode; this.model = requested === 'sonnet' ? sonnetName ?? this.primary.model : this.primary.model;
  }
  private request<T extends Request>(value: T): T {
    // Owner answer 3 of 2026-10-12 (ADR-0009 stage 1): every Haiku turn thinks at medium (luna_plus) and is never escalated
    // mid-turn; Sonnet escalation stays the owner's explicit choice of mode.
    if (this.requested === 'haiku') {
      const { firstTokenBudgetMs: _watch, escalation: _escalation, ...rest } = value;
      return { ...rest, tier: 'luna_plus' } as T;
    }
    const { escalation: _escalation, ...rest } = value;
    const voice = 'conversationClass' in value;
    const firstTokenBudgetMs = voice ? value.firstTokenBudgetMs ?? Math.max(0, Math.min(
      (value.tools?.deadline.left() ?? VOICE_SONNET_FIRST_TOKEN.maximumMs + VOICE_SONNET_FIRST_TOKEN.marginMs) - VOICE_SONNET_FIRST_TOKEN.marginMs,
      VOICE_SONNET_FIRST_TOKEN.maximumMs)) : undefined;
    return { ...rest, tier: 'sonnet', ...(firstTokenBudgetMs !== undefined ? { firstTokenBudgetMs } : {}) } as T;
  }
  private served(result: ShannonChatModelResult, request: Request): ShannonChatModelResult {
    return this.requested === 'haiku' ? { ...result, servedTier: result.servedTier ?? 'luna_plus' } : result;
  }
  async generate(request: ShannonChatModelRequest) { return this.served(await this.primary.generate(this.request(request)), request); }
  async generateStreaming(request: ShannonChatModelRequest, listener: (text: string) => void | Promise<void>) {
    return this.primary.generateStreaming ? this.served(await this.primary.generateStreaming(this.request(request), listener), request) : this.generate(request);
  }
  async generateVoice(request: ShannonVoiceModelRequest) {
    return this.served(await (this.primary.generateVoice ? this.primary.generateVoice(this.request(request)) : this.primary.generate({ ...this.request(request), generateThreadTitle: false })), request);
  }
  async generateVoiceStreaming(request: ShannonVoiceModelRequest, listener: (text: string) => void | Promise<void>, signal?: AbortSignal) {
    return this.primary.generateVoiceStreaming ? this.served(await this.primary.generateVoiceStreaming(this.request(request), listener, signal), request) : this.generateVoice(request);
  }
}
