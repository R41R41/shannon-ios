import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { anthropicFcaHistoryCodec, UNCHANGED } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import type { TaskRecallPacket } from '../src/mind/recall/taskRecallPorts.js';
import type { ShannonToolDefinition } from '../src/mind/tools/toolRegistryPorts.js';
import type { TaskMemoryItem } from '../src/mind/memory/taskMemoryPorts.js';
import { createTaskMemory } from '../src/mind/memory/taskMemory.js';
import { createTaskRecall } from '../src/mind/recall/taskRecall.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import { memoryWorld } from './support/memoryWorld.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';

/**
 * A decision message restates only what changed within its replay epoch (Minebot lane 2026-10-14, task 788da00a: the recall
 * packet and the catalog were 80% of each 62–77k-character decision message, and the same on most steps). What is sent is what is
 * stored, so the replay stays append-only; a memory is named by id only while the current packet, read through the current
 * forgetting and audience controls, still holds it with the same text.
 */
const tools: ShannonToolDefinition[] = ['task.list', 'task.get'].map(name => ({
  name, description: `Synthetic definition of ${name}`, domain: 'meta', effect: 'read', cost: 'none',
  audiences: ['owner_alone'], surfaces: ['autonomy'],
  input: { type: 'object', properties: {}, required: [], additionalProperties: false },
}));
const catalog = tools.map(tool => ({ name: tool.name, description: tool.description }));
const item = (id: string, summary = `memory ${id}`): TaskMemoryItem => ({ id, summary, observedAt: '2026-10-14T00:00:00.000Z', evidence: 'experience',
  applicability: 'task', confidence: null, conflicts: [], detailRef: `memory:${id}` });
const packet = (items: TaskMemoryItem[]): TaskRecallPacket => ({ contextVersion: 'v1', observedAt: '2026-10-14T00:00:00.000Z', status: 'ready', items, sourceIds: items.map(entry => entry.id) });
const input = (history: readonly unknown[], extra: Partial<FcaModelInput> = {}): FcaModelInput => ({
  task: { id: 'task-1', title: 'Synthetic task', goal: 'Collect logs', completionCriteria: 'Logs observed' },
  messages: [], tools, catalog, history, skillIndex: 'Skill index', ...extra,
});
const usage = { input_tokens: 12, output_tokens: 30, cache_creation_input_tokens: 700, cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 700 } };
const call = (id: string) => message([{ type: 'tool_use', id, name: 'task_list', input: {} }], 'tool_use', { model: 'claude-haiku-5-5', usage });
const signal = () => new AbortController().signal;

function harness(count: number) {
  const fixture = scriptedAnthropic(Array.from({ length: count }, (_, index) => call(`call-${index}`)));
  const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage() {} });
  /** One decision on the replay so far; its round (as stored) and the results are appended, as the runner does. */
  async function step(history: unknown[], extra: Partial<FcaModelInput>) {
    const output = await model.decide(input(history, extra), signal());
    const id = output.decision.kind === 'tools' ? output.decision.calls[0]!.id : 'none';
    return [...history, ...output.history, model.toolResults([{ id, text: 'ok', ok: true }])];
  }
  const sent = (index: number) => {
    const messages = fixture.bodies[index]!.messages as Anthropic.MessageParam[];
    const decision = [...messages].reverse().find(entry => entry.role === 'user' && typeof entry.content === 'string')!;
    return JSON.parse(decision.content as string) as Record<string, any>;
  };
  return { fixture, model, step, sent };
}

describe('restated decision parts within one replay epoch', () => {
  it('sends an unchanged catalog, skill index and memory once, names known memories by id, and stores exactly what it sent', async () => {
    const h = harness(3);
    let history: unknown[] = [];
    history = await h.step(history, { recall: packet([item('a'), item('b')]) });
    history = await h.step(history, { recall: packet([item('b'), item('c')]) });
    expect(h.sent(0)).toMatchObject({ catalog: expect.any(Array), skillIndex: 'Skill index', recall: { items: [{ id: 'a' }, { id: 'b' }] } });
    expect(h.sent(0).recall).not.toHaveProperty('knownItemIds');
    const second = h.sent(1);
    expect(second.catalog).toEqual(UNCHANGED);
    expect(second.skillIndex).toEqual(UNCHANGED);
    expect(second.recall.items.map((entry: TaskMemoryItem) => entry.id)).toEqual(['c']);
    expect(second.recall.knownItemIds).toEqual(['b']);
    // `a` left the packet: it is not named as current, though the first message (already sent) still holds it.
    expect(JSON.stringify(second)).not.toContain('memory a');
    expect(second.recall.knownItemIds).not.toContain('a');
    // Append-only: the second request starts with the first request's messages; what each stored is what each sent.
    const first = h.fixture.bodies[0]!.messages as unknown[], next = h.fixture.bodies[1]!.messages as unknown[];
    expect(next.slice(0, first.length)).toEqual(first);
    expect((history as Anthropic.MessageParam[]).filter(entry => entry.role === 'user' && typeof entry.content === 'string')
      .map(entry => JSON.parse(entry.content as string))).toEqual([h.sent(0), second]);
  });

  it('restates a memory whose text changed, and a catalog or skill index that changed', async () => {
    const h = harness(2);
    let history: unknown[] = [];
    history = await h.step(history, { recall: packet([item('a')]) });
    await h.step(history, { recall: packet([item('a', 'corrected memory a')]), catalog: [...catalog, { name: 'task.send', description: 'new' }],
      tools: [...tools], skillIndex: 'Updated skill index' });
    const second = h.sent(1);
    expect(second.recall.items).toEqual([item('a', 'corrected memory a')]);
    expect(second.recall).not.toHaveProperty('knownItemIds');
    expect(second.catalog).toHaveLength(3);
    expect(second.skillIndex).toBe('Updated skill index');
  });

  it('restates everything after a new public epoch: the bootstrap names the parts without their text', async () => {
    const h = harness(2);
    const history = await h.step([], { recall: packet([item('a')]) });
    const round = { sequence: 1, stepId: 'step-1', entries: history, status: 'executing', committedAt: '', sources: [] } as never;
    const projected = anthropicFcaHistoryCodec.project(round)!;
    expect(JSON.stringify(projected)).not.toContain('memory a');
    const bootstrap = anthropicFcaHistoryCodec.bootstrap(JSON.stringify({ kind: 'fca_public_history', summary: null, rounds: [{ messages: projected }] }));
    await h.step([...bootstrap], { recall: packet([item('a')]) });
    const second = h.sent(1);
    expect(second.catalog).toHaveLength(2);
    expect(second.skillIndex).toBe('Skill index');
    expect(second.recall.items).toEqual([item('a')]);
    expect(second.recall).not.toHaveProperty('knownItemIds');
  });
});

describe('the recall packet as the model reads it', () => {
  it('gives each memory\'s text whole and its provenance as counts, without the source id lists the runner keeps', async () => {
    const h = harness(1);
    const sourced = { ...item('a'), provenance: { kind: 'experience' as const, sourceIds: ['SOURCE-1', 'SOURCE-2'], readSourceIds: ['READ-1'] } };
    await h.step([], { recall: { ...packet([sourced]), sourceIds: ['SOURCE-1', 'SOURCE-2'] } });
    const recall = h.sent(0).recall;
    expect(recall).toEqual({ contextVersion: 'v1', observedAt: '2026-10-14T00:00:00.000Z', status: 'ready', sourceCount: 2,
      items: [{ ...item('a'), provenance: { kind: 'experience', sourceCount: 2, readSourceCount: 1 } }] });
    expect(JSON.stringify(h.fixture.bodies[0])).not.toMatch(/SOURCE-|READ-1/u);
  });
});

describe('an elided memory never stands for one withheld or forgotten since (privacy)', () => {
  const worlds: ReturnType<typeof memoryWorld>[] = [];
  afterEach(() => worlds.splice(0).forEach(world => world.close()));

  it('reads each packet through the current forgetting and audience controls before naming any memory by id', async () => {
    const w = memoryWorld(); worlds.push(w); let owner = true;
    const memory = createTaskMemory({ state: w.store, conversations: w.store, ownerScope: 'owner', ownerAlone: () => owner, now: w.now });
    const recall = createTaskRecall({ state: w.store, conversations: w.store, memory, enrich: null, now: w.now });
    const kept = w.store.appendTurn('owner', 'thread-kept', '望遠鏡は棚の上', '棚の上にある', w.now());
    const forgotten = w.store.appendTurn('owner', 'thread', '望遠鏡の秘密の約束', '秘密の約束', w.now());
    const cue = { scopeKey: 'owner', taskId: 'task-1', contextVersion: 'v1', cue: '望遠鏡', present: OWNER_AUDIENCE, semantic: false };
    const first = await recall.packet(cue);
    expect(first.items.map(entry => entry.id)).toEqual(expect.arrayContaining([kept.id, forgotten.id]));
    const h = harness(3);
    let history = await h.step([], { recall: first });
    w.advance(1000);
    new ShannonMemoryService(w.store, w.store, w.now).mutate('owner', { memoryId: forgotten.id, action: 'forget' });
    const second = await recall.packet(cue);
    expect(second.items.map(entry => entry.id)).not.toContain(forgotten.id);
    history = await h.step(history, { recall: second });
    const sent = h.sent(1);
    expect(JSON.stringify(sent)).not.toContain(forgotten.id);
    // Exactly the memories of the current packet whose text the first message showed are named; the forgotten one is not.
    const shown = new Set(first.items.map(entry => JSON.stringify(entry)));
    const expected = second.items.filter(entry => shown.has(JSON.stringify(entry))).map(entry => entry.id);
    expect(expected.length).toBeGreaterThan(0);
    expect(sent.recall.knownItemIds).toEqual(expected);
    for (const id of sent.recall.knownItemIds ?? []) expect(second.items.map(entry => entry.id)).toContain(id);
    // With someone else present the packet is withheld: nothing is named, nothing is restated.
    owner = false;
    const withheld = await recall.packet(cue);
    expect(withheld).toMatchObject({ status: 'withheld', items: [] });
    await h.step(history, { recall: withheld });
    const { sourceIds: _sources, ...withheldFields } = withheld;
    expect(h.sent(2).recall).toEqual({ ...withheldFields, sourceCount: 0, items: [] });
    for (const id of expected) expect(JSON.stringify(h.sent(2))).not.toContain(id);
  });
});
