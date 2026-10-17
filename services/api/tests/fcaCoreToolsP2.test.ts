import { describe, expect, it } from 'vitest';
import { continuesFcaEpoch, fcaObsMode, isFcaCoreTool, pinFcaCoreTools, replayAnchor } from '../src/mind/action/fca/fcaCoreTools.js';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { message, scriptedAnthropic, withoutCacheMarkers } from './support/anthropicFixtures.js';
import { BASE_CATALOG, BODY_TOOLS, definition, quiet, requestDigest, scenario, SUMMARY_POLICY, WIDE_POLICY } from './fcaCoreToolsHarness.js';

type Body = Record<string, unknown>;
const toolNames = (body: Body) => (body.tools as Array<{ name: string }>).map(tool => tool.name);
const toolsJson = (body: Body) => JSON.stringify(body.tools);
const messagesOf = (body: Body) => withoutCacheMarkers(body.messages as Array<{ role: string; content: unknown }>);
const isEpochStart = (body: Body) => { const first = messagesOf(body)[0]!; return typeof first.content === 'string' && first.content.startsWith('{"kind":"fca_public_history"'); };
const additions = (body: Body) => messagesOf(body).flatMap(entry => entry.role === 'system' && Array.isArray(entry.content)
  ? (entry.content as Array<{ type: string; tool: { name?: string; definition?: { name: string } } }>) : []);
const added = (body: Body) => additions(body).filter(change => change.type === 'tool_addition').map(change => change.tool.definition!.name);
/** Decision requests grouped by epoch: a new group starts at each request whose replay starts anew (a summary's bootstrap). */
function epochs(bodies: Body[]): Body[][] {
  const groups: Body[][] = [];
  for (const body of bodies) { if (!groups.length || isEpochStart(body)) groups.push([]); groups.at(-1)!.push(body); }
  return groups;
}
const CORE_PROVIDER = [...BODY_TOOLS.map(tool => tool.name), 'skill.read', 'memory.search', 'task.create', 'task.get', 'task.list', 'task.send'].map(name => name.replace(/\./gu, '_'));

describe('SHANNON_FCA_OBS_MODE reader and the core set', () => {
  it('reads only transient as transient', () => {
    expect([undefined, '', 'legacy', 'x', 'on'].map(fcaObsMode)).toEqual(Array(5).fill('legacy'));
    expect([' Transient ', 'transient'].map(fcaObsMode)).toEqual(['transient', 'transient']);
  });
  it('takes the body tools, task and goal tools, skill.read and the memory read tools as core, not minecraft.reflex or others', () => {
    const core = (name: string, domain: Parameters<typeof definition>[1]) => isFcaCoreTool({ name, domain });
    expect(core('mc.mine', 'minecraft_body')).toBe(true);
    expect(core('minecraft.observe', 'minecraft_body')).toBe(true);
    expect(core('minecraft.reflex', 'minecraft_body')).toBe(false);
    expect(core('task.list', 'task_runtime')).toBe(true);
    expect(core('goal.verify', 'meta' as never)).toBe(true);
    expect(core('skill.read', 'skill_read')).toBe(true);
    expect(core('memory.read', 'memory_read')).toBe(true);
    expect(core('web.search', 'host_folder')).toBe(false);
  });
  it('pins in a fixed order, and an epoch continues only while its replay starts with the same message', () => {
    const pin = pinFcaCoreTools([...BASE_CATALOG].reverse());
    expect(pin.tools.map(tool => tool.name)).toEqual([...pinFcaCoreTools(BASE_CATALOG).tools.map(tool => tool.name)]);
    expect(pin.tools.some(tool => tool.name.startsWith('lazy.'))).toBe(false);
    const history = [{ role: 'user', content: 'first' }, { role: 'assistant', content: [] }];
    const anchored = { ...pin, anchor: replayAnchor(history) };
    expect(continuesFcaEpoch(anchored, [...history, { role: 'user', content: 'later' }])).toBe(true);
    expect(continuesFcaEpoch(anchored, [{ role: 'user', content: 'bootstrap' }])).toBe(false);
    expect(continuesFcaEpoch(anchored, [])).toBe(false);
    expect(continuesFcaEpoch(pin, history)).toBe(false);
  });
});

describe('transient mode: core tools fixed at the top level, the others appended', () => {
  it('keeps `tools` byte-identical over 30 rounds, with tool_open, the controls, fca_context and the core set only', async () => {
    quiet();
    const run = scenario({ mode: () => 'transient', policy: WIDE_POLICY, contextCall: true });
    expect(await run.settle()).toBe('completed');
    expect(run.violations).toEqual([]);
    expect(run.bodies).toHaveLength(30);
    expect(new Set(run.bodies.map(toolsJson)).size).toBe(1);
    const names = toolNames(run.bodies[0]!);
    expect(names.slice(0, 4)).toEqual(['tool_open', 'fca_wait', 'fca_complete', 'fca_context']);
    expect(names.slice(4)).toEqual([...CORE_PROVIDER].sort());
    expect(run.bodies.every(body => !JSON.stringify(body.system).includes('"unchanged"'))).toBe(true);
    expect(run.bodies.every(body => !isEpochStart(body))).toBe(true);
  }, 120_000);

  it('appends the tools it opens once, never removes or re-announces one, and each request extends the last', async () => {
    quiet();
    const run = scenario({ mode: () => 'transient', policy: WIDE_POLICY });
    await run.settle();
    const last = run.bodies.at(-1)!;
    expect(added(last)).toEqual(['lazy_alpha', 'lazy_beta']);
    expect(additions(last).some(change => change.type === 'tool_removal')).toBe(false);
    for (let index = 1; index < run.bodies.length; index++) {
      const before = messagesOf(run.bodies[index - 1]!), now = messagesOf(run.bodies[index]!);
      expect(now.slice(0, before.length)).toEqual(before);
    }
    // Opened at decisions 5 and 12 (requests 4 and 11, from 0): declared from the next request, and in no request before.
    expect(added(run.bodies[4]!)).toEqual([]);
    expect(added(run.bodies[5]!)).toEqual(['lazy_alpha']);
    expect(added(run.bodies[11]!)).toEqual(['lazy_alpha']);
    expect(added(run.bodies[12]!)).toEqual(['lazy_alpha', 'lazy_beta']);
  }, 120_000);

  it('declares no core tool inline, lists only the other tools in the catalog, and says so in the instructions', async () => {
    quiet();
    const run = scenario({ mode: () => 'transient', policy: WIDE_POLICY });
    await run.settle();
    const first = run.bodies[0]!, decision = JSON.parse(messagesOf(first)[0]!.content as string);
    expect(decision.catalog.map((tool: { name: string }) => tool.name)).toEqual(['lazy_alpha', 'lazy_beta']);
    expect(JSON.stringify(first.system)).toContain('The core tools are always loaded');
    for (const body of run.bodies) for (const name of added(body)) expect(CORE_PROVIDER).not.toContain(name);
  }, 120_000);

  it('after a summary the new epoch declares again only what was opened, once, and the tools stay the same', async () => {
    quiet();
    const run = scenario({ mode: () => 'transient', policy: SUMMARY_POLICY });
    expect(await run.settle()).toBe('completed');
    expect(run.violations).toEqual([]);
    const groups = epochs(run.bodies);
    expect(groups.length).toBeGreaterThanOrEqual(3);
    expect(new Set(run.bodies.map(toolsJson)).size).toBe(1);
    for (const group of groups) {
      const final = added(group.at(-1)!);
      expect(new Set(final).size).toBe(final.length);
      for (const body of group) expect(additions(body).some(change => change.type === 'tool_removal')).toBe(false);
      for (let index = 1; index < group.length; index++) expect(messagesOf(group[index]!).slice(0, messagesOf(group[index - 1]!).length)).toEqual(messagesOf(group[index - 1]!));
    }
    // Decision 5 opens lazy_alpha in epoch 1; every later epoch declares it again at its start (beside its bootstrap), once.
    for (const group of groups.slice(1)) { expect(added(group[0]!)).toContain('lazy_alpha'); expect(added(group[0]!).filter(name => name === 'lazy_alpha')).toHaveLength(1); }
    // Within an epoch, once declared, a tool is not declared again: the count of declarations never grows past the opened ones.
    for (const group of groups) expect(added(group.at(-1)!).length).toBeLessThanOrEqual(2);
  }, 120_000);

  it('applies a changed body catalog only at an epoch boundary: the one the change itself starts, never mid-epoch', async () => {
    quiet();
    const changed = [...BASE_CATALOG.map(tool => tool.name === 'mc.skill-1' ? definition(tool.name, 'minecraft_body', '説明を書き換えた。') : tool),
      definition('mc.skill-new', 'minecraft_body')];
    const run = scenario({ mode: () => 'transient', policy: WIDE_POLICY, catalogAt: decision => decision >= 7 ? changed : BASE_CATALOG });
    expect(await run.settle()).toBe('completed');
    expect(run.violations).toEqual([]);
    // The first six requests (before the change) share one top level; from the seventh, the first replay after the change starts a
    // new epoch (a summary) and the core is pinned again: the new tool and the new description are on the top level, and stay.
    const before = run.bodies.slice(0, 6), after = run.bodies.slice(6);
    expect(new Set(before.map(toolsJson)).size).toBe(1);
    expect(toolNames(before[0]!)).not.toContain('mc_skill-new');
    expect(isEpochStart(after[0]!)).toBe(true);
    expect(new Set(after.map(toolsJson)).size).toBe(1);
    expect(toolNames(after[0]!)).toContain('mc_skill-new');
    expect(JSON.stringify(after[0]!.tools)).toContain('説明を書き換えた');
    // The new core is on the top level, so it is announced inline nowhere.
    for (const body of after) expect(added(body)).not.toContain('mc_skill-new');
  }, 120_000);
  it('offers fca_context at the top level without a shared context and answers a call of it as not provided', async () => {
    quiet();
    const run = scenario({ mode: () => 'transient', policy: WIDE_POLICY, contextCall: true });
    expect(await run.settle()).toBe('completed');
    const results = run.bodies.slice(3).flatMap(body => messagesOf(body).flatMap(entry => Array.isArray(entry.content)
      ? (entry.content as Array<{ type: string; tool_use_id: string; content: string }>).filter(block => block.type === 'tool_result' && block.tool_use_id === 'toolu_3_context') : []));
    expect(results.length).toBeGreaterThan(0);
    expect(JSON.parse(results[0]!.content).received).toBe(false);
  }, 120_000);

  it('lets fca_context be top-level without the selected menu (the guard FCA_CONTEXT_REQUIRES_SELECTED_MODE is relaxed here)', async () => {
    const fixture = scriptedAnthropic([message([{ type: 'tool_use', id: 'w', name: 'fca_wait', input: { summary: '待つ' } }], 'tool_use')]);
    const model = createAnthropicFcaModel({ apiKey: 'synthetic', model: 'claude-sonnet-5-5', fetcher: fixture.fetcher, recordUsage() {} });
    const core = definition('mc.skill-1', 'minecraft_body');
    const sharedContext = { affect: { version: 'fca_affect.v1', revision: 1, updatedAt: '2026-10-09T00:00:00Z', emotion: { valence: 0, arousal: 0, openness: 0 }, feeling: null, causes: [] },
      recentOutcomes: [] } as never;
    const base = { task: { id: 't', title: 'x', goal: 'x', completionCriteria: 'x' }, messages: [], history: [], tools: [core], sharedContext };
    await expect(model.decide({ ...base } as never, new AbortController().signal)).rejects.toThrow('FCA_CONTEXT_REQUIRES_SELECTED_MODE');
    await model.decide({ ...base, coreTools: [core] } as never, new AbortController().signal);
    expect(toolNames(fixture.bodies[0]!)).toEqual(['tool_open', 'fca_wait', 'fca_complete', 'fca_context', 'mc_skill-1']);
  });
});

describe('transient mode leaves everything else as it was', () => {
  it('does not change a task that is not a body task', async () => {
    quiet();
    const plain = scenario({ policy: WIDE_POLICY, keepBody: false });
    await plain.settle();
    const withSwitch = scenario({ mode: () => 'transient', policy: WIDE_POLICY, keepBody: false });
    await withSwitch.settle();
    expect(withSwitch.bodies.map(requestDigest)).toEqual(plain.bodies.map(requestDigest));
    expect(toolNames(withSwitch.bodies[0]!)).toEqual(['tool_open', 'fca_wait', 'fca_complete']);
  }, 120_000);

  it('serves the legacy request when the switch says legacy, as when there is no switch', async () => {
    quiet();
    const plain = scenario({ policy: SUMMARY_POLICY });
    await plain.settle();
    const explicit = scenario({ mode: () => 'legacy', policy: SUMMARY_POLICY });
    await explicit.settle();
    expect(explicit.bodies.map(requestDigest)).toEqual(plain.bodies.map(requestDigest));
    expect(toolNames(explicit.bodies[0]!)).toEqual(['tool_open', 'fca_wait', 'fca_complete']);
  }, 120_000);

  it('keeps the mode a task started with when the switch changes in the middle of it', async () => {
    quiet();
    let mode: 'legacy' | 'transient' = 'legacy';
    const started = scenario({ mode: () => mode, policy: WIDE_POLICY, steps: 12 });
    const legacyOnly = scenario({ policy: WIDE_POLICY, steps: 12 });
    // Flip after the sixth request is made.
    const flip = setInterval(() => { if (started.bodies.length >= 6) mode = 'transient'; }, 0);
    await started.settle(); clearInterval(flip);
    await legacyOnly.settle();
    expect(started.bodies.map(requestDigest)).toEqual(legacyOnly.bodies.map(requestDigest));
    mode = 'transient';
    const other = scenario({ mode: () => mode, policy: WIDE_POLICY, steps: 12 });
    const flipBack = setInterval(() => { if (other.bodies.length >= 6) mode = 'legacy'; }, 0);
    await other.settle(); clearInterval(flipBack);
    expect(new Set(other.bodies.map(toolsJson)).size).toBe(1);
    expect(toolNames(other.bodies[0]!)).toContain('fca_context');
  }, 120_000);
});
