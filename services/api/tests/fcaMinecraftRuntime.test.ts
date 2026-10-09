import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { fcaMinecraftTools } from '../src/wiring/fcaMinecraftTools.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import type { MinecraftControlPoll, MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { acquireAction } from '../src/wiring/actionExecutionWiring.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';
import { actionHarness } from './support/actionThreadHarness.js';

const at = '2026-10-09T00:00:00.000Z', closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
function fixture() {
  const h = actionHarness(() => at), calls: FcaModelInput[] = [], bodyStore = new MinecraftControlStore(h.db);
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world', title: 'world', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  let sequence = 0;
  const control = new MinecraftControl(bodyStore, configuration, { now: () => Date.parse(at), ownerAlone: () => true, pollMilliseconds: 1,
    leaseValid: lease => !!h.store.check(lease, at)?.resources.includes(actionResource('minebot', 'minecraft-body')) });
  const poll = (receipts: MinecraftControlReceipt[] = []) => control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, {
    schemaVersion: 1, serverId: 'world', connectionId: 'connection',
    observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: at, receivedAt: at, connected: true, state: { inventory: receipts.length ? { stone: 1 } : {} }, facts: {} },
    skills: [{ name: 'dig', description: 'Dig the requested count.', readOnly: false,
      inputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 16 } }, required: ['count'], additionalProperties: false } }],
    candidates: [], receipts, activeOperationIds: [],
  } satisfies MinecraftControlPoll);
  poll();
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: () => at,
    model: { async decide(input) { calls.push(input); return input.history.length
      ? { decision: { kind: 'complete', summary: 'Stone confirmed' }, history: [{ role: 'assistant', content: 'Confirmed stone in fresh result.' }] }
      : { decision: { kind: 'tools', calls: [{ id: 'dig-once', name: 'mc.dig', input: { count: 1 } }] }, history: [{ role: 'assistant', content: 'Dig once.' }] }; },
      toolResults: results => ({ role: 'user', results }) },
    stepPorts: (_runtime, step) => ({ tools: fcaMinecraftTools({ control, step, ownerAlone: () => true, sourcesVisible: () => true }) }),
  });
  const root = driver.runtime.ensureRoot('owner'), task = driver.runtime.createChild('owner', root.id, { title: 'Stone', goal: 'Find one stone' }, 'owner-request');
  bodyStore.bind(task.id, 'minecraft:world');
  closes.push(async () => { await driver.close(); h.close(); });
  return { ...h, driver, task, control, bodyStore, calls, poll };
}

describe('normal physical tools in the common FCA executor', () => {
  it('withdraws a reflex-cancelled skill while another task owns the body, without dispatching or stopping the outer task', async () => {
    const f = fixture(), resource = actionResource('minebot', 'minecraft-body');
    const other = await f.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: 'other' });
    expect(await f.actions.dispatch(leaseOf(other!), [resource])).toBe(true);
    let attempted!: () => void;
    const attempting = new Promise<void>(resolve => { attempted = resolve; });
    const active = await acquireAction({ ...f.actions, async dispatch(lease, resources) {
      const result = await f.actions.dispatch(lease, resources); attempted(); return result;
    } }, { scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: `fca:${f.task.id}:${f.task.revision}`,
      resources: [actionResource('owner', `fca:${f.task.id}`)] });
    expect(active).not.toBeNull(); closes.push(async () => { active!.stop(); });
    const step = f.driver.runtime.beginStep('owner', f.task.id, active!.execution.lease, f.task.revision)!;
    const tools = fcaMinecraftTools({ control: f.control, step, ownerAlone: () => true, sourcesVisible: () => true });
    const local = new AbortController();
    const waiting = inActionExecution(active!.execution, () => tools.execute({ scopeKey: 'owner', taskId: f.task.id,
      operationId: 'cancelled-before-dispatch', name: 'mc.dig', input: { count: 1 }, signal: local.signal }));
    const rejected = expect(waiting).rejects.toThrow('FCA_BODY_LEASE_INVALID');
    await attempting; local.abort(); await rejected;
    expect(active!.execution.signal.aborted).toBe(false);
    expect(f.store.get(active!.view.id)?.state).toBe('running');
    expect(f.bodyStore.pending('minecraft:world')).toEqual([]);
    expect(f.poll().commands).toEqual([]);
    await f.actions.finish(leaseOf(other!), 'completed', 'done');
    await active!.finish('cancelled', 'test_complete');
  });
  it('uses one task, native arguments, the existing body resource lease and exact physical receipt before progressing', async () => {
    const f = fixture(); await f.driver.tick();
    for (let count = 0; count < 1000 && !f.bodyStore.pending('minecraft:world').length; count++) await delay(1);
    const command = f.poll().commands[0]!; expect(command).toBeDefined();
    expect(command).toMatchObject({ kind: 'skill', skill: 'dig', arguments: { count: 1 }, context: { taskId: f.task.id, bodyId: 'minecraft:world' } });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.tools.find(tool => tool.name === 'mc.dig')?.nativeInputSchema).toMatchObject({ required: ['count'], properties: { count: { type: 'integer' } } });
    expect(f.driver.runtime.get('owner', f.task.id)?.phase).toBe('executing');
    expect(f.poll().commands).toEqual([]);
    const receipt = { id: command.id, connectionId: 'connection', outcome: 'completed' as const, inputsReleased: true, observedAt: at, result: 'One stone observed in inventory.' };
    expect(f.poll([receipt]).acknowledged).toEqual([command.id]); await f.driver.drain();
    expect(f.driver.runtime.get('owner', f.task.id)?.phase).toBe('ready'); // Tool acknowledgement alone never marks goal complete.
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
    await f.driver.tick(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', f.task.id)).toMatchObject({ phase: 'completed', summary: 'Stone confirmed' });
    expect(f.calls).toHaveLength(2); expect(f.db.prepare('SELECT COUNT(*) AS n FROM fca_body_operations').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT * FROM agent_task_commands').all()).toEqual([]);
  });
});
