import { describe, expect, it } from 'vitest';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import type { LlmUsageEvent } from '../src/infra/models/llmUsage.js';
import { anthropicFixture, scriptedAnthropic } from './support/anthropicFixtures.js';

const settings = { model: 'claude-sonnet-5-5', effort: 'medium', textThinking: 'adaptive', voiceThinking: 'between_tools' } as const;
const request = { scopeKey: 'synthetic-owner', systemPrompt: 'Synthetic identity', history: [], message: 'Hello' };

function native(usage: Record<string, unknown>) {
  const response = anthropicFixture('structured-answer');
  const transport = scriptedAnthropic([{ ...response, model: settings.model, usage }]);
  const recorded: LlmUsageEvent[] = [];
  const model = new AnthropicChatModel({ apiKey: 'test-only', settings, fetch: transport.fetcher,
    usageStore: { recordLlmUsage: value => { recorded.push(value); }, backgroundLlmCostUsd: () => 0 } });
  return { model, bodies: transport.bodies, recorded };
}

describe('owner-selectable Sonnet cache accounting', () => {
  it.each([false, true])('retains known paid usage on an unconfirmed cache and emits no streamed reply (stream=%s)', async stream => {
    const h = native({ input_tokens: 420, output_tokens: 96, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } });
    const parts: string[] = [];
    await expect(stream ? h.model.generateStreaming(request, text => { parts.push(text); }) : h.model.generate(request))
      .rejects.toThrow('HAIKU_CACHE_UNCONFIRMED'); // The shared cache guard retains its existing closed code.
    expect(parts).toEqual([]);
    expect(h.bodies).toHaveLength(1);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ model: settings.model, inputTokens: 420,
      outputTokens: stream ? 1 : 96, estimatedCostUsd: stream ? 4.16 : 0.0018 });
  });

  it('retains a conservative bound rather than recording missing usage as a zero-priced successful answer', async () => {
    const h = native({ input_tokens: 420, cache_creation_input_tokens: 0, cache_read_input_tokens: 900,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } });
    await expect(h.model.generate(request)).rejects.toThrow('HAIKU_RESPONSE_USAGE_INVALID');
    expect(h.bodies).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ model: settings.model, inputTokens: 1320, cachedInputTokens: 900, outputTokens: 0 });
    expect(h.recorded[0]!.estimatedCostUsd).toBe(4.16);
  });

  it('charges a mixed provider TTL receipt by its actual counts while requesting one-hour reuse', async () => {
    const h = native({ input_tokens: 420, output_tokens: 96, cache_creation_input_tokens: 1000, cache_read_input_tokens: 900,
      cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 700 } });
    const result = await h.model.generate(request);
    expect(result.model).toBe(settings.model);
    expect(h.bodies[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(h.recorded[0]!.estimatedCostUsd).toBeCloseTo((420 * 2 + 300 * 2.5 + 700 * 4 + 900 * 0.2 + 96 * 10) / 1e6, 9);
  });
});
