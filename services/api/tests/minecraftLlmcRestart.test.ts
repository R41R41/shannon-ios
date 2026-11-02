import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import type { PlanTree } from '@shannon/mind';
import { createFcaConversationBridge, createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationPorts.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { configuredMinecraftBody, type MinecraftTurnRequest } from '../src/contracts/minecraftBodyContract.js';
import { fcaMinecraftRequests } from '../src/wiring/fcaMinecraftRequests.js';
import { fcaMinecraftBodyWake } from '../src/wiring/fcaMinecraftBodyWake.js';
import { underWriteLock } from '../src/infra/sqlite/lockWaits.js';
import { forgetAllBodyAbsent } from '../src/surfaces/minecraft/minecraftBodyAbsent.js';
import { forgetLlmcEvents } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { llmcStepParts } from '../src/wiring/minecraftLlmcWiring.js';
import { createFcaHistoryAhead } from '../src/mind/action/fca/fcaHistory.js';
import { createEyeLedger } from '../src/surfaces/minecraft/minecraftEyeLedger.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { forgetReplans, REPLAN, type ReplanLedger } from '../src/surfaces/minecraft/minecraftLlmcReplan.js';
import { forgetStalls, noteProgress } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import { createWaitLedger } from '../src/surfaces/minecraft/minecraftPurposeProgress.js';
import { actionHarness } from './support/actionThreadHarness.js';

/**
 * The run of 4 to 5 hours on a Spot VM that stops and starts (2026-11-02): after a restart, the plan's nodes, the places she remembers (the thrown
 * eyes), the deadlines of her waits and the count of the strong model's new plans come back from the checkpoint as they were, and a window or a
 * count is not dealt again. Each "restart" here is a new set of step parts made from what the store holds, with the process's memory of the task
 * (`forgetStalls`, `forgetReplans`) gone.
 */
const at = '2026-11-02T00:00:00.000Z', stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); forgetAllBodyAbsent(); forgetLlmcEvents(); forgetStalls(); forgetReplans(); });

const world = { localMap: 'map', dimension: 'overworld', health: 20, food: 20, position: { x: 1, y: 64, z: 2 }, inventory: [], nearbyThreats: [] as unknown[] };
function fixture() {
  const h = actionHarness(() => at);
  stops.push(h.close);
  migrateAgentTasks(h.db);
  const clock = Date.parse(at);
  const authority = new SQLiteFcaTaskAuthority(h.db), runtime = new SQLiteTaskRuntimeStore(h.db, { authority, now: () => at, leaseValid: () => true,
    conversationLeaseValid: () => true, provenanceRefs: true });
  const root = runtime.ensureRoot('owner'), state = new InMemoryCompanionStateStore(() => at), conversations = new InMemoryConversationStore();
  const visible = createFcaSourceGuard({ runtime, state, conversations, ownerScope: 'owner', ownerAlone: () => true });
  const conversation = createFcaConversationBridge({ runtime, ownerScope: 'owner', visible });
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world',
    title: 'world', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const control = new MinecraftControl(new MinecraftControlStore(h.db), configuration, { now: () => clock, leaseValid: () => true, ownerAlone: () => true });
  control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, { schemaVersion: 1, serverId: 'world', connectionId: 'connection',
    observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1, stateAt: at, receivedAt: at, connected: true, state: { world: world as never },
      facts: { alive: true } }, skills: [], candidates: [], receipts: [], activeOperationIds: [] });
  const api = fcaMinecraftRequests({ runtime, control, conversation, visible, ownerScope: 'owner', ownerAlone: () => true, sourceVisible: () => true,
    stop: async (id, reason) => runtime.stop('owner', id, reason), atomic: work => underWriteLock(h.db, null, '', work, 'minecraft_test'), log: () => undefined });
  void fcaMinecraftBodyWake;
  return { runtime, control, api };
}
type Fixture = ReturnType<typeof fixture>;

let leases = 0;
const begin = (f: Fixture, id: string) => {
  const step = f.runtime.beginStep('owner', id, { id: `lease-${++leases}`, holder: 'test', generation: 1 })!;
  expect(step).not.toBeNull();
  return step;
};
const inner = { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
  toolSignal: (_name: string, parent: AbortSignal) => parent, async close() {} };

/** One process's parts for a step: the strong model is a spy (it says no more than "nothing to change"). */
function process(f: Fixture, id: string) {
  const asked: string[] = [];
  const llmc = { names: { main: 'm', escalate: null, plan: 'p' }, models: { main: {} as never, escalate: null }, summarizer: null, policy: {},
    historyAhead: createFcaHistoryAhead(), replanner: async (_system: string, brief: string) => { asked.push(brief); return { ops: [], why: '変えない' }; } };
  const step = begin(f, id);
  const parts = llmcStepParts(llmc as never, step, f.control, () => undefined);
  const lifecycle = parts.wrap(inner as never);
  return { step, parts, lifecycle, asked, checkpoint: () => parts.ports.checkpoint() as Record<string, unknown> };
}
/** The step ends: its checkpoint (the parts' and the plan's tree) is what the store holds for the next process. */
function end(f: Fixture, run: ReturnType<typeof process>): void {
  f.runtime.commitStep(run.step, { disposition: 'continue', history: [], consumedMessageIds: run.step.messageIds,
    checkpoint: { ...run.checkpoint(), fcaPlanTree: run.parts.ports.plan.tree() } });
  f.runtime.acknowledgeReceipt('owner', run.step.id);
}
async function goal(f: Fixture): Promise<string> {
  const made = (await f.api.intent({ scopeKey: 'owner', request: { requestId: 'game-one', serverId: 'world', observedAt: at } as MinecraftTurnRequest,
    experienceId: 'turn-1', intent: { kind: 'task', goal: 'エンドラを討伐して' } }))!;
  return made.request!.id;
}

describe('a restart of the API (a Spot VM that stopped and started) in the middle of a run to the dragon', () => {
  const signal = new AbortController().signal;
  const done = (tree: PlanTree, ids: readonly string[]): PlanTree => ({ ...tree, nodes: tree.nodes.map(node => ids.includes(node.id) ? { ...node, state: 'done' as const } : node) });

  it('brings back the plan\'s nodes, the thrown eyes, the wait\'s deadline and the count of new plans, and deals none of them again', async () => {
    const f = fixture(), id = await goal(f);
    // process 1: the run so far, as its parts would have written it
    const first = process(f, id);
    const tree = done(seedPlan('エンドラを討伐して')!, ['p1', 'p2']);
    const eyes = createEyeLedger(null);
    eyes.note('c1', JSON.stringify({ v: 1, ok: true, done: 1, of: 1, lines: [{ i: 1, do: 'use', status: 'done', line: '' }], at: { x: 0, y: 64, z: 0 }, hp: 20, food: 20, ms: 100,
      eye: { from: { x: 120, y: 64, z: -80 }, bearingDeg: 17.7, flew: 12, to: { x: 124, y: 70, z: -91 }, broke: false } }), 'overworld', Date.now());
    const waits = createWaitLedger(null);
    waits.until('p3', { key: 'time:day', remainingMs: 300_000 }, Date.now());
    const spent: ReplanLedger = { v: 1, total: REPLAN.perRun - 1, recent: [Date.now() - 20 * 60_000], nodes: { p3: 1 }, last: [] };
    noteProgress(id, { node: 'p3', state: 'continue', milestone: null, items: 0 }, Date.now());
    f.runtime.commitStep(first.step, { disposition: 'continue', history: [], consumedMessageIds: first.step.messageIds,
      checkpoint: { ...first.checkpoint(), fcaPlanTree: tree, ...eyes.checkpoint(), ...waits.checkpoint(), minecraftReplans: spent,
        minecraftReplanPending: { stall: { kind: 'death', key: '1-1', why: '死んだ（死の回数 1）' }, at: Date.now() - 60_000 } } });
    f.runtime.acknowledgeReceipt('owner', first.step.id);

    // process 2: the VM started again; nothing of the task is in memory
    forgetStalls();
    forgetReplans();
    const second = process(f, id);
    const kept = second.checkpoint();
    expect(second.parts.ports.plan.tree().nodes.filter(node => node.state === 'done').map(node => node.id)).toEqual(['p1', 'p2']);
    expect(second.parts.ports.plan.tree().current).toBe(tree.current);
    expect(kept.minecraftEyes).toEqual(eyes.checkpoint().minecraftEyes);
    expect(kept.minecraftWaitDeadlines).toEqual(waits.checkpoint().minecraftWaitDeadlines);
    expect(kept.minecraftReplans).toEqual(spent);
    expect(kept.minecraftReplanPending).toMatchObject({ stall: { kind: 'death', key: '1-1' } });
    // the count is not dealt again: the one new plan left is asked for the death found before the restart, and it is counted
    await second.lifecycle.beforeDecision!(signal);
    expect(second.asked).toHaveLength(1);
    expect(second.asked[0]).toContain('死んだ');
    expect(second.checkpoint().minecraftReplans).toMatchObject({ total: REPLAN.perRun });
    expect(second.checkpoint().minecraftReplanPending).toBeNull();
    end(f, second);

    // process 3: another restart; the run's bound is reached and no window is opened again by it
    forgetStalls();
    forgetReplans();
    const third = process(f, id);
    expect(third.checkpoint().minecraftReplans).toMatchObject({ total: REPLAN.perRun });
    third.parts.ports.plan.tree();
    await third.lifecycle.beforeDecision!(signal);
    expect(third.asked).toHaveLength(0);
    expect(third.checkpoint().minecraftEyes).toEqual(eyes.checkpoint().minecraftEyes);
    expect(third.checkpoint().minecraftWaitDeadlines).toEqual(waits.checkpoint().minecraftWaitDeadlines);
  });
});
