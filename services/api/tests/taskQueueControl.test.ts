import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import { validControlPoll, validQueueFields, validSkills } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { ACT_INPUT_SCHEMA } from '../src/contracts/minecraftActContract.js';
import type { MinecraftControlPoll, MinecraftControlReceipt, MinecraftQueueEnvelope } from '../src/contracts/minecraftControlContract.js';
import type { BodyTaskContext } from '../src/contracts/bodyControlContract.js';

/** The task queue's head side of the control (design 2026-10-26): enqueue, the receipt clock, queued ids as reported, many commands in one reply, safe(open). */
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function fixture(options: { cancelWaitMilliseconds?: number } = {}) {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world', title: 'world', onlineMode: true,
    ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const store = new MinecraftControlStore(db);
  let allowed = true, sequence = 0;
  const control = new MinecraftControl(store, configuration, { now: Date.now, leaseValid: () => allowed, leaseKnown: () => true, ownerAlone: () => allowed,
    pollMilliseconds: 1, cancelWaitMilliseconds: 10, ...options });
  const scope = { scopeKey: 'owner', deviceId: 'minebot' };
  const poll = (patch: Partial<MinecraftControlPoll> = {}): MinecraftControlPoll => ({ schemaVersion: 1, serverId: 'world', connectionId: 'connection',
    observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
      connected: true, state: { health: 20 }, facts: {} }, candidates: [],
    skills: [{ name: 'act', description: 'act', readOnly: false, inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
    receipts: [], activeOperationIds: [], ...patch });
  const context: BodyTaskContext = { scopeKey: 'owner', taskId: 'task', taskRevision: 1, bodyId: 'minecraft:world', sessionId: 'step', generation: 1,
    goal: 'stone', completionCondition: 'inventory' };
  const envelope = (item: string, after: string | null, patch: Partial<MinecraftQueueEnvelope> = {}): MinecraftQueueEnvelope => ({ item, after, node: null,
    maxMs: 60_000, startBy: new Date(Date.now() + 60_000).toISOString(), ...patch });
  const item = (id: string, after: string | null, milliseconds = 60_000) => ({ id, context, lease: { id: 'lease', holder: 'holder', generation: 1 },
    kind: 'skill' as const, skill: 'act', arguments: { hands: [{ do: 'wait', seconds: 1 }] }, milliseconds, queue: envelope(`q${id.slice(1)}`, after) });
  const receipt = (id: string, patch: Partial<MinecraftControlReceipt> = {}): MinecraftControlReceipt => ({ id, connectionId: 'connection', outcome: 'completed',
    inputsReleased: true, observedAt: new Date().toISOString(), ...patch });
  control.poll(scope, poll());
  return { db, control, store, scope, poll, context, item, receipt, disallow() { allowed = false; } };
}
const settled = (promise: Promise<unknown>) => { let state = 'pending'; promise.then(() => { state = 'settled'; }, () => { state = 'rejected'; }); return () => state; };

describe('enqueue: a command that is handed over and waited for apart', () => {
  it('inserts the command and returns before the body answers', async () => {
    const f = fixture();
    const { id, receipt } = f.control.enqueue(f.item('q1', null));
    const state = settled(receipt);
    expect(id).toBe('q1');
    expect(f.store.command('q1')?.queue?.item).toBe('q1');
    await delay(5);
    expect(state()).toBe('pending');
    expect(f.control.poll(f.scope, f.poll()).commands.map(c => c.id)).toEqual(['q1']);
    f.control.poll(f.scope, f.poll({ receipts: [f.receipt('q1')] }));
    expect((await receipt).outcome).toBe('completed');
  });
  it('rejects the receipt like command() and leaves no unhandled rejection behind', async () => {
    const f = fixture();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', listener);
    try {
      f.disallow();
      const { receipt } = f.control.enqueue(f.item('q1', null));
      await delay(20);
      expect(unhandled).toEqual([]);
      await expect(receipt).rejects.toThrow('FCA_BODY_LEASE_INVALID');
    } finally { process.off('unhandledRejection', listener); }
  });
  it('answers a repeated id with the first receipt only and refuses a changed command (ADR-0014)', async () => {
    const f = fixture();
    const same = f.item('q1', null), first = f.control.enqueue(same);
    f.control.poll(f.scope, f.poll());
    f.control.poll(f.scope, f.poll({ receipts: [f.receipt('q1')] }));
    const done = await first.receipt;
    expect(await f.control.enqueue(same).receipt).toEqual(done);
    await expect(f.control.enqueue({ ...same, arguments: { hands: [{ do: 'jump' }] } }).receipt).rejects.toThrow('CONFLICT');
  });
});

describe('the clock of a command waiting in the body\'s queue', () => {
  it('does not run while a poll lists the command as waiting, and runs from the last such poll', async () => {
    const f = fixture();
    const { receipt } = f.control.enqueue(f.item('q2', 'q1', 40));
    const state = settled(receipt);
    f.control.poll(f.scope, f.poll());
    for (let round = 0; round < 12; round += 1) {
      f.control.poll(f.scope, f.poll({ activeOperationIds: ['q1'], queuedOperationIds: ['q2'] }));
      await delay(15);
    }
    expect(state()).toBe('pending'); // 180 ms of waiting against a 40 ms budget
    // It starts: no longer listed as waiting. Its 40 ms count from the last listing; then the body is asked (unknown) as for any command.
    f.control.poll(f.scope, f.poll({ activeOperationIds: ['q2'] }));
    await expect(receipt).rejects.toThrow('FCA_BODY_OUTCOME_UNKNOWN');
  });
  it('is the old clock for a command no poll lists as waiting', async () => {
    const f = fixture();
    const { receipt } = f.control.enqueue(f.item('q2', 'q1', 30));
    f.control.poll(f.scope, f.poll());
    await delay(60);
    f.control.poll(f.scope, f.poll({ activeOperationIds: ['q2'] }));
    await expect(receipt).rejects.toThrow('FCA_BODY_OUTCOME_UNKNOWN');
  });
  it('counts a queued id as reported: the delivered command is confirmed, not handed again; an unlisted one is handed again', () => {
    const f = fixture();
    f.control.enqueue(f.item('q1', null));
    expect(f.control.poll(f.scope, f.poll()).commands.map(c => c.id)).toEqual(['q1']);
    expect(f.control.poll(f.scope, f.poll({ queuedOperationIds: ['q1'] })).commands).toEqual([]);
    expect(f.store.phase('q1')).toBe('running');
    expect(f.control.poll(f.scope, f.poll({ queuedOperationIds: ['q1'] })).commands).toEqual([]);
    const g = fixture();
    g.control.enqueue(g.item('q1', null));
    g.control.poll(g.scope, g.poll());
    expect(g.control.poll(g.scope, g.poll()).commands.map(c => c.id)).toEqual(['q1']); // not reported: it never reached the body
  });
});

describe('a reply hands over several queue items', () => {
  it('up to three in order, then the fourth in the next reply', () => {
    const f = fixture();
    for (const [id, after] of [['q1', null], ['q2', 'q1'], ['q3', 'q2'], ['q4', 'q3']] as const) f.control.enqueue(f.item(id, after));
    expect(f.control.poll(f.scope, f.poll()).commands.map(c => c.id)).toEqual(['q1', 'q2', 'q3']);
    expect(f.control.poll(f.scope, f.poll({ activeOperationIds: ['q1'], queuedOperationIds: ['q2', 'q3'] })).commands.map(c => c.id)).toEqual(['q4']);
  });
  it('hands over one command of another kind alone, and never mixes it with a queue item', async () => {
    const f = fixture();
    f.control.command({ id: 'a-probe', context: f.context, lease: { id: 'lease', holder: 'holder', generation: 1 }, kind: 'skill', skill: 'probe',
      arguments: { kind: 'sight' } }).catch(() => undefined);
    await delay(2);
    f.control.enqueue(f.item('q1', null));
    expect(f.control.poll(f.scope, f.poll()).commands.map(c => c.id)).toEqual(['a-probe']);
    expect(f.control.poll(f.scope, f.poll({ activeOperationIds: ['a-probe'] })).commands.map(c => c.id)).toEqual(['q1']);
  });
});

describe('what the step still waits for is not unsafe, a settled unknown is', () => {
  it('safe(task, open) ignores an unsettled operation in the set only', () => {
    const f = fixture();
    f.control.enqueue(f.item('q1', null));
    f.control.enqueue(f.item('q2', 'q1'));
    f.control.poll(f.scope, f.poll());
    expect(f.store.safe('task')).toBe(false);
    expect(f.store.safe('task', new Set(['q1']))).toBe(false);
    expect(f.store.safe('task', new Set(['q1', 'q2']))).toBe(true);
    f.control.poll(f.scope, f.poll({ receipts: [f.receipt('q1', { outcome: 'unknown', inputsReleased: false })] }));
    expect(f.store.safe('task', new Set(['q1', 'q2']))).toBe(false);
  });
  it('cancelTask takes queue items off too: one the body has not got is settled cancelled, one it has is listed for cancel', async () => {
    const f = fixture();
    const first = f.control.enqueue(f.item('q1', null)), second = f.control.enqueue(f.item('q2', 'q1'));
    f.control.poll(f.scope, f.poll({}));
    f.control.enqueue(f.item('q3', 'q2'));
    f.control.cancelTask('task');
    expect(f.store.receipt('q3')?.outcome).toBe('cancelled');
    const reply = f.control.poll(f.scope, f.poll({ activeOperationIds: ['q1'], queuedOperationIds: ['q2'] }));
    expect([...reply.cancel].sort()).toEqual(['q1', 'q2']);
    f.control.poll(f.scope, f.poll({ receipts: [f.receipt('q1', { outcome: 'cancelled' }), f.receipt('q2', { outcome: 'cancelled' })] }));
    expect((await first.receipt).outcome).toBe('cancelled');
    expect((await second.receipt).outcome).toBe('cancelled');
  });
  it('cancelQueued settles a command the body has not got', async () => {
    const f = fixture();
    const { receipt } = f.control.enqueue(f.item('q1', null));
    f.control.cancelQueued(['q1']);
    expect((await receipt).outcome).toBe('cancelled');
  });
});

describe('the poll\'s queue fields', () => {
  it('are read from the newest current frame', () => {
    const f = fixture();
    expect(f.control.queued('minecraft:world')).toEqual([]);
    expect(f.control.progress('minecraft:world')).toBeNull();
    f.control.poll(f.scope, f.poll({ queuedOperationIds: ['q2', 'q3'], queue: { id: 'q1', hand: 2, of: 5, iteration: 1, repeat: 4 } }));
    expect(f.control.queued('minecraft:world')).toEqual(['q2', 'q3']);
    expect(f.control.progress('minecraft:world')).toEqual({ id: 'q1', hand: 2, of: 5, iteration: 1, repeat: 4 });
  });
  it('are optional, and strict in shape', () => {
    const f = fixture(), now = Date.now();
    expect(validControlPoll(f.poll(), now)).toBe(true);
    expect(validControlPoll(f.poll({ queuedOperationIds: ['q1', 'q2'], queue: { id: 'q1', hand: 1, of: 3, iteration: 1, repeat: 1 } }), now)).toBe(true);
    for (const bad of [{ queuedOperationIds: 'q1' }, { queuedOperationIds: [1] }, { queuedOperationIds: Array.from({ length: 9 }, (_, i) => `q${i}`) },
      { queue: { id: 'q1', hand: 0, of: 3, iteration: 1, repeat: 1 } }, { queue: { id: 'q1', hand: 1, of: 3, iteration: 1, repeat: 9 } },
      { queue: { id: 'q1', hand: 1.5, of: 3, iteration: 1, repeat: 1 } }, { queue: 'x' }, { queue: { hand: 1, of: 3, iteration: 1, repeat: 1 } }]) {
      expect(validControlPoll(f.poll(bad as never), now), JSON.stringify(bad)).toBe(false);
      expect(validQueueFields(bad as never)).toBe(false);
    }
  });
  it('take the body\'s act schema with a condition in it (two levels deeper than before) and the head\'s own', () => {
    const condition = { type: 'array', items: { type: 'array', items: { type: 'object', properties: { k: { type: 'string' } }, required: ['k'], additionalProperties: false } } };
    const act = { type: 'object', additionalProperties: false, required: [], properties: { hands: { type: 'array', items: { type: 'string' } }, done: { anyOf: [condition, { type: 'null' }] } } };
    expect(validSkills([{ name: 'act', description: 'x', readOnly: false, inputSchema: act }])).toBe(true);
    expect(validSkills([{ name: 'act', description: 'x', readOnly: false, inputSchema: ACT_INPUT_SCHEMA as never }])).toBe(true);
  });
});
