import Anthropic from '@anthropic-ai/sdk';
import { actionPermit, currentActionExecution } from '../../../infra/context/actionExecution.js';
import { cacheHaikuRequest, validateHaikuCacheUsage } from '../../../infra/models/anthropic/haikuCache.js';
import { usesOneHourAnthropicCache } from '../../../infra/models/anthropic/haikuConfig.js';
import { claudeClient } from '../../../infra/models/claude/claudeClient.js';
import { tokenCount } from '../../../infra/models/claude/claudeUsage.js';
import { AutonomyModelError, type AutonomyTextRequest, type AutonomyTextResult } from './autonomyTextModel.js';

interface AnthropicAutonomyOptions { apiKey: string; fetcher?: typeof fetch; timeoutMilliseconds?: number }
const ZERO_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cachedInputTokens: 0 });

/** Native Messages adapter for her own time. Its caller supplies only the dedicated credential, never a chat client. */
export class AnthropicAutonomyTextModel {
  private readonly client: Anthropic;
  private readonly timeoutMilliseconds: number;

  constructor(options: AnthropicAutonomyOptions) {
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 90_000;
    this.client = claudeClient({ apiKey: options.apiKey, timeoutMilliseconds: this.timeoutMilliseconds, fetch: options.fetcher });
  }

  async generate(request: AutonomyTextRequest): Promise<AutonomyTextResult> {
    if (!usesOneHourAnthropicCache(request.model) || !Number.isSafeInteger(request.maximumOutputTokens) || request.maximumOutputTokens < 1) {
      throw new AutonomyModelError('AUTONOMY_MODEL_INVALID', ZERO_USAGE);
    }
    const execution = currentActionExecution();
    const signals = [AbortSignal.timeout(this.timeoutMilliseconds), request.signal, execution?.signal].filter((signal): signal is AbortSignal => !!signal);
    const signal = AbortSignal.any(signals);
    if (signal.aborted) throw new AutonomyModelError('ACTION_STOPPED', ZERO_USAGE);
    // Recheck immediately before the only outside request. Neither a refusal nor an uncertain result is retried.
    try { await actionPermit(); }
    catch { throw new AutonomyModelError('ACTION_STOPPED', ZERO_USAGE); }
    let message: Anthropic.Message;
    try {
      const body = cacheHaikuRequest({
        model: request.model, max_tokens: request.maximumOutputTokens,
        system: [{ type: 'text', text: request.system }],
        messages: [{ role: 'user', content: request.prompt }],
        thinking: { type: 'adaptive' as const }, output_config: { effort: 'low' as const },
      });
      // Her own time has no observer span and leaves no cache receipt, so its one request is the pinned client's own: its
      // process loads nothing of the conversation's transport (autonomyLoopPrivacy.test.ts pins that closure).
      message = await this.client.messages.create(body, { signal, maxRetries: 0 });
    } catch (error) {
      // API refusals are closed, not sent again. Transport/server failures leave the paid outcome unknown. Never expose
      // the SDK's message, which can contain the provider's copy of the prompt or the credential.
      if (error instanceof Anthropic.APIError && error.status !== undefined) {
        const code = `AUTONOMY_MODEL_HTTP_${error.status}`;
        if (error.status >= 400 && error.status < 500) throw new AutonomyModelError(code, ZERO_USAGE);
        throw new Error(code);
      }
      throw new Error(signal.aborted ? 'AUTONOMY_MODEL_ABORTED' : 'AUTONOMY_MODEL_RESPONSE_UNKNOWN');
    }
    const native = message.usage;
    if (!native || !tokenCount(native.input_tokens) || !tokenCount(native.output_tokens)
      || !tokenCount(native.cache_creation_input_tokens) || !tokenCount(native.cache_read_input_tokens)) {
      throw new Error('AUTONOMY_MODEL_USAGE_UNKNOWN');
    }
    const creation = native.cache_creation_input_tokens;
    const cached = native.cache_read_input_tokens;
    const input = native.input_tokens + creation + cached;
    if (!Number.isSafeInteger(input)) throw new Error('AUTONOMY_MODEL_USAGE_UNKNOWN');
    const breakdown = native.cache_creation;
    const knownTtl = breakdown && tokenCount(breakdown.ephemeral_5m_input_tokens) && tokenCount(breakdown.ephemeral_1h_input_tokens)
      && breakdown.ephemeral_5m_input_tokens + breakdown.ephemeral_1h_input_tokens === creation;
    const usage = { inputTokens: input, outputTokens: native.output_tokens, cacheCreationInputTokens: creation, cachedInputTokens: cached,
      ...(knownTtl ? { cacheCreation5mInputTokens: breakdown.ephemeral_5m_input_tokens, cacheCreation1hInputTokens: breakdown.ephemeral_1h_input_tokens } : {}),
    };
    // The closed response already spent these tokens. Preserve that cost even when caching did not obey the contract.
    try { validateHaikuCacheUsage(native); }
    catch { throw new AutonomyModelError('AUTONOMY_MODEL_CACHE_INVALID', usage); }
    const truncated = message.stop_reason === 'max_tokens';
    const text = Array.isArray(message.content) ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim() : '';
    if (message.stop_reason === 'refusal') throw new AutonomyModelError('AUTONOMY_MODEL_REFUSED', usage);
    if (!text) throw new AutonomyModelError(truncated ? 'AUTONOMY_MODEL_TRUNCATED' : 'AUTONOMY_MODEL_EMPTY', usage);
    if (message.stop_reason !== 'end_turn' && !truncated) throw new AutonomyModelError('AUTONOMY_MODEL_INCOMPLETE', usage);
    return { text, usage, ...(truncated ? { truncated: true as const } : {}) };
  }
}
