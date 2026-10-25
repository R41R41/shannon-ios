import type Anthropic from '@anthropic-ai/sdk';
import { shannonIdentityPrompt, SHANNON_FCA_TASK_CAPABILITY } from '@shannon/cognition';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicFcaModel, createAnthropicFcaModel, type AnthropicFcaClient, type AnthropicFcaUsage } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { estimatedAnthropicCostUsd, unknownCostUpperBound } from '../src/infra/models/claude/claudeUsage.js';
import { retryAfterMilliseconds } from '../src/infra/models/anthropic/anthropicFcaFailure.js';
import { FcaProviderError, retryVerdict } from '../src/mind/action/fca/fcaProviderRetry.js';
import { HAIKU_PROTOCOL_PREFIX } from '../src/infra/models/anthropic/haikuCache.js';
import { claudeTool } from '../src/infra/models/anthropic/anthropicRequest.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import { FCA_COMPACT_ABOVE_TOKENS, fcaCompactAboveTokens } from '../src/infra/models/anthropic/anthropicFcaCompaction.js';
import type { ShannonToolDefinition } from '../src/mind/tools/toolRegistryPorts.js';
import { message, scriptedAnthropic, type AnthropicMessage, withoutCacheMarkers } from './support/anthropicFixtures.js';
import { installObserverSink, withObserverRun } from '../src/infra/observer/observerContext.js';
import type { ObserverDraft } from '../src/contracts/observerContract.js';
import { inActionExecution, type ActionExecution } from '../src/infra/context/actionExecution.js';
import { FcaNoDecisionError, FcaNoResponseError } from '../src/mind/action/fca/fcaNoResponse.js';

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

describe('the skill gists a request carries (Minebot run 12: did the gist reach the model?)', () => {
  it('logs how many gists the decision message holds, 0 when none, keeping every earlier field and no gist text', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = harness([answer(), answer()]);
    const gists = [{ skill: 'mc-low-health', steps: ['2. 秘密の手順 mc.build-around-self'] }, { skill: 'mc-food-and-pace', steps: ['3. 別の秘密の手順'] }];
    await fixture.model.decide({ ...input(), body: { report: '短い報告', skillGists: gists } } as unknown as FcaModelInput, signal());
    await fixture.model.decide({ ...input(), body: { report: '短い報告' } } as unknown as FcaModelInput, signal());
    const lines = info.mock.calls.map(args => String(args[0])).filter(line => line.includes('fca_request_size'));
    const sizes = lines.map(line => JSON.parse(line));
    expect(sizes.map(size => size.skillGists)).toEqual([2, 0]);
    // The earlier fields keep their place; the fields that say why the count is what it is follow (run 13).
    expect(Object.keys(sizes[0])).toEqual(['event', 'model', 'historyCharacters', 'nativeHistoryCharacters', 'toolDefinitionCharacters', 'requestCharacters',
      'estimatedInputTokens', 'skillGists', 'taskId', 'bodyAttached', 'skillPointers', 'skillGistsBuilt', 'skillGistsElided', 'elidedParts', 'compactedLevel']);
    // The line stays what existing greps read, and carries no gist text.
    expect(lines[0]).toMatch(/"historyCharacters":\d+,/u);
    expect(lines[0]).toMatch(/"toolDefinitionCharacters":\d+,/u);
    expect(lines.join('\n')).not.toContain('秘密');
    expect(JSON.parse(String((fixture.bodies[0]!.messages as Array<{ content: unknown }>).at(-1)!.content)).body.skillGists).toEqual(gists);
  });
});

describe('why a request\'s skillGists is what it is (Minebot run 13: gists offered, skillGists:0), content-free', () => {
  const sizesOf = (info: ReturnType<typeof vi.spyOn>) => info.mock.calls.map(args => String(args[0])).filter(line => line.includes('fca_request_size'));
  const gists = [{ skill: 'mc-bed-before-night', steps: ['2. 秘密の手順 mc.explore-for-structure'] }];
  const pointed = { report: '短い報告', skillPointers: ['mc-bed-before-night（日暮れが近いのにベッドが無い）'], skillGists: gists, skillPointerNote: '注記' };

  it('names the task, whether a body was attached, and tells "no body" and "no pointer" from "gists sent"', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = harness([answer(), answer(), answer(), answer()]);
    await fixture.model.decide(input(), signal());
    await fixture.model.decide({ ...input(), body: { report: '短い報告' } } as unknown as FcaModelInput, signal());
    await fixture.model.decide({ ...input(), body: { report: '短い報告', skillPointers: pointed.skillPointers, skillPointerNote: '注記' } } as unknown as FcaModelInput, signal());
    await fixture.model.decide({ ...input(), body: pointed } as unknown as FcaModelInput, signal());
    const lines = sizesOf(info), sizes = lines.map(line => JSON.parse(line));
    expect(sizes.map(size => [size.taskId, size.bodyAttached, size.skillPointers, size.skillGists, size.skillGistsBuilt, size.skillGistsElided])).toEqual([
      ['task-1', false, 0, 0, 0, false], ['task-1', true, 0, 0, 0, false], ['task-1', true, 1, 0, 0, false], ['task-1', true, 1, 1, 1, false]]);
    expect(sizes.every(size => size.compactedLevel === null && Array.isArray(size.elidedParts))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/秘密|ベッド|explore-for-structure/u);
  });

  it('says which parts were left out as unchanged, and that the body\'s gists are restated every decision, never elided', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = harness([answer([call('fca_wait', 'wait-1', { summary: 'Wait' })]), answer()]);
    const first = await fixture.model.decide({ ...input(), skillIndex: '索引', body: pointed } as unknown as FcaModelInput, signal());
    // The same index and the body's fixed rule again in the same epoch are given as unchanged; the body (and its gists) is restated every decision, never elided.
    await fixture.model.decide({ ...input(first.history), skillIndex: '索引', body: pointed } as unknown as FcaModelInput, signal());
    const sizes = sizesOf(info).map(line => JSON.parse(line));
    expect(sizes[0].elidedParts).toEqual([]);
    expect(sizes[1].elidedParts).toEqual(['skillIndex', 'bodyInstructions']);
    expect(sizes.map(size => [size.skillGists, size.skillGistsBuilt, size.skillGistsElided])).toEqual([[1, 1, false], [1, 1, false]]);
    expect(JSON.parse(String((fixture.bodies[1]!.messages as Array<{ content: unknown }>).at(-1)!.content)).body.skillGists).toEqual(gists);
  });
});

describe('compaction before the price step (C4)', () => {
  const children = [{ id: 'child-1', title: '材料集め', phase: 'executing', summary: '木を集める途中、'.repeat(300) }];
  const bulky = (): FcaModelInput => ({ ...input(), children, body: { report: 'インベントリ'.repeat(40_000), position: { x: 1, y: 64, z: -3 } },
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
    expect(message.children).toEqual(children);
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

  it('tells an answer that called no tool from the other closed refusals: a typed error the runner asks again, and a content-free line', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const fixture = harness([answer([{ type: 'thinking', thinking: 'secret reasoning', signature: 's' }, { type: 'text', text: 'Done with the logs.' }],
        nativeUsage(), 'end_turn')]);
      const failure = await fixture.model.decide(input(), signal()).then(() => null, (error: Error) => error);
      expect(failure).toBeInstanceOf(FcaNoDecisionError);
      expect(failure?.message).toBe('FCA_MODEL_DECISION_MISSING');
      expect(retryVerdict(failure)).toMatchObject({ reason: 'no_decision', possiblyBilled: false, attempts: 2 });
      expect(fixture.receipts).toHaveLength(1);
      const line = String(warned.mock.calls.map(call => String(call[0])).find(text => text.includes('fca_decision_missing')));
      expect(JSON.parse(line)).toMatchObject({ event: 'fca_decision_missing', stopReason: 'end_turn', blocks: { thinking: 1, text: 1 }, textCharacters: 19 });
      expect(line).not.toContain('secret reasoning');
      expect(line).not.toContain('Done with the logs');
      for (const stop of ['max_tokens', 'refusal']) {
        const other = harness([answer([call()], nativeUsage(), stop)]);
        expect(retryVerdict(await other.model.decide(input(), signal()).then(() => null, (error: Error) => error))).toBeNull();
      }
    } finally { warned.mockRestore(); }
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

  it.each([400, 500])('never retries HTTP %s itself; an answered error is a known outcome that books nothing (the runner asks again)', async status => {
    const fixture = scriptedAnthropic(() => new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'synthetic-private-error' } }),
      { status, headers: { 'content-type': 'application/json' } }));
    const receipts: AnthropicFcaUsage[] = [];
    const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage: usage => { receipts.push(usage); } });
    const execution = ({ lease: { id: 'a', holder: 'api', generation: 1 }, signal: signal(), permit: async () => ({}) }) as unknown as ActionExecution;
    const failure = await inActionExecution(execution, () => model.decide(input(), signal())).catch(error => error as Error);
    expect(failure).toMatchObject({ message: `FCA_MODEL_HTTP_${status}` });
    expect(failure instanceof FcaProviderError).toBe(status === 500); // a 400 is a plain closed code: it is never asked again
    expect(fixture.bodies).toHaveLength(1);
    // The provider answered an error: no decision, no charge. Before 2026-10-19 a 500 booked a whole-context upper bound (about
    // a dollar a request), which, repeated by the retries of one outage, would have booked a task's cap away.
    expect(receipts).toHaveLength(0);
    expect(execution.modelOutcome).toBe('acknowledged');
  });

  it.each([[429, '7', 7_000], [529, '0.5', 500], [503, undefined, null]] as const)('carries the status and the retry-after of an answered %s for the runner', async (status, retryAfter, expected) => {
    const fixture = scriptedAnthropic(() => new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'x' } }),
      { status, headers: { 'content-type': 'application/json', ...(retryAfter ? { 'retry-after': retryAfter } : {}) } }));
    const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage() {} });
    const failure = await model.decide(input(), signal()).catch(error => error as Error);
    expect(failure).toBeInstanceOf(FcaProviderError);
    expect(failure).toMatchObject({ message: `FCA_MODEL_HTTP_${status}`, status, retryAfterMs: expected });
  });

  it('reads retry-after-ms before retry-after, and an HTTP date, bounded', () => {
    expect(retryAfterMilliseconds({ headers: new Headers({ 'retry-after-ms': '1500', 'retry-after': '9' }) })).toBe(1_500);
    expect(retryAfterMilliseconds({ headers: new Headers({ 'retry-after': '3' }) })).toBe(3_000);
    expect(retryAfterMilliseconds({ headers: new Headers({ 'retry-after': new Date(10_000 + 4_000).toUTCString() }) }, 10_000)).toBe(4_000);
    expect(retryAfterMilliseconds({ headers: new Headers({ 'retry-after': '99999' }) })).toBe(600_000);
    expect(retryAfterMilliseconds({ headers: new Headers({ 'retry-after': 'soon' }) })).toBeNull();
    expect(retryAfterMilliseconds({ headers: { 'retry-after': '2' } })).toBe(2_000);
    expect(retryAfterMilliseconds({})).toBeNull();
  });

  describe('a request that got no answer at all (Minebot runs 12 and 13: APIConnectionError, ETIMEDOUT)', () => {
    // The cause as undici gives it: a code on a cause whose text does not say "timed out" (the SDK would call that its timeout class).
    const wire = (code?: string) => (async () => { throw new TypeError('fetch failed', code ? { cause: Object.assign(new Error('connection failed'), { code }) } : undefined); }) as unknown as typeof fetch;
    const executionOf = () => ({ lease: { id: 'a', holder: 'api', generation: 1 }, signal: signal(), permit: async () => ({}) }) as unknown as ActionExecution;

    it.each([['ETIMEDOUT', true], ['ECONNRESET', true], ['ECONNREFUSED', false], ['ENOTFOUND', false], ['UND_ERR_CONNECT_TIMEOUT', false]] as const)(
      '%s is marked as no response (may have been charged: %s): still unknown for a caller that does not retry, never sent twice by the adapter', async (code, charged) => {
        let sent = 0;
        const counting = (async () => { sent += 1; return wire(code)(''); }) as unknown as typeof fetch;
        const receipts: AnthropicFcaUsage[] = [];
        const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: counting, recordUsage: usage => { receipts.push(usage); } });
        const execution = executionOf();
        const failure = await inActionExecution(execution, () => model.decide(input(), signal())).catch(error => error as Error);
        expect(failure).toBeInstanceOf(FcaNoResponseError);
        expect((failure as Error).message).toBe('FCA_MODEL_RESPONSE_UNKNOWN');
        expect(failure).toMatchObject({ reason: 'no_response', possiblyBilled: charged });
        expect(sent).toBe(1);
        expect(execution.modelOutcome).toBe('unknown');
        // A request that never left this machine books nothing; one the provider may have processed books an upper bound.
        expect(receipts).toHaveLength(charged ? 1 : 0);
        if (charged) {
          expect(receipts[0]).toMatchObject({ usageComplete: false });
          expect(receipts[0]!.estimatedCostUsd).toBeGreaterThan(0);
        }
      });

    it('books a request that may have been charged at an upper bound sized by the request, not by a whole context', async () => {
      const receipts: AnthropicFcaUsage[] = [];
      const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: wire('ETIMEDOUT'), recordUsage: usage => { receipts.push(usage); } });
      await inActionExecution(executionOf(), () => model.decide(input(), signal())).catch(() => undefined);
      expect(receipts).toHaveLength(1);
      const wholeContext = unknownCostUpperBound('claude-haiku-5-5', 4_000);
      expect(receipts[0]!.estimatedCostUsd).toBeGreaterThan(0);
      expect(receipts[0]!.estimatedCostUsd).toBeLessThan(wholeContext / 10);
      // At least the request's own tokens written to the one-hour cache, plus the output ceiling.
      expect(receipts[0]!.estimatedCostUsd).toBeGreaterThan(unknownCostUpperBound('claude-haiku-5-5', 4_000, 0, { input: 0, cacheWrite: 1_000, cacheRead: 0 }));
    });

    it('treats the SDK\'s own timeout and this process\'s deadline as a request that may have been charged and got no answer', async () => {
      const timedOut = (async () => { throw new DOMException('The operation was aborted', 'AbortError'); }) as unknown as typeof fetch;
      const receipts: AnthropicFcaUsage[] = [];
      const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: timedOut, recordUsage: usage => { receipts.push(usage); } });
      const sdk = await inActionExecution(executionOf(), () => model.decide(input(), signal())).catch(error => error as Error);
      expect(sdk).toBeInstanceOf(FcaNoResponseError);
      expect(sdk).toMatchObject({ message: 'FCA_MODEL_RESPONSE_UNKNOWN', reason: 'timeout', possiblyBilled: true });
      const late = createAnthropicFcaModel({ apiKey: 'synthetic', timeoutMilliseconds: 5, recordUsage: usage => { receipts.push(usage); },
        fetcher: ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError'))))) as unknown as typeof fetch });
      const deadline = await inActionExecution(executionOf(), () => late.decide(input(), signal())).catch(error => error as Error);
      expect(deadline).toBeInstanceOf(FcaNoResponseError);
      expect(deadline).toMatchObject({ message: 'FCA_MODEL_ABORTED', reason: 'timeout', possiblyBilled: true });
      expect(receipts.map(receipt => receipt.usageComplete)).toEqual([false, false]);
    });

    it('books both calls when the runner asks again: the first as an unknown upper bound, the second by its actual usage', async () => {
      const fixture = scriptedAnthropic([answer()]);
      let calls = 0;
      const fetcher = (async (url, init) => { calls += 1; return calls === 1 ? wire('ETIMEDOUT')('') : fixture.fetcher(url, init); }) as typeof fetch;
      const receipts: AnthropicFcaUsage[] = [];
      const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher, recordUsage: usage => { receipts.push(usage); } });
      const execution = executionOf();
      await expect(inActionExecution(execution, () => model.decide(input(), signal()))).rejects.toBeInstanceOf(FcaNoResponseError);
      const second = await inActionExecution(execution, () => model.decide(input(), signal()));
      expect(second.decision.kind).toBe('tools');
      expect(receipts.map(receipt => receipt.usageComplete)).toEqual([false, true]);
      expect(execution.modelOutcome).toBe('acknowledged');
      expect(fixture.bodies).toHaveLength(1);
    });

    it('is not marked for a cause that is unknown or absent, an HTTP answer, an abort, or a response whose body broke after it began', async () => {
      const run = async (fetcher: typeof fetch, controller = new AbortController()) => {
        const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher, recordUsage() {} });
        return inActionExecution(executionOf(), () => model.decide(input(), controller.signal)).catch(error => error as Error);
      };
      for (const failure of [await run(wire()), await run(wire('EWHATEVER')),
        await run((async () => new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'x' } }), { status: 500, headers: { 'content-type': 'application/json' } })) as typeof fetch),
        await run((async () => new Response('{"id":"msg_1","type":"mess', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch)]) {
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(FcaNoResponseError);
      }
      const controller = new AbortController();
      expect(await run((async () => { controller.abort(); return wire('ETIMEDOUT')(''); }) as typeof fetch, controller)).not.toBeInstanceOf(FcaNoResponseError);
    });
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

  it('lets a sent request finish within its stop grace, so a cancelled step knows its spend and outcome (Minecraft run 10)', async () => {
    const controller = new AbortController();
    const execution: ActionExecution = { lease: { id: 'original-action', holder: 'api', generation: 1 },
      signal: controller.signal, permit: async () => { throw new Error('runner_already_checked_permit'); } };
    const receipts: AnthropicFcaUsage[] = [];
    let transport: AbortSignal | undefined;
    const client: AnthropicFcaClient = { messages: { create: async (_body, options) => {
      transport = options.signal;
      controller.abort();
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(options.signal.aborted).toBe(false);
      return answer() as unknown as Anthropic.Message;
    } } };
    const model = createAnthropicFcaModel({ client, stopGraceMilliseconds: 1_000, recordUsage: usage => { receipts.push(usage); } });
    await expect(inActionExecution(execution, () => model.decide(input(), controller.signal))).rejects.toThrow('FCA_MODEL_ABORTED');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ usageComplete: true });
    expect(execution.modelOutcome).toBe('acknowledged');
    expect(transport?.aborted).toBe(false);
  });

  it('aborts a sent request when its stop grace runs out, and records it as unknown once', async () => {
    const controller = new AbortController();
    const receipts: AnthropicFcaUsage[] = [];
    const client: AnthropicFcaClient = { messages: { create: async (_body, options) => {
      controller.abort();
      await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      throw new Error('unreachable');
    } } };
    const model = createAnthropicFcaModel({ client, stopGraceMilliseconds: 5, recordUsage: usage => { receipts.push(usage); } });
    await expect(model.decide(input(), controller.signal)).rejects.toThrow('FCA_MODEL_ABORTED');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ usageComplete: false });
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
