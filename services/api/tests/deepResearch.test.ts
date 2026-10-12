import { describe, expect, it } from 'vitest';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { nativeWebSearchBody, nativeWebSearchResult } from '../src/infra/models/anthropic/anthropicWebSearch.js';
import { nativeWebReadBody, nativeWebReadResult } from '../src/infra/models/anthropic/anthropicWebRead.js';
import { settledServerSearchUsage, serverSearchCacheStart } from '../src/infra/models/anthropic/haikuCache.js';
import { mergedWebResults, webReadUrl } from '../src/infra/models/webResearch.js';
import { readToolExecutors } from '../src/mind/tools/shannonReadTools.js';
import { webReadResult, webReadUnknown } from '../src/mind/tools/webResearchTools.js';
import { toolSessionMemory, type ToolExecutionContext } from '../src/mind/tools/shannonToolTypes.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { researchAdmitted, researchTaskInput } from '../src/mind/action/fca/conversationWork.js';
import { RESEARCH_REPORT_FORMAT } from '../src/mind/action/fca/researchReport.js';
import { toolOk } from '../src/mind/tools/shannonTools.js';
import type { WebSearchInput, WebSearchResult } from '../src/infra/models/webSearch.js';
import type { WebReadInput } from '../src/infra/models/webResearch.js';
import type { LlmUsageEvent } from '../src/infra/models/llmUsage.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';

const at = '2026-10-13T00:00:00.000Z';
const PAGE = 'https://www.city.fukuoka.lg.jp/notice/1.html';

function fetched(id = 'srv_f1', options: { error?: string; requests?: number } = {}) {
  const value = message([
    { type: 'server_tool_use', id, name: 'web_fetch', input: { url: PAGE } },
    { type: 'web_fetch_tool_result', tool_use_id: id, content: options.error ? { type: 'web_fetch_tool_result_error', error_code: options.error }
      : { type: 'web_fetch_result', url: PAGE, retrieved_at: at,
        content: { type: 'document', title: '市からのお知らせ', source: { type: 'text', media_type: 'text/plain', data: '本文' }, citations: { enabled: true } } } },
    { type: 'text', text: '結論: 受付は10月20日まで。' },
    { type: 'text', text: '受付期間', citations: [{ type: 'char_location', document_index: 0, document_title: '市からのお知らせ', start_char_index: 0,
      end_char_index: 12, cited_text: '受付は10月20日（月）まで', file_id: null }] },
  ], 'end_turn');
  value.usage.server_tool_use = { web_search_requests: 0, web_fetch_requests: options.requests ?? 1 };
  return value;
}

const ok = (text = 'fact'): WebSearchResult => ({ status: 'results', text, sources: [{ title: 'source', url: 'https://example.com/a' }] });
const context = (memory = toolSessionMemory(), extra: Partial<ToolExecutionContext> = {}): ToolExecutionContext =>
  ({ scopeKey: 'owner', surface: 'text', audience: 'owner_alone', memory, timeMilliseconds: 20_000, ...extra });
async function run(call: unknown) {
  if (!call || typeof call !== 'object' || !('run' in call)) return { result: call as { ok: boolean; failure?: string; text: string } };
  return (call as { run(): Promise<{ result: { ok: boolean; failure?: string; text: string } }> }).run();
}

describe('deep research: native search narrowing', () => {
  it('keeps the unfiltered request exactly as before and adds domains, Fukuoka location and a recency hint only when asked', () => {
    const plain = nativeWebSearchBody('福岡 天気', 3);
    expect(plain.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 3, allowed_callers: ['direct'] }]);
    expect(plain.messages).toEqual([{ role: 'user', content: '福岡 天気' }]);
    const narrowed = nativeWebSearchBody('福岡 天気', 3, { allowedDomains: ['jma.go.jp', 'https://bad/path', '127.0.0.1'], blockedDomains: ['example.com'],
      locality: 'fukuoka', recency: 'week' });
    expect(narrowed.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 3, allowed_callers: ['direct'], allowed_domains: ['jma.go.jp'],
      user_location: { type: 'approximate', city: 'Fukuoka', region: 'Fukuoka', country: 'JP', timezone: 'Asia/Tokyo' } }]);
    expect(String(narrowed.messages[0]!.content)).toContain('直近1週間以内');
  });

  it('keeps only spans cited from actual results, with their URL', () => {
    const value = message([
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } },
      { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', title: 'A', url: 'https://example.com/a', encrypted_content: 'e', page_age: null }] },
      { type: 'text', text: '答え', citations: [
        { type: 'web_search_result_location', url: 'https://example.com/a', title: 'A', encrypted_index: 'i', cited_text: '本当の一節' },
        { type: 'web_search_result_location', url: 'https://invented.invalid/x', title: 'X', encrypted_index: 'i', cited_text: '作られた一節' }] },
    ], 'end_turn');
    value.usage.server_tool_use = { web_search_requests: 1, web_fetch_requests: 0 };
    expect(nativeWebSearchResult([value as never], 3).passages).toEqual([{ url: 'https://example.com/a', title: 'A', quote: '本当の一節' }]);
  });
});

describe('deep research: full-page read with the native fetch tool', () => {
  it('bounds the fetch: two pages at most, a content-token cap, citations on, and only public http(s) URLs', () => {
    expect(nativeWebReadBody(PAGE, '締切').tools).toEqual([{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 2, allowed_callers: ['direct'],
      max_content_tokens: 12_000, citations: { enabled: true } }]);
    expect(['javascript:x', 'http://127.0.0.1/a', 'https://user:pw@example.com/', 'file:///etc/passwd', 'https://localhost/'].map(webReadUrl)).toEqual([null, null, null, null, null]);
    expect(webReadUrl(PAGE)).toBe(PAGE);
  });

  it('returns the page as the source and the cited span; disagreeing receipts are unknown and a provider error is a known miss', () => {
    expect(nativeWebReadResult([fetched() as never])).toMatchObject({ status: 'results', sources: [{ title: '市からのお知らせ', url: PAGE }],
      passages: [{ url: PAGE, title: '市からのお知らせ', quote: '受付は10月20日（月）まで' }] });
    expect(nativeWebReadResult([fetched('srv_f1', { requests: 2 }) as never]).status).toBe('unknown');
    expect(nativeWebReadResult([fetched('srv_f1', { error: 'url_not_accessible' }) as never]).status).toBe('empty');
  });

  it('reads through the chat model transport and books its usage; the fetch results settle as a server-tool cache write', async () => {
    const { fetcher, bodies } = scriptedAnthropic([fetched()]);
    const usage: LlmUsageEvent[] = [];
    const chat = new AnthropicChatModel({ apiKey: 'test-only', settings: { model: 'claude-haiku-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' },
      fetch: fetcher, usageStore: { recordLlmUsage: event => { usage.push(event); }, backgroundLlmCostUsd: () => 0 } });
    const read = await chat.readWeb({ scopeKey: 'owner', url: PAGE, focus: '締切' });
    expect(read.status).toBe('results');
    expect(bodies).toHaveLength(1); expect(bodies[0]).toMatchObject({ model: 'claude-haiku-5-5', stream: true });
    expect(usage).toHaveLength(1);
    expect((await chat.readWeb({ scopeKey: 'owner', url: 'ftp://example.com/x' })).status).toBe('not_searched');
    expect(bodies).toHaveLength(1);
    const start = { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 } };
    const final = fetched();
    final.usage = { ...final.usage, ...start, output_tokens: 50, cache_creation_input_tokens: 400 } as never;
    const settled = settledServerSearchUsage(final as never, serverSearchCacheStart(start as never), undefined);
    expect(settled.usage.cache_creation).toEqual({ ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 100 });
  });
});

describe('deep research: read tools per reply and per task step', () => {
  it('passes the narrowing through, allows three searches and two page reads a reply, and more inside a task step', async () => {
    const searches: WebSearchInput[] = [], reads: WebReadInput[] = [];
    const executors = readToolExecutors({ web: async input => { searches.push(input); return ok(input.query); },
      webRead: async input => { reads.push(input); return { ...ok('page'), passages: [{ url: input.url, title: 'p', quote: '一節' }] }; } });
    const memory = toolSessionMemory();
    const first = await run(executors['web.search']!({ query: '天神 イベント', domains: 'fukuoka-now.com, bad domain', locality: 'fukuoka', recency: 'week' }, context(memory)));
    expect(first.result.ok).toBe(true);
    expect(searches[0]).toMatchObject({ query: '天神 イベント', maxUses: 3, filters: { allowedDomains: ['fukuoka-now.com'], locality: 'fukuoka', recency: 'week' } });
    for (const query of ['b', 'c']) expect((await run(executors['web.search']!({ query }, context(memory)))).result.ok).toBe(true);
    expect((await run(executors['web.search']!({ query: 'd' }, context(memory)))).result.failure).toBe('limit');
    expect(searches.at(-1)!.filters).toBeUndefined();
    const page = await run(executors['web.read']!({ url: PAGE, focus: '締切' }, context(memory)));
    expect(page.result.ok).toBe(true); expect(page.result.text).toContain('[Web page read'); expect(page.result.text).toContain('一節');
    expect((await run(executors['web.read']!({ url: PAGE }, context(memory)))).result.ok).toBe(true);
    expect((await run(executors['web.read']!({ url: PAGE }, context(memory)))).result.failure).toBe('limit');
    expect(webReadResult(memory)).toMatchObject({ status: 'results', passages: [{ url: PAGE, quote: '一節' }] });
    expect((await run(executors['web.read']!({ url: 'not a url' }, context()))).result.failure).toBe('invalid_input');
    expect((await run(executors['web.read']!({ url: PAGE }, context(toolSessionMemory(), { secrets: { carries: () => true } })))).result.failure).toBe('refused');
    const step = toolSessionMemory();
    const outcomes = [];
    for (let index = 0; index < 7; index++) outcomes.push((await run(executors['web.search']!({ query: `q${index}` }, context(step, { acknowledgementOwner: 'fca' })))).result.ok);
    expect(outcomes).toEqual([true, true, true, true, true, true, false]);
  });

  it('keeps an unfinished read unknown, while the reply still has what other reads found', async () => {
    let release!: (value: WebSearchResult) => void;
    const executors = readToolExecutors({ web: input => input.query === 'slow' ? new Promise(resolve => { release = resolve; }) : Promise.resolve(ok()) });
    const memory = toolSessionMemory();
    await run(executors['web.search']!({ query: 'fast' }, context(memory)));
    const pending = run(executors['web.search']!({ query: 'slow' }, context(memory)));
    expect(webReadUnknown(memory)).toBe(true); expect(webReadResult(memory)?.status).toBe('results');
    release(ok('late')); await pending;
    expect(webReadUnknown(memory)).toBe(false);
    expect(mergedWebResults([{ status: 'empty', text: 'none', sources: [] }])?.status).toBe('empty');
  });

  it('offers the page read only with its port, and the voice research hand-off only while a task runtime is bound', () => {
    const runner = createInMemoryAutonomyService(() => at).tools;
    runner.useReads({ web: async () => ok() });
    expect(runner.offered('text', 'owner_alone').some(tool => tool.name === 'web.read')).toBe(false);
    runner.useReads({ web: async () => ok(), webRead: async () => ok() });
    expect(runner.offered('text', 'owner_alone').some(tool => tool.name === 'web.read')).toBe(true);
    expect(runner.offered('voice', 'owner_alone', 'owner').some(tool => tool.name === 'web.research')).toBe(false);
    runner.useTaskRuntime({ available: () => true, execute: () => toolOk('{}') });
    expect(runner.offered('voice', 'owner_alone', 'owner').some(tool => tool.name === 'web.research')).toBe(true);
    expect(runner.offered('text', 'owner_alone', 'owner').some(tool => tool.name === 'web.research')).toBe(false);
    expect(runner.offered('voice', 'others', 'owner').some(tool => tool.name === 'web.research')).toBe(false);
  });
});

describe('deep research: a call hands research to a task that reports in Markdown', () => {
  it('turns web.research into the conversation-work task, with the answer-first report format, and tells the call it is admitted, not answered', () => {
    const task = researchTaskInput('web.research', { question: '今週末の福岡の天気' })!;
    expect(task.name).toBe('task.create');
    expect(task.input).toMatchObject({ title: '今週末の福岡の天気', goal: '今週末の福岡の天気' });
    expect(task.input.context).toContain('[Conversation work]'); expect(task.input.context).toContain(RESEARCH_REPORT_FORMAT);
    expect(task.input.context).toContain('web.read');
    expect(RESEARCH_REPORT_FORMAT).toMatch(/## 結論[\s\S]*## わかったこと[\s\S]*## 未確認・注意/u);
    expect(researchTaskInput('task.create', { question: 'x' })).toBeNull();
    expect(researchTaskInput('web.research', { question: ' ' })).toBeNull();
    const admitted = researchAdmitted(toolOk(JSON.stringify({ id: 'task-1', phase: 'ready' })));
    expect(admitted.ok).toBe(true); expect(admitted.text).toContain('task-1'); expect(admitted.text).toContain('まだ結果はない');
  });
});
