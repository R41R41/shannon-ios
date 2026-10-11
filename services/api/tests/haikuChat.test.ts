import { describe, expect, it } from 'vitest';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { createConfiguredChatModel, type ShannonChatModelRequest } from '../src/infra/models/chatModel.js';
import { TieredChatModel } from '../src/infra/models/tieredChatModel.js';
import { HAIKU_PROTOCOL_PREFIX } from '../src/infra/models/anthropic/haikuCache.js';
import { estimatedAnthropicCostUsd } from '../src/infra/models/anthropic/anthropicConfig.js';
import { estimatedOpenAICostUsd, responseUsage, type LlmUsageEvent } from '../src/infra/models/llmUsage.js';
import { TurnDeadline, TEXT_TURN_DEADLINE } from '../src/mind/action/respond/turnDeadline.js';
import { shannonTool } from '../src/mind/tools/shannonTools.js';
import { anthropicFixture, message, scriptedAnthropic, type AnthropicMessage } from './support/anthropicFixtures.js';

const settings = { model: 'claude-haiku-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' } as const;
const base: ShannonChatModelRequest = { scopeKey: 'owner', systemPrompt: 'Identity', profilePrompt: 'Profile', history: [], message: 'こんにちは', turnContext: 'Current context' };
const haikuMessage = (value: AnthropicMessage, write = 0, read = 900): AnthropicMessage => ({ ...value, model: settings.model,
  usage: { ...value.usage, cache_creation_input_tokens: write, cache_read_input_tokens: read,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write } } });
function model(script: Parameters<typeof scriptedAnthropic>[0], options: Partial<ConstructorParameters<typeof AnthropicChatModel>[0]> = {}) {
  const transport = scriptedAnthropic(script);
  const usage: LlmUsageEvent[] = [];
  const chat = new AnthropicChatModel({ apiKey: 'test-only', settings, fetch: transport.fetcher,
    usageStore: { recordLlmUsage: event => { usage.push(event); }, backgroundLlmCostUsd: () => 0 }, ...options });
  return { chat, usage, bodies: transport.bodies };
}

describe('native Haiku conversation migration', () => {
  it('selects Anthropic for a missing or retired Luna setting, and requires its credential', () => {
    for (const value of [undefined, 'gpt-5.6-luna']) {
      const selected = createConfiguredChatModel({ SHANNON_LLM_MODEL: value, SHANNON_ANTHROPIC_API_KEY: 'native', OPENAI_API_KEY: 'other' });
      expect(selected).toMatchObject({ model: settings.model, mode: 'anthropic' });
    }
    expect(createConfiguredChatModel({ OPENAI_API_KEY: 'other' }).mode).toBe('local-stub');
    expect(createConfiguredChatModel({ SHANNON_LLM_MODEL: 'gpt-5.6-terra', OPENAI_API_KEY: 'other' })).toMatchObject({ mode: 'openai', model: 'gpt-5.6-terra' });
  });

  it('preserves the structured text result and stable layers with three 1h breakpoints', async () => {
    const h = model([haikuMessage(anthropicFixture('structured-answer'), 1800, 0)]);
    const answer = await h.chat.generate(base);
    expect(answer).toMatchObject({ mode: 'anthropic', model: settings.model, reply: expect.any(String) });
    const body = h.bodies[0]!;
    expect(body.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const systems = body.system as Array<{ text: string; cache_control: unknown }>;
    expect(systems[0]).toEqual({ type: 'text', text: HAIKU_PROTOCOL_PREFIX, cache_control: { type: 'ephemeral', ttl: '1h' } });
    expect(systems[1]!.text).toContain('Identity');
    expect(systems[1]!.text).not.toContain('Current context');
    expect(systems[1]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(JSON.stringify(body.messages)).toContain('Current context');
    expect(h.usage).toHaveLength(1);
    expect(h.usage[0]).toMatchObject({ inputTokens: 2220, cachedInputTokens: 0, estimatedCostUsd: estimatedAnthropicCostUsd(settings.model,
      { input: 420, cacheWrite: 1800, cacheRead: 0, output: 96, searches: 0, cacheWrite5m: 0, cacheWrite1h: 1800 }) });
  });

  it('streams only the JSON reply, confirms warm cache and bills output once', async () => {
    const h = model([haikuMessage(anthropicFixture('structured-answer'))]);
    const parts: string[] = [];
    const answer = await h.chat.generateStreaming(base, text => { parts.push(text); });
    expect(parts.join('')).toBe(answer.reply);
    expect(h.usage).toHaveLength(1);
    expect(h.usage[0]).toMatchObject({ cachedInputTokens: 900, outputTokens: 96 });
  });

  it('keeps a paid answer whose cache use is unconfirmed, booking its measured usage (stabilization 2026-10-12)', async () => {
    for (const stream of [false, true]) {
      const h = model([haikuMessage(anthropicFixture('structured-answer'), 0, 0)]);
      const parts: string[] = [];
      const answer = stream ? await h.chat.generateStreaming(base, text => { parts.push(text); }) : await h.chat.generate(base);
      expect(answer.reply).toEqual(expect.any(String));
      if (stream) expect(parts.join('')).toBe(answer.reply);
      expect(h.bodies).toHaveLength(1);
      expect(h.usage).toHaveLength(1);
      expect(h.usage[0]).toMatchObject({ inputTokens: 420, cachedInputTokens: 0 });
      // Measured, uncached: the full input price, with no cache discount.
      expect(h.usage[0]!.estimatedCostUsd).toBe(estimatedAnthropicCostUsd(settings.model,
        { input: 420, cacheWrite: 0, cacheRead: 0, output: 96, searches: 0, cacheWrite5m: 0, cacheWrite1h: 0 }));
    }
  });

  it('keeps the one rethink after failed tools, without repeating an operation', async () => {
    const h = model([haikuMessage(anthropicFixture('tool-call')), haikuMessage(anthropicFixture('tool-call')), haikuMessage(anthropicFixture('structured-answer'))]);
    let calls = 0;
    const answer = await h.chat.generate({ ...base, escalation: true, tools: {
      definitions: [shannonTool('study.list')!], maximumCalls: 6, deadline: new TurnDeadline(TEXT_TURN_DEADLINE),
      async call() { calls++; return JSON.stringify({ ok: false, text: 'Unavailable', retryable: false }); },
    } });
    expect(answer.escalated).toBe(true);
    expect(calls).toBe(2);
    expect(h.bodies.map(body => (body.output_config as { effort: string }).effort)).toEqual(['low', 'medium', 'medium']);
    expect(h.usage).toHaveLength(3);
    expect(JSON.stringify(h.bodies[1]!.messages)).toContain('tool_result');
  });

  it('serves an explicitly selected plus lane at medium effort', async () => {
    const h = model([haikuMessage(anthropicFixture('structured-answer'))]);
    await h.chat.generate({ ...base, tier: 'luna_plus', escalation: true });
    expect(h.bodies[0]!.output_config).toMatchObject({ effort: 'medium' });
  });

  it('keeps web citations and voice text without exposing thinking or cache metadata', async () => {
    const web = haikuMessage(anthropicFixture('web-search-answer'));
    const h = model([web, haikuMessage(message(web.content.filter(block => block.type === 'text'), 'end_turn')), haikuMessage(message([{ type: 'text', text: 'おはようございます。' }], 'end_turn'))]);
    expect((await h.chat.generate({ ...base, useWebSearch: true })).webSources).toEqual([{ title: '今日の天気', url: 'https://example.com/weather' }]);
    const parts: string[] = [];
    const reply = await h.chat.generateVoiceStreaming({ ...base, conversationClass: 'direct', useWebSearch: false }, text => { parts.push(text); });
    expect(reply.reply).toBe('おはようございます。');
    expect(parts.join('')).toBe(reply.reply);
    expect(h.bodies[2]!.thinking).toEqual({ type: 'adaptive' });
  });

  it('identifies Sonnet fallback by the execution lane even though both providers are Anthropic', async () => {
    const h = model([haikuMessage(anthropicFixture('structured-answer'))]);
    const strong = model([anthropicFixture('refusal')], { settings: { ...settings, model: 'claude-sonnet-5-5' } });
    const tiered = new TieredChatModel(h.chat, strong.chat, () => {});
    const answer = await tiered.generate({ ...base, tier: 'sonnet' });
    expect(answer).toMatchObject({ mode: 'anthropic', model: settings.model, servedTier: 'luna' });
    expect(h.bodies[0]!.output_config).toMatchObject({ effort: 'low' });
  });

  it('does not retry a caller-cancelled voice turn', async () => {
    const h = model([haikuMessage(message([{ type: 'text', text: 'はい。' }], 'end_turn'))]);
    const controller = new AbortController(); controller.abort();
    await expect(h.chat.generateVoiceStreaming({ ...base, conversationClass: 'direct', useWebSearch: false }, () => {}, controller.signal)).rejects.toThrow();
    expect(h.bodies).toHaveLength(0);
    expect(h.usage).toHaveLength(0);
  });

  it('retains the first-output bound on voice, without retrying a stalled provider', async () => {
    let calls = 0;
    const fetcher = (async (_url, init) => {
      calls++;
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    const h = model([], { fetch: fetcher, voiceStreamBounds: { firstOutputMilliseconds: 10, idleMilliseconds: 10 } });
    await expect(h.chat.generateVoiceStreaming({ ...base, conversationClass: 'direct', useWebSearch: false }, () => {})).rejects.toThrow('ANTHROPIC_RESPONSE_FIRST_OUTPUT_TIMEOUT');
    expect(calls).toBe(1);
    expect(h.usage).toEqual([]);
  });

  it('keeps known partial token counts and a bounded charge when native usage is incomplete', async () => {
    const value = haikuMessage(anthropicFixture('structured-answer'));
    value.usage.input_tokens = null;
    const h = model([value]);
    await expect(h.chat.generate(base)).rejects.toThrow('HAIKU_RESPONSE_USAGE_INVALID');
    expect(h.usage).toHaveLength(1);
    expect(h.usage[0]).toMatchObject({ inputTokens: 900, cachedInputTokens: 900, outputTokens: 96, estimatedCostUsd: 1.04 });
    const usage = responseUsage({ usage: { input_tokens: 712, input_tokens_details: { cached_tokens: 700 }, output_tokens: null,
      usage_complete: false, unknown_cost_upper_bound_usd: 1.00256 } });
    expect(usage).toMatchObject({ inputTokens: 712, cachedInputTokens: 700, unknownCostUpperBoundUsd: 1.00256 });
    expect(estimatedOpenAICostUsd(settings.model, usage)).toBe(1.00256);
  });

  it('adds acknowledged search fees to an incomplete native token receipt upper bound without adopting or retrying it', async () => {
    const value = haikuMessage(anthropicFixture('structured-answer'), 0, 0);
    value.usage.input_tokens = null;
    value.usage.output_tokens = 16_000;
    value.usage.server_tool_use = { web_search_requests: 3 };
    const h = model([value]);
    expect((await h.chat.generate({ ...base, useWebSearch: true })).reply).toBe('検索の完了を確認できませんでした。');
    expect(h.bodies).toHaveLength(1);
    expect(h.usage).toHaveLength(1);
    expect(h.usage[0]).toMatchObject({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 1 }); // The stream stops at the first invalid receipt, before its unseen final output count.
    expect(h.usage[0]!.estimatedCostUsd).toBeCloseTo(1.04, 10); // Raw helper reserves at most 4,000 output tokens, plus all three searches.
  });

  it('records the unknown upper bound when the provider omits its entire usage receipt', async () => {
    const value = { ...haikuMessage(anthropicFixture('structured-answer')), usage: undefined } as unknown as AnthropicMessage;
    const h = model([value]);
    await expect(h.chat.generate(base)).rejects.toThrow('HAIKU_CACHE_USAGE_INVALID');
    expect(h.usage).toHaveLength(1);
    expect(h.usage[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 1.04 });
    expect(h.bodies).toHaveLength(1);
  });

  it.each([false, true])('recovers once from an explicit tool-offer refusal, afterUsed=%s', async afterUsed => {
    const rejected = () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'unsupported tool schema' } }),
      { status: 400, headers: { 'content-type': 'application/json' } });
    const h = model((_body, index) => {
      if (afterUsed && index === 0) return haikuMessage(anthropicFixture('tool-call'));
      if (index === (afterUsed ? 1 : 0)) return rejected();
      return haikuMessage(anthropicFixture('structured-answer'));
    });
    let calls = 0;
    const answer = await h.chat.generate({ ...base, tools: { definitions: [shannonTool('study.list')!], maximumCalls: 6,
      deadline: new TurnDeadline(TEXT_TURN_DEADLINE), async call() { calls++; return JSON.stringify({ ok: true, text: 'original result', retryable: false }); } } });
    expect(answer.reply).toBeTruthy();
    expect(h.bodies).toHaveLength(afterUsed ? 3 : 2);
    expect(calls).toBe(afterUsed ? 1 : 0);
    if (afterUsed) {
      expect(h.bodies.at(-1)!.tools).toEqual(h.bodies[0]!.tools);
      expect(h.bodies.at(-1)!.system).toEqual(h.bodies[0]!.system);
      expect(h.bodies.at(-1)!.tool_choice).toEqual({ type: 'none' });
      expect((h.bodies.at(-1)!.messages as unknown[]).slice(0, (h.bodies[1]!.messages as unknown[]).length)).toEqual(h.bodies[1]!.messages);
      expect(JSON.stringify(h.bodies.at(-1)!.messages)).toContain('original result');
      expect(JSON.stringify(h.bodies.at(-1)!.messages)).toContain('"tool_use"');
      expect(JSON.stringify(h.bodies.at(-1)!.messages)).toContain('"thinking"');
    } else {
      expect(h.bodies.at(-1)).not.toHaveProperty('tools');
      expect(h.bodies.at(-1)).not.toHaveProperty('tool_choice');
    }
  });

  it('preserves offered-tool recovery for an explicit older Haiku override', async () => {
    const older = 'claude-haiku-4-5-20251001';
    const h = model((_body, index) => index === 0
      ? new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'unsupported tool schema' } }),
        { status: 400, headers: { 'content-type': 'application/json' } })
      : { ...haikuMessage(anthropicFixture('structured-answer')), model: older }, { settings: { ...settings, model: older } });
    const answer = await h.chat.generate({ ...base, tools: { definitions: [shannonTool('study.list')!], maximumCalls: 6,
      deadline: new TurnDeadline(TEXT_TURN_DEADLINE), async call() { throw new Error('must not run'); } } });
    expect(answer.reply).toBeTruthy();
    expect(h.bodies).toHaveLength(2);
    expect(h.bodies[1]!.model).toBe(older);
    expect(h.bodies[1]).not.toHaveProperty('tools');
  });

  // 429 and 5xx get the one bounded transient retry (stabilization 2026-10-12); nothing is recovered twice.
  it.each([400, 401, 403, 408, 409, 429, 500])('does not repeatedly recover a plain refusal or an excluded status %s', async status => {
    const h = model(() => new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'rejected' } }), { status,
      headers: { 'content-type': 'application/json' } }), { retryWait: async () => {} });
    await expect(h.chat.generate({ ...base, tools: { definitions: [shannonTool('study.list')!], maximumCalls: 6,
      deadline: new TurnDeadline(TEXT_TURN_DEADLINE), async call() { throw new Error('must not run'); } } })).rejects.toThrow();
    expect(h.bodies).toHaveLength([400, 429, 500].includes(status) ? 2 : 1);
    expect(h.usage).toEqual([]);
  });
});
