import { describe, expect, it } from 'vitest';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { TieredChatModel } from '../src/infra/models/tieredChatModel.js';
import { TURN_OUT_OF_TIME_LINE, TurnDeadline, TEXT_TURN_DEADLINE } from '../src/mind/action/respond/turnDeadline.js';
import { shannonTool } from '../src/mind/tools/shannonTools.js';
import type { LlmUsageEvent } from '../src/infra/models/llmUsage.js';
import { anthropicFixture, message, scriptedAnthropic, type AnthropicMessage } from './support/anthropicFixtures.js';

const base = { scopeKey: 'synthetic-owner', systemPrompt: 'Synthetic identity', history: [], message: 'Read a synthetic list' };
const failures = ['unconfirmed', 'required-count', 'ttl-counts'] as const;
type Failure = typeof failures[number];
function paid(model: string, response: AnthropicMessage): AnthropicMessage {
  return { ...response, model, usage: { ...response.usage, input_tokens: 420, output_tokens: 96,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 900,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } };
}
function rejected(model: string, failure: Failure): AnthropicMessage {
  const response = paid(model, anthropicFixture('structured-answer'));
  if (failure === 'unconfirmed') response.usage.cache_read_input_tokens = 0;
  if (failure === 'required-count') response.usage.input_tokens = null;
  if (failure === 'ttl-counts') {
    response.usage.cache_creation_input_tokens = 1_000;
    response.usage.cache_creation = { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 500 };
  }
  return response;
}
function native(model: string, responses: AnthropicMessage[]) {
  const transport = scriptedAnthropic(responses);
  const usage: LlmUsageEvent[] = [];
  const chat = new AnthropicChatModel({ apiKey: 'test-only',
    settings: { model, effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' }, fetch: transport.fetcher,
    usageStore: { recordLlmUsage: event => { usage.push(event); }, backgroundLlmCostUsd: () => 0 } });
  return { chat, bodies: transport.bodies, usage };
}
function toolSession(maximumCalls: number) {
  const calls: string[] = [];
  const tools = { definitions: [shannonTool('study.list')!], maximumCalls, deadline: new TurnDeadline(TEXT_TURN_DEADLINE),
    async call(name: string) { calls.push(name); return JSON.stringify({ ok: true, text: 'Original synthetic result', retryable: false }); } };
  return { tools, calls };
}

describe.each(['claude-haiku-5-5', 'claude-sonnet-5-5'])('terminal native cache evidence: %s', model => {
  // For Haiku an unconfirmed cache is no longer terminal; a missing required count still is.
  const terminal: Failure = model === 'claude-haiku-5-5' ? 'required-count' : 'unconfirmed';
  const terminalCode = model === 'claude-haiku-5-5' ? 'HAIKU_RESPONSE_USAGE_INVALID' : 'HAIKU_CACHE_UNCONFIRMED';
  for (const stream of [false, true]) {
    // maxCalls=1 exercises the answer catch; maxCalls=6 exercises the ordinary planning-round catch.
    for (const maximumCalls of [1, 6]) {
      // Haiku keeps a paid answer whose cache use is unconfirmed (stabilization 2026-10-12); the other evidence failures stay terminal.
      it.each(failures.filter(failure => model !== 'claude-haiku-5-5' || failure !== 'unconfirmed'))('does not send or run anything after %s following an original tool (stream=' + stream + ', cap=' + maximumCalls + ')', async failure => {
        const first = paid(model, message([{ type: 'thinking', thinking: '', signature: 'synthetic-original-signature' },
          { type: 'tool_use', id: 'synthetic-call', name: 'study_list', input: {} }], 'tool_use'));
        const h = native(model, [first, rejected(model, failure), paid(model, anthropicFixture('structured-answer'))]);
        const t = toolSession(maximumCalls);
        const parts: string[] = [];
        const result = stream ? await h.chat.generateStreaming({ ...base, tools: t.tools }, text => { parts.push(text); })
          : await h.chat.generate({ ...base, tools: t.tools });
        expect(result.outOfTime).toBe(true);
        expect(result.reply).toBe(TURN_OUT_OF_TIME_LINE);
        expect(parts).toEqual([]);
        expect(t.calls).toEqual(['study_list']);
        expect(h.bodies).toHaveLength(2); // No paid third send, even when a usable final response is available.
        expect(h.usage).toHaveLength(2);
        expect(h.usage.every(value => value.model === model && value.estimatedCostUsd > 0)).toBe(true);
        const original = h.bodies[1]!.messages as Array<{ role: string; content: unknown }>;
        expect(original).toContainEqual({ role: 'assistant', content: first.content });
        expect(JSON.stringify(original)).toContain('Original synthetic result');
        if (failure === 'required-count') expect(h.usage[1]!.estimatedCostUsd).toBe(model === 'claude-sonnet-5-5' ? 4.16 : 1.04);
        if (!stream && failure === 'unconfirmed') expect(h.usage[1]!.estimatedCostUsd).toBe(model === 'claude-sonnet-5-5' ? 0.0018 : 0.00009);
      });
    }
  }

  it('ends a streamed voice turn after its original tool without sending another paid answer', async () => {
    const first = paid(model, message([{ type: 'tool_use', id: 'synthetic-voice-call', name: 'study_list', input: {} }], 'tool_use'));
    const h = native(model, [first, rejected(model, terminal), paid(model, message([{ type: 'text', text: 'Must not be spoken.' }], 'end_turn'))]);
    const t = toolSession(6);
    const parts: string[] = [];
    const result = await h.chat.generateVoiceStreaming({ ...base, tools: t.tools, conversationClass: 'skill_simple', useWebSearch: false }, text => { parts.push(text); });
    expect(result.outOfTime).toBe(true);
    expect(result.reply).toContain(TURN_OUT_OF_TIME_LINE);
    expect(parts.join('')).not.toContain('Must not be spoken.');
    expect(t.calls).toEqual(['study_list']);
    expect(h.bodies).toHaveLength(2);
    expect(h.usage).toHaveLength(2);
  });

  it('still throws a pre-tool cache rejection without repairing it or running a tool', async () => {
    const h = native(model, [rejected(model, terminal), paid(model, anthropicFixture('structured-answer'))]);
    const t = toolSession(6);
    await expect(h.chat.generate({ ...base, tools: t.tools })).rejects.toThrow(terminalCode);
    expect(t.calls).toEqual([]);
    expect(h.bodies).toHaveLength(1);
    expect(h.usage).toHaveLength(1);
    expect(h.usage[0]!.estimatedCostUsd).toBeGreaterThan(0);
  });
});

it('retains the safe Sonnet-to-Haiku fallback only before any word or tool', async () => {
  const strong = native('claude-sonnet-5-5', [rejected('claude-sonnet-5-5', 'unconfirmed')]);
  const baseModel = native('claude-haiku-5-5', [paid('claude-haiku-5-5', anthropicFixture('structured-answer'))]);
  const tiered = new TieredChatModel(baseModel.chat, strong.chat, () => {});
  const t = toolSession(6);
  const result = await tiered.generate({ ...base, tier: 'sonnet', tools: t.tools });
  expect(result.model).toBe('claude-haiku-5-5');
  expect(result.servedTier).toBe('luna');
  expect(result.outOfTime).toBeUndefined();
  expect(strong.bodies).toHaveLength(1);
  expect(baseModel.bodies).toHaveLength(1);
  expect(strong.usage).toHaveLength(1);
  expect(strong.usage[0]!.estimatedCostUsd).toBeGreaterThan(0);
  expect(t.calls).toEqual([]);
});
