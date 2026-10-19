import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { runFcaStep, type FcaStepPorts } from '../src/mind/action/fca/fcaRunner.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { bedSearchMemory, minecraftSituation, minecraftSkillPointers } from '../src/surfaces/minecraft/minecraftSkillPointers.js';

/**
 * The no-sheep mark across real steps (review F1): the runner merges a step's checkpoint over the prior one (`{ ...prior, ...tools.checkpoint() }`),
 * so a cleared mark must be saved as `null`; a missing key would keep the old mark for ever and silence the bed pointer on every later day.
 */
const databases: DatabaseSync[] = [];
const at = '2026-10-17T00:00:00.000Z';
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const BED = 'mc-bed-before-night';
const observation = (darkInSeconds: number): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1, stateAt: at, receivedAt: at, connected: true,
  state: { world: { dimension: 'overworld', health: 20, food: 20, time: String(13_000 - darkInSeconds * 20), margin: { darkInSeconds }, inventory: [], nearbyThreats: [] } },
  facts: { dimension: 'overworld' } } as unknown as BodyObservation);
const none = { ok: true, text: '64ブロック以内にsheepタイプのエンティティは見つかりませんでした' };

describe('the no-sheep mark through the runner\'s checkpoint merge', () => {
  it('is saved on day 1, cleared and overwritten the next morning, and the bed pointer is offered again that day', async () => {
    const db = new DatabaseSync(':memory:'); databases.push(db); migrateAgentTasks(db);
    const actions = new SQLiteActionStore(db);
    const runtime = new SQLiteTaskRuntimeStore(db, { authority: new SQLiteFcaTaskAuthority(db), now: () => at, leaseValid: (_scope, _task, lease, time) => !!actions.check(lease, time) });
    const root = runtime.ensureRoot('owner');
    const task = runtime.createChild('owner', root.id, { title: 'Bed', goal: 'Secure a bed', completionCriteria: 'Slept' }, 'bed');
    const ports: FcaStepPorts = { runtime, ownerAlone: () => true, permit: async () => true,
      model: { async decide() { return { decision: { kind: 'tools', calls: [{ id: 'call', name: 'task.list', input: {} }] }, history: [{ role: 'assistant', content: 'turn' }] }; },
        toolResults(value) { return { role: 'user', content: value.map(item => ({ type: 'tool_result', tool_use_id: item.id, content: item.text })) }; } } };
    let sequence = 0;
    const offered: string[][] = [];
    /** One step as the body wires it: the memory starts from the saved checkpoint, meets the observation, and its checkpoint is merged by the runner. */
    async function step(seconds: number, search = false) {
      const saved = runtime.snapshot('owner', task.id)!.checkpoint as { minecraftNoSheepDarkIn?: unknown } | null;
      const memory = bedSearchMemory(saved?.minecraftNoSheepDarkIn), seen = observation(seconds);
      offered.push(minecraftSkillPointers(minecraftSituation(seen, { failedStepsInARow: 0, ...memory.facts(seen) }), new Set([BED])));
      if (search) memory.note({ name: 'mc.find-nearest-entity', input: { entityType: 'sheep' } }, none, () => seen);
      ports.tools = { definitions: [], async execute() { throw new Error('unused'); }, checkpoint: () => memory.checkpoint() };
      const action = actions.claim(actions.enqueue({ scopeKey: 'owner', sourceId: `bed-${++sequence}`, kind: 'agentTask', origin: 'owner_request' }, at).id, 'worker', at)!;
      const begun = runtime.beginStep('owner', task.id, leaseOf(action), runtime.get('owner', task.id)!.revision)!;
      await runFcaStep(begun, ports, new AbortController().signal);
      actions.finish(begun.lease, 'completed', 'yielded', at); runtime.acknowledgeReceipt('owner', begun.id);
      return (runtime.snapshot('owner', task.id)!.checkpoint as { minecraftNoSheepDarkIn?: unknown }).minecraftNoSheepDarkIn;
    }
    const pointer = [`${BED}（日暮れまでにベッドが要る）`];
    // Day 1: offered at 500 s, she looks for sheep and finds none (200 s to dark), and the mark is saved.
    expect(await step(500)).toBeNull();
    expect(await step(200, true)).toBe(200);
    // The rest of day 1 stays quiet, also through the night (the countdown reads 0).
    expect(await step(150)).toBe(200);
    expect(await step(0)).toBe(200);
    // Day 2 morning: the countdown rises, the mark clears and the saved checkpoint no longer holds it.
    expect(await step(650)).toBeNull();
    // Later that day the pointer is offered again, and the saved checkpoint stays clear.
    expect(await step(400)).toBeNull();
    expect(offered).toEqual([pointer, pointer, [], [], [], pointer]);
  });
});
