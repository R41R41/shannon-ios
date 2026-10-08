import { describe, expect, it, vi } from 'vitest';
import { inActionExecution, type ActionExecution } from '../src/infra/context/actionExecution.js';
import { DEFAULT_HAIKU_MODEL } from '../src/infra/models/anthropic/haikuConfig.js';
import { AUTONOMY_MODELS, autonomyModel, autonomyModelChoices, autonomyModelCostUsd, configuredAutonomyModelPrices } from '../src/mind/action/ownTime/autonomyModels.js';
import { callModel, generateModel, paidCall } from '../src/mind/action/ownTime/autonomyLoopCalls.js';
import { AutonomyModelError, configuredAutonomyTextModel, dedicatedAutonomyCredential, resolveAutonomyModel, type AutonomyTextRequest } from '../src/mind/action/ownTime/autonomyTextModel.js';
import { loopHarness, scope } from './autonomyLoopHarness.js';

const key = { SHANNON_AUTONOMY_ANTHROPIC_API_KEY: 'dedicated-autonomy-anthropic' };
const request: AutonomyTextRequest = { model: DEFAULT_HAIKU_MODEL, system: 'ひとりで計画を立てます。JSONで返してください。', prompt: '今できることを考えてください。', maximumOutputTokens: 800, reasoning: 'low' };
function execution(permit = async () => true): ActionExecution {
  return { lease: { id: 'original-action', generation: 1, holder: 'original-holder' }, signal: new AbortController().signal, permit };
}
function native(usage: Record<string, unknown> = {}, options: { stop?: string; content?: unknown[] } = {}) {
  return Response.json({ id: 'msg-fixture', type: 'message', role: 'assistant', model: DEFAULT_HAIKU_MODEL,
    content: options.content ?? [{ type: 'text', text: '{"steps":[]}' }], stop_reason: options.stop ?? 'end_turn', stop_sequence: null,
    usage: { input_tokens: 40, output_tokens: 90, cache_creation_input_tokens: 600, cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 600 }, ...usage },
  });
}
function mockFetch(responder: (init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return responder(init);
  }) as typeof fetch;
  return { fetcher, calls };
}

describe('Haiku own-time selection and credential separation', () => {
  it('resolves stored Luna choices without changing their metadata or stored values', () => {
    const preferences = [{ purpose: 'planning', modelId: 'gpt-5.6-luna-2026-09-25', reason: '計画を考えたい', updatedAt: '2026-10-02T01:00:00Z' }];
    const original = structuredClone(preferences);
    expect(resolveAutonomyModel('planning', preferences, () => true)).toBe(DEFAULT_HAIKU_MODEL);
    expect(autonomyModelChoices(preferences).find(choice => choice.purpose === 'planning')).toMatchObject({ modelId: DEFAULT_HAIKU_MODEL, chosenBy: 'shannon', reason: preferences[0]!.reason, updatedAt: preferences[0]!.updatedAt });
    expect(preferences).toEqual(original);
    expect(autonomyModel('gpt-5.6-luna')?.provider).toBe('anthropic');
    expect(autonomyModel('')).toBeNull();
    expect(autonomyModel('other')).toBeNull();
    expect(AUTONOMY_MODELS.filter(model => model.provider !== 'anthropic').map(model => model.id)).toEqual(['gemini-3.8-flash', 'gpt-5.6-terra', 'gpt-5.6-sol']);
  });

  it('falls back to another allowed dedicated provider when Haiku has no key', () => {
    const router = configuredAutonomyTextModel({ SHANNON_AUTONOMY_OPENAI_API_KEY: 'dedicated-openai' });
    expect(router.canUse(DEFAULT_HAIKU_MODEL)).toBe(false);
    expect(resolveAutonomyModel('planning', [{ purpose: 'planning', modelId: 'gpt-5.6-luna' }], id => router.canUse(id))).toBe('gpt-5.6-terra');
    expect(resolveAutonomyModel('research_reading', [], id => router.canUse(id))).toBeNull();
  });

  it.each(['SHANNON_HAIKU_API_KEY', 'SHANNON_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'])('refuses a duplicate %s, including whitespace', variable => {
    expect(dedicatedAutonomyCredential('anthropic', { [variable]: ' same ', SHANNON_AUTONOMY_ANTHROPIC_API_KEY: 'same' })).toBeNull();
    expect(configuredAutonomyTextModel({ [variable]: 'conversation' }).configuredProviders).toEqual([]);
    expect(dedicatedAutonomyCredential('anthropic', { [variable]: 'conversation', ...key })).toBe(key.SHANNON_AUTONOMY_ANTHROPIC_API_KEY);
  });
});

describe('native own-time Messages and closed usage', () => {
  it('uses the official SDK with only its dedicated key, native cache and bounded thinking/output', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'unrelated-bearer');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://unrelated.invalid');
    try {
      const mock = mockFetch(() => native());
      const router = configuredAutonomyTextModel({ ...key, SHANNON_HAIKU_API_KEY: 'regular-haiku', ANTHROPIC_API_KEY: 'conversation', SHANNON_ANTHROPIC_API_KEY: 'other-conversation' }, mock.fetcher);
      const result = await router.generate({ ...request, model: 'gpt-5.6-luna' });
      expect(result).toEqual({ text: '{"steps":[]}', usage: { inputTokens: 640, outputTokens: 90, cacheCreationInputTokens: 600, cachedInputTokens: 0, cacheCreation5mInputTokens: 0, cacheCreation1hInputTokens: 600 } });
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
      const headers = new Headers(mock.calls[0]!.init.headers);
      expect(headers.get('x-api-key')).toBe(key.SHANNON_AUTONOMY_ANTHROPIC_API_KEY);
      expect(headers.has('authorization')).toBe(false);
      const body = JSON.parse(mock.calls[0]!.init.body as string);
      expect(body).toMatchObject({ model: DEFAULT_HAIKU_MODEL, max_tokens: 800, thinking: { type: 'adaptive' }, output_config: { effort: 'low' }, cache_control: { type: 'ephemeral', ttl: '1h' } });
      expect(body.system.some((block: { cache_control?: unknown }) => !!block.cache_control)).toBe(true);
      expect(body.messages[0].content).toContain(request.prompt);
      expect(router.configuredProviders).toEqual(['anthropic']);
    } finally { vi.unstubAllEnvs(); }
  });

  it('reports cache reads and thinking output without exposing thinking text', async () => {
    const mock = mockFetch(() => native({ cache_creation_input_tokens: 0, cache_read_input_tokens: 600, cache_creation: null }, { content: [{ type: 'thinking', thinking: 'private', signature: 'sig' }, { type: 'text', text: '{"steps":[]}' }] }));
    expect(await configuredAutonomyTextModel(key, mock.fetcher).generate(request)).toEqual({ text: '{"steps":[]}', usage: { inputTokens: 640, outputTokens: 90, cacheCreationInputTokens: 0, cachedInputTokens: 600 } });
  });

  it('also keeps research output adaptive and low without a planning-specific reasoning field', async () => {
    const mock = mockFetch(() => native());
    await configuredAutonomyTextModel(key, mock.fetcher).generate({ ...request, reasoning: undefined });
    expect(JSON.parse(mock.calls[0]!.init.body as string)).toMatchObject({ max_tokens: 800, thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
    expect(mock.calls).toHaveLength(1);
  });

  it.each([['max_tokens', 'AUTONOMY_MODEL_TRUNCATED'], ['refusal', 'AUTONOMY_MODEL_REFUSED'], ['end_turn', 'AUTONOMY_MODEL_EMPTY']])('preserves paid usage for %s with no text', async (stop, code) => {
    const mock = mockFetch(() => native({}, { stop, content: [] }));
    await expect(configuredAutonomyTextModel(key, mock.fetcher).generate(request)).rejects.toMatchObject({ code, usage: { inputTokens: 640, outputTokens: 90, cacheCreationInputTokens: 600, cachedInputTokens: 0 } });
    expect(mock.calls).toHaveLength(1);
  });

  it('retains known spent tokens when the response failed the required cache contract', async () => {
    const mock = mockFetch(() => native({ cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null }));
    const context = execution();
    const router = configuredAutonomyTextModel(key, mock.fetcher);
    const error = await inActionExecution(context, () => generateModel(router, request)).catch(caught => caught);
    expect(error).toBeInstanceOf(AutonomyModelError);
    expect(error).toMatchObject({ code: 'AUTONOMY_MODEL_CACHE_INVALID', usage: { inputTokens: 40, outputTokens: 90, cacheCreationInputTokens: 0, cachedInputTokens: 0 } });
    expect(context.modelOutcome).toBe('acknowledged');
    expect(autonomyModelCostUsd(DEFAULT_HAIKU_MODEL, context.modelUsage!)).toBeCloseTo(0.000049, 9);
    expect(mock.calls).toHaveLength(1);
  });

  const unknownCounts = [
    { input_tokens: -1 }, { output_tokens: 1.5 }, { cache_read_input_tokens: '600' },
    ...['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
      .flatMap(field => [undefined, null].map(value => ({ [field]: value }))),
  ];
  it.each(unknownCounts)('leaves malformed or missing native token counts unknown: %j', async usage => {
    const mock = mockFetch(() => native(usage));
    const context = execution();
    await expect(inActionExecution(context, () => generateModel(configuredAutonomyTextModel(key, mock.fetcher), request))).rejects.toThrow('AUTONOMY_MODEL_USAGE_UNKNOWN');
    expect(context.modelOutcome).toBe('unknown');
    expect(context.modelUsage).toBeUndefined();
    expect(mock.calls).toHaveLength(1);
  });

  it('rechecks the action permit at the adapter boundary and sends nothing after a stop', async () => {
    let checks = 0;
    const context = execution(async () => ++checks < 2);
    const mock = mockFetch(() => native());
    await expect(inActionExecution(context, () => generateModel(configuredAutonomyTextModel(key, mock.fetcher), request))).rejects.toMatchObject({ code: 'ACTION_STOPPED', usage: { inputTokens: 0, outputTokens: 0 } });
    expect(checks).toBe(2);
    expect(mock.calls).toHaveLength(0);
    expect(context.modelOutcome).toBe('acknowledged');
  });

  it('aborts an in-flight SDK request and keeps the original uncertain outcome without retry', async () => {
    const controller = new AbortController();
    const mock = mockFetch(init => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('provider echoes private prompt')), { once: true });
      controller.abort();
    }));
    const context = execution();
    await expect(inActionExecution(context, () => generateModel(configuredAutonomyTextModel(key, mock.fetcher), { ...request, signal: controller.signal }))).rejects.toThrow('AUTONOMY_MODEL_ABORTED');
    expect(context.modelOutcome).toBe('unknown');
    expect(context.modelUsage).toBeUndefined();
    expect(mock.calls).toHaveLength(1);
  });

  it('never retries server failure and never includes the provider error body in its closed code', async () => {
    const mock = mockFetch(() => Response.json({ type: 'error', error: { type: 'api_error', message: 'credential and private request' } }, { status: 500 }));
    const context = execution();
    await expect(inActionExecution(context, () => generateModel(configuredAutonomyTextModel(key, mock.fetcher), request))).rejects.toThrow(/^AUTONOMY_MODEL_HTTP_500$/u);
    expect(context.modelOutcome).toBe('unknown');
    expect(mock.calls).toHaveLength(1);
  });
});

describe('Haiku cache costs in the existing autonomy budget', () => {
  it('reserves one-hour write plus all output and charges actual cache read/write separately', () => {
    expect(autonomyModelCostUsd(DEFAULT_HAIKU_MODEL, { inputTokens: 10_000, outputTokens: 2_000 })).toBeCloseTo(0.003, 9);
    expect(autonomyModelCostUsd(DEFAULT_HAIKU_MODEL, { inputTokens: 10_000, outputTokens: 2_000, cacheCreationInputTokens: 8_000, cachedInputTokens: 1_000 })).toBeCloseTo(0.00271, 9);
    expect(autonomyModelCostUsd(DEFAULT_HAIKU_MODEL, { inputTokens: 10_000, outputTokens: 2_000, cacheCreationInputTokens: 0, cachedInputTokens: 10_000 })).toBeCloseTo(0.0011, 9);
    expect(autonomyModelCostUsd(DEFAULT_HAIKU_MODEL, { inputTokens: 10_000, outputTokens: 2_000, cacheCreationInputTokens: 8_000, cachedInputTokens: 1_000, cacheCreation5mInputTokens: 3_000, cacheCreation1hInputTokens: 5_000 })).toBeCloseTo(0.002485, 9);
    expect(autonomyModelCostUsd(DEFAULT_HAIKU_MODEL, { inputTokens: 100_000, outputTokens: 2_000 })).toBeCloseTo(0.021, 9);
    expect(autonomyModelCostUsd(DEFAULT_HAIKU_MODEL, { inputTokens: 100_001, outputTokens: 2_000 })).toBeCloseTo(0.105001, 9);
    expect(autonomyModelCostUsd(DEFAULT_HAIKU_MODEL, { inputTokens: 100_001, outputTokens: 2_000, cacheCreationInputTokens: 0, cachedInputTokens: 100_001 })).toBeCloseTo(0.01000005, 9);
  });

  it('keeps configured prices safe for creation/read, including legacy settings and the long-context tier', () => {
    const prices = configuredAutonomyModelPrices({ SHANNON_AUTONOMY_MODEL_PRICES_JSON: JSON.stringify({ 'gpt-5.6-luna': { input: 1, output: 3 } }) });
    expect(prices).toEqual({ [DEFAULT_HAIKU_MODEL]: { input: 1, output: 3 } });
    expect(autonomyModelCostUsd(DEFAULT_HAIKU_MODEL, { inputTokens: 1_000, outputTokens: 100 }, prices)).toBeCloseTo(0.0023, 9);
    expect(autonomyModelCostUsd(DEFAULT_HAIKU_MODEL, { inputTokens: 1_000, outputTokens: 100, cacheCreationInputTokens: 400, cachedInputTokens: 500 }, prices)).toBeCloseTo(0.00125, 9);
    expect(autonomyModelCostUsd(DEFAULT_HAIKU_MODEL, { inputTokens: 100_001, outputTokens: 100 }, prices)).toBeCloseTo(1.00151, 9);
    for (const entries of [[['gpt-5.6-luna', { input: 1, output: 3 }], [DEFAULT_HAIKU_MODEL, { input: 2, output: 4 }]], [[DEFAULT_HAIKU_MODEL, { input: 2, output: 4 }], ['gpt-5.6-luna', { input: 1, output: 3 }]]]) {
      expect(configuredAutonomyModelPrices({ SHANNON_AUTONOMY_MODEL_PRICES_JSON: JSON.stringify(Object.fromEntries(entries)) })).toEqual({ [DEFAULT_HAIKU_MODEL]: { input: 2, output: 4 } });
    }
  });

  it('uses the same worst reservation at the gate, and records actual cache failure spend once', async () => {
    const harness = loopHarness();
    const mock = mockFetch(() => native({ cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null }));
    const model = configuredAutonomyTextModel(key, mock.fetcher);
    const deps = { store: harness.store, service: harness.service, config: harness.config, loop: harness.loopConfig, now: () => harness.clock.at, reader: harness.reader, showing: harness.showing, model };
    const call = paidCall(deps, scope, 'planning', { system: request.system, prompt: request.prompt }, 800)!;
    expect(call.model).toBe(DEFAULT_HAIKU_MODEL);
    expect(call.estimatedCostYen).toBeGreaterThan((call.estimate.inputTokens * 0.1 + 800 * 0.5) / 1_000_000 * 160);
    const decision = harness.service.authorize(scope, { domain: 'thinking', summary: '計画を立てます。', paid: { model: call.model, estimatedCostYen: call.estimatedCostYen } });
    expect(decision.decision).toBe('allow');
    const result = await callModel({ model }, call);
    expect(result.failure).toBe('AUTONOMY_MODEL_CACHE_INVALID');
    harness.service.recordAction(scope, { decisionId: decision.activityId, outcome: 'failed', summary: 'キャッシュを確かめられませんでした。', usage: result.usage });
    expect(harness.service.overview(scope).budget.spentYen).toBe(0.01); // Existing yen accounting rounds to cents.
    expect(() => harness.service.recordAction(scope, { decisionId: decision.activityId, outcome: 'failed', summary: '二重記録', usage: result.usage })).toThrow('AUTONOMY_ACTION_NOT_AUTHORIZED');
    harness.store.close();
  });

  it('refuses a cap that could cover ordinary input but not the full prefix cache write, before any RPC', () => {
    const harness = loopHarness({ environment: { SHANNON_AUTONOMY_MODEL_PRICES_JSON: JSON.stringify({ [DEFAULT_HAIKU_MODEL]: { input: 10, output: 10 } }), SHANNON_AUTONOMY_DAILY_BUDGET_YEN: '20' } });
    const mock = mockFetch(() => native());
    const model = configuredAutonomyTextModel(key, mock.fetcher);
    const call = paidCall({ store: harness.store, service: harness.service, config: harness.config, loop: harness.loopConfig, reader: harness.reader, showing: harness.showing, model }, scope, 'planning', { system: request.system, prompt: request.prompt }, 800)!;
    const ordinaryYen = (call.estimate.inputTokens + call.estimate.outputTokens) * 10 / 1_000_000 * 160;
    expect(ordinaryYen).toBeLessThan(20);
    expect(call.estimatedCostYen).toBeGreaterThan(20);
    expect(harness.service.authorize(scope, { domain: 'thinking', summary: '計画を立てます。', paid: { model: call.model, estimatedCostYen: call.estimatedCostYen } })).toMatchObject({ decision: 'forbidden', reason: 'budget_exhausted' });
    expect(harness.service.overview(scope).budget.spentYen).toBe(0);
    expect(mock.calls).toHaveLength(0);
    harness.store.close();
  });
});
