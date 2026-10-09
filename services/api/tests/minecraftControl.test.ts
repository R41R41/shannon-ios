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
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world', title: 'world', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const store = new MinecraftControlStore(db);
  let allowed = true, owner = true, sequence = 0;
  const control = new MinecraftControl(store, configuration, { now: Date.now, leaseValid: () => allowed, leaseKnown: () => true, ownerAlone: () => owner, pollMilliseconds: 1, cancelWaitMilliseconds: 10 });
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
    expect(f.control.poll(f.scope, f.poll()).commands).toEqual([]);
    const receipt = f.receipt();
    expect(f.control.poll(f.scope, f.poll({ receipts: [receipt] })).acknowledged).toEqual(['operation']);
    expect(await result).toEqual(receipt);
    expect(f.store.safe('task')).toBe(true);
    expect(await f.control.command(f.command)).toEqual(receipt);
    await expect(f.control.command({ ...f.command, arguments: { count: 2 } })).rejects.toThrow('CONFLICT');
  });
  it('unknown delivery survives service restart and can never be replayed', async () => {
    const f = fixture(), abort = new AbortController();
    const outcome = f.control.command(f.command, abort.signal).catch(error => error.message);
    f.control.poll(f.scope, f.poll()); abort.abort(); await delay(3);
    expect(f.control.poll(f.scope, f.poll()).cancel).toEqual(['operation']);
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
  it('keeps capture only in memory and only across fresh same-connection heartbeats', async () => {
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
});
