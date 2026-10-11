import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteModelModeStore } from '../src/infra/sqlite/modelModeStore.js';
import { configuredPlanningMode } from '../src/wiring/modelModePlanningWiring.js';
import { configuredAutonomyTextModel, AutonomyModelError } from '../src/mind/action/ownTime/autonomyTextModel.js';
import { AnthropicAutonomyTextModel } from '../src/mind/action/ownTime/anthropicAutonomyTextModel.js';
import { autonomyModelCostUsd } from '../src/mind/action/ownTime/autonomyModels.js';
import { prepareThinking } from '../src/mind/action/ownTime/autonomyLoopThinkStep.js';
import { paidCall } from '../src/mind/action/ownTime/autonomyLoopCalls.js';
import { loopHarness, scope } from './autonomyLoopHarness.js';
import { scriptedAnthropic, message } from './support/anthropicFixtures.js';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function path() { const directory = mkdtempSync(join(tmpdir(), 'shannon-planning-mode-')); directories.push(directory); return join(directory, 'state.db'); }
const environment = { SHANNON_AUTONOMY_ANTHROPIC_API_KEY: 'synthetic-own-time', SHANNON_ANTHROPIC_API_KEY: 'synthetic-conversation',
  SHANNON_ADR8_STAGE2: 'on', SHANNON_SONNET_ROUTING: 'on' };

describe('owner planning selection in the independent worker', () => {
  it('freezes one prepared planning call and its price, while subsequent planning sees the next committed mode', async () => {
    const database = path(), store = new SQLiteModelModeStore(database);
    const h = loopHarness();
    const wiring = configuredPlanningMode(environment, { path: database, ownerScope: scope, model: h.model })!;
    const dependencies = { ...h, loop: h.loopConfig, planningModel: wiring.planningModel };
    const cycle = h.store.loop.startCycle(scope, '2026-10-02', 'activity', [], h.clock.at);
    const first = prepareThinking(dependencies, cycle, { kind: 'think' }, h.clock.at)!;
    expect(first.request.paid?.model).toBe('claude-haiku-5-5');
    const price = first.request.paid?.estimatedCostYen;
    store.compareAndSet(scope, 0, 'sonnet');
    await first.perform({ model: h.model }, h.clock.at);
    expect(h.model.calls[0]?.model).toBe('claude-haiku-5-5'); expect(first.request.paid?.estimatedCostYen).toBe(price);
    const second = prepareThinking(dependencies, cycle, { kind: 'think' }, h.clock.at)!;
    expect(second.request.paid?.model).toBe('claude-sonnet-5-5');
    expect(second.request.paid!.estimatedCostYen).toBeGreaterThan(first.request.paid!.estimatedCostYen);
    await second.perform({ model: h.model }, h.clock.at); expect(h.model.calls[1]?.model).toBe('claude-sonnet-5-5');
    expect(paidCall(dependencies, scope, 'critique', { system: '', prompt: '' }, 50)?.model).toBe('gpt-5.6-terra');
    expect(paidCall(dependencies, scope, 'research_reading', { system: '', prompt: '' }, 50)?.model).toBe('claude-haiku-5-5');
    wiring.close(); store.close(); h.store.close();
  });
  it('preserves dedicated credentials and existing non-native planning when no native credential is permitted', () => {
    const database = path(), store = new SQLiteModelModeStore(database);
    expect(configuredPlanningMode({ SHANNON_ANTHROPIC_API_KEY: 'synthetic-conversation' }, { path: database, ownerScope: scope,
      model: configuredAutonomyTextModel({ SHANNON_ANTHROPIC_API_KEY: 'synthetic-conversation' }) })).toBeNull();
    expect(configuredPlanningMode({ SHANNON_AUTONOMY_ANTHROPIC_API_KEY: 'same', SHANNON_ANTHROPIC_API_KEY: 'same' }, { path: database, ownerScope: scope,
      model: configuredAutonomyTextModel({ SHANNON_AUTONOMY_ANTHROPIC_API_KEY: 'same', SHANNON_ANTHROPIC_API_KEY: 'same' }) })).toBeNull();
    store.compareAndSet(scope, 0, 'sonnet');
    const worker = configuredPlanningMode({ ...environment, SHANNON_SONNET_ROUTING: 'off' }, { path: database, ownerScope: scope, model: configuredAutonomyTextModel(environment) })!;
    expect(worker.planningModel(scope)).toBeNull(); expect(worker.planningModel('other')).toBeNull();
    expect(store.read(scope)).toEqual({ mode: 'sonnet', revision: 1 }); worker.close();
    const historical = configuredPlanningMode({ ...environment, SHANNON_SONNET_MODEL: 'claude-sonnet-4-5' }, { path: database, ownerScope: scope, model: configuredAutonomyTextModel(environment) })!;
    expect(historical.planningModel(scope)).toBeNull(); expect(store.read(scope)).toEqual({ mode: 'sonnet', revision: 1 }); historical.close(); store.close();
  });
  it('a worker read fault holds planning rather than guessing Haiku or revoking the durable selection', () => {
    const database = path(), store = new SQLiteModelModeStore(database); store.compareAndSet(scope, 0, 'sonnet');
    const worker = configuredPlanningMode(environment, { path: database, ownerScope: scope, model: configuredAutonomyTextModel(environment) })!;
    worker.close(); expect(worker.planningModel(scope)).toBeNull(); expect(store.read(scope).mode).toBe('sonnet'); store.close();
  });
  it('preserves old purpose preferences when the API explicitly overrides its default primary, then honors supported Sonnet', () => {
    const database = path(), store = new SQLiteModelModeStore(database), model = configuredAutonomyTextModel(environment);
    const worker = configuredPlanningMode({ ...environment, SHANNON_LLM_MODEL: 'gpt-5.6-terra', OPENAI_API_KEY: 'synthetic-other' }, {
      path: database, ownerScope: scope, model, fallbackPlanning: () => 'gemini-3.8-flash',
    })!;
    expect(worker.planningModel(scope)).toBe('gemini-3.8-flash');
    store.compareAndSet(scope, 0, 'sonnet'); expect(worker.planningModel(scope)).toBe('claude-sonnet-5-5'); worker.close(); store.close();
  });
  it('native Sonnet planning retains one-hour cache accounting and the original signal with no retry', async () => {
    const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 500, cache_read_input_tokens: 1000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 } };
    const fixture = scriptedAnthropic([message([{ type: 'text', text: '{"steps":[{"action":"rest"}]}' }], 'end_turn', { usage })]);
    const model = new AnthropicAutonomyTextModel({ apiKey: 'synthetic-own-time', fetcher: fixture.fetcher });
    const result = await model.generate({ model: 'claude-sonnet-5-5', system: '合成計画の決定', prompt: '合成材料', maximumOutputTokens: 1500 });
    expect(fixture.bodies).toHaveLength(1); expect(fixture.bodies[0]).toMatchObject({ model: 'claude-sonnet-5-5', cache_control: { ttl: '1h' } });
    expect(result.usage).toEqual({ inputTokens: 1510, outputTokens: 20, cacheCreationInputTokens: 500, cachedInputTokens: 1000, cacheCreation5mInputTokens: 0, cacheCreation1hInputTokens: 500 });
    expect(autonomyModelCostUsd('claude-sonnet-5-5', result.usage)).toBeCloseTo(0.00242, 8);
    expect(autonomyModelCostUsd('claude-sonnet-5-5', result.usage, { 'claude-sonnet-5-5': { input: 2, output: 10 } })).toBeCloseTo(0.00242, 8);
    expect(autonomyModelCostUsd('claude-haiku-5-5', result.usage, { 'claude-haiku-5-5': { input: 0.1, output: 0.5 } })).toBeCloseTo(0.000121, 8);
    const controller = new AbortController(); controller.abort();
    await expect(model.generate({ model: 'claude-sonnet-5-5', system: '', prompt: '', maximumOutputTokens: 1500, signal: controller.signal })).rejects.toMatchObject({ code: 'ACTION_STOPPED' });
    expect(fixture.bodies).toHaveLength(1);
  });
  it('refusal preserves known cost; malformed usage and transport remain unknown without fallback or retry', async () => {
    const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } };
    const fixture = scriptedAnthropic([message([], 'refusal', { usage }), message([{ type: 'text', text: '{}' }], 'end_turn', { usage: { input_tokens: 10, output_tokens: 20 } })]);
    const model = new AnthropicAutonomyTextModel({ apiKey: 'synthetic-own-time', fetcher: fixture.fetcher });
    const request = { model: 'claude-sonnet-5-5', system: '', prompt: '', maximumOutputTokens: 1500 };
    await expect(model.generate(request)).rejects.toMatchObject({ code: 'AUTONOMY_MODEL_REFUSED', usage: { inputTokens: 1010, outputTokens: 20 } });
    await expect(model.generate(request)).rejects.toThrow('AUTONOMY_MODEL_USAGE_UNKNOWN');
    expect(fixture.bodies).toHaveLength(2);
    const unknown = new AnthropicAutonomyTextModel({ apiKey: 'synthetic-own-time', fetcher: async () => { throw new Error('synthetic transport'); } });
    await expect(unknown.generate(request)).rejects.not.toBeInstanceOf(AutonomyModelError);
  });
});
