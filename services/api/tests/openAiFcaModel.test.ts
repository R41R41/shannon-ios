import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPACTION_SECTIONS, planPath } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { AnthropicFcaUsage } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { createOpenAiFcaModel, OpenAiFcaModel } from '../src/infra/models/openai/openAiFcaModel.js';
import { createOpenAiFcaSummarizer } from '../src/infra/models/openai/openAiFcaSummary.js';
import { openAiEffort } from '../src/infra/models/openai/openAiModels.js';
import { prunedOptional, strictJsonSchema } from '../src/infra/models/openai/openAiStructured.js';
import { FcaNoDecisionError, FcaNoResponseError } from '../src/mind/action/fca/fcaNoResponse.js';
import { FcaProviderError } from '../src/mind/action/fca/fcaProviderRetry.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import { configuredMinecraftLlmc, firstPlanner, keyFor, llmcModelNames } from '../src/wiring/minecraftLlmcConfiguration.js';
import { configuredMinecraftRoutePlanner } from '../src/wiring/minecraftRouteWiring.js';
import { strictMinecraftLlmcModel } from '../src/wiring/minecraftLlmcModelPolicy.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { createFoodTrend, llmcTokens, minecraftLlmcLive, setLlmcTokenScale } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { minecraftV2Hooks, candidateMenuTools } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { LLMC_TOOLS } from './support/minecraftBodyRequests.js';

const SOL = 'gpt-6.2-sol';
const signal = () => new AbortController().signal;

function input(history: readonly unknown[] = []): FcaModelInput {
  const tools = candidateMenuTools(LLMC_TOOLS);
  const observation = { schemaVersion: 1, bodyId: 'minecraft:w', sequence: 1, stateAt: '2026-11-18T00:00:00Z',
    receivedAt: '2026-11-18T00:00:00Z', connected: true, facts: { alive: true },
    state: { world: { dimension: 'overworld', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, inventory: [] } } } as BodyObservation;
  return { task: { id: 'openai-task', title: 'エンドラ', goal: 'エンドラを倒して', completionCriteria: 'ドラゴンを倒す' },
    children: [], messages: [], history, tools, coreTools: tools,
    transient: minecraftLlmcLive({ elapsedMinutes: 1, trend: createFoodTrend(() => 0), events: [], observation }),
    plan: { ...planPath(seedPlan('エンドラを倒して')!) }, catalog: tools.map(tool => ({ name: tool.name, description: tool.description })) } as FcaModelInput;
}

const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENCRYPTED-A' };
const call = (id: string, name: string, args: unknown) => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args), status: 'completed' });
const usage = { input_tokens: 10_000, input_tokens_details: { cached_tokens: 8_000 }, output_tokens: 700, output_tokens_details: { reasoning_tokens: 500 }, total_tokens: 10_700 };
const answer = (output: unknown[], extra: Record<string, unknown> = {}) => ({ id: 'resp_1', status: 'completed', output, usage, ...extra });
const actCall = call('call_1', 'mc_act', { hands: ['wait 2'], why: '[p1] 観測を待つ' });
const act = answer([reasoning, actCall]);

interface Sent { url: string; init: RequestInit; body: Record<string, any> }
function fakeFetch(...responses: Array<unknown | (() => never) | { status: number; json?: unknown; headers?: Record<string, string> }>) {
  const sent: Sent[] = [];
  const queue = [...responses];
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ url, init, body: JSON.parse(String(init.body)) });
    const next = queue.shift();
    if (typeof next === 'function') return (next as () => never)();
    if (next && typeof next === 'object' && 'status' in next && !('output' in next)) {
      const failure = next as { status: number; json?: unknown; headers?: Record<string, string> };
      return new Response(JSON.stringify(failure.json ?? {}), { status: failure.status, headers: failure.headers });
    }
    return new Response(JSON.stringify(next ?? {}), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, sent };
}

function model(fetcher: typeof fetch, extra: Record<string, unknown> = {}, receipts: AnthropicFcaUsage[] = []) {
  return createOpenAiFcaModel({ model: SOL, apiKey: 'sk-test', fetcher, minecraftOwnPrompt: true, minecraftV2: minecraftV2Hooks(),
    recordUsage: value => { receipts.push(value); }, ...extra });
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('NETWORK_NOT_ALLOWED'); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setLlmcTokenScale(1); });

describe('the OpenAI decision model', () => {
  it('sends one Responses request with function tools, auto choice, no storage, a task-fixed cache key and the effort', async () => {
    const { fetcher, sent } = fakeFetch(act);
    const output = await model(fetcher).decide(input(), signal());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    const body = sent[0]!.body;
    expect(body).toMatchObject({ model: SOL, store: false, tool_choice: 'auto', reasoning: { effort: 'medium' }, include: ['reasoning.encrypted_content'] });
    expect(body.prompt_cache_key).toMatch(/^fca-[0-9a-f]{24}$/u);
    expect(body.tools.every((tool: { type: string; strict: boolean }) => tool.type === 'function' && tool.strict === false)).toBe(true);
    expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(['mc_act', 'fca_complete']));
    expect(body.instructions).toContain('Request transport (Minecraft body task)');
    // the live state is the last item, alone, as a developer message
    const last = body.input.at(-1);
    expect(last.role).toBe('developer');
    expect(JSON.stringify(body)).not.toContain('cache_control');
    expect(output.decision).toMatchObject({ kind: 'tools', calls: [{ id: 'call_1', name: 'mc.act' }] });
    // the round keeps the reasoning item whole and the call as written; the live state is not stored
    const assistant = output.history.at(-1) as { role: string; content: Array<Record<string, any>> };
    expect(assistant.role).toBe('assistant');
    expect(assistant.content[0]).toMatchObject({ type: 'redacted_thinking', openai_item: reasoning });
    expect(assistant.content[1]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'mc_act', openai_arguments: actCall.arguments });
    expect(JSON.stringify(output.history)).not.toContain('"clear_at"');
  });

  it('replays the round as reasoning, function_call and function_call_output items, the earlier request as an unchanged prefix', async () => {
    const { fetcher, sent } = fakeFetch(act, answer([call('call_2', 'mc_act', { hands: ['wait 1'], why: '[p1] もう一度' })]));
    const first = model(fetcher);
    const one = await first.decide(input(), signal());
    const results = first.toolResults([{ id: 'call_1', text: '{"ok":true}', ok: true }]);
    await first.decide(input([...one.history, results]), signal());
    const [a, b] = sent.map(item => item.body.input as Array<Record<string, any>>);
    const types = b!.map(item => item.type ?? item.role);
    expect(types.slice(-4)).toEqual(['reasoning', 'function_call', 'function_call_output', 'developer']);
    expect(b!.find(item => item.type === 'function_call_output')).toEqual({ type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' });
    const replayed = b!.find(item => item.type === 'function_call')!;
    expect(replayed).toMatchObject({ id: 'fc_call_1', call_id: 'call_1', name: 'mc_act', arguments: actCall.arguments });
    // everything the first request sent but its live state is the start of the second request, byte for byte
    expect(JSON.stringify(b!.slice(0, a!.length - 1))).toBe(JSON.stringify(a!.slice(0, -1)));
    expect(sent[1]!.body.prompt_cache_key).toBe(sent[0]!.body.prompt_cache_key);
    // exactly one live state goes out
    expect(b!.filter(item => item.role === 'developer')).toHaveLength(1);
    expect(sent[1]!.body.instructions).toBe(sent[0]!.body.instructions);
    expect(JSON.stringify(sent[1]!.body.tools)).toBe(JSON.stringify(sent[0]!.body.tools));
  });

  it('marks a failed result and sends no reasoning when the reasoning is not kept', async () => {
    const { fetcher, sent } = fakeFetch(answer([call('call_1', 'mc_act', { hands: ['wait 2'], why: '[p1] x' })]), answer([call('call_2', 'mc_act', { hands: ['wait 1'], why: '[p1] もう一度' })]));
    const kept = model(fetcher, { replayReasoning: false });
    const one = await kept.decide(input(), signal());
    expect(sent[0]!.body.include).toBeUndefined();
    expect(JSON.stringify(one.history)).not.toContain('redacted_thinking');
    await kept.decide(input([...one.history, kept.toolResults([{ id: 'call_1', text: 'no', ok: false }])]), signal());
    expect(sent[1]!.body.input.find((item: { type?: string }) => item.type === 'function_call_output').output).toBe('[tool error]\nno');
    const echoed = sent[1]!.body.input.filter((item: { type?: string }) => item.type === 'function_call' || item.type === 'message');
    expect(echoed.length).toBeGreaterThan(0);
    for (const item of echoed) expect(item).not.toHaveProperty('id');
  });

  it('writes usage as the ledger keeps it: all input, the cache read, the reasoning in the output, at the ledger price', async () => {
    const receipts: AnthropicFcaUsage[] = [];
    await model(fakeFetch(act).fetcher, {}, receipts).decide(input(), signal());
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ model: SOL, usageComplete: true, inputTokens: 10_000, cachedInputTokens: 8_000, cacheCreationInputTokens: 0,
      outputTokens: 700, totalTokens: 10_700 });
    expect(receipts[0]!.estimatedCostUsd).toBeGreaterThan(0);
    const cheaper = new Array<AnthropicFcaUsage>();
    await model(fakeFetch(answer(act.output, { usage: { ...usage, input_tokens_details: { cached_tokens: 0 } } })).fetcher, {}, cheaper).decide(input(), signal());
    expect(cheaper[0]!.estimatedCostUsd).toBeGreaterThan(receipts[0]!.estimatedCostUsd);
  });

  it('refuses an answer whose usage is not known, after booking its upper bound', async () => {
    const receipts: AnthropicFcaUsage[] = [];
    await expect(model(fakeFetch({ ...act, usage: undefined }).fetcher, {}, receipts).decide(input(), signal())).rejects.toThrow('OPENAI_RESPONSE_USAGE_INVALID');
    expect(receipts[0]).toMatchObject({ usageComplete: false });
    expect(receipts[0]!.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('maps failures: credit, throttling and server errors for the runner to ask again, refusals, truncation, no decision', async () => {
    const receipts: AnthropicFcaUsage[] = [];
    const failing = async (response: unknown) => model(fakeFetch(response as never).fetcher, {}, receipts).decide(input(), signal()).catch((error: unknown) => error);
    expect((await failing({ status: 429, json: { error: { code: 'insufficient_quota', type: 'insufficient_quota' } } }) as Error).message).toBe('FCA_MODEL_BILLING');
    expect((await failing({ status: 402, json: { error: { code: 'credit_balance_exhausted' } } }) as Error).message).toBe('FCA_MODEL_BILLING');
    const limited = await failing({ status: 429, json: { error: { code: 'rate_limit_exceeded' } }, headers: { 'retry-after': '3' } });
    expect(limited).toBeInstanceOf(FcaProviderError);
    expect(limited).toMatchObject({ status: 429, retryAfterMs: 3_000 });
    expect(await failing({ status: 503 })).toMatchObject({ status: 503 });
    expect((await failing({ status: 400, json: { error: { code: 'invalid_prompt' } } }) as Error).message).toBe('FCA_MODEL_HTTP_400');
    expect(receipts).toEqual([]);
    expect((await failing(answer(act.output, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })) as Error).message).toBe('FCA_MODEL_TRUNCATED');
    expect((await failing(answer([{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }])) as Error).message).toBe('FCA_MODEL_REFUSED');
    expect(await failing(answer([reasoning, { type: 'message', content: [{ type: 'output_text', text: '考え中' }] }]))).toBeInstanceOf(FcaNoDecisionError);
    expect(receipts).toHaveLength(3);
  });

  it('books an upper bound for a request that may have been processed, and nothing for one that never left', async () => {
    const reset = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); };
    const refused = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
    const receipts: AnthropicFcaUsage[] = [];
    const lost = await model(fakeFetch(reset).fetcher, {}, receipts).decide(input(), signal()).catch((error: unknown) => error);
    expect(lost).toBeInstanceOf(FcaNoResponseError);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ usageComplete: false });
    expect(receipts[0]!.estimatedCostUsd).toBeGreaterThan(0);
    const never = await model(fakeFetch(refused).fetcher, {}, receipts).decide(input(), signal()).catch((error: unknown) => error);
    expect(never).toBeInstanceOf(FcaNoResponseError);
    expect(never).toMatchObject({ possiblyBilled: false });
    expect(receipts).toHaveLength(1);
  });

  it('does not ask for Anthropic cache evidence, and refuses a legacy (not transient) decision and a task history of another shape', async () => {
    const { fetcher } = fakeFetch(act, act);
    const m = model(fetcher);
    await expect(m.decide({ ...input(), coreTools: undefined }, signal())).rejects.toThrow('FCA_MODEL_OPENAI_TRANSIENT_ONLY');
    await expect(m.decide(input([{ type: 'function_call' }]), signal())).rejects.toThrow('FCA_MODEL_HISTORY_INVALID');
    await expect(m.decide(input(), signal())).resolves.toMatchObject({ decision: { kind: 'tools' } });
    expect(() => new OpenAiFcaModel({ model: 'claude-sonnet-5-5', apiKey: 'k', recordUsage() {} })).toThrow('FCA_MODEL_CONFIG_INVALID');
    expect(() => new OpenAiFcaModel({ model: SOL, recordUsage() {} })).toThrow('OPENAI_API_KEY_REQUIRED');
  });

  it('answers a wait or a completion with its result and no second judgment', async () => {
    const { fetcher } = fakeFetch(answer([call('call_9', 'fca_complete', { summary: 'ドラゴンの死を見た' })]));
    const m = model(fetcher);
    const output = await m.decide(input(), signal());
    expect(output.decision).toEqual({ kind: 'complete', summary: 'ドラゴンの死を見た' });
    expect((output.history.at(-1) as { content: Array<{ tool_use_id: string }> }).content[0]!.tool_use_id).toBe('call_9');
    expect(m.redecide).toBeUndefined();
  });
});

describe('structured outputs', () => {
  it('writes the summary in strict structured output and reads it by the shared rule', async () => {
    const template = Object.fromEntries(COMPACTION_SECTIONS.map((section, index) => [`section_${index + 1}`, section === '済み' ? ['q1: 待機を完了'] : []]));
    const { fetcher, sent } = fakeFetch(answer([{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(template) }] }]));
    const receipts: AnthropicFcaUsage[] = [];
    const summarizer = createOpenAiFcaSummarizer({ model: SOL, apiKey: 'k', effort: 'low', fetcher, maximumOutputTokens: 8_000, recordUsage: value => { receipts.push(value); } });
    await expect(summarizer.summarize({ previous: null, rounds: [] }, signal())).resolves.toMatchObject({ '済み': ['q1: 待機を完了'] });
    const format = sent[0]!.body.text.format;
    expect(format).toMatchObject({ type: 'json_schema', strict: true });
    expect(format.schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(format.schema.required).toHaveLength(COMPACTION_SECTIONS.length);
    expect(sent[0]!.body).toMatchObject({ model: SOL, store: false, reasoning: { effort: 'low' }, max_output_tokens: 8_000 });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ model: SOL, usageComplete: true });
  });

  it('closes a schema for strict mode and prunes what it made nullable', () => {
    const schema = { type: 'object', additionalProperties: false, required: ['a'],
      properties: { a: { type: 'string', maxLength: 30 }, x: { type: 'integer' }, list: { type: 'array', items: { type: 'object', required: ['k'], properties: { k: { type: 'string' }, y: { type: ['integer', 'null'] } } } } } };
    const strict = strictJsonSchema(schema) as { required: string[]; additionalProperties: boolean; properties: Record<string, any> };
    expect(strict.required).toEqual(['a', 'x', 'list']);
    expect(strict.additionalProperties).toBe(false);
    expect(strict.properties.x).toEqual({ anyOf: [{ type: 'integer' }, { type: 'null' }] });
    expect(strict.properties.a.description).toContain('30字まで');
    expect(strict.properties.list.anyOf[0].items.required).toEqual(['k', 'y']);
    expect(strict.properties.list.anyOf[0].items.additionalProperties).toBe(false);
    expect(prunedOptional({ a: 'v', x: null, list: [{ k: 'q', y: null }] }, schema)).toEqual({ a: 'v', list: [{ k: 'q' }] });
  });

  it('asks the plans of an OpenAI plan model on the Responses API and charges their usage', async () => {
    const plan = { legs: [] };
    const { fetcher, sent } = fakeFetch(answer([{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(plan) }] }]),
      { status: 500, json: {} });
    const receipts: AnthropicFcaUsage[] = [];
    const made = firstPlanner({ OPENAI_API_KEY: 'k' }, SOL, value => { receipts.push(value); }, () => {}, undefined, { type: 'object', properties: { legs: { type: 'array', items: { type: 'string' } } }, required: ['legs'] }, undefined, fetcher);
    await expect(made.planner!('system', 'input', signal())).resolves.toEqual(plan);
    expect(sent[0]!.body).toMatchObject({ model: SOL, reasoning: { effort: 'medium' }, instructions: 'system' });
    expect(receipts).toHaveLength(1);
    await expect(made.planner!('system', 'input', signal())).rejects.toMatchObject({ status: 500 });
    expect(receipts).toHaveLength(1);
  });

  it('asks the route plan on the Responses API when the route model is OpenAI', async () => {
    const { fetcher, sent } = fakeFetch(answer([{ type: 'message', content: [{ type: 'output_text', text: '{"legs":[]}' }] }]));
    const receipts: AnthropicFcaUsage[] = [];
    const planner = configuredMinecraftRoutePlanner({ SHANNON_MINECRAFT_ROUTE_PLAN: 'on', SHANNON_MINECRAFT_ROUTE_MODEL: SOL, SHANNON_MINECRAFT_ROUTE_EFFORT: 'high', OPENAI_API_KEY: 'k' },
      { recordUsage: value => { receipts.push(value); }, fetcher });
    await expect(planner!('s', 'i', signal())).resolves.toEqual({ legs: [] });
    expect(sent[0]!.body).toMatchObject({ model: SOL, reasoning: { effort: 'high' } });
    expect(receipts[0]).toMatchObject({ model: SOL, usageComplete: true });
    expect(configuredMinecraftRoutePlanner({ SHANNON_MINECRAFT_ROUTE_PLAN: 'on', SHANNON_MINECRAFT_ROUTE_MODEL: SOL }, { recordUsage() {} })).toBeUndefined();
  });
});

describe('the settings of the OpenAI roles', () => {
  const base = (fetcher: typeof fetch) => ({ recordUsage() {}, fetcher });
  const env = { OPENAI_API_KEY: 'k', SHANNON_MINECRAFT_LLMC_MODEL: SOL, SHANNON_MINECRAFT_LLMC_PLAN_MODEL: SOL };

  it('makes OpenAI models by the name, with the key of OpenAI, no escalation to another maker, and the plans on OpenAI', () => {
    expect(keyFor({ OPENAI_API_KEY: ' k ', ANTHROPIC_API_KEY: 'a' }, SOL)).toBe('k');
    expect(llmcModelNames(env)).toEqual({ main: SOL, plan: SOL, escalate: null });
    expect(llmcModelNames({ ...env, SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL: 'next' }).escalate).toBeNull();
    expect(llmcModelNames({ ...env, SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL: 'claude-opus-5-5' }).escalate).toBeNull();
    const wiring = configuredMinecraftLlmc({ ...env, SHANNON_MINECRAFT_LLMC_SUMMARY_MODEL: SOL, SHANNON_MINECRAFT_LLMC_EFFORT: 'high' }, base(fakeFetch().fetcher))!;
    expect(wiring.models.main).toBeInstanceOf(OpenAiFcaModel);
    expect(wiring.models.escalate).toBeNull();
    expect(wiring.models.strong).toBeNull();
    expect(wiring.summarizer).not.toBeNull();
    expect(wiring.planner).toBeTypeOf('function');
    expect(wiring.replanner).toBeTypeOf('function');
    expect(wiring.policy.maximumConversationTokens).toBe(Math.floor(40_000 / 1.2));
    expect(wiring.hard?.maximumConversationTokens).toBe(Math.floor(56_000 / 1.2));
  });

  it('sees the live state through a count a fifth higher for an OpenAI main model, and as before for Claude', () => {
    const text = 'x'.repeat(1_000) + '日本語'.repeat(300);
    const claude = llmcTokens(text);
    configuredMinecraftLlmc(env, base(fakeFetch().fetcher));
    expect(llmcTokens(text) / claude).toBeGreaterThan(1.19);
    expect(llmcTokens(text) / claude).toBeLessThan(1.21);
    configuredMinecraftLlmc({ ANTHROPIC_API_KEY: 'a' }, { recordUsage() {} });
    expect(llmcTokens(text)).toBe(claude);
  });

  it('keeps the main model deciding in the End stages when the plan model is of another maker', () => {
    const wiring = configuredMinecraftLlmc({ ...env, SHANNON_MINECRAFT_LLMC_PLAN_MODEL: 'claude-sonnet-5-5', ANTHROPIC_API_KEY: 'a' }, { recordUsage() {} }, { log: () => {} })!;
    expect(wiring.models.main).toBeInstanceOf(OpenAiFcaModel);
    expect(wiring.models.strong).toBeNull();
    expect(wiring.names.plan).toBe('claude-sonnet-5-5');
  });

  it('reads the efforts: medium by default, a model\'s own setting, and no `none` for sol', () => {
    expect(openAiEffort(undefined, SOL)).toBe('medium');
    expect(openAiEffort('high', SOL)).toBe('high');
    expect(openAiEffort('none', SOL)).toBe('medium');
    expect(openAiEffort('none', 'gpt-6-luna')).toBe('none');
    expect(openAiEffort('typo', SOL)).toBe('medium');
    const wiring = configuredMinecraftLlmc({ ...env, SHANNON_MINECRAFT_LLMC_EFFORT: 'low' }, base(fakeFetch().fetcher))!;
    expect((wiring.models.main as unknown as { effort: string }).effort).toBe('low');
    const planned = configuredMinecraftLlmc({ ...env, SHANNON_MINECRAFT_LLMC_PLAN_MODEL: 'gpt-6.2-astra', SHANNON_MINECRAFT_LLMC_PLAN_EFFORT: 'high' }, base(fakeFetch().fetcher))!;
    expect((planned.models.strong as unknown as { effort: string }).effort).toBe('high');
  });

  it('lets the strict single-model policy name an OpenAI model for every role', () => {
    const strict = { SHANNON_MINECRAFT_LLMC_STRICT_MODEL: 'on', SHANNON_MINECRAFT_LLMC_MODEL: SOL, SHANNON_MINECRAFT_LLMC_PLAN_MODEL: SOL, SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL: 'none' };
    for (const name of ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna']) {
      expect(strictMinecraftLlmcModel({ ...strict, SHANNON_MINECRAFT_LLMC_MODEL: name, SHANNON_MINECRAFT_LLMC_PLAN_MODEL: name })).toBe(name);
    }
    expect(() => strictMinecraftLlmcModel({ ...strict, SHANNON_MINECRAFT_LLMC_MODEL: 'gpt-4o', SHANNON_MINECRAFT_LLMC_PLAN_MODEL: 'gpt-4o' })).toThrow('MINECRAFT_LLMC_STRICT_MODEL_INVALID');
    expect(() => strictMinecraftLlmcModel({ ...strict, SHANNON_MINECRAFT_LLMC_PLAN_MODEL: 'gpt-6.2-astra' })).toThrow('MINECRAFT_LLMC_STRICT_MODEL_INVALID');
    expect(() => configuredMinecraftLlmc(strict, { recordUsage() {} })).toThrow('MINECRAFT_LLMC_STRICT_MODEL_KEY_REQUIRED');
    const wiring = configuredMinecraftLlmc({ ...strict, OPENAI_API_KEY: 'k' }, { recordUsage() {} })!;
    expect(wiring.models.main).toBeInstanceOf(OpenAiFcaModel);
    expect(wiring.summarizer).not.toBeNull();
    expect(wiring.planner).toBeTypeOf('function');
  });
});
