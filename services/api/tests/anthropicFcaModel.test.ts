import type Anthropic from '@anthropic-ai/sdk';
import { shannonIdentityPrompt, SHANNON_FCA_TASK_CAPABILITY } from '@shannon/cognition';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicFcaModel, createAnthropicFcaModel, type AnthropicFcaClient, type AnthropicFcaUsage } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { estimatedAnthropicCostUsd } from '../src/infra/models/claude/claudeUsage.js';
import { HAIKU_PROTOCOL_PREFIX } from '../src/infra/models/anthropic/haikuCache.js';
import { claudeTool } from '../src/infra/models/anthropic/anthropicRequest.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import { FCA_COMPACT_ABOVE_TOKENS, fcaCompactAboveTokens } from '../src/infra/models/anthropic/anthropicFcaCompaction.js';
import type { ShannonToolDefinition } from '../src/mind/tools/toolRegistryPorts.js';
import { message, scriptedAnthropic, type AnthropicMessage, withoutCacheMarkers } from './support/anthropicFixtures.js';
import { installObserverSink, withObserverRun } from '../src/infra/observer/observerContext.js';
import type { ObserverDraft } from '../src/contracts/observerContract.js';
import { inActionExecution, type ActionExecution } from '../src/infra/context/actionExecution.js';

const tools: ShannonToolDefinition[] = ['task.create', 'task.list', 'task.get', 'task.send'].map(name => ({
  name, description: `Synthetic definition of ${name}`, domain: 'meta', effect: 'write', cost: 'none',
  audiences: ['owner_alone'], surfaces: ['autonomy'],
  input: { type: 'object', properties: { value: { type: 'string', description: 'Synthetic argument' } }, required: [], additionalProperties: false },
}));
const input = (history: readonly unknown[] = []): FcaModelInput => ({
  task: { id: 'task-1', title: 'Synthetic task', goal: 'Observe a child result', completionCriteria: 'An actual result is present' },
  children: [{ id: 'child-1', title: 'Research', phase: 'completed', summary: 'Fact verified' }],
  messages: [{ id: 'message-1', text: 'Synthetic instruction', sourceTaskId: 'parent-1' }], tools, history,
});
const nativeUsage = (creation = 700, read = 0) => ({ input_tokens: 12, output_tokens: 30,
  cache_creation_input_tokens: creation, cache_read_input_tokens: read,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: creation } });
const call = (name = 'task_list', id = 'tool-1', args: unknown = {}) => ({ type: 'tool_use', name, id, input: args });
const answer = (content: Array<Record<string, unknown>> = [call()], usage: unknown = nativeUsage(), stop = 'tool_use') => message(content, stop, { model: 'claude-haiku-5-5', usage });
const signal = () => new AbortController().signal;

function harness(script: AnthropicMessage[]) {
  const fixture = scriptedAnthropic(script);
  const receipts: AnthropicFcaUsage[] = [];
  const model = createAnthropicFcaModel({ apiKey: 'synthetic-fca-key', fetcher: fixture.fetcher, recordUsage: usage => { receipts.push(usage); } });
  return { ...fixture, receipts, model };
}

afterEach(() => vi.unstubAllEnvs());

describe('native one-step FCA model', () => {
  it('puts the source-checked skill index in dynamic context while preserving the stable prefix and signed replay', async () => {
    const fixture = harness([answer([call('fca_wait', 'wait-1', { summary: 'Wait for requested evidence' })]), answer([call('task_list', 'next-list')], nativeUsage(0, 700))]);
    const first = await fixture.model.decide({ ...input(), skillIndex: 'First compact skill index' }, signal());
    const signed = { role: 'assistant', content: [{ type: 'thinking', thinking: 'Opaque fixture', signature: 'stable-signature' }, { type: 'text', text: 'Public evidence' }] };
    const replay = [...first.history, signed];
    await fixture.model.decide({ ...input(replay), skillIndex: 'Updated compact skill index' }, signal());
    expect(fixture.bodies[0]!.system).toEqual(fixture.bodies[1]!.system);
    expect(JSON.stringify(fixture.bodies[0]!.system)).not.toContain('First compact skill index');
    expect(JSON.parse(String((fixture.bodies[0]!.messages as Array<{ content: unknown }>).at(-1)!.content)).skillIndex).toBe('First compact skill index');
    expect(JSON.parse(String((fixture.bodies[1]!.messages as Array<{ content: unknown }>).at(-1)!.content)).skillIndex).toBe('Updated compact skill index');
    expect(withoutCacheMarkers((fixture.bodies[1]!.messages as unknown[]).slice(0, replay.length))).toEqual(replay);
  });
  it('states in the dynamic context, not the cached prefix, that nobody can answer the task (Minebot lane run 1)', async () => {
    const fixture = harness([answer([call('task_list', 'list-1')]), answer([call('task_list', 'list-2')], nativeUsage(0, 700))]);
    await fixture.model.decide({ ...input(), waiting: { replyPossible: false, refusedWaits: 1, refusalLimit: 2 } }, signal());
    await fixture.model.decide(input(), signal());
    const current = (index: number) => JSON.parse(String((fixture.bodies[index]!.messages as Array<{ content: unknown }>).at(-1)!.content));
    expect(current(0).waiting).toMatchObject({ replyPossible: false, refusedWaits: 1, refusalLimit: 2, rule: expect.stringContaining('fca_wait is turned away') });
    expect(current(1)).not.toHaveProperty('waiting');
    expect(fixture.bodies[0]!.system).toEqual(fixture.bodies[1]!.system);
  });
  it('makes one call, offers the existing schemas (only controls strict), maps provider names and returns only appended native history', async () => {
    const signed = { type: 'thinking', thinking: 'Synthetic private thinking', signature: 'opaque-signature' };
    const redacted = { type: 'redacted_thinking', data: 'opaque-redacted-data' };
    const previous = [
      { role: 'user', content: 'Original request' },
      { role: 'assistant', content: [signed, redacted, call('task_get', 'old-call')] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old-call', content: 'Original result', is_error: false }] },
    ];
    const content = [signed, redacted, call('task_list', 'new-list'), call('task_get', 'new-get', { value: 'child-1' })];
    const fixture = harness([answer(content)]);
    const original = JSON.stringify(previous);
    const result = await fixture.model.decide(input(previous), signal());
    expect(fixture.bodies).toHaveLength(1);
    expect(result.decision).toEqual({ kind: 'tools', calls: [
      { id: 'new-list', name: 'task.list', input: {} }, { id: 'new-get', name: 'task.get', input: { value: 'child-1' } },
    ] });
    expect(fixture.bodies[0]!.tools).toEqual([...tools.map(tool => ({ ...claudeTool(tool), strict: false })),
      expect.objectContaining({ name: 'fca_wait', strict: true }), expect.objectContaining({ name: 'fca_complete', strict: true })]);
    expect(withoutCacheMarkers(fixture.bodies[0]!.messages)).toEqual([...previous, { role: 'user', content: JSON.stringify({ task: input().task, children: input().children, messages: input().messages }) }]);
    expect(result.history).toEqual([{ role: 'user', content: JSON.stringify({ task: input().task, children: input().children, messages: input().messages }) },
      { role: 'assistant', content }]);
    expect(JSON.stringify(previous)).toBe(original);
    expect(fixture.receipts).toEqual([{ model: 'claude-haiku-5-5', usageComplete: true, inputTokens: 712, cachedInputTokens: 0,
      cacheCreationInputTokens: 700, outputTokens: 30, totalTokens: 742,
      estimatedCostUsd: estimatedAnthropicCostUsd('claude-haiku-5-5', { input: 12, output: 30, cacheWrite: 700, cacheRead: 0, searches: 0 }) }]);
  });

  it.each(['wait', 'complete'] as const)('acknowledges the %s control call before the next native request', async kind => {
    const content = [{ type: 'thinking', thinking: '', signature: 'keep-me' }, call(`fca_${kind}`, 'control-1', { summary: 'Synthetic public summary' })];
    const fixture = harness([answer(content), answer([call('task_list', 'later-call')], nativeUsage(0, 700))]);
    const first = await fixture.model.decide(input(), signal());
    expect(first.decision).toEqual({ kind, summary: 'Synthetic public summary' });
    expect(first.history).toHaveLength(3);
    expect(first.history[1]).toEqual({ role: 'assistant', content });
    expect(first.history[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'control-1', is_error: false,
      content: JSON.stringify({ received: true, requestedDecision: kind }) }] });
    const next = input(first.history);
    next.messages = [{ id: 'message-2', text: 'New information', sourceTaskId: 'child-1' }];
    await fixture.model.decide(next, signal());
    expect(withoutCacheMarkers((fixture.bodies[1]!.messages as unknown[]).slice(0, 3))).toEqual(first.history);
    expect(fixture.bodies[0]!.system).toEqual(fixture.bodies[1]!.system);
    expect(fixture.bodies[0]!.tools).toEqual(fixture.bodies[1]!.tools);
    const system = fixture.bodies[0]!.system as Anthropic.TextBlockParam[];
    expect(system[0]).toEqual({ type: 'text', text: HAIKU_PROTOCOL_PREFIX, cache_control: { type: 'ephemeral', ttl: '1h' } });
    expect(system[1]!.text.startsWith(shannonIdentityPrompt())).toBe(true);
    expect(system[1]!.text).toContain(SHANNON_FCA_TASK_CAPABILITY.text);
    expect(system[1]!.text).not.toContain('Synthetic task');
    // The fixed instructions end with their own breakpoint, so a new public epoch still reads them (Minebot lane 2026-10-14,
    // task 788da00a: 1,792–1,798 cached tokens, only the tools and the protocol prefix); the conversation keeps the automatic one.
    expect(system).toHaveLength(2);
    expect(system[1]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    // The second request also marks its last history block (the acknowledged control result): four breakpoints in all, and the
    // stored history carries none.
    expect(JSON.stringify(fixture.bodies[0]!.messages)).not.toContain('cache_control');
    const replayed = fixture.bodies[1]!.messages as Array<{ content: Array<Record<string, unknown>> | string }>;
    expect((replayed[2]!.content as Array<Record<string, unknown>>).at(-1)!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(JSON.stringify(replayed).match(/cache_control/gu)).toHaveLength(1);
    expect(JSON.stringify(fixture.bodies[1]).match(/cache_control/gu)).toHaveLength(4);
    expect(JSON.stringify(first.history)).not.toContain('cache_control');
    for (const body of fixture.bodies) expect(body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 4_000,
      thinking: { type: 'adaptive' }, output_config: { effort: 'low' }, cache_control: { type: 'ephemeral', ttl: '1h' }, tool_choice: { type: 'auto' } });
    expect(fixture.receipts[1]).toMatchObject({ usageComplete: true, cachedInputTokens: 700, cacheCreationInputTokens: 0 });
  });

  it('returns native user tool results in caller order without executing any tools or making a model call', () => {
    const fixture = harness([]);
    expect(fixture.model.toolResults([{ id: 'ok-1', text: 'Observed result', ok: true }, { id: 'bad-1', text: 'Refused by gate', ok: false }]))
      .toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ok-1', content: 'Observed result', is_error: false },
        { type: 'tool_result', tool_use_id: 'bad-1', content: 'Refused by gate', is_error: true }] });
    expect(() => fixture.model.toolResults([])).toThrow('FCA_MODEL_RESULTS_INVALID');
    expect(() => fixture.model.toolResults([{ id: 'same', text: '', ok: true }, { id: 'same', text: '', ok: false }])).toThrow('FCA_MODEL_RESULTS_INVALID');
    expect(fixture.bodies).toHaveLength(0);
  });

  it('permits explicit Sonnet 5.5 while preserving its one-hour cache contract and prices', async () => {
    const fixture = scriptedAnthropic([answer()]);
    const receipts: AnthropicFcaUsage[] = [];
    const model = new AnthropicFcaModel({ model: 'claude-sonnet-5-5', apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage: usage => { receipts.push(usage); } });
    await model.decide(input(), signal());
    expect(fixture.bodies[0]).toMatchObject({ model: 'claude-sonnet-5-5', cache_control: { ttl: '1h' } });
    expect(receipts[0]!.estimatedCostUsd).toBe(estimatedAnthropicCostUsd('claude-sonnet-5-5', { input: 12, output: 30, cacheWrite: 700, cacheRead: 0, searches: 0 }));
    expect(() => new AnthropicFcaModel({ model: 'gpt-anything', apiKey: 'synthetic', recordUsage() {} })).toThrow('FCA_MODEL_CONFIG_INVALID');
  });
});

describe('the estimated size of an FCA request (the 100k-token price step)', () => {
  it('logs every request\'s estimated input tokens, and warns, still sending it, when it passes the step', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = harness([answer(), answer()]);
    await fixture.model.decide(input(), signal());
    const long = { ...input(), messages: [{ id: 'long', text: '原木'.repeat(50_000), sourceTaskId: 'parent-1' }] };
    await fixture.model.decide(long, signal());
    const sizes = info.mock.calls.map(args => String(args[0])).filter(line => line.includes('fca_request_size')).map(line => JSON.parse(line));
    expect(sizes.map(size => size.estimatedInputTokens)).toEqual([expect.any(Number), expect.any(Number)]);
    expect(sizes[0].estimatedInputTokens).toBeLessThan(10_000);
    expect(sizes[1].estimatedInputTokens).toBeGreaterThan(100_000);
    expect(fixture.bodies).toHaveLength(2);
    const warnings = warn.mock.calls.map(args => String(args[0])).filter(line => line.includes('fca_request_price_step'));
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(warnings[0]!)).toEqual({ event: 'fca_request_price_step', model: 'claude-haiku-5-5', estimatedInputTokens: sizes[1].estimatedInputTokens });
    expect(warnings[0]).not.toContain('原木');
  });
});

describe('compaction before the price step (C4)', () => {
  const bulky = (): FcaModelInput => ({ ...input(), body: { report: 'インベントリ'.repeat(40_000), position: { x: 1, y: 64, z: -3 } },
    observations: [{ kind: 'look', text: '見えたもの'.repeat(20_000) }] } as unknown as FcaModelInput);
  const sent = (fixture: ReturnType<typeof harness>, index: number) => JSON.parse(String((fixture.bodies[index]!.messages as Array<{ content: unknown }>).at(-1)!.content));

  it('shortens the decision message below the threshold before sending, keeping the task, the owner\'s words and every id', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = harness([answer()]);
    const output = await fixture.model.decide(bulky(), signal());
    const sizes = info.mock.calls.map(args => String(args[0])).filter(line => line.includes('fca_request_size')).map(line => JSON.parse(line));
    expect(sizes[0].estimatedInputTokens).toBeLessThanOrEqual(FCA_COMPACT_ABOVE_TOKENS);
    expect(warn.mock.calls.some(args => String(args[0]).includes('fca_request_price_step'))).toBe(false);
    const compacted = info.mock.calls.map(args => String(args[0])).filter(line => line.includes('fca_request_compacted')).map(line => JSON.parse(line));
    expect(compacted).toEqual([{ event: 'fca_request_compacted', model: 'claude-haiku-5-5', level: expect.any(Number), maximumTokens: FCA_COMPACT_ABOVE_TOKENS }]);
    const message = sent(fixture, 0);
    expect(message.task).toEqual(input().task);
    expect(message.messages).toEqual(input().messages);
    expect(message.body.position).toEqual({ x: 1, y: 64, z: -3 });
    expect(message.body.report).toMatch(/…（長いため後略: \d+字）$/u);
    expect(message.body.report.length).toBeLessThan('インベントリ'.repeat(40_000).length);
    // Stored as sent: the replay of the next decision holds the shortened message.
    expect(output.history[0]).toEqual((fixture.bodies[0]!.messages as unknown[]).at(-1));
  });

  it('sends a request under the threshold unchanged, and reads the threshold from its option', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = harness([answer()]);
    await fixture.model.decide({ ...input(), body: { report: '短い報告' } } as unknown as FcaModelInput, signal());
    expect(sent(fixture, 0).body).toEqual({ report: '短い報告' });
    const small = scriptedAnthropic([answer()]);
    const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: small.fetcher, recordUsage() {}, compactAboveTokens: 5_000 });
    await model.decide({ ...input(), body: { report: 'あ'.repeat(20_000) } } as unknown as FcaModelInput, signal());
    expect(JSON.parse(String((small.bodies[0]!.messages as Array<{ content: unknown }>).at(-1)!.content)).body.report.length).toBeLessThan(5_000);
    expect(() => createAnthropicFcaModel({ apiKey: 'synthetic', recordUsage() {}, compactAboveTokens: 0 })).toThrow('FCA_MODEL_CONFIG_INVALID');
  });

  it('takes SHANNON_FCA_COMPACT_ABOVE_TOKENS when it is a positive whole number', () => {
    expect(fcaCompactAboveTokens(undefined)).toBe(95_000);
    expect(fcaCompactAboveTokens('90000')).toBe(90_000);
    for (const value of ['', ' ', '0', '-5', '1.5', 'many']) expect(fcaCompactAboveTokens(value)).toBe(95_000);
  });
});

describe('FCA usage evidence and invalid decisions', () => {
  it.each([
    [nativeUsage(0, 0), 'HAIKU_CACHE_UNCONFIRMED'],
    [{ ...nativeUsage(), cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 699 } }, 'HAIKU_CACHE_USAGE_INVALID'],
  ])('records spent usage before the real cache validator rejects %j', async (usage, code) => {
    const fixture = harness([answer([call()], usage)]);
    await expect(fixture.model.decide(input(), signal())).rejects.toThrow(String(code));
    expect(fixture.receipts).toHaveLength(1);
    expect(fixture.receipts[0]).toMatchObject({ usageComplete: true, outputTokens: 30 });
    expect(fixture.receipts[0]!.estimatedCostUsd).toBeGreaterThan(0);
    expect(fixture.bodies).toHaveLength(1);
  });

  it.each([undefined, null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('keeps a malformed required counter %s unknown with paid lower bounds and no retry', async count => {
    const fixture = harness([answer([call()], { ...nativeUsage(), input_tokens: count })]);
    await expect(fixture.model.decide(input(), signal())).rejects.toThrow('HAIKU_RESPONSE_USAGE_INVALID');
    expect(fixture.bodies).toHaveLength(1);
    expect(fixture.receipts).toHaveLength(1);
    expect(fixture.receipts[0]).toMatchObject({ usageComplete: false, inputTokens: 700, outputTokens: 30 });
    expect(fixture.receipts[0]!.estimatedCostUsd).toBeGreaterThan(1);
  });

  it('keeps absent usage unknown, and accepts actual mixed provider cache TTLs', async () => {
    const missing = harness([answer([call()], null)]);
    await expect(missing.model.decide(input(), signal())).rejects.toThrow('HAIKU_RESPONSE_USAGE_INVALID');
    expect(missing.receipts[0]).toMatchObject({ usageComplete: false });
    const mixed = harness([answer([call()], { ...nativeUsage(), cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 300 } })]);
    await mixed.model.decide(input(), signal());
    expect(mixed.receipts[0]!.estimatedCostUsd).toBe(estimatedAnthropicCostUsd('claude-haiku-5-5', {
      input: 12, output: 30, cacheWrite: 700, cacheRead: 0, searches: 0, cacheWrite5m: 400, cacheWrite1h: 300,
    }));
  });

  it.each([
    [[], 'tool_use', 'FCA_MODEL_OUTPUT_INVALID'],
    [[{ type: 'text', text: 'Unstructured final answer' }], 'end_turn', 'FCA_MODEL_DECISION_MISSING'],
    [[call()], 'max_tokens', 'FCA_MODEL_TRUNCATED'],
    [[call()], 'refusal', 'FCA_MODEL_REFUSED'],
    [[call()], 'pause_turn', 'FCA_MODEL_DECISION_MISSING'],
    [[call(), call('task_get')], 'tool_use', 'FCA_MODEL_CALL_INVALID'],
    [[call('not_offered')], 'tool_use', 'FCA_MODEL_TOOL_NOT_OFFERED'],
    [[call('task_list', 'bad-input', [])], 'tool_use', 'FCA_MODEL_CALL_INVALID'],
    [[call('fca_wait', 'wait', { summary: 'Waiting' }), call()], 'tool_use', 'FCA_MODEL_CONTROL_MIXED'],
    [[call('fca_wait', 'wait', { summary: 'Waiting' }), call('fca_complete', 'done', { summary: 'Done' })], 'tool_use', 'FCA_MODEL_CONTROL_MIXED'],
    [[call('fca_complete', 'done', { summary: ' ' })], 'tool_use', 'FCA_MODEL_SUMMARY_INVALID'],
    [[call('fca_complete', 'done', { summary: 'Done', extra: true })], 'tool_use', 'FCA_MODEL_SUMMARY_INVALID'],
  ])('rejects an invalid decision without a repair call (%s, %s)', async (content, stop, code) => {
    const fixture = harness([answer(content as Array<Record<string, unknown>>, nativeUsage(), String(stop))]);
    await expect(fixture.model.decide(input(), signal())).rejects.toThrow(String(code));
    expect(fixture.bodies).toHaveLength(1);
    expect(fixture.receipts).toHaveLength(1);
    expect(fixture.receipts[0]!.usageComplete).toBe(true);
  });

  it('rejects reused tool ids, malformed history and provider-name collisions', async () => {
    const fixture = harness([answer()]);
    const prior = [{ role: 'user', content: 'Task' }, { role: 'assistant', content: [call()] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Done' }] }];
    await expect(fixture.model.decide(input(prior), signal())).rejects.toThrow('FCA_MODEL_CALL_INVALID');
    await expect(fixture.model.decide(input([{ role: 'system', content: 'Cannot replace task authority' }]), signal())).rejects.toThrow('FCA_MODEL_HISTORY_INVALID');
    await expect(fixture.model.decide({ ...input(), tools: [tools[0]!, { ...tools[0]!, name: 'task_create' }] }, signal())).rejects.toThrow('FCA_MODEL_TOOL_CONFLICT');
    await expect(fixture.model.decide({ ...input(), tools: [{ ...tools[0]!, name: 'fca.wait' }] }, signal())).rejects.toThrow('FCA_MODEL_TOOL_CONFLICT');
    expect(fixture.bodies).toHaveLength(1);
  });
});

describe('FCA native transport boundary', () => {
  it('observes native encoding and exactly the provider call without exposing task, history or signed response content', async () => {
    const events: ObserverDraft[] = [];
    const restore = installObserverSink(event => { events.push(event); });
    const privateValues = ['private-task-title', 'private-goal', 'private-criteria', 'private-message-body', 'private-old-history',
      'private-thinking-body', 'private-native-signature', 'private-redacted-block', 'private-control-summary'];
    const fixture = scriptedAnthropic([answer([
      { type: 'thinking', thinking: privateValues[5], signature: privateValues[6] },
      { type: 'redacted_thinking', data: privateValues[7] }, call('fca_wait', 'control', { summary: privateValues[8] }),
    ])]);
    const fetcher = (async (url, init) => {
      expect(events.at(-1)).toMatchObject({ node: 'llm', kind: 'span.started' });
      return fixture.fetcher(url, init);
    }) as typeof fetch;
    const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher, recordUsage() {
      expect(events.at(-1)).toMatchObject({ node: 'llm', kind: 'span.completed' });
    } });
    const request: FcaModelInput = { ...input([{ role: 'user', content: privateValues[4] }]),
      task: { id: 'task-1', title: privateValues[0]!, goal: privateValues[1]!, completionCriteria: privateValues[2]! },
      children: [{ id: 'child-1', title: 'Research', phase: 'completed', summary: 'Fact verified' }],
  messages: [{ id: 'message-1', sourceTaskId: 'parent-1', text: privateValues[3]! }] };
    try {
      await withObserverRun({ scopeKey: 'owner', surface: 'fca', runId: 'distinct-fca-run' }, () => model.decide(request, signal()));
      expect(fixture.bodies).toHaveLength(1);
      const native = events.filter(event => event.node === 'native');
      const llm = events.filter(event => event.node === 'llm' && event.kind !== 'handoff');
      expect(native.map(event => event.kind)).toEqual(['span.started', 'span.completed']);
      expect(llm.map(event => event.kind)).toEqual(['span.started', 'span.completed']);
      expect(events.find(event => event.kind === 'handoff')).toMatchObject({ fromNode: 'native', toNode: 'llm', sourceSpanId: native[0]!.spanId });
      expect(llm[0]!.input).toEqual({ model: 'claude-haiku-5-5', messageCount: 2, maximumOutputTokens: 4_000,
        offeredTools: ['task.create', 'task.list', 'task.get', 'task.send', 'fca_wait', 'fca_complete'] });
      expect(llm[1]!.output).toMatchObject({ stopReason: 'tool_use', selectedTools: ['fca_wait'], usage: { inputTokens: 12, cacheCreationTokens: 700 } });
      expect(events.every(event => event.runId === 'distinct-fca-run')).toBe(true);
      const projected = JSON.stringify(events);
      for (const value of privateValues) expect(projected).not.toContain(value);
      expect(projected).not.toContain(shannonIdentityPrompt());
      expect(projected).not.toContain('signature');
      expect(projected).not.toContain('thinking');
      expect(projected).not.toContain('requestedDecision');
    } finally { restore(); }
  });

  it('uses only explicit API credentials and official endpoint despite ambient SDK settings', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://wrong.example.test');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'synthetic-ambient-token');
    vi.stubEnv('ANTHROPIC_LOG', 'debug');
    const fixture = scriptedAnthropic([answer()]);
    const urls: string[] = []; const headers: Headers[] = [];
    const fetcher = (async (url, init) => { urls.push(String(url)); headers.push(new Headers(init?.headers)); return fixture.fetcher(url, init); }) as typeof fetch;
    const model = createAnthropicFcaModel({ apiKey: 'synthetic-explicit', fetcher, recordUsage() {} });
    await model.decide(input(), signal());
    expect(urls).toEqual(['https://api.anthropic.com/v1/messages']);
    expect(headers[0]!.get('x-api-key')).toBe('synthetic-explicit');
    expect(headers[0]!.get('authorization')).toBeNull();
    expect(() => createAnthropicFcaModel({ recordUsage() {} })).toThrow('ANTHROPIC_API_KEY_REQUIRED');
  });

  it.each([400, 500])('never retries HTTP %s; a server error keeps its unknown spend but is a known outcome', async status => {
    const fixture = scriptedAnthropic(() => new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'synthetic-private-error' } }),
      { status, headers: { 'content-type': 'application/json' } }));
    const receipts: AnthropicFcaUsage[] = [];
    const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage: usage => { receipts.push(usage); } });
    await expect(model.decide(input(), signal())).rejects.toThrow(`FCA_MODEL_HTTP_${status}`);
    expect(fixture.bodies).toHaveLength(1);
    expect(receipts).toHaveLength(status === 400 ? 0 : 1);
    if (status === 500) expect(receipts[0]).toMatchObject({ usageComplete: false });
  });

  it('supports client injection, forwards cancellation and records an interrupted request as unknown once', async () => {
    const controller = new AbortController();
    const receipts: AnthropicFcaUsage[] = [];
    let calls = 0;
    const client: AnthropicFcaClient = { messages: { create: async (_body, options) => {
      calls += 1;
      expect(options.maxRetries).toBe(0);
      expect(options.signal.aborted).toBe(false);
      controller.abort();
      expect(options.signal.aborted).toBe(true);
      throw new Error('synthetic-private-error');
    } } };
    const model = createAnthropicFcaModel({ client, recordUsage: usage => { receipts.push(usage); } });
    await expect(model.decide(input(), controller.signal)).rejects.toThrow('FCA_MODEL_ABORTED');
    expect(calls).toBe(1);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ usageComplete: false });
    await expect(model.decide(input(), controller.signal)).rejects.toThrow('FCA_MODEL_ABORTED');
    expect(calls).toBe(1);
    expect(receipts).toHaveLength(1);
  });

  it.each([true, false])('acknowledges cancellation after a response only with complete recorded usage (%s)', async complete => {
    const controller = new AbortController();
    const execution: ActionExecution = { lease: { id: 'original-action', holder: 'api', generation: 1 },
      signal: controller.signal, permit: async () => { throw new Error('runner_already_checked_permit'); } };
    const usage = nativeUsage();
    const fixture = scriptedAnthropic([answer([call()], complete ? usage : { ...usage, output_tokens: null })]);
    const receipts: AnthropicFcaUsage[] = [];
    const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage(receipt) {
      expect(execution.modelOutcome).toBe('unknown');
      receipts.push(receipt); controller.abort();
    } });
    await expect(inActionExecution(execution, () => model.decide(input(), controller.signal))).rejects.toThrow(
      complete ? 'FCA_MODEL_ABORTED' : 'HAIKU_RESPONSE_USAGE_INVALID');
    expect(execution.modelOutcome).toBe(complete ? 'acknowledged' : 'unknown');
    expect(receipts).toHaveLength(1);
    expect(fixture.bodies).toHaveLength(1);
    if (complete) expect(execution.modelUsage).toEqual({ inputTokens: 712, outputTokens: 30 });
    else expect(execution.modelUsage).toBeUndefined();
  });
});
