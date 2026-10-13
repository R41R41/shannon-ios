import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import type { FcaBodyLifecycle, FcaExternalTools, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import type { FcaToolSelector } from '../src/mind/selectors/fcaToolSelection.js';
import type { BodyObservation, BodyValue } from '../src/contracts/bodyControlContract.js';
import { providerToolName, toolOk } from '../src/mind/tools/shannonTools.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { FCA_HISTORY_POLICY } from '../src/mind/action/fca/fcaHistory.js';
import { MINECRAFT_OBSERVATION_DETAIL, MINECRAFT_OBSERVATION_SUMMARY_CHARACTERS, minecraftObservationSummary } from '../src/surfaces/minecraft/minecraftObservationSummary.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';
import { anthropicRequestViolation } from './support/anthropicProviderRules.js';

/**
 * Minebot lane, 2026-10-14 01:52 JST, production 999dccfc: 「エンドラを討伐してください」 became task ecf64b3e. Its first round was
 * about 100,000 characters (user 43,238 with the world frame, inline definitions of 77 mc.* tools 46,652, assistant 2,593,
 * tool result 7,565) against a 64,000-character history budget, with nothing older to summarize: the second step failed with
 * FCA_HISTORY_RECENT_LIMIT. Every Minecraft task failed the same way.
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });

const GOAL = 'エンドラを討伐する', CRITERIA = '目的の達成を新しいワールド観測と実行結果から確認する。';

/** A Minebot-shaped world frame (`captureWorldObservation`) of the given length. */
function worldFrame(characters: number): BodyObservation {
  const entity = (index: number) => ({ name: index % 3 ? 'zombie' : 'enderman', kind: index % 3 ? 'hostile' : 'mob', distance: 4 + index,
    position: { x: 100.5 + index, y: 64, z: -20.25 - index }, closingSpeed: 0.4, secondsToContact: 9.5 });
  const world: Record<string, BodyValue> = {
    observedAt: '2026-10-14T01:52:00.000Z', dimension: 'overworld', position: { x: 100.5, y: 64, z: -20.25 }, health: 20, food: 18, oxygen: 20,
    isInWater: false, weather: 'clear', time: '13000', biome: 'plains', heldItem: 'diamond_sword',
    inventory: Array.from({ length: 30 }, (_, index) => ({ name: `item_${index}`, count: index + 1 })),
    nearbyEntities: Array.from({ length: 16 }, (_, index) => entity(index)), nearbyThreats: Array.from({ length: 10 }, (_, index) => entity(index)),
    rememberedPlaces: { 拠点: '100,64,-20', 村: '400,70,300' },
    landmarks: [] as BodyValue[],
  };
  const observation: BodyObservation = { schemaVersion: 1, bodyId: 'minecraft:world', sequence: 7, stateAt: '2026-10-14T01:52:00.000Z',
    receivedAt: '2026-10-14T01:52:00.000Z', connected: true, state: { world, primitives: { inventory: [], targets: [], ray: null } },
    facts: { connected: true, alive: true, danger: false, stuck: false, visualRequired: false, imageAvailable: false, dimension: 'overworld' } };
  const landmarks = world.landmarks as BodyValue[];
  while (JSON.stringify(observation).length < characters) {
    landmarks.push({ name: `目印${landmarks.length}`, kind: 'structure', position: { x: landmarks.length * 17, y: 70, z: -landmarks.length * 13 }, note: '遠くに見えた建物の角' });
  }
  return observation;
}

/** 77 registered body skills whose inline definitions total about 46,000 characters, as the paired adapter advertised them. */
const skills: FcaToolDefinition[] = Array.from({ length: 77 }, (_, index) => ({
  name: `mc.skill_${index}`, description: `身体スキル${index}。${'指定した対象に近づき、条件を満たしたら操作する。'.repeat(4)}`,
  input: { type: 'object', properties: {}, required: [], additionalProperties: false },
  nativeInputSchema: { type: 'object', additionalProperties: false, required: ['target'], properties: {
    target: { type: 'string', description: `対象の名前。${'例: zombie、ender_dragon。'.repeat(6)}` },
    distance: { type: 'number', description: '近づく距離（ブロック）。' } } },
  domain: 'minecraft_body', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'],
}));
const reflex: FcaToolDefinition = { name: 'minecraft.reflex', description: '一人称画像を更新しながら短い身体操作を選ぶ。',
  input: { type: 'object', properties: {}, required: [], additionalProperties: false },
  domain: 'minecraft_body', effect: 'write', cost: 'model', audiences: ['owner_alone'], surfaces: ['text'] };

function minecraftRun(options: { observation: number; result: number }) {
  let time = Date.parse('2026-10-14T01:52:00.000Z');
  const now = () => new Date(time).toISOString();
  const h = actionHarness(now);
  const answers = [
    [{ type: 'thinking', thinking: '画像で周囲を確かめる', signature: 'signed-round-1' }, { type: 'tool_use', id: 'toolu_reflex_1', name: providerToolName('minecraft.reflex'), input: {} }],
    [{ type: 'tool_use', id: 'toolu_wait_2', name: 'fca_wait', input: { summary: '観測を待つ' } }],
  ];
  const fixture = scriptedAnthropic((body, index) => {
    const violation = anthropicRequestViolation(body);
    if (violation) throw new Error(violation);
    return message(answers[index] ?? answers[1]!, 'tool_use');
  });
  const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage() {} });
  const frame = worldFrame(options.observation);
  // The pre-fix shape: the whole frame on every decision, so this holds at the history layer alone.
  const body: FcaBodyLifecycle = { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: frame }), guard: async () => true,
    toolSignal: (_name, parent) => parent, close: async () => {} };
  const tools: FcaExternalTools = { definitions: [...skills, reflex],
    async execute() { return toolOk(JSON.stringify({ reason: 'observation_unavailable', decisions: 0, control: 'returned', latestObservation: 'x'.repeat(options.result) })); } };
  const selector: FcaToolSelector = { async select(request) { return { names: request.tools.map(tool => tool.name), source: 'fallback' }; } };
  let only = '';
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, model, scopeKey: 'owner', ownerAlone: () => true, now, canRunTask: (_runtime, id) => id === only,
    stepPorts: () => ({ body, tools, selector, history: { codec: anthropicFcaHistoryCodec } }) });
  cleanups.push(async () => { await driver.close(); h.close(); });
  const root = driver.runtime.ensureRoot('owner');
  const task = driver.runtime.createChild('owner', root.id, { title: GOAL, goal: GOAL, completionCriteria: CRITERIA }, 'minecraft-request');
  only = task.id;
  async function settle(done: () => boolean) { for (let i = 0; i < 20 && !done(); i++) { await driver.tick(); await driver.drain(); time += 1_000; } }
  return { driver, task, fixture, settle };
}
const messages = (body: Record<string, unknown>) => body.messages as Array<{ role: string; content: unknown }>;
const length = (value: unknown) => JSON.stringify(value).length;

describe('a Minecraft task whose first round alone exceeds the history budget takes its second step (Minebot lane 2026-10-14)', () => {
  it('replays the first round byte for byte: inline tool definitions are measured apart from the history budget', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = minecraftRun({ observation: 25_000, result: 7_400 });
    await run.settle(() => run.fixture.bodies.length >= 2);
    const [first, second] = run.fixture.bodies;
    // The production shape of round 1: a user message of about 43k and inline definitions of about 46k.
    const [user, definitions] = messages(first!);
    expect(user!.role).toBe('user'); expect(definitions!.role).toBe('system');
    expect(length(user)).toBeGreaterThan(40_000); expect(length(user)).toBeLessThan(48_000);
    expect(length(definitions)).toBeGreaterThan(43_000); expect(length(definitions)).toBeLessThan(50_000);
    expect(second).toBeDefined();
    const round = messages(second!).slice(0, 4);
    // Over the old single budget, all of it is native: signed thinking and the call/result pair, unchanged.
    expect(length(round)).toBeGreaterThan(FCA_HISTORY_POLICY.maximumNativeCharacters + 30_000);
    expect(round.slice(0, 2)).toEqual(messages(first!));
    expect(round[2]).toMatchObject({ role: 'assistant', content: [{ type: 'thinking', signature: 'signed-round-1' }, { type: 'tool_use', id: 'toolu_reflex_1' }] });
    expect(round[3]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_reflex_1' }] });
    // The cached prefix keeps the definitions; no second copy is appended.
    expect(messages(second!).filter(entry => entry.role === 'system')).toHaveLength(1);
    const current = JSON.parse(String(messages(second!).at(-1)!.content)) as { task: { goal: string; completionCriteria: string } };
    expect(current.task).toMatchObject({ goal: GOAL, completionCriteria: CRITERIA });
    expect(run.driver.runtime.get('owner', run.task.id)?.phase).not.toBe('failed');
    expect(log.mock.calls.map(args => String(args[0])).filter(line => line.startsWith('Shannon FCA step'))).toEqual([]);
  });

  it('replays a lone round too long by itself as a clipped public epoch, its call and result paired and the goal stated again', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = minecraftRun({ observation: 25_000, result: 90_000 });
    await run.settle(() => run.fixture.bodies.length >= 2);
    const second = run.fixture.bodies[1];
    expect(second).toBeDefined();
    const sent = messages(second!);
    // A fresh epoch: one public user message, the definitions added again after it, then the current decision.
    expect(sent.map(entry => entry.role)).toEqual(['user', 'system', 'user']);
    expect(length(sent[0])).toBeLessThanOrEqual(FCA_HISTORY_POLICY.maximumNativeCharacters);
    expect(JSON.stringify(sent)).not.toContain('signed-round-1');
    const bootstrap = JSON.parse(String(sent[0]!.content)) as { kind: string; rounds: Array<{ messages: Array<{ role: string; callId?: string; content: string }> }> };
    expect(bootstrap.kind).toBe('fca_public_history');
    const public_ = bootstrap.rounds[0]!.messages;
    expect(public_.filter(entry => entry.role === 'tool_call').map(entry => entry.callId)).toEqual(['toolu_reflex_1']);
    expect(public_.filter(entry => entry.role === 'tool_result').map(entry => entry.callId)).toEqual(['toolu_reflex_1']);
    expect(public_.find(entry => entry.role === 'tool_result')!.content).toMatch(/履歴の上限により後略: \d+字。元の記録は保存済み/u);
    const current = JSON.parse(String(sent.at(-1)!.content)) as { task: { goal: string; completionCriteria: string } };
    expect(current.task).toMatchObject({ goal: GOAL, completionCriteria: CRITERIA });
    // The stored round is untouched.
    const stored = run.driver.runtime.snapshot('owner', run.task.id)!.history;
    expect(JSON.stringify(stored)).toContain('signed-round-1');
    expect(JSON.stringify(stored)).not.toContain('履歴の上限により後略');
    expect(log.mock.calls.map(args => String(args[0])).filter(line => line.startsWith('Shannon FCA step'))).toEqual([]);
  });
});

describe('the body observation of a Minecraft decision is a bounded summary (Minebot lane 2026-10-14)', () => {
  it('keeps vitals, position, inventory, threats and facts, names what it left out, and points at minecraft.observe', () => {
    const frame = worldFrame(43_000);
    const summary = minecraftObservationSummary(frame);
    expect(length(summary)).toBeLessThanOrEqual(MINECRAFT_OBSERVATION_SUMMARY_CHARACTERS);
    expect(summary).toMatchObject({ bodyId: 'minecraft:world', sequence: 7, connected: true, facts: frame.facts });
    const world = summary.state.world as Record<string, unknown>;
    expect(world).toMatchObject({ dimension: 'overworld', health: 20, food: 18, heldItem: 'diamond_sword', position: { x: 100.5, y: 64, z: -20.25 } });
    expect(world.inventory).toContain('item_0×1');
    expect((world.nearbyThreats as unknown[]).length).toBe(6); // five and how many were left out
    expect(summary.state.detail).toBe(MINECRAFT_OBSERVATION_DETAIL);
    expect(summary.state.omitted).toContain('world.landmarks');
    expect(frame.state.world).toHaveProperty('landmarks'); // the original is not changed
  });

  it('stays within its bound for an unusual frame by dropping the largest parts, naming each', () => {
    const frame = worldFrame(10_000);
    const world = frame.state.world as Record<string, BodyValue>;
    const wide = { ...frame, state: { ...frame.state, world: { ...world, inventory: Array.from({ length: 36 }, (_, index) => ({ name: `long_item_name_${'x'.repeat(120)}_${index}`, count: 1 })) } } };
    const summary = minecraftObservationSummary(wide);
    expect(length(summary)).toBeLessThanOrEqual(MINECRAFT_OBSERVATION_SUMMARY_CHARACTERS);
    expect(summary.state.omitted).toContain('world.inventory');
  });
});
