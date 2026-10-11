import { describe, expect, it } from 'vitest';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import Anthropic from '@anthropic-ai/sdk';
import { TRANSIENT_RETRY, transientProviderFailure, transientRetryWaitMs } from '../src/infra/models/claude/claudeTransport.js';
import type { ShannonChatModelRequest } from '../src/infra/models/chatModel.js';
import type { LlmUsageEvent } from '../src/infra/models/llmUsage.js';
import { TurnDeadline, TEXT_TURN_DEADLINE } from '../src/mind/action/respond/turnDeadline.js';
import { shannonTool } from '../src/mind/tools/shannonTools.js';
import { anthropicFixture, message, scriptedAnthropic, type AnthropicMessage } from './support/anthropicFixtures.js';

/** Stabilization 2026-10-12: one bounded Haiku retry of a transient refusal before anything ran, was billed or said. */
const base: ShannonChatModelRequest = { scopeKey: 'owner', systemPrompt: 'Identity', history: [], message: 'こんにちは' };
const paid = (model: string, value: AnthropicMessage): AnthropicMessage => ({ ...value, model, usage: { ...value.usage,
  cache_creation_input_tokens: 0, cache_read_input_tokens: 900, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } });
const refusal = (status: number, headers: Record<string, string> = {}) => new Response(JSON.stringify({ type: 'error',
  error: { type: status === 529 ? 'overloaded_error' : 'rate_limit_error', message: 'busy' } }), { status, headers: { 'content-type': 'application/json', ...headers } });
const overloaded = ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }] as const;
function stream(events: ReadonlyArray<readonly [string, unknown]>): Response {
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
function model(name: string, script: Parameters<typeof scriptedAnthropic>[0]) {
  const transport = scriptedAnthropic(script), usage: LlmUsageEvent[] = [], waits: number[] = [];
  const chat = new AnthropicChatModel({ apiKey: 'test-only', settings: { model: name, effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' },
    fetch: transport.fetcher, usageStore: { recordLlmUsage: event => { usage.push(event); }, backgroundLlmCostUsd: () => 0 },
    retryWait: async milliseconds => { waits.push(milliseconds); } });
  return { chat, bodies: transport.bodies, usage, waits };
}

describe('one bounded transient retry in Haiku mode', () => {
  it.each([false, true])('answers after one 529 that returned nothing (stream=%s)', async stream => {
    const answer = paid('claude-haiku-5-5', anthropicFixture('structured-answer'));
    const h = model('claude-haiku-5-5', (_body, index) => index === 0 ? refusal(529, { 'retry-after': '0' }) : answer);
    const parts: string[] = [];
    const result = stream ? await h.chat.generateStreaming(base, text => { parts.push(text); }) : await h.chat.generate(base);
    expect(result.reply).toEqual(expect.any(String));
    if (stream) expect(parts.join('')).toBe(result.reply);
    expect(h.bodies).toHaveLength(2);
    expect(h.bodies[1]).toEqual(h.bodies[0]);
    expect(h.usage).toHaveLength(1);
    expect(h.waits).toEqual([0]);
  });

  it('retries only once, and caps a long retry-after at three seconds', async () => {
    const h = model('claude-haiku-5-5', () => refusal(429, { 'retry-after': '30' }));
    await expect(h.chat.generate(base)).rejects.toThrow();
    expect(h.bodies).toHaveLength(2);
    expect(h.waits).toEqual([TRANSIENT_RETRY.maximumWaitMs]);
    expect(h.usage).toEqual([]);
  });

  it('never retries a refusal after a tool has run, a plain client error, or Sonnet', async () => {
    const tool = paid('claude-haiku-5-5', message([{ type: 'tool_use', id: 'call', name: 'study_list', input: {} }], 'tool_use'));
    const afterTool = model('claude-haiku-5-5', (_body, index) => index === 0 ? tool : refusal(529));
    const calls: string[] = [];
    await afterTool.chat.generate({ ...base, tools: { definitions: [shannonTool('study.list')!], maximumCalls: 6, deadline: new TurnDeadline(TEXT_TURN_DEADLINE),
      async call(name) { calls.push(name); return JSON.stringify({ ok: true, text: 'listed', retryable: false }); } } }).catch(() => null);
    expect(calls).toEqual(['study_list']);
    // The existing answer round may follow (tool_choice none); the refused request itself is never sent again.
    expect(afterTool.bodies.slice(1).every((body, index, rest) => index === 0 || JSON.stringify(body) !== JSON.stringify(rest[index - 1]))).toBe(true);
    expect(afterTool.waits).toEqual([]);

    const client = model('claude-haiku-5-5', () => refusal(401));
    await expect(client.chat.generate(base)).rejects.toThrow();
    expect(client.bodies).toHaveLength(1);

    const sonnet = model('claude-sonnet-5-5', () => refusal(529));
    await expect(sonnet.chat.generate(base)).rejects.toThrow();
    expect(sonnet.bodies).toHaveLength(1);
    expect(sonnet.waits).toEqual([]);
  });

  it('retries an overloaded error event that arrives before the response begins', async () => {
    const answer = paid('claude-haiku-5-5', anthropicFixture('structured-answer'));
    const h = model('claude-haiku-5-5', (_body, index) => index === 0 ? stream([overloaded]) : answer);
    const parts: string[] = [];
    const result = await h.chat.generateStreaming(base, text => { parts.push(text); });
    expect(parts.join('')).toBe(result.reply);
    expect(h.bodies).toHaveLength(2);
    expect(h.waits).toEqual([TRANSIENT_RETRY.defaultWaitMs]);
  });

  it('never retries once the response began (message_start received), even before any word', async () => {
    const answer = paid('claude-haiku-5-5', anthropicFixture('structured-answer'));
    const start = ['message_start', { type: 'message_start', message: { ...answer, content: [], stop_reason: null, usage: { ...answer.usage, output_tokens: 1 } } }] as const;
    const h = model('claude-haiku-5-5', () => stream([start, overloaded]));
    const parts: string[] = [];
    await expect(h.chat.generateStreaming(base, text => { parts.push(text); })).rejects.toThrow();
    expect(parts).toEqual([]);
    expect(h.bodies).toHaveLength(1);
    expect(h.waits).toEqual([]);
    expect(h.usage).toHaveLength(1); // the started response is booked conservatively, never sent again
  });

  it('never retries a connection failure: whether it was processed is unknown', async () => {
    const h = model('claude-haiku-5-5', () => { throw new TypeError('fetch failed'); });
    await expect(h.chat.generate(base)).rejects.toThrow();
    expect(h.bodies).toHaveLength(1);
    expect(h.waits).toEqual([]);
  });

  it('reads retry-after-ms, seconds and dates, defaulting to one second', () => {
    const error = (headers: Record<string, string>) => Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error' } }, 'busy', new Headers(headers));
    const now = Date.parse('2026-10-12T00:00:00.000Z');
    expect(transientRetryWaitMs(error({}), now)).toBe(TRANSIENT_RETRY.defaultWaitMs);
    expect(transientRetryWaitMs(error({ 'retry-after-ms': '250' }), now)).toBe(250);
    expect(transientRetryWaitMs(error({ 'retry-after': '2' }), now)).toBe(2_000);
    expect(transientRetryWaitMs(error({ 'retry-after': 'Mon, 12 Oct 2026 00:00:01 GMT' }), now)).toBe(1_000);
    expect(transientProviderFailure(error({}))).toBe('529');
    expect(transientProviderFailure(new Anthropic.APIConnectionError({ message: 'reset' }))).toBeNull();
    expect(transientProviderFailure(new Error('plain'))).toBeNull();
  });
});
