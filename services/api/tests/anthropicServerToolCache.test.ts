import { describe, expect, it } from 'vitest';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { serverSearchCacheStart, settledServerSearchUsage, validateHaikuCacheUsage } from '../src/infra/models/anthropic/haikuCache.js';
import type { LlmUsageEvent } from '../src/infra/models/llmUsage.js';
import { anthropicFixture, message, sse } from './support/anthropicFixtures.js';

const settings = { model: 'claude-haiku-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' } as const;
const search = { scopeKey: 'synthetic-owner', query: 'Synthetic public weather fixture', maxUses: 1 };
const weatherBlocks = [
  { type: 'server_tool_use', id: 'srv_synthetic', name: 'web_search', input: { query: 'Synthetic public weather fixture' } },
  { type: 'web_search_tool_result', tool_use_id: 'srv_synthetic', content: [
    { type: 'web_search_result', title: 'Synthetic forecast', url: 'https://example.test/weather', encrypted_content: 'synthetic', page_age: null },
  ] },
  { type: 'thinking', thinking: 'Synthetic private thinking', signature: 'synthetic-signature' },
  { type: 'text', text: '合成の天気：晴れ。', citations: [] },
];

/** Actual native shape: final cumulative creation grows; MessageDeltaUsage carries no TTL breakdown. */
function serverStream(initialCreation = 0, stop = 'end_turn', options: { modelName?: string; explicitTtl?: unknown; mismatch?: boolean; pending?: boolean; finishPending?: boolean; interrupted?: boolean } = {}) {
  const initialRead = initialCreation ? 0 : 4195;
  const finalUsage = { input_tokens: 6, output_tokens: 853, cache_creation_input_tokens: initialCreation + 7590,
    cache_read_input_tokens: initialCreation ? 5000 : 8390,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: initialCreation },
    server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } };
  const content = weatherBlocks.filter(block => !options.finishPending || block.type !== 'server_tool_use')
    .map(block => block.type === 'web_search_tool_result' ? { ...block, tool_use_id: options.mismatch ? 'not-the-call' : options.finishPending ? 'srv_pending' : block.tool_use_id } : block);
  if (options.pending) content.push({ type: 'server_tool_use', id: 'srv_pending', name: 'web_search', input: { query: 'Synthetic next search' } });
  let raw = sse(message(content, stop, { model: options.modelName ?? settings.model, usage: finalUsage }));
  raw = raw.split('\n\n').map(frame => {
    if (!frame.startsWith('event: message_start') && !frame.startsWith('event: message_delta')) return frame;
    const [type, data] = frame.split('\ndata: '); const event = JSON.parse(data!);
    if (event.type === 'message_start') event.message.usage = { ...event.message.usage, input_tokens: 4, output_tokens: 16,
      cache_creation_input_tokens: initialCreation, cache_read_input_tokens: initialRead };
    else {
      delete event.usage.cache_creation;
      if (Object.hasOwn(options, 'explicitTtl')) event.usage.cache_creation = options.explicitTtl;
    }
    return type + '\ndata: ' + JSON.stringify(event);
  }).join('\n\n');
  if (options.interrupted) return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(raw.slice(0, raw.indexOf('event: content_block_start'))));
    controller.error(new Error('SYNTHETIC_STREAM_INTERRUPTED'));
  } }), { headers: { 'content-type': 'text/event-stream' } });
  return new Response(raw, { headers: { 'content-type': 'text/event-stream' } });
}

function harness(first: () => Response, more: (() => Response)[] = [], modelName = settings.model as string) {
  const bodies: Record<string, any>[] = [], recorded: LlmUsageEvent[] = [];
  const responses = [first, ...more];
  const fetcher: typeof fetch = async (input, init) => {
    const body = JSON.parse(await new Request(input, init).clone().text()); bodies.push(body);
    const response = responses[bodies.length - 1]; if (!response) throw new Error('UNEXPECTED_EXTRA_NATIVE_SEND');
    return response();
  };
  const model = new AnthropicChatModel({ apiKey: 'offline-test-only', settings: { ...settings, model: modelName }, fetch: fetcher,
    usageStore: { recordLlmUsage: value => { recorded.push(value); }, backgroundLlmCostUsd: () => 0 } });
  return { model, bodies, recorded };
}

function finalResponse() {
  const value = anthropicFixture('structured-answer');
  value.model = settings.model;
  value.usage = { input_tokens: 2, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 512,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, server_tool_use: null };
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

describe('native server-search streaming cache receipts', () => {
  it.each([0, 5000])('retains the immutable initial 1h write and prices additional automatic 5m writes (initial=%s)', async initial => {
    const h = harness(() => serverStream(initial));
    const result = await h.model.searchWeb(search);
    expect(result).toMatchObject({ status: 'results', text: '合成の天気：晴れ。', sources: [{ title: 'Synthetic forecast', url: 'https://example.test/weather' }] });
    expect(h.bodies).toHaveLength(1);
    expect(h.bodies[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ inputTokens: initial ? 17596 : 15986, cachedInputTokens: initial ? 5000 : 8390, outputTokens: 853 });
    expect(h.recorded[0]!.estimatedCostUsd).toBeCloseTo((6 * .1 + 7590 * .125 + initial * .2 + (initial ? 5000 : 8390) * .01 + 853 * .5) / 1e6 + .01, 12);
  });

  it('continues a completed pause request with a resolved result and a pending call, retaining the signed prefix', async () => {
    const h = harness(() => serverStream(5000, 'pause_turn', { pending: true }), [() => serverStream(0, 'end_turn', { finishPending: true })]);
    const result = await h.model.searchWeb({ ...search, maxUses: 2 });
    expect(result.status).toBe('results');
    expect(h.bodies).toHaveLength(2);
    expect(h.recorded).toHaveLength(2);
    expect(h.bodies[1]!.tools).toEqual(h.bodies[0]!.tools);
    expect(h.bodies[1]!.system).toEqual(h.bodies[0]!.system);
    expect(h.bodies[1]!.messages.slice(0, -1)).toEqual(h.bodies[0]!.messages);
    expect(h.bodies[1]!.messages.at(-1)).toMatchObject({ role: 'assistant', content: expect.arrayContaining([
      expect.objectContaining({ type: 'thinking', signature: 'synthetic-signature' }),
      expect.objectContaining({ type: 'web_search_tool_result', tool_use_id: 'srv_synthetic' }),
      expect.objectContaining({ type: 'server_tool_use', id: 'srv_pending' }),
    ]) });
  });

  it('passes verified actual-source context to the separate structured final response without a second search', async () => {
    const h = harness(() => serverStream(), [finalResponse]);
    const result = await h.model.generate({ scopeKey: search.scopeKey, systemPrompt: 'Synthetic fixture', history: [], message: search.query, useWebSearch: true });
    expect(result.webSources).toEqual([{ title: 'Synthetic forecast', url: 'https://example.test/weather' }]);
    expect(result.reply).toBeTruthy();
    expect(h.bodies).toHaveLength(2);
    expect(h.bodies[0]!.tools[0].name).toBe('web_search');
    expect(h.bodies[1]!.tools).toBeUndefined();
    expect(h.bodies[1]!.output_config.format.type).toBe('json_schema');
    expect(JSON.stringify(h.bodies[1]!.messages)).toContain('https://example.test/weather');
    expect(h.recorded).toHaveLength(2);
  });

  const voiceCases = (['claude-haiku-5-5', 'claude-sonnet-5-5'] as const).flatMap(modelName =>
    (['skill_simple', 'skill_complex'] as const).flatMap(conversationClass =>
      [0, 5000].map(initial => ({ modelName, conversationClass, initial }))));
  it.each(voiceCases)('completes a direct streamed voice search with measured cache writes/reads ($modelName, $conversationClass, initial=$initial)', async ({ modelName, conversationClass, initial }) => {
    const h = harness(() => serverStream(initial, 'end_turn', { modelName }), [], modelName);
    const spoken: string[] = [];
    const result = await h.model.generateVoiceStreaming({ scopeKey: search.scopeKey, systemPrompt: 'Synthetic fixture',
      history: [], message: search.query, useWebSearch: true, conversationClass }, text => { spoken.push(text); });
    expect(result.reply).toBe('合成の天気：晴れ。');
    expect(spoken.join('')).toBe(result.reply);
    expect(result.webSources).toEqual([{ title: 'Synthetic forecast', url: 'https://example.test/weather' }]);
    expect(h.bodies).toHaveLength(1);
    expect(h.bodies[0]!.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search',
      max_uses: conversationClass === 'skill_complex' ? 3 : 2, allowed_callers: ['direct'] }]);
    expect(h.bodies[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]!.cachedInputTokens).toBe(initial ? 5000 : 8390);
    const price = modelName === 'claude-haiku-5-5' ? { input: .1, write: .125, hour: .2, read: .01, output: .5 }
      : { input: 2, write: 2.5, hour: 4, read: .2, output: 10 };
    expect(h.recorded[0]!.estimatedCostUsd).toBeCloseTo((6 * price.input + 7590 * price.write + initial * price.hour
      + (initial ? 5000 : 8390) * price.read + 853 * price.output) / 1e6 + .01, 12);
  });

  it('continues a paused streamed voice search without speaking unverified intermediate text or repeating the completed search', async () => {
    const h = harness(() => serverStream(5000, 'pause_turn', { pending: true }), [() => serverStream(0, 'end_turn', { finishPending: true })]);
    const spoken: string[] = [];
    const result = await h.model.generateVoiceStreaming({ scopeKey: search.scopeKey, systemPrompt: 'Synthetic fixture',
      history: [], message: search.query, useWebSearch: true, conversationClass: 'skill_simple' }, text => { spoken.push(text); });
    expect(result.webSources).toEqual([{ title: 'Synthetic forecast', url: 'https://example.test/weather' }]);
    expect(spoken.join('')).toBe(result.reply);
    expect(h.bodies).toHaveLength(2);
    expect(h.recorded).toHaveLength(2);
    expect(h.bodies[1]!.tools).toEqual(h.bodies[0]!.tools);
    expect(h.bodies[1]!.messages.slice(0, -1)).toEqual(h.bodies[0]!.messages);
    expect(h.bodies[1]!.messages.at(-1)).toMatchObject({ role: 'assistant', content: expect.arrayContaining([
      expect.objectContaining({ type: 'thinking', signature: 'synthetic-signature' }),
      expect.objectContaining({ type: 'web_search_tool_result', tool_use_id: 'srv_synthetic' }),
    ]) });
  });

  it.each([{ mismatch: true }, { explicitTtl: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }])(
    'does not speak a weather claim or retry a streamed voice search with unverified receipts (%j)', async options => {
      const h = harness(() => serverStream(0, 'end_turn', options));
      const spoken: string[] = [];
      const result = await h.model.generateVoiceStreaming({ scopeKey: search.scopeKey, systemPrompt: 'Synthetic fixture',
        history: [], message: search.query, useWebSearch: true, conversationClass: 'skill_simple' }, text => { spoken.push(text); });
      expect(result.reply).toBe('検索の完了を確認できませんでした。');
      expect(result.webSources).toBeUndefined();
      expect(spoken.join('')).toBe(result.reply);
      expect(h.bodies).toHaveLength(1);
      expect(h.recorded).toHaveLength(1);
      expect(h.recorded[0]!.estimatedCostUsd).toBeGreaterThan(0);
    });

  it('uses an explicit valid delta TTL split instead of the SDK stale start split', async () => {
    const h = harness(() => serverStream(0, 'end_turn', { explicitTtl: { ephemeral_5m_input_tokens: 7000, ephemeral_1h_input_tokens: 590 } }));
    expect((await h.model.searchWeb(search)).status).toBe('results');
    expect(h.recorded[0]!.estimatedCostUsd).toBeCloseTo((6 * .1 + 7000 * .125 + 590 * .2 + 8390 * .01 + 853 * .5) / 1e6 + .01, 12);
  });

  it('retains a legal explicit null TTL and prices known creation conservatively at 1h', async () => {
    const h = harness(() => serverStream(0, 'end_turn', { explicitTtl: null }));
    expect((await h.model.searchWeb(search)).status).toBe('results');
    expect(h.recorded[0]!.estimatedCostUsd).toBeCloseTo((6 * .1 + 7590 * .2 + 8390 * .01 + 853 * .5) / 1e6 + .01, 12);
  });

  it.each([
    { explicitTtl: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
    { explicitTtl: { ephemeral_5m_input_tokens: -1, ephemeral_1h_input_tokens: 7591 } },
    { mismatch: true },
  ])('refuses malformed explicit TTL or unmatched server results without a retry (%j)', async options => {
    const h = harness(() => serverStream(0, 'end_turn', options));
    expect((await h.model.searchWeb(search)).status).toBe('unknown');
    expect(h.bodies).toHaveLength(1);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]!.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('keeps interrupted server usage unknown and never continues', async () => {
    const h = harness(() => serverStream(0, 'end_turn', { interrupted: true }));
    expect((await h.model.searchWeb(search)).status).toBe('unknown');
    expect(h.bodies).toHaveLength(1);
    expect(h.recorded[0]!.estimatedCostUsd).toBeGreaterThanOrEqual(1);
  });

  it('never uses a server correction without a captured initial receipt or repairs an ordinary invalid cache', () => {
    const value = message(weatherBlocks, 'end_turn', { usage: { input_tokens: 6, output_tokens: 853, cache_creation_input_tokens: 7590, cache_read_input_tokens: 8390,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, server_tool_use: { web_search_requests: 1 } } });
    const native = value as unknown as Parameters<typeof settledServerSearchUsage>[0];
    expect(settledServerSearchUsage(native, null, undefined)).toBe(native);
    expect(() => validateHaikuCacheUsage(native.usage)).toThrow('HAIKU_CACHE_USAGE_INVALID');
    const invalidStart = { ...native.usage, cache_creation_input_tokens: 0.5 };
    expect(serverSearchCacheStart(invalidStart)).toBeNull();
  });
});
