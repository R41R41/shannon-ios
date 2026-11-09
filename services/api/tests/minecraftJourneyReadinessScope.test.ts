import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { createFcaHistoryAhead } from '../src/mind/action/fca/fcaHistory.js';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { forgetFirstPlans } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { forgetLlmcEvents } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { readinessParts } from '../src/surfaces/minecraft/minecraftLlmcBodyFacts.js';
import { minecraftV2Hooks } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { llmcStepParts } from '../src/wiring/minecraftLlmcWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';

const AT = '2026-11-06T00:00:00.000Z', DRAGON = 'エンドラを討伐してください';
const PEARL = 'エンダーパールを14個実在庫に集め、今回の入場anchorへ生存して帰還してください';
const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); forgetFirstPlans(); forgetLlmcEvents(); vi.restoreAllMocks(); });

const world = { dimension: 'the_nether', position: { x: 304.5, y: 49, z: -117.5 }, localMap: 'observed floor',
  health: 14, food: 16, worn: 'iron_chestplate', inventory: [{ name: 'iron_pickaxe', count: 1 }, { name: 'cobblestone', count: 128 }],
  nearbyThreats: [{ id: 17, name: 'blaze', distance: 20, position: { x: 324.5, y: 49, z: -117.5 } }],
  scan: { at: AT, text: 'loaded chunks', rows: [] } };
const observation = (value = world): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1,
  stateAt: AT, receivedAt: AT, connected: true, facts: { alive: true }, state: { world: value as never } });

function taskParts(goal: string, scene = world) {
  const h = actionHarness(() => AT);
  stops.push(h.close);
  migrateAgentTasks(h.db);
  const runtime = new SQLiteTaskRuntimeStore(h.db, { authority: new SQLiteFcaTaskAuthority(h.db), now: () => AT,
    leaseValid: () => true, conversationLeaseValid: () => true });
  const root = runtime.ensureRoot('owner');
  const task = runtime.createChild('owner', root.id, { title: 'local Minecraft', goal }, 'owner-request');
  const step = runtime.beginStep('owner', task.id, { id: `lease-${task.id}`, holder: 'test', generation: 1 })!;
  const store = new MinecraftControlStore(h.db);
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot',
    servers: [{ serverId: 'world', title: 'world', onlineMode: false, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const control = new MinecraftControl(store, configuration, { now: () => Date.parse(AT), leaseValid: () => true, ownerAlone: () => true });
  control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, { schemaVersion: 1, serverId: 'world', connectionId: 'connection',
    observation: observation(scene), skills: [], candidates: [], receipts: [], activeOperationIds: [] });
  store.bind(task.id, 'minecraft:world');
  const plannerInputs: string[] = [];
  const llmc = { names: { main: 'm', escalate: null, plan: 'p' }, models: { main: {} as never, escalate: null }, summarizer: null,
    policy: {}, historyAhead: createFcaHistoryAhead(), planner: async (_system: string, input: string) => {
      plannerInputs.push(input); return { nodes: [] };
    } };
  const parts = llmcStepParts(llmc as never, step, control, () => undefined);
  const inner = { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
    toolSignal: (_name: string, parent: AbortSignal) => parent, async close() {} };
  const body = parts.wrap(inner as never);
  body.context();
  return { parts, plannerInputs, live: body.transient!() as Record<string, unknown> };
}

describe('original goal scopes journey preparation, without removing local facts', () => {
  it.each([PEARL, 'エンドラの話ではなくブレイズロッドを7本集めて帰って'])('keeps %s free of journey tables in both real wiring paths', async goal => {
    const run = taskParts(goal);
    await vi.waitFor(() => expect(run.plannerInputs).toHaveLength(1));
    expect(run.plannerInputs[0]).not.toContain('準備の不足（ネザーの奥へ）');
    expect(run.plannerInputs[0]).toContain('体力 14/20 は自然に戻らない');
    expect(run.plannerInputs[0]).toContain('着ている物: iron_chestplate');
    expect(run.live).not.toHaveProperty('shortage');
    expect(JSON.stringify(run.live)).toContain('体力 14/20 は自然に戻らない');
    expect(JSON.stringify(run.live)).toContain('blaze');
    expect(run.live).toHaveProperty('state.health', 14);
  });

  it('keeps the native dragon journey and legacy helper output unchanged', async () => {
    const run = taskParts(DRAGON);
    await vi.waitFor(() => expect(run.plannerInputs).toHaveLength(1));
    const legacy = readinessParts({ plan: () => undefined, planView: () => null }, null, observation());
    expect(run.live.shortage).toBe(legacy.shortage);
    expect(run.live.shortage).toContain('準備の不足（ネザーの奥へ）: 作業台・盾が無い');
    expect(run.plannerInputs[0]).toContain(legacy.shortage);
  });

  it('keeps current mining capability, actual target materials, fuel and recovery for a local task', () => {
    const tree: PlanTree = { schema: 'shannon.plan-tree.v2', revision: 1, current: 'mine', promises: [], nodes: [
      { id: 'mine', parentId: null, order: 1, title: '鉄鉱石を採掘', kind: 'iron', state: 'continue',
        target: { item: 'iron_ingot', count: 12 }, doneWhen: 'have:iron_ingot>=12' }] };
    const frame = observation({ ...world, inventory: [{ name: 'wooden_pickaxe', count: 1 }, { name: 'raw_iron', count: 8 }] });
    const local = readinessParts({ journeyReadiness: false, plan: () => undefined, planView: () => null, planTree: () => tree }, null, frame);
    expect(local.shortage).not.toContain('準備の不足（ネザーの奥へ）');
    expect(local.shortage).toContain('鉄鉱石の採掘に使えるツルハシ');
    expect(local.shortage).toContain('燃料');
    expect(local.shortage).toContain('取得目標 iron_ingot');
    expect(local.recovery?.join(' ')).toContain('体力 14/20 は自然に戻らない');
  });

  it('preserves the urgent near-enemy state and recovery for either goal', () => {
    const near = { ...world, nearbyThreats: [{ id: 17, name: 'blaze', distance: 4, position: { x: 308.5, y: 49, z: -117.5 } }] };
    for (const goal of [PEARL, DRAGON]) {
      const run = taskParts(goal, near);
      expect(run.live.urgent).toEqual(expect.arrayContaining([expect.stringContaining('blaze')]));
      expect(run.live).toHaveProperty('state.health', 14);
      expect(JSON.stringify(run.live.recovery)).toContain('体力 14/20 は自然に戻らない');
    }
  });

  it('carries the scoped live facts into the actual V2 provider request without sending it', async () => {
    const calls: Record<string, unknown>[] = [];
    const client = { messages: { async create(input: Record<string, unknown>) {
      calls.push(JSON.parse(JSON.stringify(input)) as Record<string, unknown>); throw new Error('OFFLINE_CAPTURE_ONLY');
    } } };
    const model = createAnthropicFcaModel({ model: 'claude-haiku-5-5', client: client as never, recordUsage() {},
      minecraftOwnPrompt: true, minecraftV2: minecraftV2Hooks() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const goal of [PEARL, DRAGON]) {
      const run = taskParts(goal);
      await expect(model.decide({ task: { id: goal, title: 'readiness scope', goal, completionCriteria: 'actual inventory and safe return' },
        messages: [], children: [], history: [], tools: [], coreTools: [], transient: run.live }, new AbortController().signal)).rejects.toThrow();
    }
    expect(calls).toHaveLength(2);
    const local = JSON.stringify(calls[0]!.messages), dragon = JSON.stringify(calls[1]!.messages);
    expect(local).not.toContain('準備の不足（ネザーの奥へ）');
    expect(dragon).toContain('準備の不足（ネザーの奥へ）');
    for (const input of [local, dragon]) {
      expect(input).toContain('blaze');
      expect(input).toContain('体力 14/20 は自然に戻らない');
    }
  });
});
