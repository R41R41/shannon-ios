import { configuredActionResourceProof } from '../src/wiring/configuredActionResourceProof.js';
import { afterEach, expect, it } from 'vitest';
import { actionHarness } from './support/actionThreadHarness.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { MinecraftLifecycleStore } from '../src/surfaces/minecraft/store/minecraftLifecycleStore.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { MinecraftLifecycle } from '../src/surfaces/minecraft/minecraftLifecycle.js';
import { createMinecraftLifecycleRecovery } from '../src/wiring/minecraftLifecycleRecoveryWiring.js';
import type { MinecraftLifecycleCommand, MinecraftLifecycleReceipt } from '../src/contracts/minecraftLifecycleContract.js';
const finish: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of finish.splice(0).reverse()) await close(); });
async function fixture() {
  const at = '2026-10-09T00:00:00.000Z', h = actionHarness(() => at, ':memory:', undefined, db => configuredActionResourceProof({ SHANNON_MINECRAFT_LIFECYCLE: 'on', SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'operator', servers: [{ serverId: 'home', title: 'Home', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) }, db)); finish.push(h.close);
  const body = actionResource('operator', 'minecraft-body'), unrelated = actionResource('host', 'unrelated-file');
  const action = await h.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: 'fca:task:1', resources: [actionResource('owner', 'fca:task')] });
  const active = (await h.actions.claim(action.id))!, lease = leaseOf(active);
  await h.actions.dispatch(lease, [body, unrelated]);
  const store = new MinecraftLifecycleStore(h.db), native = new MinecraftControlStore(h.db);
  const command: MinecraftLifecycleCommand = { schemaVersion: 1, id: 'lifecycle:original', connectionId: 'original-connection', serverId: 'home', action: 'login', issuedAt: at,
    authority: { scopeKey: 'owner', origin: 'owner_request', executionId: lease.id, lease, sourceIds: ['experience:original-turn'] }, deadlineAt: '2026-10-09T00:02:00.000Z' };
  store.insert(command); store.deliver(command.id);
  const service = new MinecraftLifecycle(store, { deviceId: 'operator', ownerScopeKey: 'owner', servers: new Map([['home', { serverId: 'home', title: 'Home', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }]]) }, { now: () => Date.parse(at) + 2000, allowed: () => false });
  const recovery = createMinecraftLifecycleRecovery({ db: h.db, service, actions: h.actions, deviceId: 'operator' }); finish.push(recovery.close);
  const receipt = (patch: Partial<MinecraftLifecycleReceipt> = {}): MinecraftLifecycleReceipt => ({ id: command.id, connectionId: command.connectionId, serverId: 'home', action: 'login', outcome: 'completed', code: 'changed', inputsReleased: true,
    observedAt: '2026-10-09T00:00:02.000Z', state: { serverId: 'home', observedAt: '2026-10-09T00:00:02.000Z', running: 'running', bot: 'joined', otherPlayers: 0 }, ...patch });
  const poll = (value: MinecraftLifecycleReceipt) => service.poll({ scopeKey: 'owner', deviceId: 'operator' }, { schemaVersion: 1, connectionId: command.connectionId, sequence: Number(h.db.prepare('SELECT COUNT(*) n FROM minecraft_lifecycle_receipt_events').get()!.n) + 1,
    states: [receipt().state], receipts: [value] });
  await h.actions.finish(lease, 'unknown', 'fca_result_unknown');
  return { h, body, unrelated, command, lease, store, native, recovery, receipt, poll };
}
it('a later same-original terminal receipt releases the body only, preserving unknown task and unrelated resources', async () => {
  const f = await fixture();
  expect(f.poll(f.receipt({ outcome: 'unknown', code: 'error', inputsReleased: false, observedAt: '2026-10-09T00:00:01.000Z', state: { ...f.receipt().state, observedAt: '2026-10-09T00:00:01.000Z' } })).acknowledged).toEqual([f.command.id]);
  await f.recovery.recover(); expect(f.h.store.get(f.lease.id)!.resources).toContain(f.body);
  expect(f.poll(f.receipt()).acknowledged).toEqual([f.command.id]);
  await f.recovery.recover();
  expect(f.h.store.get(f.lease.id)).toMatchObject({ state: 'unknown', sent: true, result: 'fca_result_unknown', resources: expect.arrayContaining([f.unrelated]) });
  expect(f.h.store.get(f.lease.id)!.resources).not.toContain(f.body);
  expect(f.h.db.prepare('SELECT COUNT(*) n FROM minecraft_lifecycle_receipt_events').get()).toEqual({ n: 2 });
  expect(f.h.db.prepare('SELECT COUNT(*) n FROM mind_action_resource_acknowledgements').get()).toEqual({ n: 1 });
  await f.recovery.recover(); expect(f.h.db.prepare('SELECT COUNT(*) n FROM mind_action_resource_acknowledgements').get()).toEqual({ n: 1 });
});
it('does not release native body ownership while a separate original control command is unresolved', async () => {
  const f = await fixture();
  f.native.insert({ schemaVersion: 1, id: 'native:original', serverId: 'home', connectionId: 'native-connection', kind: 'skill', lease: f.lease, deadlineAt: f.command.deadlineAt,
    context: { scopeKey: 'owner', taskId: 'task', taskRevision: 1, bodyId: 'minecraft:home', sessionId: 'step', generation: f.lease.generation, goal: 'goal', completionCondition: 'condition' }, skill: 'look-at', arguments: {} }, f.receipt().observedAt);
  f.native.deliver('native:original'); f.poll(f.receipt());
  await f.recovery.recover(); expect(f.h.store.get(f.lease.id)!.resources).toContain(f.body);
  f.native.settle({ id: 'native:original', connectionId: 'native-connection', outcome: 'completed', inputsReleased: true, observedAt: f.receipt().observedAt });
  await f.recovery.recover(); expect(f.h.store.get(f.lease.id)!.resources).not.toContain(f.body);
});
it('a matching current snapshot or wrong-connection receipt does not release the original resource', async () => {
  const f = await fixture();
  expect(f.poll(f.receipt({ connectionId: 'replacement-connection' })).acknowledged).toEqual([]);
  await f.recovery.recover(); expect(f.h.store.get(f.lease.id)!.resources).toContain(f.body);
  expect(f.h.db.prepare('SELECT COUNT(*) n FROM mind_action_resource_acknowledgements').get()).toEqual({ n: 0 });
});
it('rechecks native cleanup inside the action writer transaction after the IPC gap', async () => {
  const f = await fixture(); f.poll(f.receipt()); let inserted = false;
  const recovery = createMinecraftLifecycleRecovery({ db: f.h.db, service: new MinecraftLifecycle(f.store, { deviceId: 'operator', ownerScopeKey: 'owner', servers: new Map() }, { now: () => 0, allowed: () => false }), deviceId: 'operator',
    actions: { async reconcileResource(lease, resource, id) {
      if (!inserted) {
        inserted = true;
        f.native.insert({ schemaVersion: 1, id: 'native:cleanup', serverId: 'home', connectionId: 'native-connection', kind: 'release', lease: f.lease, deadlineAt: f.command.deadlineAt,
          context: { scopeKey: 'owner', taskId: 'task', taskRevision: 1, bodyId: 'minecraft:home', sessionId: 'step', generation: f.lease.generation, goal: 'goal', completionCondition: 'condition' } }, f.receipt().observedAt);
      }
      return f.h.actions.reconcileResource(lease, resource, id);
    } } }); finish.push(recovery.close);
  await recovery.recover(); expect(inserted).toBe(true); expect(f.h.store.get(f.lease.id)!.resources).toContain(f.body);
  f.native.cancel('native:cleanup');
  await recovery.recover(); expect(f.h.store.get(f.lease.id)!.resources).not.toContain(f.body);
  // A cleanup that reaches insertion after release cannot adopt old ownership.
  expect(() => f.native.insert({ schemaVersion: 1, id: 'native:late', serverId: 'home', connectionId: 'native-connection', kind: 'release', lease: f.lease, deadlineAt: f.command.deadlineAt,
    context: { scopeKey: 'owner', taskId: 'task', taskRevision: 1, bodyId: 'minecraft:home', sessionId: 'step', generation: f.lease.generation, goal: 'goal', completionCondition: 'condition' } }, f.receipt().observedAt,
    () => { expect(f.h.db.isTransaction).toBe(true); return f.h.store.get(f.lease.id)!.resources.includes(f.body); })).toThrow('FCA_BODY_LEASE_INVALID');
  expect(f.native.command('native:late')).toBeNull();
});
