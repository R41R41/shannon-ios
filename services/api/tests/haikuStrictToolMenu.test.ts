import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { estimatedAnthropicCostUsd } from '../src/infra/models/anthropic/anthropicConfig.js';
import type { LlmUsageEvent } from '../src/infra/models/llmUsage.js';
import { withToolMenu } from '../src/mind/tools/shannonToolMenu.js';
import { offeredTools, providerToolName, toolResultForModel } from '../src/mind/tools/shannonTools.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
import { TurnDeadline, TEXT_TURN_DEADLINE } from '../src/mind/action/respond/turnDeadline.js';
import { MinecraftBodyRequests } from '../src/surfaces/minecraft/minecraftBodyRequests.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { SQLiteAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { anthropicFixture, message, scriptedAnthropic, type AnthropicMessage } from './support/anthropicFixtures.js';

const model = 'claude-haiku-5-5';
const goal = 'エンダードラゴンを討伐してください';
const base = { scopeKey: 'owner', systemPrompt: 'Synthetic owner identity', history: [], message: goal };
const paid = (value: AnthropicMessage): AnthropicMessage => ({ ...value, model, usage: { ...value.usage,
  input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 900,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 } } });
const signed = (id: string, name: string, input: unknown) => paid(message([
  { type: 'thinking', thinking: '', signature: `signed-${id}` }, { type: 'tool_use', id, name, input },
], 'tool_use'));
type Tool = { name: string; strict?: boolean; input_schema?: { properties?: Record<string, { enum?: string[] }>; required?: string[] } };
type Body = Record<string, unknown>;
type Messages = Array<{ role: string; content: Array<Record<string, unknown>> | string }>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
const closed: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of closed.splice(0)) close(); });

async function session(chosen: string[]) {
  const now = () => '2026-10-08T12:00:00.000Z';
  const requests = new MinecraftBodyRequests(':memory:', { deviceId: 'synthetic-body', ownerScopeKey: 'owner' }, now);
  const store = new SQLiteAutonomyStore(':memory:');
  const autonomy = createInMemoryAutonomyService(now, { store, minecraftBody: requests });
  closed.push(() => { requests.close(); store.close(); });
  await requests.claim('owner', 'synthetic-body', { waitSeconds: 0, holding: [] });
  const definitions = offeredTools('text', 'owner_alone');
  const calls: string[] = [];
  const tools = withToolMenu({ definitions, maximumCalls: 6, deadline: new TurnDeadline(TEXT_TURN_DEADLINE),
    async call(name, input) {
      calls.push(name);
      return toolResultForModel(await autonomy.tools.call(name.replaceAll('_', '.'), input, {
        scopeKey: 'owner', surface: 'text', audience: 'owner_alone', memory: toolSessionMemory('original-turn'), threadId: 'original-talk',
      }));
    },
  }, chosen);
  return { tools, requests, calls, definitions };
}

/** An offline provider boundary: the documented strict-schema cap is enforced before a message is returned. */
function native(script: (body: Body, index: number) => AnthropicMessage | Response) {
  const usage: LlmUsageEvent[] = [];
  const headers: Headers[] = [];
  const transport = scriptedAnthropic((body, index) => {
    const top = (body.tools ?? []) as Tool[];
    const inline = (body.messages as Messages).flatMap(item => Array.isArray(item.content) ? item.content.flatMap(block => {
      const tool = block.tool as { type?: string; definition?: Tool } | undefined;
      return block.type === 'tool_addition' && tool?.type === 'tool_definition' && tool.definition ? [tool.definition] : [];
    }) : []);
    const strict = [...top, ...inline].filter(tool => tool.strict === true);
    if (strict.length > 20) return rejected(400, 'private synthetic error payload');
    return script(body, index);
  });
  const chat = new AnthropicChatModel({ apiKey: 'test-only', settings: { model, effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' },
    fetch: (input, init) => { headers.push(new Headers(init?.headers)); return transport.fetcher(input, init); },
    usageStore: { recordLlmUsage: event => usage.push(event), backgroundLlmCostUsd: () => 0 },
  });
  return { chat, usage, bodies: transport.bodies, headers };
}
function rejected(status: number, text: string) {
  return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: text } }),
    { status, headers: { 'content-type': 'application/json' } });
}

describe('Haiku full registry and strict tool admission', () => {
  it('keeps every offered tool strict and discoverable while a chosen original goal reaches the real queue once', async () => {
    const t = await session(['minecraft_request']);
    expect(t.definitions.length).toBeGreaterThan(20);
    const h = native((_body, index) => index === 0 ? signed('original-request', 'minecraft_request', { goal }) : paid(anthropicFixture('structured-answer')));
    await h.chat.generate({ ...base, tools: t.tools });
    const initial = h.bodies[0]!.tools as Tool[];
    expect(initial.map(tool => tool.name)).toEqual(['aether_propose', 'minecraft_request', 'minecraft_cancel', 'tool_open']);
    expect(initial.every(tool => tool.strict === true)).toBe(true);
    expect(initial.find(tool => tool.name === 'tool_open')!.input_schema!.properties!.name!.enum)
      .toEqual(t.definitions.map(tool => providerToolName(tool.name)));
    expect(h.bodies).toHaveLength(2);
    expect(t.calls).toEqual(['minecraft_request']);
    expect(t.requests.recent('owner')).toHaveLength(1);
    expect(t.requests.recent('owner')[0]).toMatchObject({ goal, state: 'queued', origin: { surface: 'text', threadId: 'original-talk' } });
    expect(h.bodies[1]!.tools).toEqual(initial);
    expect(h.headers.every(header => header.get('anthropic-beta') === 'inline-tools-2026-09-15')).toBe(true);
    expect(h.bodies.every(body => body.cache_control && (body.cache_control as { ttl: string }).ttl === '1h')).toBe(true);
    expect(h.usage).toHaveLength(2);
    expect(h.usage.every(event => event.inputTokens === 1_200 && event.cachedInputTokens === 900 && event.outputTokens === 50)).toBe(true);
    const charge = estimatedAnthropicCostUsd(model, { input: 100, cacheRead: 900, output: 50, cacheWrite: 200,
      cacheWrite5m: 0, cacheWrite1h: 200, searches: 0 });
    expect(h.usage.reduce((sum, event) => sum + event.estimatedCostUsd, 0)).toBeCloseTo(charge * 2, 10);
  });

  it('refuses hidden execution, then opens by value without changing signed history or executing the original goal twice', async () => {
    const t = await session([]);
    const attempt = signed('hidden', 'minecraft_request', { goal });
    const open = signed('open', 'tool_open', { name: 'minecraft_request' });
    const execute = signed('execute', 'minecraft_request', { goal });
    const script = [attempt, open, execute, paid(anthropicFixture('structured-answer'))];
    const h = native((body, index) => {
      if (index > 0) {
        const previous = h.bodies[index - 1]!;
        expect(digest(body.tools)).toBe(digest(previous.tools));
        expect(digest(body.system)).toBe(digest(previous.system));
        const prior = previous.messages as Messages;
        expect(digest((body.messages as Messages).slice(0, prior.length))).toBe(digest(prior));
        expect((body.messages as Messages)[prior.length]).toEqual({ role: 'assistant', content: script[index - 1]!.content });
      }
      if (index === 1) expect(t.requests.recent('owner')).toEqual([]);
      if (index === 2) {
        expect(t.requests.recent('owner')).toEqual([]);
        expect((body.messages as Messages).at(-1)).toEqual({ role: 'system', content: [{ type: 'tool_addition', tool: {
          type: 'tool_definition', definition: expect.objectContaining({ name: 'minecraft_request', strict: true }),
        } }] });
      }
      return script[index]!;
    });
    await h.chat.generate({ ...base, tools: t.tools });
    expect(t.calls).toEqual(['minecraft_request']);
    expect(t.requests.recent('owner')).toHaveLength(1);
    expect(t.requests.recent('owner')[0]!.goal).toBe(goal);
    expect(h.bodies).toHaveLength(4);
    expect(h.usage).toHaveLength(4);
  });

  it('keeps the explicit 400 fallback once and logs only its closed category and numeric status', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = await session(['minecraft_request']);
    const h = native((_body, index) => index === 0 ? rejected(400, 'DO_NOT_LOG_PRIVATE_PROVIDER_CONTENT') : paid(anthropicFixture('structured-answer')));
    const result = await h.chat.generate({ ...base, tools: t.tools });
    expect(result.reply).toBeTruthy();
    expect(h.bodies).toHaveLength(2);
    expect(h.bodies[1]!.tools).toBeUndefined();
    expect(h.usage).toHaveLength(1);
    expect(t.requests.recent('owner')).toEqual([]);
    expect(log.mock.calls).toEqual([[JSON.stringify({ event: 'anthropic_tool_offer_refused', status: 400, category: 'offered_request_rejected' })]]);
  });

  it.each([401, 403, 408, 409, 429])('does not classify status %s as a schema refusal or issue a plain recovery', async status => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = await session(['minecraft_request']);
    const h = native(() => rejected(status, 'DO_NOT_LOG_PRIVATE_PROVIDER_CONTENT'));
    await expect(h.chat.generate({ ...base, tools: t.tools })).rejects.toThrow();
    expect(h.bodies).toHaveLength(1);
    expect(log.mock.calls).toEqual([]);
    expect(h.usage).toEqual([]);
    expect(t.requests.recent('owner')).toEqual([]);
  });
});
