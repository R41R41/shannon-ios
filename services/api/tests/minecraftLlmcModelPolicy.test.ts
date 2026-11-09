import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPACTION_SECTIONS, planPath } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { createAnthropicFcaModel, type AnthropicFcaUsage } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { classifyDispatchFailure, failureMayHaveBeenCharged } from '../src/infra/models/anthropic/anthropicFcaFailure.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import { configuredMinecraftLlmc, firstPlanner, llmcModelNames } from '../src/wiring/minecraftLlmcConfiguration.js';
import { guardMinecraftLlmcModelClient, strictMinecraftLlmcModel } from '../src/wiring/minecraftLlmcModelPolicy.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { createFoodTrend, minecraftLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { candidateMenuTools } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { LLMC_TOOLS } from './support/minecraftBodyRequests.js';
import { message } from './support/anthropicFixtures.js';

const HAIKU = 'claude-haiku-5-5', SONNET = 'claude-sonnet-5-5', OPUS = 'claude-opus-5-5';
const signal = () => new AbortController().signal;
const settings = (model: string) => ({ SHANNON_MINECRAFT_LLMC_STRICT_MODEL: 'on', SHANNON_MINECRAFT_LLMC_MODEL: model,
  SHANNON_MINECRAFT_LLMC_PLAN_MODEL: model, SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL: 'none' });
const usage = { input_tokens: 400, output_tokens: 300, cache_creation_input_tokens: 25_000, cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 25_000 } };
const answer = (model: string, content: Array<Record<string, unknown>>, stop = 'tool_use') =>
  message(content, stop, { model, usage }) as unknown as Anthropic.Message;
const act = (model: string) => answer(model, [{ type: 'thinking', thinking: '', signature: 'synthetic' },
  { type: 'tool_use', id: 'act', name: 'mc_act', input: { hands: ['wait 2'], why: '[p1] 観測を待つ' } }]);

function input(): FcaModelInput {
  const tools = candidateMenuTools(LLMC_TOOLS);
  const observation = { schemaVersion: 1, bodyId: 'minecraft:w', sequence: 1, stateAt: '2026-11-05T00:00:00Z',
    receivedAt: '2026-11-05T00:00:00Z', connected: true, facts: { alive: true },
    state: { world: { dimension: 'overworld', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, inventory: [] } } } as BodyObservation;
  return { task: { id: 'policy-task', title: 'エンドラ', goal: 'エンドラを倒して', completionCriteria: 'ドラゴンを倒す' },
    children: [], messages: [], history: [], tools, coreTools: tools,
    transient: minecraftLlmcLive({ elapsedMinutes: 1, trend: createFoodTrend(() => 0), events: [], observation }),
    plan: { ...planPath(seedPlan('エンドラを倒して')!) }, catalog: tools.map(tool => ({ name: tool.name, description: tool.description })) } as FcaModelInput;
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('NETWORK_NOT_ALLOWED'); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Minecraft single-model spending policy', () => {
  it.each([HAIKU, SONNET])('uses %s for decisions, second judgments, first plans, replans and summaries', async model => {
    const bodies: Anthropic.MessageCreateParamsNonStreaming[] = [], receipts: AnthropicFcaUsage[] = [];
    const template = Object.fromEntries(COMPACTION_SECTIONS.map(section => [section, section === '済み' ? ['q1: 待機を完了'] : []]));
    const queue = [act(model), act(model), answer(model, [{ type: 'text', text: '{}' }], 'end_turn'),
      answer(model, [{ type: 'text', text: '{}' }], 'end_turn'),
      answer(model, [{ type: 'tool_use', id: 'summary', name: 'fca_history_summary', input: { template: JSON.stringify(template) } }])];
    const client = { messages: { async create(body: Anthropic.MessageCreateParamsNonStreaming, _options: { signal: AbortSignal; maxRetries?: number }) {
      bodies.push(body);
      const next = queue.shift();
      if (!next) throw new Error('NO_SYNTHETIC_RESPONSE');
      return next;
    } } };
    const wiring = configuredMinecraftLlmc(settings(model), { client, redecideModel: OPUS, recordUsage: value => { receipts.push(value); } }, { client })!;
    expect(wiring.names).toEqual({ main: model, plan: model, escalate: null });
    expect(wiring.models.strong).toBeNull();
    await wiring.models.main.decide(input(), signal());
    const second = await wiring.models.main.redecide!({ taskId: 'policy-task', note: '制約を確かめる', signal: signal(), timeoutMs: 5_000 });
    expect(second?.model).toBe(model);
    await expect(wiring.planner!('system', 'plan', signal())).resolves.toEqual({});
    await expect(wiring.replanner!('system', 'replan', signal())).resolves.toEqual({});
    await expect(wiring.summarizer!.summarize({ previous: null, rounds: [] }, signal())).resolves.toMatchObject({ '済み': ['q1: 待機を完了'] });
    expect(bodies.map(body => body.model)).toEqual(Array(5).fill(model));
    expect(receipts.map(receipt => receipt.model)).toEqual(Array(5).fill(model));
    expect(receipts.every(receipt => receipt.usageComplete && receipt.estimatedCostUsd > 0)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never falls back to Opus for missing or conflicting strict settings', () => {
    for (const bad of [
      { SHANNON_MINECRAFT_LLMC_STRICT_MODEL: 'on' },
      settings(OPUS),
      { ...settings(HAIKU), SHANNON_MINECRAFT_LLMC_PLAN_MODEL: SONNET },
      { ...settings(HAIKU), SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL: 'next' },
      { ...settings(HAIKU), SHANNON_MINECRAFT_LLMC_STRICT_MODEL: 'typo' },
    ]) expect(() => llmcModelNames(bad)).toThrow('MINECRAFT_LLMC_STRICT_MODEL_INVALID');
    expect(llmcModelNames({ SHANNON_MINECRAFT_LLMC_STRICT_MODEL: 'on', SHANNON_MINECRAFT_LLMC_MODEL: HAIKU }))
      .toEqual({ main: HAIKU, plan: HAIKU, escalate: null });
  });

  it('fails closed without the selected credential and leaves legacy defaults unchanged without strict policy', () => {
    const base = { recordUsage() {} };
    expect(() => configuredMinecraftLlmc(settings(HAIKU), base)).toThrow('MINECRAFT_LLMC_STRICT_MODEL_KEY_REQUIRED');
    expect(() => configuredMinecraftLlmc({ ...settings(SONNET), SHANNON_HAIKU_API_KEY: 'synthetic-haiku-only' }, base))
      .toThrow('MINECRAFT_LLMC_STRICT_MODEL_KEY_REQUIRED');
    expect(() => firstPlanner(settings(HAIKU), HAIKU, () => {}, () => {})).toThrow('MINECRAFT_LLMC_STRICT_MODEL_KEY_REQUIRED');
    expect(() => firstPlanner(settings(HAIKU), OPUS, () => {}, () => {})).toThrow('MINECRAFT_LLMC_STRICT_MODEL_INVALID');
    expect(strictMinecraftLlmcModel({})).toBeNull();
    expect(llmcModelNames({})).toEqual({ main: OPUS, plan: OPUS, escalate: null });
    expect(configuredMinecraftLlmc({}, base)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks a model mismatch before dispatch, while preserving the allowed call and cancellation options', async () => {
    const provider = { messages: { create: vi.fn(async (_body: Anthropic.MessageCreateParamsNonStreaming, _options: { signal: AbortSignal }) => act(HAIKU)) } };
    const guarded = guardMinecraftLlmcModelClient(provider, HAIKU);
    const options = { signal: signal() };
    const body = { model: OPUS, max_tokens: 1, messages: [] } as Anthropic.MessageCreateParamsNonStreaming;
    let rejected: unknown;
    try { await guarded.messages.create(body, options); } catch (error) { rejected = error; }
    expect(rejected).toMatchObject({ message: 'MINECRAFT_LLMC_MODEL_POLICY' });
    expect(provider.messages.create).not.toHaveBeenCalled();
    expect(failureMayHaveBeenCharged(classifyDispatchFailure(rejected, { stopped: true, deadline: true }))).toBe(false);
    await guarded.messages.create({ ...body, model: HAIKU }, options);
    expect(provider.messages.create).toHaveBeenCalledWith({ ...body, model: HAIKU }, options);
  });

  it('does not book an unknown charge when a local model policy refuses a decision', async () => {
    const provider = { messages: { create: vi.fn(async (_body: Anthropic.MessageCreateParamsNonStreaming, _options: { signal: AbortSignal; maxRetries: number }) => act(HAIKU)) } };
    const receipts: AnthropicFcaUsage[] = [];
    const model = createAnthropicFcaModel({ model: HAIKU, client: guardMinecraftLlmcModelClient(provider, SONNET),
      recordUsage: value => { receipts.push(value); } });
    await expect(model.decide(input(), signal())).rejects.toThrow('ANTHROPIC_REQUEST_NOT_SENT');
    expect(provider.messages.create).not.toHaveBeenCalled();
    expect(receipts).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
