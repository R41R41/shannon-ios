import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import { validControlPoll, validSkills, validSkillInput } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import type { MinecraftControlPoll, MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';
import type { BodyTaskContext } from '../src/contracts/bodyControlContract.js';
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function fixture(options: { frameMilliseconds?: number; cancelWaitMilliseconds?: number; pollMilliseconds?: number } = {}) {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world', title: 'world', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const store = new MinecraftControlStore(db);
  let allowed = true, owner = true, sequence = 0;
  const control = new MinecraftControl(store, configuration, { now: Date.now, leaseValid: () => allowed, leaseKnown: () => true, ownerAlone: () => owner, pollMilliseconds: 1, cancelWaitMilliseconds: 10, ...options });
  const scope = { scopeKey: 'owner', deviceId: 'minebot' };
  const poll = (patch: Partial<MinecraftControlPoll> = {}): MinecraftControlPoll => ({ schemaVersion: 1, serverId: 'world', connectionId: 'connection',
    observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: new Date().toISOString(), receivedAt: new Date().toISOString(), connected: true, state: { health: 20 }, facts: { target: 'stone' } },
    skills: [{ name: 'dig', description: 'dig', readOnly: false, inputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 64 } }, required: ['count'], additionalProperties: false } }], candidates: [], receipts: [], activeOperationIds: [], ...patch });
  const context: BodyTaskContext = { scopeKey: 'owner', taskId: 'task', taskRevision: 1, bodyId: 'minecraft:world', sessionId: 'step', generation: 1, goal: 'stone', completionCondition: 'inventory' };
  const command = { id: 'operation', context, lease: { id: 'lease', holder: 'holder', generation: 1 }, kind: 'skill' as const, skill: 'dig', arguments: { count: 1 } };
  const receipt = (patch: Partial<MinecraftControlReceipt> = {}): MinecraftControlReceipt => ({ id: 'operation', connectionId: 'connection', outcome: 'completed', inputsReleased: true, observedAt: new Date().toISOString(), result: 'stone acquired', ...patch });
  control.poll(scope, poll());
  return { db, control, store, scope, poll, context, command, receipt, disallow() { allowed = false; owner = false; } };
}
describe('Minecraft common FCA body protocol', () => {
  it('delivers once, accepts the exact receipt and retains no image bytes', async () => {
    const f = fixture(), result = f.control.command(f.command);
    expect(f.control.poll(f.scope, f.poll()).commands.map(c => c.id)).toEqual(['operation']);
    expect(f.control.poll(f.scope, f.poll({ activeOperationIds: ['operation'] })).commands).toEqual([]);
    expect(f.control.poll(f.scope, f.poll()).commands).toEqual([]); // Confirmed running: never handed again.
    const receipt = f.receipt();
    expect(f.control.poll(f.scope, f.poll({ receipts: [receipt] })).acknowledged).toEqual(['operation']);
    expect(await result).toEqual(receipt);
    expect(f.store.safe('task')).toBe(true);
    expect(await f.control.command(f.command)).toEqual(receipt);
    await expect(f.control.command({ ...f.command, arguments: { count: 2 } })).rejects.toThrow('CONFLICT');
  });
  it('takes the body events once, says how far it took them, and skips a malformed one (mb-arch stage 1)', () => {
    const f = fixture();
    const at = new Date().toISOString();
    const iron = { seq: 1, at, kind: 'need.appeared', subject: 'b:16,43,0', data: { need: 'iron', name: 'iron_ore', distance: 16, canReach: true } };
    expect(f.control.poll(f.scope, f.poll()).eventsThrough).toBeUndefined();
    expect(f.control.working('minecraft:world')).toBeNull();
    const reply = f.control.poll(f.scope, f.poll({ events: [iron, { seq: 2, at, kind: 'bogus', subject: 'x', data: {} }] }));
    // The malformed one is skipped, but its number is taken too, so the body stops sending it.
    expect(reply.eventsThrough).toBe(2);
    expect(f.control.working('minecraft:world')?.needs().map(need => need.name)).toEqual(['iron_ore']);
    expect(f.control.poll(f.scope, f.poll({ events: [iron] })).eventsThrough).toBe(2);
    expect(f.control.working('minecraft:world')?.cursor()).toBe(1);
    expect(validControlPoll(f.poll({ events: 'no' as never }), Date.now())).toBe(false);
    // Only the first 32 of a longer list are taken; the poll itself stands.
    const many = Array.from({ length: 40 }, (_, index) => ({ ...iron, seq: index + 2, subject: `iron:b:${index},43,0` }));
    expect(f.control.poll(f.scope, f.poll({ events: many })).eventsThrough).toBe(33);
    // A new connection forgets the old one's needs even when its first poll tells nothing.
    f.control.poll(f.scope, f.poll({ connectionId: 'connection2' }));
    expect(f.control.working('minecraft:world')?.needs()).toEqual([]);
  });
  it('unknown delivery survives service restart and can never be replayed', async () => {
    const f = fixture(), abort = new AbortController();
    const outcome = f.control.command(f.command, abort.signal).catch(error => error.message);
    f.control.poll(f.scope, f.poll()); abort.abort(); await delay(3);
    expect(f.control.poll(f.scope, f.poll({ activeOperationIds: ['operation'] })).cancel).toEqual(['operation']);
    expect(await outcome).toBe('FCA_BODY_OUTCOME_UNKNOWN');
    const restarted = new MinecraftControl(new MinecraftControlStore(f.db), f.control.configuration, { now: Date.now, leaseValid: () => true, ownerAlone: () => true });
    expect(restarted.poll(f.scope, f.poll()).commands).toEqual([]);
    expect(f.store.safe('task')).toBe(false);
    await expect(restarted.command(f.command)).rejects.toThrow('UNKNOWN');
    restarted.poll(f.scope, f.poll({ receipts: [f.receipt({ outcome: 'cancelled' })] }));
    expect(f.store.safe('task')).toBe(true);
  });
  it('requires physical cancellation receipt after dispatch but knows cancellation before dispatch', async () => {
    const f = fixture(), abort = new AbortController();
    const outcome = f.control.command(f.command, abort.signal);
    abort.abort(); await delay(3);
    expect((await outcome).outcome).toBe('cancelled');
    expect(f.control.poll(f.scope, f.poll()).commands).toEqual([]);
  });
  it('allows only original-lease stop cleanup after owner and execution authority disappear', async () => {
    const f = fixture(); f.disallow();
    await expect(f.control.command(f.command)).rejects.toThrow('LEASE_INVALID');
    const result = f.control.command({ ...f.command, id: 'cleanup', kind: 'release' });
    expect(f.control.poll(f.scope, f.poll()).commands[0]?.kind).toBe('release');
    f.control.poll(f.scope, f.poll({ receipts: [f.receipt({ id: 'cleanup' })] }));
    expect((await result).inputsReleased).toBe(true);
  });
  it('refuses other paired devices, another scope, stale frame and unconfigured world', () => {
    const f = fixture();
    expect(() => f.control.poll({ ...f.scope, deviceId: 'phone' }, f.poll())).toThrow('DENIED');
    expect(() => f.control.poll({ ...f.scope, scopeKey: 'other' }, f.poll())).toThrow('DENIED');
    const frame = f.poll(); f.control.poll(f.scope, frame);
    expect(() => f.control.poll(f.scope, frame)).toThrow('STALE');
    expect(() => f.control.poll(f.scope, f.poll({ serverId: 'other' }))).toThrow('INVALID');
  });
  it('never accepts wrong generation receipts or old-connection receipts', async () => {
    const f = fixture(), abort = new AbortController(), outcome = f.control.command(f.command, abort.signal).catch(() => null);
    f.control.poll(f.scope, f.poll());
    expect(f.control.poll(f.scope, f.poll({ receipts: [f.receipt({ action: { schemaVersion: 1, operationId: 'forged', bodyId: 'minecraft:world', sessionId: 'step', generation: 8, outcome: 'completed', inputsReleased: true, observedAt: new Date().toISOString(), evidenceId: 'x' } })] })).acknowledged).toEqual([]);
    expect(f.control.poll(f.scope, f.poll({ connectionId: 'new-connection' })).commands).toEqual([]);
    expect(f.store.safe('task')).toBe(false); abort.abort(); await outcome;
  });
  it('refuses a connection a newer one replaced while the newer one is alive, so a kept process cannot swap the catalog (mb-arch)', () => {
    let now = Date.now();
    const f = fixture({ now: () => now } as never);
    const older = (skills = [{ name: 'dig', description: 'old dig', readOnly: false, inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }]) =>
      f.poll({ connectionId: 'connection', skills } as never);
    f.control.poll(f.scope, f.poll({ connectionId: 'newer' }));
    expect(() => f.control.poll(f.scope, older())).toThrow('FCA_BODY_RETIRED_CONNECTION');
    expect(f.control.frame('minecraft:world')?.poll.connectionId).toBe('newer');
    expect(f.control.frame('minecraft:world')?.poll.skills?.[0]?.description).toBe('dig');
    // The newer one silent for five seconds: the earlier one is taken again (it may be the only one left).
    f.control.poll(f.scope, f.poll({ connectionId: 'newer' }));
    now += 6_000;
    expect(() => f.control.poll(f.scope, older())).not.toThrow();
    expect(f.control.frame('minecraft:world')?.poll.connectionId).toBe('connection');
    // Only as a stand-in: the newer one is taken again at once, and the earlier one is refused again.
    expect(() => f.control.poll(f.scope, f.poll({ connectionId: 'newer' }))).not.toThrow();
    expect(() => f.control.poll(f.scope, older())).toThrow('FCA_BODY_RETIRED_CONNECTION');
  });  it('keeps capture only in memory and only across fresh same-connection heartbeats', async () => {
    const f = fixture(), result = f.control.command({ ...f.command, kind: 'capture' });
    f.control.poll(f.scope, f.poll());
    const pixels = 'data:image/jpeg;base64,/9j/2Q==';
    f.control.poll(f.scope, f.poll({ receipts: [f.receipt({ image: { dataUrl: pixels, capturedAt: new Date().toISOString() } })] }));
    await result;
    const image = f.control.observe('minecraft:world')!.image!;
    expect(f.control.image(image.ref)).toBe(pixels);
    f.control.poll(f.scope, f.poll()); expect(f.control.observe('minecraft:world')?.image).toEqual(image);
    expect(JSON.stringify(f.db.prepare('SELECT * FROM fca_body_operations').all())).not.toContain('/9j/2Q');
    f.control.poll(f.scope, f.poll({ connectionId: 'new-connection' })); expect(f.control.observe('minecraft:world')?.image).toBeUndefined();
  });
  it('validates native schema bounds and concrete candidate prerequisites', () => {
    const f = fixture(), skills = f.poll().skills!;
    expect(validSkills(skills)).toBe(true);
    expect(validSkills([{ ...skills[0], name: 'execute-command' }])).toBe(false);
    expect(validSkillInput({ count: 65 }, skills[0]!.inputSchema)).toBe(false);
    expect(validSkillInput({ count: 2, injected: true }, skills[0]!.inputSchema)).toBe(false);
    const value = f.poll({ candidates: [{ kind: 'action', operation: 'dig', arguments: {}, label: 'dig', preconditions: [{ key: 'missing', value: true }], maxDurationMs: 100, expiresAt: new Date(Date.now() + 1000).toISOString() }] });
    expect(validControlPoll(value, Date.now())).toBe(false);
  });

  it('hands a stop over through a blocked API thread: redelivered under the same id, settled, never unknown (run 6)', async () => {
    const f = fixture({ frameMilliseconds: 300, cancelWaitMilliseconds: 200, pollMilliseconds: 5 });
    const stop = { requestId: 'stop-request', context: f.context, reason: 'danger' };
    const id = 'stop:run6';
    const outcome = f.control.command({ id, context: f.context, lease: f.command.lease, kind: 'stop', stop, milliseconds: 200 } as never)
      .then(value => value, (error: Error) => error.message);
    await delay(10);
    // The reply carrying the stop is written while the body has already given up on that request (its 2 s poll timeout).
    expect(f.control.poll(f.scope, f.poll()).commands.map(command => command.id)).toEqual([id]);
    const blocked = Date.now(); while (Date.now() - blocked < 700) { /* The API's one thread is blocked (run 6: 9.9 s, 13.6 s). */ }
    // The body's next poll is read in the next I/O turn; it does not list the stop: it never reached the body.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.control.poll(f.scope, f.poll()).commands.map(command => command.id)).toEqual([id]);
    expect(f.control.poll(f.scope, f.poll({ activeOperationIds: [id] })).commands).toEqual([]); // Taken now: not handed again.
    const receipt = f.receipt({ id, stop: { bodyId: 'minecraft:world', sessionId: 'step', generation: 1, requestId: 'stop-request', state: 'stopped',
      inputsReleased: true, observedAt: new Date().toISOString() } });
    expect(f.control.poll(f.scope, f.poll({ receipts: [receipt] })).acknowledged).toEqual([id]);
    expect(await outcome).toMatchObject({ id, outcome: 'completed', stop: { state: 'stopped', inputsReleased: true } });
    expect(f.store.safe('task')).toBe(true);
  });
  it('settles a cancelled command the body never received as cancelled, without a physical acknowledgement', async () => {
    const f = fixture(), abort = new AbortController();
    const outcome = f.control.command(f.command, abort.signal).catch((error: Error) => error.message);
    await delay(3);
    f.control.poll(f.scope, f.poll()); // Delivered, but the reply was lost.
    abort.abort(); await delay(3);
    f.control.poll(f.scope, f.poll()); // The next poll does not list it: proven never handed over.
    expect(await outcome).toMatchObject({ outcome: 'cancelled', inputsReleased: true });
    expect(f.store.safe('task')).toBe(true);
  });
  it('asks the body once more before an unknown: a command still running there gets one more wait', async () => {
    const f = fixture({ cancelWaitMilliseconds: 100, pollMilliseconds: 2 }), abort = new AbortController();
    const outcome = f.control.command(f.command, abort.signal).catch((error: Error) => error.message);
    await delay(3);
    f.control.poll(f.scope, f.poll());
    f.control.poll(f.scope, f.poll({ activeOperationIds: ['operation'] })); // Confirmed running on the body.
    abort.abort();
    await delay(140); // The cancel wait passed: the body is asked again (its next poll).
    f.control.poll(f.scope, f.poll({ activeOperationIds: ['operation'] })); // Still running there: one more wait, not unknown.
    await delay(20);
    f.control.poll(f.scope, f.poll({ receipts: [f.receipt({ outcome: 'cancelled' })] }));
    expect(await outcome).toMatchObject({ outcome: 'cancelled', inputsReleased: true });
  });
  it('declares unknown when the body, asked again, no longer reports a command it was running', async () => {
    const f = fixture({ cancelWaitMilliseconds: 20, pollMilliseconds: 2 }), abort = new AbortController();
    const outcome = f.control.command(f.command, abort.signal).catch((error: Error) => error.message);
    await delay(3);
    f.control.poll(f.scope, f.poll());
    f.control.poll(f.scope, f.poll({ activeOperationIds: ['operation'] }));
    abort.abort();
    for (let i = 0; i < 10; i++) { await delay(8); f.control.poll(f.scope, f.poll({ receipts: Array.from({ length: 16 }, (_, k) => f.receipt({ id: `other-${k}` })) })); }
    expect(await outcome).toBe('FCA_BODY_OUTCOME_UNKNOWN');
  });
});
