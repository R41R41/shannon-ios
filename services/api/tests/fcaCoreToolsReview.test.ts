import { describe, expect, it, vi } from 'vitest';
import { estimatedAnthropicTokens, anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { conflictingProviderNames, fcaTransientHistory, FCA_CORE_COOLDOWN_STEPS, FCA_TRANSIENT_MINIMUM_REPLAY_TOKENS, shouldForceFcaEpoch } from '../src/mind/action/fca/fcaCoreHistory.js';
import { pinFcaCoreTools, replayAnchor } from '../src/mind/action/fca/fcaCoreTools.js';
import { selectFcaTools } from '../src/mind/action/fca/fcaToolState.js';
import { FCA_HISTORY_POLICY } from '../src/mind/action/fca/fcaHistory.js';
import type { FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { withoutCacheMarkers } from './support/anthropicFixtures.js';
import { BASE_CATALOG, definition, LAZY_TOOLS, quiet, scenario, SUMMARY_POLICY, WIDE_POLICY } from './fcaCoreToolsHarness.js';

type Body = Record<string, unknown>;
const toolsJson = (body: Body) => JSON.stringify(body.tools);
const messagesOf = (body: Body) => withoutCacheMarkers(body.messages as Array<{ role: string; content: unknown }>);
const added = (body: Body) => messagesOf(body).flatMap(entry => entry.role === 'system' && Array.isArray(entry.content)
  ? (entry.content as Array<{ type: string; tool: { definition?: { name: string } } }>).filter(change => change.type === 'tool_addition').map(change => change.tool.definition!.name) : []);
const removals = (body: Body) => messagesOf(body).flatMap(entry => entry.role === 'system' && Array.isArray(entry.content)
  ? (entry.content as Array<{ type: string }>).filter(change => change.type === 'tool_removal') : []);
const infoEvents = () => vi.mocked(console.info).mock.calls.flatMap(([line]) => { try { return [JSON.parse(String(line)) as { event?: string; reason?: string }]; } catch { return []; } });
/** Every body skill asks for `count` from now on: a changed core schema. */
const withCount = (catalog: readonly FcaToolDefinition[]) => catalog.map(tool => tool.domain === 'minecraft_body' && tool.name.startsWith('mc.')
  ? { ...tool, input: { ...tool.input, properties: { ...tool.input.properties, count: { type: 'string', description: '個数。' } }, required: ['count'] } } as FcaToolDefinition : tool);

describe('transient mode keeps its request below the price step (the core is no longer in the replay)', () => {
  it('takes the pinned core estimate off the replay budget, with a floor', () => {
    const codec = { ...anthropicFcaHistoryCodec, tokens: () => 25_000 };
    const found = fcaTransientHistory({}, BASE_CATALOG, { obsMode: 'transient', keepBodyTools: () => true, selector: {}, history: { codec } })!;
    expect(found.policy.maximumReplayTokens).toBe(FCA_HISTORY_POLICY.maximumReplayTokens - 25_000);
    const huge = fcaTransientHistory({}, BASE_CATALOG, { obsMode: 'transient', keepBodyTools: () => true, selector: {}, history: { codec: { ...codec, tokens: () => 90_000 } } })!;
    expect(huge.policy.maximumReplayTokens).toBe(FCA_TRANSIENT_MINIMUM_REPLAY_TOKENS);
    expect(fcaTransientHistory({}, BASE_CATALOG, { keepBodyTools: () => true, selector: {}, history: { codec } })).toBeNull();
    expect(fcaTransientHistory({}, BASE_CATALOG, { obsMode: 'transient', keepBodyTools: () => false, selector: {}, history: { codec } })).toBeNull();
    expect(fcaTransientHistory({ fcaToolSelection: { obsMode: undefined } }, BASE_CATALOG, { obsMode: 'transient', keepBodyTools: () => true, selector: {}, history: { codec } })).toBeNull();
  });

  it('keeps every request of a long task with a 25k-token core and big results under the cap, with no decision shortened', async () => {
    quiet();
    const big = Array.from({ length: 24 }, (_, index) => definition(`mc.skill-${index + 1}`, 'minecraft_body', '身体スキルの説明。'.repeat(125)));
    const catalog = [...big, ...BASE_CATALOG.filter(tool => tool.domain !== 'minecraft_body')];
    const run = scenario({ mode: () => 'transient', catalogAt: () => catalog, steps: 26, resultSize: 3_500 });
    expect(await run.settle()).toBe('completed');
    expect(run.violations).toEqual([]);
    const sizes = run.bodies.map(estimatedAnthropicTokens);
    expect(estimatedAnthropicTokens(run.bodies[0]!.tools)).toBeGreaterThan(20_000);
    expect(Math.max(...sizes)).toBeGreaterThan(60_000);
    expect(Math.max(...sizes)).toBeLessThan(95_000);
    expect(infoEvents().filter(event => event.event === 'fca_request_compacted')).toEqual([]);
    expect(new Set(run.bodies.map(toolsJson)).size).toBe(1);
  }, 120_000);
});

describe('a core that no longer matches the catalog starts a new epoch', () => {
  it('re-pins at the next replay when a body tool schema changes, so no execution fails on the old definition', async () => {
    quiet();
    const run = scenario({ mode: () => 'transient', policy: WIDE_POLICY, strictInput: true, steps: 20,
      catalogAt: decision => decision >= 7 ? withCount(BASE_CATALOG) : BASE_CATALOG });
    expect(await run.settle()).toBe('completed');
    expect(run.violations).toEqual([]);
    expect(run.failures).toBe(0);
    const before = run.bodies.slice(0, 6), after = run.bodies.slice(6);
    expect(new Set(before.map(toolsJson)).size).toBe(1);
    expect(new Set(after.map(toolsJson)).size).toBe(1);
    expect(toolsJson(after[0]!)).not.toBe(toolsJson(before[0]!));
    expect(toolsJson(after[0]!)).toContain('count');
    expect(infoEvents().filter(event => event.event === 'fca_core_tools_stale')).toEqual([{ event: 'fca_core_tools_stale', taskId: run.task.id, reason: 'definitions_changed' }]);
  }, 120_000);

  it('lets a change in the first steps of an epoch fail only the calls of its cooldown (fewer than the five that stop a task), then settles', async () => {
    quiet();
    const run = scenario({ mode: () => 'transient', policy: WIDE_POLICY, strictInput: true, steps: 14,
      catalogAt: decision => decision >= 2 ? withCount(BASE_CATALOG) : BASE_CATALOG });
    expect(await run.settle()).toBe('completed');
    expect(run.failures).toBeGreaterThan(0);
    expect(run.failures).toBeLessThan(5);
    expect(run.summaries()).toBe(1);
    expect(toolsJson(run.bodies.at(-1)!)).toContain('count');
  }, 120_000);

  it('summarizes a flapping catalog at most once for each cooldown, not at every step', async () => {
    quiet();
    const run = scenario({ mode: () => 'transient', policy: WIDE_POLICY, steps: 30,
      catalogAt: decision => decision % 2 === 0 ? withCount(BASE_CATALOG) : BASE_CATALOG });
    expect(await run.settle()).toBe('completed');
    expect(run.summaries()).toBeGreaterThan(0);
    expect(run.summaries()).toBeLessThanOrEqual(Math.ceil(30 / (FCA_CORE_COOLDOWN_STEPS + 1)));
    expect(infoEvents().filter(event => event.event === 'fca_core_tools_stale')).toHaveLength(run.summaries());
  }, 120_000);

  it('forces a summary only for a stale core of a replay that still starts the epoch, after the cooldown', () => {
    const pin = { ...pinFcaCoreTools(BASE_CATALOG), anchor: replayAnchor([{ role: 'user', content: 'head' }]), steps: FCA_CORE_COOLDOWN_STEPS };
    const ports = { obsMode: 'transient' as const, keepBodyTools: () => true, selector: {}, history: { codec: anthropicFcaHistoryCodec } };
    const stale = fcaTransientHistory({ fcaToolSelection: { obsMode: 'transient', core: pin } }, withCount(BASE_CATALOG), ports)!;
    expect(stale.stale).toBe('definitions_changed');
    const head = [{ role: 'user', content: 'head' }], bootstrap = [{ role: 'user', content: '{"kind":"fca_public_history"}' }];
    quiet();
    expect(shouldForceFcaEpoch(stale, head, 't')).toBe(true);
    expect(shouldForceFcaEpoch(stale, bootstrap, 't')).toBe(false);
    expect(shouldForceFcaEpoch({ ...stale, pin: { ...pin, steps: FCA_CORE_COOLDOWN_STEPS - 1 } }, head, 't')).toBe(false);
    expect(shouldForceFcaEpoch({ ...stale, stale: null }, head, 't')).toBe(false);
  });

  it('does not summarize for a catalog that kept only minecraft.reflex of the body (it would pin a core without the body)', () => {
    const pin = { ...pinFcaCoreTools(BASE_CATALOG), anchor: 'a', steps: 9 };
    const ports = { obsMode: 'transient' as const, keepBodyTools: () => true, selector: {}, history: { codec: anthropicFcaHistoryCodec } };
    const away = [...BASE_CATALOG.filter(tool => tool.domain !== 'minecraft_body'), definition('minecraft.reflex', 'minecraft_body')];
    expect(fcaTransientHistory({ fcaToolSelection: { obsMode: 'transient', core: pin } }, away, ports)!.stale).toBeNull();
    const observeOnly = [...away, definition('minecraft.observe', 'minecraft_body')];
    expect(fcaTransientHistory({ fcaToolSelection: { obsMode: 'transient', core: pin } }, observeOnly, ports)!.stale).toBeNull();
    expect(fcaTransientHistory({ fcaToolSelection: { obsMode: 'transient', core: pin } }, withCount(BASE_CATALOG), ports)!.stale).toBe('definitions_changed');
  });

  it('logs a skipped catalog tool once for each change, not for every request', async () => {
    quiet();
    const renamed = [...BASE_CATALOG.filter(tool => tool.name !== 'mc.skill-1'), definition('mc_skill-1', 'host_folder', '名前を変えた道具。')];
    const run = scenario({ mode: () => 'transient', policy: WIDE_POLICY, steps: 3, catalogAt: decision => decision >= 2 ? renamed : BASE_CATALOG });
    await run.settle();
    expect(infoEvents().filter(event => event.event === 'fca_core_tools_conflict')).toHaveLength(1);
  }, 120_000);

  it('does not start an epoch for tools that are not core (minecraft.reflex entering and leaving) and never re-announces them', async () => {
    quiet();
    const reflex = definition('minecraft.reflex', 'minecraft_body');
    const run = scenario({ mode: () => 'transient', policy: WIDE_POLICY, steps: 20,
      catalogAt: decision => decision >= 8 && decision <= 12 ? [...BASE_CATALOG, reflex] : BASE_CATALOG });
    expect(await run.settle()).toBe('completed');
    expect(new Set(run.bodies.map(toolsJson)).size).toBe(1);
    expect(infoEvents().filter(event => event.event === 'fca_core_tools_stale')).toEqual([]);
    const last = run.bodies.at(-1)!;
    expect(added(last).filter(name => name === 'minecraft_reflex')).toEqual(['minecraft_reflex']);
    expect(run.bodies.every(body => removals(body).length === 0)).toBe(true);
  }, 120_000);

  it('leaves out a catalog tool that shares a provider name with a pinned core tool instead of failing every step', async () => {
    quiet();
    const renamed = [...BASE_CATALOG.filter(tool => tool.name !== 'mc.skill-1'), definition('mc_skill-1', 'minecraft_body', '名前を変えた道具。')];
    const run = scenario({ mode: () => 'transient', policy: WIDE_POLICY, steps: 12, catalogAt: decision => decision >= 2 ? renamed : BASE_CATALOG });
    expect(await run.settle()).toBe('completed');
    expect(run.violations).toEqual([]);
    expect(infoEvents().some(event => event.event === 'fca_core_tools_conflict')).toBe(true);
  }, 120_000);

  it('names conflicts only where pinning again would settle them', () => {
    const pin = pinFcaCoreTools(BASE_CATALOG);
    const renamed = [...BASE_CATALOG.filter(tool => tool.name !== 'mc.skill-1'), definition('mc_skill-1', 'host_folder')];
    expect(conflictingProviderNames(pin, renamed)).toEqual(['mc_skill-1']);
    expect(conflictingProviderNames(pin, [...BASE_CATALOG, definition('mc_skill-1', 'host_folder')])).toEqual([]);
    expect(conflictingProviderNames(pin, [...BASE_CATALOG, ...LAZY_TOOLS])).toEqual([]);
  });
});

describe('a transient task is never read as another mode', () => {
  const input = { task: { id: 't', title: 'x', goal: 'x', completionCriteria: 'x' }, messages: [], history: [], tools: [] };
  const selector = { async select() { return { names: [], source: 'jev' as const }; } };
  const state = (extra: Record<string, unknown>) => ({ version: 1, key: 'k', inputKey: '', names: [], opened: [], refresh: false, recentResults: [], ...extra });
  it('fails safely with a clear code when the checkpoint says transient without a valid core', async () => {
    const run = (prior: unknown) => selectFcaTools(input as never, [], prior, selector, 'owner', new AbortController().signal);
    await expect(run(state({ obsMode: 'transient' }))).rejects.toThrow('FCA_CORE_TOOLS_STATE_INVALID');
    await expect(run(state({ obsMode: 'transient', core: { hash: 1 }, announced: [] }))).rejects.toThrow('FCA_CORE_TOOLS_STATE_INVALID');
    await expect(run(state({ obsMode: 'transient', core: { hash: 'h', anchor: null, tools: [] }, announced: 'no' }))).rejects.toThrow('FCA_CORE_TOOLS_STATE_INVALID');
    await expect(run({ obsMode: 'transient', core: null })).rejects.toThrow('FCA_CORE_TOOLS_STATE_INVALID');
    await expect(run(state({ obsMode: 'transient', core: { hash: 'h', anchor: null, tools: [] }, announced: [] }))).resolves.toMatchObject({ obsMode: 'transient' });
  });
  it('the history preparation refuses it as well', () => {
    const ports = { obsMode: 'transient' as const, keepBodyTools: () => true, selector: {}, history: { codec: anthropicFcaHistoryCodec } };
    expect(() => fcaTransientHistory({ fcaToolSelection: { obsMode: 'transient' } }, BASE_CATALOG, ports)).toThrow('FCA_CORE_TOOLS_STATE_INVALID');
  });
});

describe('transient mode survives what a long task meets', () => {
  it('keeps its core and its appended tools across a restart of the API on the same database', async () => {
    quiet();
    const run = scenario({ mode: () => 'transient', policy: WIDE_POLICY, steps: 20, restartAt: 9 });
    expect(await run.settle()).toBe('completed');
    expect(run.violations).toEqual([]);
    expect(run.bodies).toHaveLength(20);
    expect(new Set(run.bodies.map(toolsJson)).size).toBe(1);
    for (let index = 1; index < run.bodies.length; index++) {
      const before = messagesOf(run.bodies[index - 1]!);
      expect(messagesOf(run.bodies[index]!).slice(0, before.length)).toEqual(before);
    }
  }, 120_000);

  it('still pins one core across summaries when the catalog is steady', async () => {
    quiet();
    const run = scenario({ mode: () => 'transient', policy: SUMMARY_POLICY, steps: 24 });
    expect(await run.settle()).toBe('completed');
    expect(new Set(run.bodies.map(toolsJson)).size).toBe(1);
    expect(infoEvents().filter(event => event.event === 'fca_core_tools_stale')).toEqual([]);
  }, 120_000);
});
