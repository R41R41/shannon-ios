import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult, ShannonVoiceModelRequest } from './chatModel.js';
import type { AnthropicChatModel } from './anthropic/anthropicChatModel.js';
import { TURN_OUT_OF_TIME_LINE } from '../../mind/action/respond/turnDeadline.js';
import { completeSpokenSentences } from '../../surfaces/voice/spokenSentences.js';
import { turnToolResults } from '../../mind/tools/toolsPorts.js';

/**
 * The tiers as one chat model (Syzygy ADR-0008 stage 2, step 5; `docs/skill-and-routing-contract.md`). Core: response path.
 *
 * A request the difficulty policy gave `tier: 'sonnet'` (only while the Anthropic key is present and `SHANNON_SONNET_ROUTING=on`;
 * on voice only when the turn's time can absorb Sonnet's measured first-token latency, owner answer I-2) is answered by Sonnet.
 * Every other request is luna's, passed on unchanged. A Sonnet failure or refusal is answered by luna instead, as plain luna,
 * **only while nothing of the turn has happened** (review H1, H2): once any word of hers went out (streamed text or speech) or
 * any tool ran in the turn, a failure ends the turn with her fixed line after what was said, so no word is said twice and no
 * write runs twice. The caller's own cancellation is not retried. On voice Sonnet's first word or tool call has a budget
 * (`firstTokenBudgetMs`, review H3); past it Sonnet is aborted before anything happened and luna answers.
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
    return this.route(request, () => this.sonnet.generate(request), lunaRequest => this.luna.generate(lunaRequest), () => '', sent => this.sonnet.outOfTimeTurn(request, sent));
  }

  generateStreaming(request: ShannonChatModelRequest, onReplyText: (text: string) => void | Promise<void>): Promise<ShannonChatModelResult> {
    let written = '';
    return this.route(request, () => this.sonnet.generateStreaming(request, text => { written += text; return onReplyText(text); }),
      lunaRequest => this.luna.generateStreaming ? this.luna.generateStreaming(lunaRequest, onReplyText) : this.luna.generate(lunaRequest),
      () => written, sent => this.sonnet.outOfTimeTurn(request, sent));
  }

  generateVoice(request: ShannonVoiceModelRequest): Promise<ShannonChatModelResult> {
    return this.route(request, () => this.sonnet.generateVoice(request),
      lunaRequest => this.luna.generateVoice ? this.luna.generateVoice(lunaRequest) : this.luna.generate({ ...lunaRequest, generateThreadTitle: false }),
      () => '', sent => this.spokenLine(sent));
  }

  generateVoiceStreaming(request: ShannonVoiceModelRequest, onTextDelta: (delta: string) => void | Promise<void>, signal?: AbortSignal): Promise<ShannonChatModelResult> {
    let spoken = '';
    return this.route(request, () => this.sonnet.generateVoiceStreaming(request, delta => { spoken += delta; return onTextDelta(delta); }, signal),
      lunaRequest => this.luna.generateVoiceStreaming ? this.luna.generateVoiceStreaming(lunaRequest, onTextDelta, signal)
        : this.luna.generateVoice ? this.luna.generateVoice(lunaRequest) : this.luna.generate({ ...lunaRequest, generateThreadTitle: false }),
      () => spoken, async sent => { await onTextDelta(TURN_OUT_OF_TIME_LINE); return this.spokenLine(sent); }, signal);
  }

  /** Sonnet's measured first-token latency on streamed voice turns (step 5's hook for the voice policy); null until measured. */
  sonnetFirstTokenMs(): number | null { return this.sonnet.firstTokenLatency.estimate(); }

  private spokenLine(sent: string): ShannonChatModelResult {
    return { mode: this.sonnet.mode, model: this.sonnet.model, reply: `${completeSpokenSentences(sent.trim()) || ''}${TURN_OUT_OF_TIME_LINE}`, outOfTime: true };
  }

  private async route<T extends { tier?: string; escalation?: true; firstTokenBudgetMs?: number; tools?: ShannonChatModelRequest['tools'] }>(request: T,
    sonnet: () => Promise<ShannonChatModelResult>, luna: (request: T) => Promise<ShannonChatModelResult>,
    sent: () => string, fixedLine: (sent: string) => ShannonChatModelResult | Promise<ShannonChatModelResult>, signal?: AbortSignal): Promise<ShannonChatModelResult> {
    if (request.tier !== 'sonnet') return luna(request);
    try {
      return await sonnet();
    } catch (error) {
      if (signal?.aborted) throw error;
      const said = sent();
      const ran = safeCount(() => turnToolResults(request.tools).length);
      const reason = `${error instanceof Error ? error.name : 'unknown'}${error instanceof Error && /^SONNET_REFUSAL/u.test(error.message) ? ` ${error.message}` : ''}`;
      // Words went out, or a tool ran: luna would repeat them (or run a write twice). Her fixed line ends the turn.
      if (said || ran > 0) {
        this.log(`Shannon sonnet tier ended with the fixed line: ${reason} said=${said ? 1 : 0} tools=${ran}`);
        return fixedLine(said);
      }
      this.log(`Shannon sonnet tier fell back to luna: ${reason}`);
      const { tier: _tier, escalation: _escalation, firstTokenBudgetMs: _budget, ...plain } = request;
      return luna(plain as T);
    }
  }
}

/** A count that cannot be read counts as one: closed, no fallback. */
function safeCount(read: () => number): number {
  try { return read(); } catch { return 1; }
}
