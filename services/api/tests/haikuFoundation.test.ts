import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { sonnetRoutingAvailable } from '../src/infra/models/anthropic/anthropicConfig.js';
import { anthropicPrices, estimatedAnthropicCostUsd } from '../src/infra/models/claude/claudeUsage.js';
import { configuredResponseModel, DEFAULT_HAIKU_MODEL, isHaikuModel, replacementModel } from '../src/infra/models/anthropic/haikuConfig.js';
import { cacheHaikuRequest, HAIKU_PROTOCOL_PREFIX, validateHaikuCacheUsage } from '../src/infra/models/anthropic/haikuCache.js';
import { claudeBackground, completeStructured, type ClaudeBackground, type StructuredInput } from '../src/infra/models/claude/claudeStructured.js';
import type { LlmUsageEvent } from '../src/infra/models/llmUsage.js';
import { configuredSonnet, configuredSkillProposer } from '../src/wiring/sonnetWiring.js';
import { createConfiguredSkillSleepModels } from '../src/mind/sleep/skillSleepModel.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';

const usage = (creation = 700, read = 0) => ({ input_tokens: 12, output_tokens: 30, cache_creation_input_tokens: creation,
  cache_read_input_tokens: read, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: creation } });
const answer = (creation = 700, read = 0, stop = 'end_turn') => message([{ type: 'text', text: '{"answer":"synthetic"}' }], stop,
  { model: DEFAULT_HAIKU_MODEL, usage: usage(creation, read) });
const INSTRUCTIONS = 'Extract the supplied answer only; keep the original task boundary.';
const SCHEMA = { type: 'object', additionalProperties: false, properties: { answer: { type: 'string', maxLength: 100 } }, required: ['answer'] };
/** One background request through the route (`claudeStructured.ts`), with its booked rows. */
function route(fetcher: typeof fetch, apiKey = 'synthetic') {
  const rows: LlmUsageEvent[] = [];
  const claude = claudeBackground(DEFAULT_HAIKU_MODEL, { apiKey, fetcher, usageStore: { recordLlmUsage: row => { rows.push(row); } } })!;
  return { claude, rows };
}
const ask = (claude: ClaudeBackground, input: StructuredInput = 'short dynamic input', options: Partial<Parameters<typeof completeStructured>[4]> = {}) =>
  completeStructured('person_facts', INSTRUCTIONS, input, SCHEMA, { claude, scopeKey: 'owner', maximumOutputTokens: 300, effort: 'none', ...options });

describe('Haiku credential and model selection', () => {
  it('replaces only Luna or an absent setting and keeps deliberate other models', () => {
    expect(replacementModel()).toBe(DEFAULT_HAIKU_MODEL);
    expect(replacementModel('  ')).toBe(DEFAULT_HAIKU_MODEL);
    expect(replacementModel('gpt-5.6-luna')).toBe(DEFAULT_HAIKU_MODEL);
    expect(replacementModel('gpt-5.6-luna-2026-07-01')).toBe(DEFAULT_HAIKU_MODEL);
    expect(replacementModel('gpt-5.6-terra')).toBe('gpt-5.6-terra');
    expect(replacementModel('explicit-model')).toBe('explicit-model');
    expect(isHaikuModel(DEFAULT_HAIKU_MODEL)).toBe(true);
    expect(isHaikuModel('claude-sonnet-5-5')).toBe(false);
  });
  it('never falls back to an OpenAI credential when Haiku has no key', () => {
    expect(configuredResponseModel({ OPENAI_API_KEY: 'synthetic-openai' }, 'SMALL_MODEL')).toBeNull();
    expect(configuredResponseModel({ SHANNON_ANTHROPIC_API_KEY: ' synthetic-primary ', ANTHROPIC_API_KEY: 'synthetic-secondary' }, 'SMALL_MODEL'))
      .toEqual({ model: DEFAULT_HAIKU_MODEL, apiKey: 'synthetic-primary' });
    expect(configuredResponseModel({ OPENAI_API_KEY: 'synthetic-openai', SMALL_MODEL: 'gpt-5.6-terra' }, 'SMALL_MODEL'))
      .toEqual({ model: 'gpt-5.6-terra', apiKey: 'synthetic-openai' });
    expect(configuredResponseModel({ ANTHROPIC_API_KEY: 'synthetic-anthropic', OPENAI_API_KEY: 'synthetic-openai' }, 'SMALL_MODEL', 'gpt-5.6-terra'))
      .toEqual({ model: 'gpt-5.6-terra', apiKey: 'synthetic-openai' });
  });
  it('prioritizes the Haiku-only key for defaults and legacy settings, with regular-key compatibility', () => {
    const environment = { SHANNON_HAIKU_API_KEY: ' synthetic-haiku-only ', SHANNON_ANTHROPIC_API_KEY: 'synthetic-generic',
      ANTHROPIC_API_KEY: 'synthetic-fallback', OPENAI_API_KEY: 'synthetic-openai', SMALL_MODEL: 'gpt-5.6-luna' };
    expect(configuredResponseModel(environment, 'SMALL_MODEL')).toEqual({ model: DEFAULT_HAIKU_MODEL, apiKey: 'synthetic-haiku-only' });
    expect(configuredResponseModel({ ...environment, SHANNON_HAIKU_API_KEY: ' ' }, 'SMALL_MODEL'))
      .toEqual({ model: DEFAULT_HAIKU_MODEL, apiKey: 'synthetic-generic' });
    expect(configuredResponseModel({ SHANNON_HAIKU_API_KEY: '', ANTHROPIC_API_KEY: 'synthetic-fallback' }, 'SMALL_MODEL'))
      .toEqual({ model: DEFAULT_HAIKU_MODEL, apiKey: 'synthetic-fallback' });
    expect(configuredResponseModel({ ...environment, SMALL_MODEL: 'gpt-5.6-terra' }, 'SMALL_MODEL'))
      .toEqual({ model: 'gpt-5.6-terra', apiKey: 'synthetic-openai' });
  });
  it('uses the Haiku-only key for native cached work without enabling either Sonnet entry', async () => {
    const environment = { SHANNON_HAIKU_API_KEY: 'synthetic-haiku-only', SHANNON_ADR8_STAGE2: 'on',
      SHANNON_SKILLS: 'on', SHANNON_SONNET_ROUTING: 'on' };
    const selected = configuredResponseModel(environment, 'SMALL_MODEL');
    expect(selected).toEqual({ model: DEFAULT_HAIKU_MODEL, apiKey: 'synthetic-haiku-only' });
    const fixture = scriptedAnthropic([answer()]); const headers: Headers[] = [];
    const fetcher = (async (url, init) => { headers.push(new Headers(init?.headers)); return fixture.fetcher(url, init); }) as typeof fetch;
    expect(sonnetRoutingAvailable(environment)).toBe(false);
    expect(configuredSonnet(environment, { fetch: fetcher })).toBeNull();
    expect(configuredSkillProposer(environment, { fetch: fetcher })).toBeNull();
    expect(fixture.bodies).toHaveLength(0);
    await expect(ask(route(fetcher, selected!.apiKey).claude)).resolves.toEqual({ ok: true, value: { answer: 'synthetic' } });
    expect(headers[0]!.get('x-api-key')).toBe('synthetic-haiku-only');
    expect(fixture.bodies).toHaveLength(1);
    expect(fixture.bodies[0]).toMatchObject({ model: DEFAULT_HAIKU_MODEL });
    expect((fixture.bodies[0]!.system as Array<{ cache_control?: unknown }>)[0]).toMatchObject({ cache_control: { ttl: '1h' } });
    expect(fixture.bodies[0]).not.toHaveProperty('cache_control');
  });
  it('preserves the existing Terra sleep proposer when only a Haiku key is added, with Sonnet routing on or off', () => {
    for (const routing of ['on', 'off']) {
      const environment = { SHANNON_HAIKU_API_KEY: 'synthetic-haiku-only', OPENAI_API_KEY: 'synthetic-openai',
        SHANNON_ADR8_STAGE2: 'on', SHANNON_SKILLS: 'on', SHANNON_SONNET_ROUTING: routing };
      const models = createConfiguredSkillSleepModels(environment, undefined, () => configuredSkillProposer(environment, {}));
      expect(models.maintainer?.model).toBe('gpt-5.6-terra');
      expect(models.proposer?.model).toBe('gpt-5.6-terra');
      expect(configuredSonnet(environment, {})).toBeNull();
    }
    const compatibility = { SHANNON_ANTHROPIC_API_KEY: 'synthetic-generic', SHANNON_ADR8_STAGE2: 'on', SHANNON_SKILLS: 'on', SHANNON_SONNET_ROUTING: 'on' };
    expect(configuredSonnet(compatibility, {})?.model).toBe('claude-sonnet-5-5');
    expect(configuredSkillProposer(compatibility, {})?.model).toBe('claude-sonnet-5-5');
  });
});

describe('Haiku mandatory prefix caching', () => {
  const body = (): Anthropic.MessageCreateParamsNonStreaming => ({ model: DEFAULT_HAIKU_MODEL, max_tokens: 1_024,
    system: 'Authoritative original task instructions.', messages: [{ role: 'user', content: 'one short input' }] });
  it('caches useful stable protocol before unchanged task authority and variable input without mutating either', () => {
    const original = body(); const before = JSON.stringify(original);
    const first = cacheHaikuRequest(original);
    const second = cacheHaikuRequest({ ...body(), messages: [{ role: 'user', content: 'another short input' }] });
    expect(JSON.stringify(original)).toBe(before);
    expect(first.system).toEqual(second.system);
    expect(first.system).toEqual([{ type: 'text', text: HAIKU_PROTOCOL_PREFIX, cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'Authoritative original task instructions.' }]);
    expect(HAIKU_PROTOCOL_PREFIX.split(/\s+/u).length).toBeGreaterThan(600); // real tokenizer/countTokens remains a live gate
    expect(first.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(first.messages).not.toEqual(second.messages);
    expect(cacheHaikuRequest(first)).toBe(first);
  });
  it('preserves data/schema properties named cache_control and refuses actual conflicting TTLs or excess breakpoints', () => {
    const tool: Anthropic.Tool = { name: 'synthetic', input_schema: { type: 'object', properties: { cache_control: { type: 'string' } } } };
    expect(cacheHaikuRequest({ ...body(), tools: [tool] }).tools).toEqual([tool]);
    const markers = Array.from({ length: 3 }, () => ({ type: 'text' as const, text: 'static', cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } }));
    expect(() => cacheHaikuRequest({ ...body(), system: markers })).toThrow('HAIKU_CACHE_BREAKPOINT_LIMIT');
    expect(() => cacheHaikuRequest({ ...body(), system: [{ type: 'text', text: 'static', cache_control: { type: 'ephemeral' } }] })).toThrow('HAIKU_CACHE_TTL_CONFLICT');
    const other = { ...body(), model: 'claude-sonnet-5' };
    expect(cacheHaikuRequest(other)).toBe(other);
  });
  it('shares mandatory one-hour caching with owner-selectable Sonnet 5.5, preserving the original task and idempotency', () => {
    const original = { ...body(), model: 'claude-sonnet-5-5' };
    const before = JSON.stringify(original);
    const cached = cacheHaikuRequest(original);
    expect(JSON.stringify(original)).toBe(before);
    expect(cached.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(cached.system).toEqual([{ type: 'text', text: HAIKU_PROTOCOL_PREFIX, cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: original.system }]);
    expect(cacheHaikuRequest(cached)).toBe(cached);
    expect(estimatedAnthropicCostUsd(original.model, { input: 0, cacheWrite: 1_000_000, cacheRead: 0, output: 0, searches: 0 })).toBe(4);
    expect(anthropicPrices(original.model, 100_001).cacheRead).toBe(0.2);
    expect(anthropicPrices('claude-sonnet-5', 100_001).cacheRead).toBe(0.2);
  });
  it('requires actual positive native cache usage, including consistent mixed TTL accounting', () => {
    expect(() => validateHaikuCacheUsage(usage())).not.toThrow();
    expect(() => validateHaikuCacheUsage(usage(0, 700))).not.toThrow();
    expect(() => validateHaikuCacheUsage(usage(0, 0))).toThrow('HAIKU_CACHE_UNCONFIRMED');
    expect(() => validateHaikuCacheUsage({ cache_creation_input_tokens: 2 })).toThrow('HAIKU_CACHE_USAGE_INVALID');
    expect(() => validateHaikuCacheUsage({ ...usage(), cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 300 } })).not.toThrow();
    expect(() => validateHaikuCacheUsage({ ...usage(), cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 699 } })).toThrow('HAIKU_CACHE_USAGE_INVALID');
  });
});

describe('the background route (ADR-0009 stage 1, M8: completeStructured)', () => {
  it('uses the official native endpoint/SDK and a stable cache request, booking cache writes then reads', async () => {
    const fixture = scriptedAnthropic([answer(), answer(0, 700)]); const urls: string[] = []; const headers: Headers[] = [];
    const transport = (async (url, init) => { urls.push(String(url)); headers.push(new Headers(init?.headers)); return fixture.fetcher(url, init); }) as typeof fetch;
    const { claude, rows } = route(transport, 'synthetic-anthropic');
    await expect(ask(claude)).resolves.toEqual({ ok: true, value: { answer: 'synthetic' } });
    await ask(claude, 'other dynamic input');
    expect(urls).toEqual(['https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/messages']);
    expect(headers[0]!.get('x-api-key')).toBe('synthetic-anthropic');
    expect(headers[0]!.get('authorization')).toBeNull();
    expect(headers[0]!.get('anthropic-version')).toBe('2023-06-01');
    expect(rows).toMatchObject([{ lane: 'memory_background', inputTokens: 712, cachedInputTokens: 0, outputTokens: 30, totalTokens: 742, estimatedCostUsd: 0.0001562 },
      { inputTokens: 712, cachedInputTokens: 700 }]);
    expect(fixture.bodies[0]!.system).toEqual(fixture.bodies[1]!.system);
    expect(fixture.bodies[0]!).toMatchObject({ max_tokens: 1_024, thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
    for (const key of ['cache_control', 'temperature', 'reasoning', 'store']) expect(fixture.bodies[0]!).not.toHaveProperty(key);
  });
  it('retains history and native image blocks, and converts the existing schema subset', async () => {
    const fixture = scriptedAnthropic([answer()]);
    const input: Anthropic.MessageParam[] = [{ role: 'user', content: 'prior user input' }, { role: 'assistant', content: 'prior reply' }, { role: 'user', content: [
      { type: 'text', text: 'Describe this synthetic input.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
      { type: 'image', source: { type: 'url', url: 'https://images.example.test/synthetic.png' } },
    ] }];
    const original = JSON.stringify(input);
    await ask(route(fixture.fetcher).claude, input);
    expect(JSON.stringify(input)).toBe(original);
    expect(fixture.bodies[0]!.messages).toEqual(JSON.parse(original));
    expect(fixture.bodies[0]!.output_config).toMatchObject({ format: { type: 'json_schema', schema: { properties: {
      answer: { type: 'string', description: '（100字まで）' },
    } } } });
  });
  it('treats a background history ending in assistant as input without native assistant prefill', async () => {
    const fixture = scriptedAnthropic([answer()]);
    await ask(route(fixture.fetcher).claude, [{ role: 'user', content: 'original' }, { role: 'assistant', content: 'reply to extract' }]);
    const messages = fixture.bodies[0]!.messages as Array<Record<string, unknown>>;
    expect(messages.slice(0, 2)).toEqual([{ role: 'user', content: 'original' }, { role: 'assistant', content: 'reply to extract' }]);
    expect(messages.at(-1)).toEqual({ role: 'user', content: '[Apply the current application task instructions to the input above and return the required result.]' });
  });
  it.each(['end_turn', 'refusal', 'max_tokens'])('books paid usage before rejecting %s with missing cache or a nonterminal answer', async stop => {
    const fixture = scriptedAnthropic([answer(stop === 'end_turn' ? 0 : 700, 0, stop)]);
    const { claude, rows } = route(fixture.fetcher);
    await expect(ask(claude)).rejects.toThrow(stop === 'end_turn' ? 'HAIKU_CACHE_UNCONFIRMED' : stop === 'refusal' ? 'HAIKU_RESPONSE_REFUSAL' : 'HAIKU_RESPONSE_INCOMPLETE');
    expect(rows).toMatchObject([{ outputTokens: 30, inputTokens: stop === 'end_turn' ? 12 : 712 }]);
  });
  it('keeps known native input/cache counts when output is absent and books the bound of the reported input', async () => {
    const malformed = answer(0, 700); delete (malformed.usage as Record<string, unknown>).output_tokens;
    const fixture = scriptedAnthropic([malformed]);
    const { claude, rows } = route(fixture.fetcher);
    await expect(ask(claude)).rejects.toThrow('HAIKU_RESPONSE_USAGE_INVALID');
    // The bound prices the input counts that were reported and the whole output ceiling (ADR-0009 stage 1, M4 review; was 1.00256).
    expect(rows).toMatchObject([{ inputTokens: 712, cachedInputTokens: 700, estimatedCostUsd: 0.0005202 }]);
    expect(fixture.bodies).toHaveLength(1);
  });
  it('books known cache tokens and a conservative bound for missing input or all native usage', async () => {
    const partial = answer(0, 700); delete (partial.usage as Record<string, unknown>).input_tokens;
    const absent = answer(); delete (absent as Record<string, unknown>).usage;
    const fixture = scriptedAnthropic([partial, absent]);
    const { claude, rows } = route(fixture.fetcher);
    // Without the uncached input count the input is unknown: the full-context bound stays.
    await expect(ask(claude)).rejects.toThrow('HAIKU_RESPONSE_USAGE_INVALID');
    await expect(ask(claude, 'other', { maximumOutputTokens: 2_000 })).rejects.toThrow('HAIKU_CACHE_USAGE_INVALID');
    expect(rows).toMatchObject([{ inputTokens: 700, cachedInputTokens: 700, estimatedCostUsd: 1.00256 }, { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 1.005 }]);
    expect(fixture.bodies).toHaveLength(2);
  });
  it('an FCA-accounted call refuses an unknown bill before anything else, after booking it', async () => {
    const malformed = answer(0, 0); delete (malformed.usage as Record<string, unknown>).output_tokens;
    const fixture = scriptedAnthropic([malformed]);
    const { claude, rows } = route(fixture.fetcher);
    let booked = 0;
    await expect(ask(claude, 'input', { requireUsage: true, onBooked: () => { booked++; } })).rejects.toThrow('BACKGROUND_MODEL_USAGE_UNKNOWN');
    expect([rows.length, booked]).toEqual([1, 1]);
  });
  it('returns an HTTP rejection with its status, books nothing and makes no SDK retry', async () => {
    const fixture = scriptedAnthropic(() => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'synthetic' } }),
      { status: 429, headers: { 'content-type': 'application/json' } }));
    const { claude, rows } = route(fixture.fetcher);
    await expect(ask(claude)).resolves.toMatchObject({ ok: false, status: 429 });
    expect(fixture.bodies).toHaveLength(1);
    expect(rows).toEqual([]);
  });
  it('honors pre-dispatch and in-flight AbortSignal with the original reason and one dispatch at most', async () => {
    const controller = new AbortController(); const reason = new Error('synthetic-stop'); let calls = 0;
    const pre = route((async () => { calls++; throw new Error('unexpected'); }) as typeof fetch).claude;
    controller.abort(reason);
    await expect(ask(pre, 'input', { signal: controller.signal })).rejects.toBe(reason);
    expect(calls).toBe(0);
    const inFlight = new AbortController(); let began!: () => void; const dispatched = new Promise<void>(resolve => { began = resolve; });
    const claude = route((async (_url, init) => {
      calls++; began(); return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
    }) as typeof fetch).claude;
    const pending = ask(claude, 'input', { signal: inFlight.signal });
    await dispatched; inFlight.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(calls).toBe(1);
  });
  it('is only for Claude: another model keeps its own provider, and a native credential is never routed to the OpenAI endpoint', () => {
    expect(claudeBackground('gpt-5.6-terra', { apiKey: 'synthetic' })).toBeNull();
    expect(() => claudeBackground(DEFAULT_HAIKU_MODEL, { apiKey: 'synthetic', endpoint: 'https://api.openai.com/v1/responses' })).toThrow('HAIKU_ENDPOINT_INVALID');
    expect(() => claudeBackground(DEFAULT_HAIKU_MODEL, { apiKey: ' ' })).toThrow('ANTHROPIC_API_KEY_REQUIRED');
  });
});

describe('Haiku exact usage pricing', () => {
  it('prices cache TTL separately and applies the >100k tier to both input and output', () => {
    const counts = { input: 12, cacheWrite: 700, cacheRead: 0, output: 30, searches: 0, cacheWrite5m: 0, cacheWrite1h: 700 };
    expect(estimatedAnthropicCostUsd(DEFAULT_HAIKU_MODEL, counts)).toBe(0.0001562);
    expect(estimatedAnthropicCostUsd(DEFAULT_HAIKU_MODEL, { ...counts, cacheWrite5m: 700, cacheWrite1h: 0 })).toBe(0.0001037);
    expect(anthropicPrices(DEFAULT_HAIKU_MODEL, 100_000).input).toBe(0.1);
    expect(anthropicPrices(DEFAULT_HAIKU_MODEL, 100_001).input).toBe(0.5);
    expect(estimatedAnthropicCostUsd(DEFAULT_HAIKU_MODEL, { ...counts, input: 100_000 })).toBe(0.050775);
    const { cacheWrite5m: _five, cacheWrite1h: _hour, ...withoutTTL } = counts;
    expect(estimatedAnthropicCostUsd(DEFAULT_HAIKU_MODEL, withoutTTL)).toBe(0.0001562);
  });
});

describe('background one-shot calls (ADR-0009 stage 1, quick fixes 4 and 5)', () => {
  it('passes the caller\'s effort through on the native scale instead of forcing low', async () => {
    const efforts = ['none', 'minimal', 'low', 'medium', 'high'] as const;
    const fixture = scriptedAnthropic(efforts.map(() => answer()));
    const { claude } = route(fixture.fetcher);
    for (const effort of efforts) await ask(claude, 'input', { effort });
    const sent = fixture.bodies.map(body => (body.output_config as { effort?: string }).effort);
    expect(sent).toEqual(['low', 'low', 'low', 'medium', 'high']);
  });

  it('caches only the fixed protocol prefix: no automatic marker on the unique task tail', async () => {
    const fixture = scriptedAnthropic([answer()]);
    // The prefix alone still gives the provider receipt the cache-evidence rule requires.
    await expect(ask(route(fixture.fetcher).claude)).resolves.toMatchObject({ ok: true });
    const body = fixture.bodies[0]!;
    expect(body).not.toHaveProperty('cache_control');
    expect(body.system).toEqual([{ type: 'text', text: HAIKU_PROTOCOL_PREFIX, cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: INSTRUCTIONS }]);
  });
});
