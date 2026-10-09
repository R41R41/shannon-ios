import { describe, expect, it } from 'vitest';
import { TieredChatModel } from '../src/infra/models/tieredChatModel.js';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { conversationTools } from '../src/mind/tools/shannonToolSession.js';
import { TurnDeadline, TEXT_TURN_DEADLINE } from '../src/mind/action/respond/turnDeadline.js';
import { withToolMenu } from '../src/mind/tools/shannonToolMenu.js';
import { nativeWebSearchResult } from '../src/infra/models/anthropic/anthropicWebSearch.js';
import { HAIKU_PROTOCOL_PREFIX } from '../src/infra/models/anthropic/haikuCache.js';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
import { readToolExecutors } from '../src/mind/tools/shannonReadTools.js';
import { observedAnthropicResponse } from '../src/infra/models/anthropic/observerProjection.js';
import type { LlmUsageEvent } from '../src/infra/models/llmUsage.js';
import type { ShannonChatModelRequest } from '../src/infra/models/chatModel.js';
import { message, scriptedAnthropic, type AnthropicMessage } from './support/anthropicFixtures.js';

const at = '2026-10-09T00:00:00.000Z';
const settings = { model: 'claude-haiku-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' } as const;
const base: ShannonChatModelRequest = { scopeKey: 'owner', systemPrompt: 'identity', profilePrompt: 'PRIVATE_PROFILE', history: [{ role: 'user', content: 'PRIVATE_HISTORY' }], message: '明日の横浜の天気を確認して' };
function answer(reply = '検索結果では晴れです。', needsInput = false) {
  return message([{ type: 'text', text: JSON.stringify({ reply, threadSummary: null, threadTitle: null, taskDecision: { disposition: 'none', reason: 'reply' }, taskProposal: null, intentPlan: null, artifacts: null, webSearchNeedsInput: needsInput }) }], 'end_turn');
}
function search(id = 'srv_1', stop = 'end_turn') {
  const value = message([
    { type: 'thinking', thinking: 'private reasoning', signature: 'signed-original' },
    { type: 'server_tool_use', id, name: 'web_search', input: { query: '横浜 明日 天気' } },
    { type: 'web_search_tool_result', tool_use_id: id, content: [{ type: 'web_search_result', title: '天気予報', url: 'https://example.com/forecast', encrypted_content: 'encrypted-original', page_age: null }] },
    { type: 'text', text: '横浜は晴れの予報です。これは調査資料です。', citations: [{ type: 'web_search_result_location', url: 'https://example.com/forecast', title: '天気予報', encrypted_index: 'citation-original', cited_text: '晴れ' }] },
  ], stop);
  value.usage.server_tool_use = { web_search_requests: 1 };
  return value;
}
function client(script: Parameters<typeof scriptedAnthropic>[0], model: string = settings.model) {
  const { fetcher, bodies } = scriptedAnthropic(script);
  const usage: LlmUsageEvent[] = [];
  const chat = new AnthropicChatModel({ apiKey: 'test-only', settings: { ...settings, model }, fetch: fetcher,
    usageStore: { recordLlmUsage: event => { usage.push(event); }, backgroundLlmCostUsd: () => 0 } });
  return { chat, bodies, usage };
}
const requestTool = (name: string, input: Record<string, unknown> = {}) => message([{ type: 'tool_use', id: `tool_${name}`, name, input }], 'tool_use');

describe('native non-JSON search and receipts', () => {
  it('separates explicit search from JSON synthesis and keeps auxiliary Haiku when the primary is Sonnet', async () => {
    const h = client([search(), answer()], 'claude-sonnet-5-5');
    const reply = await h.chat.generate({ ...base, useWebSearch: true });
    expect(reply.reply).toBe('検索結果では晴れです。');
    expect(reply.model).toBe('claude-sonnet-5-5');
    expect(reply.webSources).toEqual([{ title: '天気予報', url: 'https://example.com/forecast' }]);
    expect(h.bodies).toHaveLength(2);
    expect(h.bodies[0]).toMatchObject({ model: 'claude-haiku-5-5', output_config: { effort: 'low' }, tools: [{ name: 'web_search', max_uses: 3 }], tool_choice: { type: 'auto' }, cache_control: { type: 'ephemeral', ttl: '1h' } });
    expect((h.bodies[0]!.output_config as object)).not.toHaveProperty('format');
    expect(JSON.stringify(h.bodies[0])).not.toContain('PRIVATE_');
    expect((h.bodies[0]!.system as Array<{ text: string }>)[0]!.text).toBe(HAIKU_PROTOCOL_PREFIX);
    expect(h.bodies[1]).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { format: { type: 'json_schema' } } });
    expect(h.bodies[1]!.tools).toBeUndefined();
    expect(h.usage.map(row => row.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
  });

  it('does not report a promise-only HTTP 200 response as a completed search or make a synthesis call', async () => {
    const value = answer('これから確認します。'); value.usage.server_tool_use = { web_search_requests: 0 };
    const h = client([value]);
    const result = await h.chat.generate({ ...base, useWebSearch: true });
    expect(result.reply).toBe('検索は実行されていません。');
    expect(result.webSources).toBeUndefined(); expect(h.bodies).toHaveLength(1);
  });

  it.each(['empty', 'error', 'missing_usage', 'unpaired', 'refusal', 'invalid_url'] as const)('keeps %s evidence unsuccessful', async kind => {
    const value = search();
    if (kind === 'empty') value.content[2]!.content = [];
    if (kind === 'error') value.content[2]!.content = { type: 'web_search_tool_result_error', error_code: 'unavailable' };
    if (kind === 'missing_usage') value.usage.server_tool_use = null;
    if (kind === 'unpaired') value.content[2]!.tool_use_id = 'not-the-call';
    if (kind === 'refusal') value.stop_reason = 'refusal';
    if (kind === 'invalid_url') (value.content[2]!.content as Array<Record<string, unknown>>)[0]!.url = 'javascript:bad';
    const h = client([value]);
    const result = await h.chat.searchWeb({ scopeKey: 'owner', query: 'query' });
    expect(result.status).not.toBe('results'); expect(result.sources).toEqual([]); expect(h.bodies).toHaveLength(1);
    if (kind === 'missing_usage') expect(h.usage[0]!.estimatedCostUsd).toBeGreaterThanOrEqual(0.03);
  });

  it('takes sources only from matched actual search results, never generated text or an invented citation', () => {
    const value = search(); value.content[3]!.text = 'https://invented.invalid/extra';
    value.content[3]!.citations = [{ type: 'web_search_result_location', url: 'https://invented.invalid/citation' }];
    const result = nativeWebSearchResult([value as never], 3);
    expect(result.sources.map(source => source.url)).toEqual(['https://example.com/forecast']);
    expect(observedAnthropicResponse(value as never)).toMatchObject({ selectedTools: ['web_search'], usage: { webSearchRequests: 1 } });
  });

  it('retains every signed block and fixed prefix across at most three bounded pause continuations', async () => {
    const values = [search('srv_1', 'pause_turn'), search('srv_2', 'pause_turn'), search('srv_3', 'pause_turn'), search('srv_4')];
    const h = client((_body, index) => {
      const value = values[index]!;
      const events: Array<[string, unknown]> = [['message_start', { type: 'message_start', message: { ...value, content: [], stop_reason: null } }]];
      value.content.forEach((block, i) => { events.push(['content_block_start', { type: 'content_block_start', index: i, content_block: block }], ['content_block_stop', { type: 'content_block_stop', index: i }]); });
      events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: value.stop_reason }, usage: value.usage }], ['message_stop', { type: 'message_stop' }]);
      return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    });
    expect((await h.chat.searchWeb({ scopeKey: 'owner', query: 'query' })).status).toBe('results');
    expect(h.bodies).toHaveLength(4);
    for (const body of h.bodies.slice(1)) { expect(body.tools).toEqual(h.bodies[0]!.tools); expect(body.system).toEqual(h.bodies[0]!.system); }
    expect((h.bodies[1]!.messages as Array<unknown>)[1]).toEqual({ role: 'assistant', content: values[0]!.content });
    expect(h.usage).toHaveLength(4);
    const stopped = client(Array.from({ length: 4 }, (_, i) => search(`srv_${i}`, 'pause_turn')));
    expect((await stopped.chat.searchWeb({ scopeKey: 'owner', query: 'query' })).status).toBe('unknown');
    expect(stopped.bodies).toHaveLength(4);
  });

  it('does not retry a 400, missing cache evidence or a cancelled call', async () => {
    const refused = client(() => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'rejected' } }), { status: 400, headers: { 'content-type': 'application/json' } }));
    expect((await refused.chat.searchWeb({ scopeKey: 'owner', query: 'query' })).status).toBe('unknown'); expect(refused.bodies).toHaveLength(1);
    const value = search(); value.usage.cache_read_input_tokens = 0;
    const missing = client([value]); expect((await missing.chat.searchWeb({ scopeKey: 'owner', query: 'query' })).status).toBe('unknown'); expect(missing.usage).toHaveLength(1); expect(missing.bodies).toHaveLength(1);
    const partial = search(); partial.usage.cache_read_input_tokens = 0; partial.usage.server_tool_use = { web_search_requests: 0 };
    const interrupted = client([partial]); expect((await interrupted.chat.searchWeb({ scopeKey: 'owner', query: 'query' })).status).toBe('unknown');
    expect(interrupted.usage[0]!.estimatedCostUsd).toBeGreaterThanOrEqual(1.04);
    const stopped = client([search()]); const controller = new AbortController(); controller.abort();
    await expect(stopped.chat.searchWeb({ scopeKey: 'owner', query: 'query', signal: controller.signal })).rejects.toThrow(); expect(stopped.bodies).toHaveLength(0);
  });

  it('preserves the place schema and the one-time permitted location without native web beside JSON', async () => {
    const h = client([search(), answer()]);
    await h.chat.generate({ ...base, placeSearch: { latitude: 35.4, longitude: 139.6 } });
    expect(JSON.stringify(h.bodies[0]!.messages)).toContain('35.4, 139.6');
    expect((h.bodies[1]!.output_config as { format: { schema: { properties: object } } }).format.schema.properties).toHaveProperty('places');
    expect(h.bodies[1]!.tools).toBeUndefined();
  });

  it('keeps web voice non-JSON, but never speaks an unsuccessful search promise', async () => {
    const good = client([search()]); const heard: string[] = [];
    const response = await good.chat.generateVoiceStreaming({ ...base, useWebSearch: true, conversationClass: 'direct' }, text => { heard.push(text); });
    expect(heard.join('')).toBe(response.reply); expect(response.webSources).toHaveLength(1);
    expect(good.bodies[0]!.output_config).not.toHaveProperty('format');
    const bad = search(); bad.content[3]!.text = '調べます。'; bad.content[2]!.content = { type: 'web_search_tool_result_error', error_code: 'unavailable' };
    const failure = client([bad]); const failedSpeech: string[] = [];
    const failed = await failure.chat.generateVoiceStreaming({ ...base, useWebSearch: true, conversationClass: 'direct' }, text => { failedSpeech.push(text); });
    expect(failed.webSources).toBeUndefined(); expect(failedSpeech.join('')).toBe(failed.reply); expect(failedSpeech.join('')).not.toContain('調べます'); expect(failure.bodies).toHaveLength(1);
  });

  it.each([400, 404, 422, 429])('preserves a safe native voice fallback after a first-request HTTP %i rejection', async status => {
    const rejected = () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'closed refusal' } }), { status, headers: { 'content-type': 'application/json' } });
    const haiku = client([search()]), sonnet = client(rejected, 'claude-sonnet-5-5');
    const model = new TieredChatModel(haiku.chat, sonnet.chat, () => {});
    const result = await model.generateVoice({ ...base, useWebSearch: true, conversationClass: 'direct', tier: 'sonnet' });
    expect(result.servedTier).toBe('luna'); expect(result.webSources).toHaveLength(1);
    expect(sonnet.bodies).toHaveLength(1); expect(haiku.bodies).toHaveLength(1);
    const paused = client((_body, index) => index === 0 ? search('already_sent', 'pause_turn') : rejected(), 'claude-sonnet-5-5');
    const noReplay = client([search()]);
    const closed = await new TieredChatModel(noReplay.chat, paused.chat, () => {}).generateVoice({ ...base, useWebSearch: true, conversationClass: 'direct', tier: 'sonnet' });
    expect(closed.reply).toBe('検索の完了を確認できませんでした。'); expect(noReplay.bodies).toHaveLength(0); expect(paused.bodies).toHaveLength(2);
  });

  it('keeps an exhausted deadline and an in-flight cancellation from starting another paid request', async () => {
    const short = client([search()]); expect((await short.chat.searchWeb({ scopeKey: 'owner', query: 'query', milliseconds: 0 })).status).toBe('unavailable'); expect(short.bodies).toHaveLength(0);
    const controller = new AbortController();
    const cancelled = client(() => { controller.abort(); return search(); });
    await expect(cancelled.chat.searchWeb({ scopeKey: 'owner', query: 'query', signal: controller.signal })).rejects.toThrow();
    expect(cancelled.bodies).toHaveLength(1); expect(cancelled.usage).toHaveLength(1); expect(cancelled.usage[0]!.estimatedCostUsd).toBeGreaterThanOrEqual(0.03);
    let clock = 0;
    const script = scriptedAnthropic(() => { clock = 49_500; return search(); });
    const timed = new AnthropicChatModel({ apiKey: 'test-only', settings, fetch: script.fetcher, clock: () => clock });
    expect((await timed.generate({ ...base, useWebSearch: true })).outOfTime).toBe(true); expect(script.bodies).toHaveLength(1);
  });
});

describe('search is a discoverable conversation read', () => {
  function kernel(h: ReturnType<typeof client>, chosen: string[] | null) {
    return createLocalApiKernel(() => at, { chatModel: h.chat, readTools: { web: h.chat.searchWeb }, turnChooser: { choose: async () => ({ menu: chosen === null ? null : { chosen } }) } });
  }
  const chat = (api: ReturnType<typeof kernel>, extra: object = {}) => api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'weather-test', message: base.message, ...extra } });

  it('recovers a Jev none selection through tool_open, then returns only actual source links', async () => {
    const h = client([requestTool('tool_open', { name: 'web_search' }), requestTool('web_search', { query: '横浜 明日の天気' }), search(), answer()]);
    const result = await chat(kernel(h, []));
    expect(result.status).toBe(200); expect((result.body as { reply: string }).reply).toContain('https://example.com/forecast');
    const tools = h.bodies[0]!.tools as Array<{ name: string; input_schema?: { properties: { name: { enum?: string[] } } } }>;
    expect(tools.map(tool => tool.name)).toEqual(['tool_open', 'tool_call']);
    expect(tools[0]!.input_schema!.properties.name.enum).toBeUndefined();
    const initial = h.bodies[0]!.messages as Array<{ role: string; content: string | Array<{ type: string; tool?: { definition?: { name: string } } }> }>;
    expect(JSON.stringify(initial)).toContain('- web_search: '); // Full discovery now lives after the cached prefix.
    const initialSchemas = initial.flatMap(item => Array.isArray(item.content) ? item.content.flatMap(block =>
      block.type === 'tool_addition' && block.tool?.definition ? [block.tool.definition.name] : []) : []);
    expect(initialSchemas).not.toContain('web_search'); // Jev chose none; the schema is still unavailable until opened.
    expect(h.bodies[1]!.tools).toEqual(h.bodies[0]!.tools);
    expect(h.bodies[1]!.system).toEqual(h.bodies[0]!.system);
    const opened = h.bodies[1]!.messages as Array<unknown>;
    expect(opened.slice(0, initial.length)).toEqual(initial);
    expect(opened.at(-1)).toEqual({ role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_definition',
      definition: expect.objectContaining({ name: 'web_search', strict: true }) } }] });
    expect(h.bodies).toHaveLength(4); // Open, selected call, one actual auxiliary search, then synthesis.
    expect(h.bodies.filter(body => !(body.output_config as object)?.hasOwnProperty('format'))).toHaveLength(1);
  });

  it('repairs an unexecuted selected search once before delivering any promise, preserving signed history', async () => {
    const promise = answer('今から確認します。');
    const h = client([promise, requestTool('web_search', { query: '横浜 明日の天気' }), search(), answer()]);
    const sent: string[] = [];
    const api = kernel(h, ['web_search']);
    const result = await api.dispatch({ method: 'POST', path: '/v1/chat', chatSentences: { write: item => { sent.push(JSON.stringify(item)); } }, body: { scopeKey: 'owner', threadId: 'repair-test', message: base.message, stream: 'sentences' } });
    expect(result.status).toBe(200); expect((result.body as { reply: string }).reply).toContain('検索結果');
    expect(sent.join('')).not.toContain('今から確認');
    expect(h.bodies[1]!.tools).toEqual(h.bodies[0]!.tools); expect(h.bodies[1]!.system).toEqual(h.bodies[0]!.system);
    expect((h.bodies[1]!.messages as Array<{ role: string; content: unknown }>).find(item => item.role === 'assistant')!.content).toEqual([{ ...promise.content[0], citations: null }]);
    expect(h.bodies).toHaveLength(4);
  });

  it('keeps the explicit UI intent and lets the primary form the tool query', async () => {
    const h = client([requestTool('web_search', { query: '横浜 明日の天気' }), search(), answer()]);
    const result = await chat(kernel(h, []), { webSearch: true });
    expect(result.status).toBe(200); expect((h.bodies[0]!.output_config as object)).toHaveProperty('format'); expect(h.bodies).toHaveLength(3);
  });

  it('asks for missing input without claiming a search, and bounds repeated promises to one recovery', async () => {
    const clarification = client([answer('どの地域の天気ですか？', true)]);
    expect(((await chat(kernel(clarification, ['web_search']))).body as { reply: string }).reply).toBe('どの地域の天気ですか？'); expect(clarification.bodies).toHaveLength(1);
    const promises = client([answer('調べます。'), answer('調べます。')]);
    expect(((await chat(kernel(promises, ['web_search']))).body as { reply: string }).reply).toBe('検索は実行されていません。'); expect(promises.bodies).toHaveLength(2);
  });

  it('does not turn a failed read into a model-claimed successful forecast or repeat it', async () => {
    const empty = answer('調べます。'); empty.usage.server_tool_use = { web_search_requests: 0 };
    const h = client([requestTool('web_search', { query: '横浜 天気' }), empty, answer('調べたところ晴れでした。')]);
    const response = await chat(kernel(h, ['web_search']));
    expect((response.body as { reply: string }).reply).toBe('検索は実行されていません。'); expect(h.bodies).toHaveLength(3);
    const ordinary = client([answer('こんにちは。')]);
    await chat(kernel(ordinary, []), { message: 'こんにちは' }); expect(ordinary.bodies).toHaveLength(1);
  });

  it('preserves unrelated structured outputs and actual successful writes when search fails', async () => {
    const final = answer('検索では晴れ。メモも作りました。');
    const dto = JSON.parse(final.content[0]!.text as string);
    dto.threadTitle = '調査とメモ'; dto.threadSummary = '検索を確かめてメモを書く';
    dto.artifacts = [{ name: 'note.txt', mimeType: 'text/plain', content: '買い物', summary: null }];
    final.content[0]!.text = JSON.stringify(dto);
    const empty = answer('調べます。'); empty.usage.server_tool_use = { web_search_requests: 0 };
    const h = client([requestTool('study_create', { kind: 'note', title: '買い物', body: '牛乳を買う' }), requestTool('web_search', { query: '横浜 天気' }), empty, final]);
    const autonomy = createInMemoryAutonomyService(() => at); autonomy.tools.useReads({ web: h.chat.searchWeb });
    const offer = conversationTools(autonomy, 'owner', 'text', true, { audience: { othersKnown: () => false, noteOthers: () => {} } }, 'compound\nweather', new TurnDeadline(TEXT_TURN_DEADLINE), undefined, { reads: { web_search: true } });
    const result = await h.chat.generate({ ...base, message: '買い物メモを作って、明日の天気も調べて', generateThreadTitle: true, requireWebSearch: true, tools: withToolMenu(offer.tools!, ['study_create', 'web_search']) });
    expect(result).toMatchObject({ reply: expect.stringContaining('検索は実行されていません。'), threadTitle: '調査とメモ', threadSummary: '検索を確かめてメモを書く', taskDecision: { disposition: 'none' }, artifacts: [{ name: 'note.txt', content: '買い物' }] });
    expect(result.reply).toContain('実行済み: 書斎に新しいメモか物語を書く');
    expect(result.reply).not.toContain('晴れ'); expect(h.bodies).toHaveLength(4);
  });

  it.each(['invalid', 'secret', 'unknown_secret', 'not_offered'] as const)('keeps a recovered %s search attempt unsuccessful before any external call', async kind => {
    const h = client([requestTool('tool_open', { name: 'web_search' }), requestTool('web_search', kind === 'invalid' ? { query: '' } : { query: 'private query' }), answer('調べたところ晴れです。')]);
    let external = 0;
    const autonomy = createInMemoryAutonomyService(() => at);
    autonomy.tools.useReads({ web: async () => { external++; throw new Error('must not send'); } });
    const offer = conversationTools(autonomy, 'owner', 'text', true, { audience: { othersKnown: () => false, noteOthers: () => {} }, secrets: () => kind === 'unknown_secret' ? null : { carries: () => kind === 'secret' } }, 'attempt\nweather', new TurnDeadline(TEXT_TURN_DEADLINE), undefined, { reads: { web_search: kind !== 'not_offered' } });
    const tools = withToolMenu(offer.tools!, []);
    const reply = await h.chat.generate({ ...base, tools });
    expect(reply.reply).toBe('検索は実行されていません。'); expect(reply.webSources).toBeUndefined(); expect(external).toBe(0);
  });

  it.each(['limit', 'time', 'cut_off'] as const)('does not claim success when a provider search attempt was skipped for %s before the session', async kind => {
    let clock = 0, sent = 0;
    const calls = kind === 'limit' ? [
      { type: 'tool_use', id: 'one', name: 'study_list', input: {} }, { type: 'tool_use', id: 'two', name: 'web_search', input: { query: 'query' } },
    ] : [{ type: 'tool_use', id: 'one', name: 'web_search', input: { query: 'query' } }];
    const h = client((_body, index) => {
      if (index === 0) { if (kind === 'time') clock = 43_500; return message(calls, kind === 'cut_off' ? 'max_tokens' : 'tool_use'); }
      return answer('調べたところ晴れです。');
    });
    const autonomy = createInMemoryAutonomyService(() => at); autonomy.tools.useReads({ web: async () => { sent++; throw new Error('must not send'); } });
    const offer = conversationTools(autonomy, 'owner', 'text', true, { audience: { othersKnown: () => false, noteOthers: () => {} } }, 'skipped\nweather', new TurnDeadline(TEXT_TURN_DEADLINE, () => clock), undefined, { reads: { web_search: true } });
    const tools = withToolMenu(offer.tools!, ['study_list', 'web_search']);
    if (kind === 'limit') Object.defineProperty(tools, 'maximumCalls', { value: 1 });
    const streamed: string[] = [];
    const result = await h.chat.generateStreaming({ ...base, tools }, text => { streamed.push(text); });
    expect(result.reply).toBe('検索は実行されていません。'); expect(result.webSources).toBeUndefined(); expect(sent).toBe(0);
    expect(streamed.join('')).not.toContain('晴れ'); expect(h.bodies).toHaveLength(2);
  });

  it('does not offer the read to other audiences or autonomy and reserves one operation per turn', async () => {
    let calls = 0;
    const operation = async () => { calls++; return { status: 'results' as const, text: 'fact', sources: [{ title: 'source', url: 'https://example.com' }] }; };
    const runner = createInMemoryAutonomyService(() => at).tools; runner.useReads({ web: operation });
    expect(runner.offered('text', 'owner_alone').some(tool => tool.name === 'web.search')).toBe(true);
    expect(runner.offered('text', 'others').some(tool => tool.name === 'web.search')).toBe(false);
    expect(runner.offered('voice', 'owner_alone').some(tool => tool.name === 'web.search')).toBe(false);
    expect(runner.offered('autonomy', 'owner_alone').some(tool => tool.name === 'web.search')).toBe(false);
    const memory = toolSessionMemory(); const executors = readToolExecutors({ web: operation });
    const context = { scopeKey: 'owner', surface: 'text' as const, audience: 'owner_alone' as const, memory, timeMilliseconds: 1234 };
    const first = executors['web.search']!({ query: 'one' }, context), second = executors['web.search']!({ query: 'two' }, context);
    if (!('run' in first) || !('run' in second)) throw new Error('not prepared');
    const results = await Promise.all([first.run(), second.run()]); expect(calls).toBe(1); expect(results.map(item => item.result.ok)).toEqual([true, false]);
    const secret = executors['web.search']!({ query: 'private' }, { ...context, memory: toolSessionMemory(), secrets: { carries: () => true } });
    expect(secret).toMatchObject({ ok: false, failure: 'refused' }); expect(calls).toBe(1);
  });
});
