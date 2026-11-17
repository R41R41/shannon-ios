import { describe, expect, it, vi } from 'vitest';
import { replacementModel, configuredResponseModel } from '../src/infra/models/anthropic/haikuConfig.js';
import { OpenAIResponsesChatModel, createConfiguredChatModel } from '../src/infra/models/chatModel.js';
import { estimatedOpenAICostUsd, estimatedOpenAICostWithCacheUsd, responseUsage } from '../src/infra/models/llmUsage.js';
import { configuredOpenAIReasoningEffort, REASONING_HEADROOM_TOKENS } from '../src/infra/models/openAIReasoningEffort.js';
import { OpenAiVoiceSummaryWriter, createConfiguredVoiceSummaryWriter } from '../src/mind/memory/voiceHistorySummary.js';

const none = {};
const usage = (input: number, cached: number, output: number, writes = 0, writes12h = 0) => responseUsage({ usage: {
  input_tokens: input, output_tokens: output,
  input_tokens_details: { cached_tokens: cached, ...(writes ? { cache_write_tokens: writes, cache_write_tokens_details: { ttl_12h_tokens: writes12h } } : {}) } } });

describe('GPT-6 prices', () => {
  it('counts cached reads at the cached price and reasoning in the output', () => {
    // 200K input of which 120K cached: 80K*$2 + 120K*$0.10 + 20K*$10 = 0.16 + 0.012 + 0.2
    expect(estimatedOpenAICostUsd('gpt-6.2-sol', usage(200_000, 120_000, 20_000), none)).toBeCloseTo(0.372, 9);
    expect(estimatedOpenAICostUsd('gpt-6.2-astra', usage(100_000, 0, 10_000), none)).toBeCloseTo(0.8 + 0.4, 9);
    expect(estimatedOpenAICostUsd('gpt-6.1-sol', usage(100_000, 50_000, 0), none)).toBeCloseTo(0.1 + 0.005, 9);
    expect(estimatedOpenAICostUsd('gpt-6.1-terra', usage(100_000, 0, 100_000), none)).toBeCloseTo(0.1 + 0.5, 9);
    expect(estimatedOpenAICostUsd('gpt-6-luna', usage(100_000, 100_000, 100_000), none)).toBeCloseTo(0.001 + 0.05, 9);
  });

  it('charges cache writes at 1.25x input (2.5x for 12 hours) as a part of the input', () => {
    // 100K input: 30K read, 40K written (10K of them 12h), 30K plain on Sol
    expect(estimatedOpenAICostUsd('gpt-6.2-sol', usage(100_000, 30_000, 0, 40_000, 10_000), none))
      .toBeCloseTo((30_000 * 2 + 30_000 * 0.1 + 30_000 * 2.5 + 10_000 * 5) / 1e6, 9);
  });

  it('doubles input and raises output 1.5x above 272K input tokens', () => {
    expect(estimatedOpenAICostUsd('gpt-6.2-sol', usage(300_000, 0, 10_000), none)).toBeCloseTo(300_000 * 4 / 1e6 + 10_000 * 15 / 1e6, 9);
  });

  it('keeps the older rows at the full input price for cached input', () => {
    expect(estimatedOpenAICostUsd('gpt-5.6-terra', usage(1_000_000, 900_000, 0), none)).toBeCloseTo(2, 9);
    expect(estimatedOpenAICostUsd('gpt-9-unknown', usage(1_000_000, 900_000, 0), none)).toBeCloseTo(5, 9);
  });

  it('the report that compares with a cache does not count the discount twice', () => {
    const u = usage(1_000_000, 600_000, 0);
    expect(estimatedOpenAICostWithCacheUsd('gpt-6.2-sol', u, none)).toBe(estimatedOpenAICostUsd('gpt-6.2-sol', u, none));
  });
});

describe('GPT-6 names and effort', () => {
  it('the old luna replacement does not touch GPT-6 names', () => {
    for (const name of ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna']) expect(replacementModel(name)).toBe(name);
    expect(replacementModel('gpt-5.6-luna')).toBe('claude-haiku-5-5');
    expect(configuredResponseModel({ SHANNON_LLM_MODEL: 'gpt-6.2-sol', OPENAI_API_KEY: 'test-only' }, 'SHANNON_LLM_MODEL'))
      .toEqual({ model: 'gpt-6.2-sol', apiKey: 'test-only' });
  });

  it('reads the effort of a layer from its own name; Sol never gets none', () => {
    expect(configuredOpenAIReasoningEffort({}, 'SHANNON_LLM_MODEL', 'gpt-6.2-sol')).toBe('medium');
    expect(configuredOpenAIReasoningEffort({}, 'SHANNON_LLM_MODEL', 'gpt-6-luna')).toBeUndefined();
    expect(configuredOpenAIReasoningEffort({ SHANNON_LLM_REASONING_EFFORT: 'high' }, 'SHANNON_LLM_MODEL', 'gpt-6.2-sol')).toBe('high');
    expect(configuredOpenAIReasoningEffort({ SHANNON_X_REASONING_EFFORT: 'none' }, 'SHANNON_X_MODEL', 'gpt-6.2-sol')).toBe('low');
    expect(() => configuredOpenAIReasoningEffort({ SHANNON_LLM_REASONING_EFFORT: 'max' }, 'SHANNON_LLM_MODEL', 'gpt-6.2-sol')).toThrow();
  });

  it('sends Sol a reasoning effort of its own and room for it, on text and voice turns', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ output_text: JSON.stringify({ reply: 'うん。', taskDecision: { disposition: 'none', reason: 'x' }, taskProposal: null }) }));
    });
    const configured = createConfiguredChatModel({ SHANNON_LLM_MODEL: 'gpt-6.2-sol', OPENAI_API_KEY: 'test-only', SHANNON_LLM_REASONING_EFFORT: 'low' });
    expect(configured.model).toBe('gpt-6.2-sol');
    const sol = new OpenAIResponsesChatModel({ model: 'gpt-6.2-sol', apiKey: 'test-only', fetcher: fetcher as typeof fetch, reasoningEffort: 'low' });
    await sol.generateVoice({ scopeKey: 'o', systemPrompt: 's', history: [], message: 'やあ', useWebSearch: false, conversationClass: 'greeting' });
    expect(bodies[0]?.reasoning).toEqual({ effort: 'low' });
    expect(bodies[0]?.max_output_tokens).toBe(180 + REASONING_HEADROOM_TOKENS.low);
    const dflt = new OpenAIResponsesChatModel({ model: 'gpt-6.2-sol', apiKey: 'test-only', fetcher: fetcher as typeof fetch });
    await dflt.generate({ scopeKey: 'o', systemPrompt: 's', history: [], message: 'やあ' });
    expect(bodies[1]?.reasoning).toEqual({ effort: 'medium' });
    expect(bodies[1]?.max_output_tokens).toBe(2_200 + REASONING_HEADROOM_TOKENS.medium);
    expect((bodies[1]?.text as { format?: { type?: string } }).format?.type).toBe('json_schema');
    // Luna is unchanged: the effort the request carries.
    const luna = new OpenAIResponsesChatModel({ model: 'gpt-6-luna', apiKey: 'test-only', fetcher: fetcher as typeof fetch });
    await luna.generate({ scopeKey: 'o', systemPrompt: 's', history: [], message: 'やあ' });
    expect(bodies[2]?.reasoning).toEqual({ effort: 'none' });
    expect(bodies[2]?.max_output_tokens).toBe(2_200);
  });
});

describe('voice summary on OpenAI', () => {
  it('writes with a GPT-6 summary model and books the usage; other OpenAI models still get no writer', async () => {
    expect(createConfiguredVoiceSummaryWriter({ OPENAI_API_KEY: 'test-only', SHANNON_CONVERSATION_SUMMARY_MODEL: 'gpt-5.6-terra' })).toBeNull();
    expect(createConfiguredVoiceSummaryWriter({ OPENAI_API_KEY: 'test-only', SHANNON_CONVERSATION_SUMMARY_MODEL: 'gpt-6.2-sol' })).not.toBeNull();
    const rows: unknown[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ output_text: '話題: a', usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 0 } } }));
    });
    const made = new OpenAiVoiceSummaryWriter({ apiKey: 'test-only', model: 'gpt-6.2-sol', effort: 'medium', fetcher: fetcher as typeof fetch,
      usageStore: { recordLlmUsage: row => { rows.push(row); } } });
    expect(await made.write('o', { previousSummary: null, lines: ['x'] })).toBe('話題: a');
    expect(bodies[0]).toMatchObject({ model: 'gpt-6.2-sol', store: false, reasoning: { effort: 'medium' }, max_output_tokens: 4_700 });
    expect(rows).toMatchObject([{ lane: 'memory_background', model: 'gpt-6.2-sol', estimatedCostUsd: 0.003 }]);
  });
});
