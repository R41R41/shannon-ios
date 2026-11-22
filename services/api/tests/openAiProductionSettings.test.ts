import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPACTION_SECTIONS, planPath } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { AnthropicFcaModel, type AnthropicFcaUsage } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { createConfiguredChatModel } from '../src/infra/models/chatModel.js';
import { estimatedOpenAICostUsd, responseUsage } from '../src/infra/models/llmUsage.js';
import { createOpenAiFcaModel, OpenAiFcaModel } from '../src/infra/models/openai/openAiFcaModel.js';
import { openAiCostUsd } from '../src/infra/models/openai/openAiFcaWire.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import { LLMC_MAIN_MODEL, configuredMinecraftLlmc, llmcModelNames } from '../src/wiring/minecraftLlmcConfiguration.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { createFoodTrend, llmcTokens, minecraftLlmcLive, setLlmcTokenScale } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { candidateMenuTools } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { LLMC_TOOLS } from './support/minecraftBodyRequests.js';

/**
 * The head's paid roles on OpenAI by settings alone (decisions, first plan, replan, history summary), the others as they were.
 * The values are the ones a luna run sets. The Anthropic key is present as it is in production, and nothing may reach it.
 */
const LUNA = 'gpt-6-luna';
const LUNA_ENV = Object.freeze({
  OPENAI_API_KEY: 'k-openai', ANTHROPIC_API_KEY: 'k-anthropic',
  SHANNON_MINECRAFT_LLMC_MODEL: LUNA, SHANNON_MINECRAFT_LLMC_PLAN_MODEL: LUNA, SHANNON_MINECRAFT_LLMC_SUMMARY_MODEL: LUNA,
  SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL: 'none',
  SHANNON_MINECRAFT_LLMC_EFFORT: 'low', SHANNON_MINECRAFT_LLMC_PLAN_EFFORT: 'low', SHANNON_MINECRAFT_LLMC_SUMMARY_EFFORT: 'low',
});
const PRODUCTION_ENV = Object.freeze({ ANTHROPIC_API_KEY: 'k-anthropic', SHANNON_MINECRAFT_LLMC_MODEL: 'claude-sonnet-5-5' });
const signal = () => new AbortController().signal;

function input(): FcaModelInput {
  const tools = candidateMenuTools(LLMC_TOOLS);
  const observation = { schemaVersion: 1, bodyId: 'minecraft:w', sequence: 1, stateAt: '2026-11-18T00:00:00Z',
    receivedAt: '2026-11-18T00:00:00Z', connected: true, facts: { alive: true },
    state: { world: { dimension: 'overworld', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, inventory: [] } } } as BodyObservation;
  return { task: { id: 'luna-task', title: 'ケーキ', goal: 'ケーキを作って', completionCriteria: 'ケーキを持つ' },
    children: [], messages: [], history: [], tools, coreTools: tools,
    transient: minecraftLlmcLive({ elapsedMinutes: 1, trend: createFoodTrend(() => 0), events: [], observation }),
    plan: { ...planPath(seedPlan('エンドラを倒して')!) }, catalog: tools.map(tool => ({ name: tool.name, description: tool.description })) } as FcaModelInput;
}

const usage = { input_tokens: 40_000, input_tokens_details: { cached_tokens: 36_000 }, output_tokens: 900, output_tokens_details: { reasoning_tokens: 700 } };
const say = (text: string) => ({ id: 'r', status: 'completed', usage, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
const act = { id: 'r', status: 'completed', usage, output: [{ type: 'function_call', id: 'fc', call_id: 'call_1', name: 'mc_act', status: 'completed',
  arguments: JSON.stringify({ hands: ['wait 2'], why: '[p1] 待つ' }) }] };

interface Sent { url: string; body: Record<string, any> }
function recorder(answers: unknown[]) {
  const sent: Sent[] = [];
  const queue = [...answers];
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(queue.shift() ?? {}), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, sent };
}
/** A client that fails the test when anything of Anthropic's is used. */
const noAnthropic = new Proxy({}, { get() { throw new Error('ANTHROPIC_MUST_NOT_BE_CALLED'); } }) as never;

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('NETWORK_NOT_ALLOWED'); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setLlmcTokenScale(1); });

describe('the head on luna by settings', () => {
  it('sends the decision, the first plan, the replan and the history summary to OpenAI as luna at the set effort, and nothing to Anthropic', async () => {
    const template = Object.fromEntries(COMPACTION_SECTIONS.map((section, index) => [`section_${index + 1}`, section === '済み' ? ['q1: 待機を完了'] : []]));
    const { fetcher, sent } = recorder([act, say(JSON.stringify({ legs: [] })), say(JSON.stringify({ legs: [] })), say(JSON.stringify(template))]);
    const receipts: AnthropicFcaUsage[] = [];
    const wiring = configuredMinecraftLlmc(LUNA_ENV, { recordUsage: value => { receipts.push(value); }, fetcher, client: noAnthropic },
      { log: () => {}, client: noAnthropic })!;
    expect(wiring.names).toEqual({ main: LUNA, escalate: null, plan: LUNA });
    expect(wiring.models.main).toBeInstanceOf(OpenAiFcaModel);
    expect(wiring.models.escalate).toBeNull();
    expect(wiring.models.strong).toBeNull();

    await wiring.models.main.decide(input(), signal());
    await wiring.planner!('system', 'input', signal()).catch(() => undefined);
    await wiring.replanner!('system', 'input', signal()).catch(() => undefined);
    await wiring.summarizer!.summarize({ previous: null, rounds: [] }, signal()).catch(() => undefined);

    expect(sent).toHaveLength(4);
    for (const call of sent) {
      expect(call.url).toBe('https://api.openai.com/v1/responses');
      expect(call.body).toMatchObject({ model: LUNA, store: false, reasoning: { effort: 'low' } });
    }
    // every answer is booked under luna's own name, at luna's prices
    expect(receipts.length).toBe(4);
    expect(receipts.every(row => row.model === LUNA && row.usageComplete)).toBe(true);
    expect(receipts.every(row => row.estimatedCostUsd < 0.01)).toBe(true);
  });

  it('with none of the settings, everything stays Anthropic as it was and OpenAI is never asked', () => {
    expect(llmcModelNames({ ANTHROPIC_API_KEY: 'k-anthropic' })).toEqual({ main: LLMC_MAIN_MODEL, escalate: null, plan: 'claude-opus-5-5' });
    const { fetcher, sent } = recorder([]);
    const wiring = configuredMinecraftLlmc({ ANTHROPIC_API_KEY: 'k-anthropic', OPENAI_API_KEY: 'k-openai' }, { recordUsage() {}, fetcher }, { log: () => {} })!;
    expect(wiring.models.main).toBeInstanceOf(AnthropicFcaModel);
    expect(wiring.models.main).not.toBeInstanceOf(OpenAiFcaModel);
    expect(wiring.summarizer).not.toBeNull();
    expect(wiring.planner).toBeTypeOf('function');
    expect(wiring.replanner).toBeTypeOf('function');
    expect(sent).toHaveLength(0);
  });

  it('leaves no OpenAI token scale behind when the next configuration is Anthropic', () => {
    const { fetcher } = recorder([]);
    const text = 'x'.repeat(1_000) + '日本語'.repeat(300);
    const claude = (configuredMinecraftLlmc(PRODUCTION_ENV, { recordUsage() {}, fetcher }, { log: () => {} }), llmcTokens(text));
    configuredMinecraftLlmc(LUNA_ENV, { recordUsage() {}, fetcher });
    expect(llmcTokens(text)).toBeGreaterThan(claude);
    configuredMinecraftLlmc(PRODUCTION_ENV, { recordUsage() {}, fetcher }, { log: () => {} });
    expect(llmcTokens(text)).toBe(claude);
  });

  it('keeps today\'s production shape when an OpenAI key is merely present: Sonnet decides, Opus raises and plans', () => {
    const today = { ...PRODUCTION_ENV, SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL: 'next', SHANNON_MINECRAFT_LLMC_PLAN_MODEL: 'claude-opus-5-5' };
    expect(llmcModelNames(today)).toEqual({ main: 'claude-sonnet-5-5', escalate: 'claude-opus-5-5', plan: 'claude-opus-5-5' });
    expect(llmcModelNames({ ...today, OPENAI_API_KEY: 'k-openai' })).toEqual(llmcModelNames(today));
  });

  it('chooses each role on its own: luna decides while the plan stays Opus, or the reverse', () => {
    expect(llmcModelNames({ ...LUNA_ENV, SHANNON_MINECRAFT_LLMC_PLAN_MODEL: 'claude-opus-5-5' })).toEqual({ main: LUNA, escalate: null, plan: 'claude-opus-5-5' });
    expect(llmcModelNames({ ...PRODUCTION_ENV, OPENAI_API_KEY: 'k-openai', SHANNON_MINECRAFT_LLMC_PLAN_MODEL: LUNA })).toEqual({ main: 'claude-sonnet-5-5', escalate: null, plan: LUNA });
  });

  it('turns the head off, and says so, when luna is chosen without the key of OpenAI', () => {
    const lines: string[] = [];
    const { OPENAI_API_KEY: _key, ...withoutKey } = LUNA_ENV;
    expect(configuredMinecraftLlmc(withoutKey, { recordUsage() {} }, { log: line => lines.push(line) })).toBeNull();
    expect(lines.join('\n')).toContain('no key for its main model');
  });

  it('does not touch the talk layer: the conversation model reads its own setting', () => {
    expect(createConfiguredChatModel({ ...LUNA_ENV, SHANNON_LLM_MODEL: 'claude-haiku-5-5' }).model).toBe('claude-haiku-5-5');
    expect(createConfiguredChatModel({ ...LUNA_ENV }).model).not.toBe(LUNA);
  });
});

describe('luna in the ledger', () => {
  const counted = responseUsage({ usage });

  it('prices a decision at luna\'s own rates: 0.10 input, 0.01 cached input and 0.50 output per million tokens', () => {
    const expected = (4_000 * 0.1 + 36_000 * 0.01 + 900 * 0.5) / 1e6;
    expect(estimatedOpenAICostUsd(LUNA, counted, {})).toBeCloseTo(expected, 6);
    expect(openAiCostUsd(LUNA, { input: 40_000, cached: 36_000, cacheWrite: 0, output: 900 })).toBeCloseTo(expected, 6);
  });

  it('prices an unlisted GPT-6 name high, which is what luna cost before its row existed', () => {
    const expected = (4_000 * 0.1 + 36_000 * 0.01 + 900 * 0.5) / 1e6;
    expect(estimatedOpenAICostUsd('gpt-6-unlisted', counted, {})).toBeGreaterThan(expected * 20);
  });
});

describe('where the decision message of luna is cut', () => {
  // About 100,000 estimated tokens of live state: over the Claude default (95,000), far under luna's context and its dearer price step.
  const big = () => {
    const base = input();
    const words = Array.from({ length: 2_600 }, (_, index) => `地図の${index}番目の場所にある洞窟と鉱石と溶岩の様子`).join('。');
    return { ...base, transient: { ...base.transient, map: words } } as FcaModelInput;
  };
  const compacted = () => (console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(row => String(row[0]).includes('fca_request_compacted'));

  it('keeps an observation of about 100,000 estimated tokens whole for luna, where the Claude bound would cut it to a few hundred characters', async () => {
    const { fetcher } = recorder([act]);
    const control = createOpenAiFcaModel({ model: LUNA, apiKey: 'k', fetcher, compactAboveTokens: 95_000, recordUsage() {}, minecraftOwnPrompt: true });
    await control.decide(big(), signal()).catch(() => undefined);
    expect(compacted()).toHaveLength(1);
    (console.info as unknown as { mockClear(): void }).mockClear();

    const wired = recorder([act]);
    const wiring = configuredMinecraftLlmc(LUNA_ENV, { recordUsage() {}, fetcher: wired.fetcher, compactAboveTokens: 95_000, client: noAnthropic }, { log: () => {}, client: noAnthropic })!;
    await wiring.models.main.decide(big(), signal());
    expect(compacted()).toHaveLength(0);
    expect(JSON.stringify(wired.sent[0]!.body)).toContain('地図の2599番目の場所');
  });
});
