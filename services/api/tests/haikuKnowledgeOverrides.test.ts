import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HAIKU_MODEL } from '../src/infra/models/anthropic/haikuConfig.js';
import { HAIKU_PROTOCOL_PREFIX } from '../src/infra/models/anthropic/haikuCache.js';
import { estimatedOpenAICostUsd, type LlmUsageEvent, type LlmUsageStore } from '../src/infra/models/llmUsage.js';
import { createConfiguredKnowledgeAnalyzer } from '../src/mind/sleep/knowledgeConsolidation.js';
import { createConfiguredSkillSleepModels, type SkillSleepModel } from '../src/mind/sleep/skillSleepModel.js';
import { liveEstimate, liveReadiness, runReachSuite, scriptedDrivers } from './reach/reachSuite.js';

const credentials = { OPENAI_API_KEY: 'openai-synthetic', SHANNON_ANTHROPIC_API_KEY: 'haiku-synthetic' };
const schema = { type: 'object', additionalProperties: false, properties: {}, required: [] };
const usage = { input_tokens: 40, cache_creation_input_tokens: 600, cache_read_input_tokens: 0, output_tokens: 20,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 600 } };
afterEach(() => vi.unstubAllGlobals());
function harness(native = true, validUsage = true) {
  const events: LlmUsageEvent[] = [];
  const calls: Array<{ url: string; body: Record<string, any>; headers: Headers }> = [];
  const store: LlmUsageStore = { recordLlmUsage: event => events.push(event), backgroundLlmCostUsd: () => 0 };
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(native ? { id: 'synthetic', type: 'message', role: 'assistant', model: DEFAULT_HAIKU_MODEL,
      content: [{ type: 'text', text: '{"operations":[]}' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: validUsage ? usage : { ...usage, input_tokens: null } }
      : { output_text: '{"operations":[]}', usage: { input_tokens: 40, output_tokens: 20 } }), { headers: { 'content-type': 'application/json' } });
  });
  return { calls, events, store };
}
function expectHaiku(h: ReturnType<typeof harness>, index = 0) {
  const call = h.calls[index]!;
  expect(call.url).toBe('https://api.anthropic.com/v1/messages');
  expect(call.headers.get('x-api-key')).toBe('haiku-synthetic');
  expect(call.headers.has('authorization')).toBe(false);
  expect(call.body.model).toBe(DEFAULT_HAIKU_MODEL);
  expect(call.body.system[0]).toEqual({ type: 'text', text: HAIKU_PROTOCOL_PREFIX, cache_control: { type: 'ephemeral', ttl: '1h' } });
  expect(h.events[index]).toMatchObject({ model: DEFAULT_HAIKU_MODEL, lane: 'memory_background', inputTokens: 640, outputTokens: 20 });
}

describe('all explicitly configured Luna overrides migrate without changing Terra and Sonnet roles', () => {
  it('routes an old knowledge model override through native Haiku and its credential', async () => {
    const h = harness();
    const model = createConfiguredKnowledgeAnalyzer({ ...credentials, SHANNON_KNOWLEDGE_MODEL: 'gpt-5.6-luna' }, h.store)!;
    expect(await model.analyze('owner', { experiences: [], knowledge: [] })).toEqual([]);
    expect(h.calls).toHaveLength(1);
    expectHaiku(h);
  });

  it.each(['SHANNON_SKILL_MODEL', 'SHANNON_KNOWLEDGE_MODEL'])('migrates %s for both maintainer and fallback proposer', async setting => {
    const h = harness();
    const models = createConfiguredSkillSleepModels({ ...credentials, [setting]: 'gpt-5.6-luna' }, h.store);
    expect(models.maintainer?.model).toBe(DEFAULT_HAIKU_MODEL);
    expect(models.proposer?.model).toBe(DEFAULT_HAIKU_MODEL);
    await models.maintainer!.json('owner', 'maintain', 'Keep the skill current.', {}, schema);
    await models.proposer!.json('owner', 'propose', 'Propose a skill.', {}, schema);
    expect(h.calls).toHaveLength(2);
    expectHaiku(h); expectHaiku(h, 1);
  });

  it('migrates a proposer-only Luna override while preserving its Terra maintainer', async () => {
    const h = harness();
    const models = createConfiguredSkillSleepModels({ ...credentials, SHANNON_SKILL_PROPOSER_MODEL: 'gpt-5.6-luna' }, h.store);
    expect(models.maintainer?.model).toBe('gpt-5.6-terra');
    expect(models.proposer?.model).toBe(DEFAULT_HAIKU_MODEL);
    await models.proposer!.json('owner', 'propose', 'Propose a skill.', {}, schema);
    expectHaiku(h);
  });

  it('preserves the strongest Sonnet proposer hook and never dispatches the fallback', async () => {
    const h = harness();
    const json = vi.fn(async () => ({}));
    const strongest: SkillSleepModel = { model: 'claude-sonnet-5-5', json };
    const models = createConfiguredSkillSleepModels({ ...credentials, SHANNON_SKILL_MODEL: 'gpt-5.6-luna', SHANNON_SKILL_PROPOSER_MODEL: 'gpt-5.6-luna' }, h.store, () => strongest);
    expect(models.maintainer?.model).toBe(DEFAULT_HAIKU_MODEL);
    expect(models.proposer).toBe(strongest);
    await models.proposer!.json('owner', 'propose', 'Propose a skill.', {}, schema);
    expect(json).toHaveBeenCalledOnce();
    expect(h.calls).toEqual([]);
  });

  it('preserves default Terra transport, credential, output and usage', async () => {
    const h = harness(false);
    await createConfiguredKnowledgeAnalyzer(credentials, h.store)!.analyze('owner', { experiences: [], knowledge: [] });
    const models = createConfiguredSkillSleepModels(credentials, h.store);
    expect(models.maintainer?.model).toBe('gpt-5.6-terra');
    expect(models.proposer?.model).toBe('gpt-5.6-terra');
    expect(await models.maintainer!.json('owner', 'maintain', 'Keep the skill current.', {}, schema)).toEqual({ operations: [] });
    expect(h.calls).toHaveLength(2);
    expect(h.calls.every(call => call.url === 'https://api.openai.com/v1/responses' && call.headers.get('authorization') === 'Bearer openai-synthetic')).toBe(true);
    expect(h.events.every(event => event.model === 'gpt-5.6-terra' && event.inputTokens === 40)).toBe(true);
  });

  it('keeps knowledge OFF and absent selected credentials from offering either model', () => {
    const strongest = vi.fn(() => ({ model: 'claude-sonnet-5-5', json: async () => ({}) }));
    expect(createConfiguredKnowledgeAnalyzer({ ...credentials, SHANNON_KNOWLEDGE_ENABLED: 'false' })).toBeNull();
    expect(createConfiguredKnowledgeAnalyzer({ OPENAI_API_KEY: 'openai-only', SHANNON_KNOWLEDGE_MODEL: 'gpt-5.6-luna' })).toBeNull();
    expect(createConfiguredSkillSleepModels({ ...credentials, SHANNON_KNOWLEDGE_ENABLED: 'false' }, undefined, strongest)).toEqual({ maintainer: null, proposer: null });
    expect(createConfiguredSkillSleepModels({ SHANNON_ANTHROPIC_API_KEY: 'haiku-only' }, undefined, strongest)).toEqual({ maintainer: null, proposer: null });
    expect(strongest).not.toHaveBeenCalled();
    expect(createConfiguredSkillSleepModels({ OPENAI_API_KEY: 'openai-only', SHANNON_SKILL_PROPOSER_MODEL: 'gpt-5.6-luna' }).proposer).toBeNull();
  });

  it.each(['knowledge', 'skill'])('%s retains known usage and charges unknown counts before rejection without retries', async kind => {
    const h = harness(true, false);
    const request = kind === 'knowledge' ? createConfiguredKnowledgeAnalyzer({ ...credentials, SHANNON_KNOWLEDGE_MODEL: 'gpt-5.6-luna' }, h.store)!
      .analyze('owner', { experiences: [], knowledge: [] }) : createConfiguredSkillSleepModels({ ...credentials, SHANNON_SKILL_MODEL: 'gpt-5.6-luna' }, h.store)
      .maintainer!.json('owner', 'maintain', 'Keep the skill current.', {}, schema);
    await expect(request).rejects.toThrow('HAIKU_RESPONSE_USAGE_INVALID');
    expect(h.calls).toHaveLength(1);
    expect(h.events).toMatchObject([{ inputTokens: 600, outputTokens: 20, estimatedCostUsd: 1.01 }]);
  });

  it('binds live reach readiness and model-free estimates to Haiku, preserving other explicit providers', async () => {
    expect(liveReadiness({ SHANNON_ANTHROPIC_API_KEY: 'haiku-only' }).conversation).toBe(true);
    expect(liveReadiness({ OPENAI_API_KEY: 'openai-only' }).conversation).toBe(false);
    expect(liveReadiness({ ...credentials, SHANNON_LLM_MODEL: 'gpt-5.6-luna' }).conversation).toBe(true);
    expect(liveReadiness({ OPENAI_API_KEY: 'openai-only', SHANNON_LLM_MODEL: 'gpt-5.6-terra' }).conversation).toBe(true);
    expect(liveReadiness({ SHANNON_AUTONOMY_ANTHROPIC_API_KEY: 'dedicated' }).autonomy).toBe(true);
    const report = await runReachSuite(scriptedDrivers(), { mode: 'scripted', revision: 'synthetic', only: ['context.shiritori-60'], now: () => '2026-10-08T00:00:00Z' });
    expect(report.runs).toHaveLength(1);
    const current = liveEstimate(report, credentials);
    expect(current).toEqual(liveEstimate(report, { ...credentials, SHANNON_LLM_MODEL: 'gpt-5.6-luna' }));
    expect(current[0]!.yen).toBeGreaterThan(0);
    expect(current[0]!.basis).toContain('at 1/2.5 USD per million');
    expect(current[0]!.basis).toContain(`~${report.runs[0]!.cost.promptCharacters + report.runs[0]!.cost.calls * HAIKU_PROTOCOL_PREFIX.length} input`);
    expect(estimatedOpenAICostUsd(DEFAULT_HAIKU_MODEL, { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, totalTokens: 1_000_000 })).toBe(0.5);
  });
});
