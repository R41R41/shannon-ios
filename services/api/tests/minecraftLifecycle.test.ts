import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import type { MinecraftLifecycleCommand, MinecraftLifecyclePoll, MinecraftLifecycleReceipt, MinecraftLifecycleRequest, MinecraftLifecycleState } from '../src/contracts/minecraftLifecycleContract.js';
import { MinecraftLifecycle } from '../src/surfaces/minecraft/minecraftLifecycle.js';
import { MinecraftLifecycleStore } from '../src/surfaces/minecraft/store/minecraftLifecycleStore.js';

const dbs: DatabaseSync[] = [];
const directories: string[] = [];
afterEach(() => { dbs.splice(0).forEach(db => db.close()); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });
function fixture(databasePath = ':memory:') {
  const db = new DatabaseSync(databasePath); dbs.push(db);
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'operator', servers: [{ serverId: 'home', title: 'home', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  let allowed = true, sequence = 0;
  const options = { now: Date.now, allowed: () => allowed, pollMilliseconds: 1, cancelWaitMilliseconds: 5 };
  const store = new MinecraftLifecycleStore(db), service = new MinecraftLifecycle(store, configuration, options);
  const principal = { scopeKey: 'owner', deviceId: 'operator' };
  const state = (patch: Partial<MinecraftLifecycleState> = {}): MinecraftLifecycleState => ({ serverId: 'home', observedAt: new Date().toISOString(), running: 'stopped', bot: 'absent', otherPlayers: 0, ...patch });
  const poll = (patch: Partial<MinecraftLifecyclePoll> = {}): MinecraftLifecyclePoll => ({ schemaVersion: 1, connectionId: 'connection', sequence: sequence++, states: [state()], receipts: [], ...patch });
  const request: MinecraftLifecycleRequest = { id: 'operation', serverId: 'home', action: 'start', authority: { scopeKey: 'owner', origin: 'owner_request', executionId: 'execution', lease: { id: 'lease', generation: 1, holder: 'runner' }, sourceIds: ['source:owner'] } };
  const receipt = (patch: Partial<MinecraftLifecycleReceipt> = {}): MinecraftLifecycleReceipt => ({ id: 'operation', connectionId: 'connection', serverId: 'home', action: 'start', outcome: 'completed', code: 'changed', observedAt: new Date().toISOString(), inputsReleased: true, state: state({ running: 'running' }), ...patch });
  service.poll(principal, poll());
  return { db, configuration, options, service, store, principal, state, poll, request, receipt, revoke() { allowed = false; } };
}
describe('Minecraft lifecycle operator authority and receipts', () => {
  it('offers an offline bot/server, delivers once and reconciles the original receipt', async () => {
    const f = fixture(), result = f.service.execute(f.request);
    expect(f.service.available('owner')).toBe(true);
    expect(f.service.poll(f.principal, f.poll()).commands[0]?.action).toBe('start');
    expect(f.service.poll(f.principal, f.poll()).commands).toEqual([]);
    expect(f.service.authorize(f.principal, 'operation')).toBe(true);
    const receipt = f.receipt();
    expect(f.service.poll(f.principal, f.poll({ receipts: [receipt] })).acknowledged).toEqual(['operation']);
    expect(await result).toEqual(receipt);
    expect(await f.service.execute(f.request)).toEqual(receipt);
    await expect(f.service.execute({ ...f.request, action: 'login' })).rejects.toThrow('CONFLICT');
  });
  it('shares fresh operator frames and queue with a separate own-time worker instance', async () => {
    const f = fixture(), worker = new MinecraftLifecycle(new MinecraftLifecycleStore(f.db), f.configuration, f.options);
    expect(worker.status('owner')[0]?.running).toBe('stopped');
    const request = { ...f.request, authority: { ...f.request.authority, origin: 'own_time' as const } };
    const result = worker.execute(request);
    const command = f.service.poll(f.principal, f.poll()).commands[0]!;
    expect(command.authority.origin).toBe('own_time');
    expect(command.authority.sourceIds).toEqual(['source:owner']);
    f.service.poll(f.principal, f.poll({ receipts: [f.receipt()] }));
    expect((await result).outcome).toBe('completed');
  });
  it('shares fresh state across separate SQLite connections and reserves one original operation atomically', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-lifecycle-')); directories.push(directory);
    const databasePath = join(directory, 'fixture.sqlite'), f = fixture(databasePath);
    const workerDb = new DatabaseSync(databasePath); dbs.push(workerDb);
    const worker = new MinecraftLifecycle(new MinecraftLifecycleStore(workerDb), f.configuration, f.options);
    expect(worker.status('owner')[0]?.running).toBe('stopped');
    const result = worker.execute(f.request);
    await expect(f.service.execute({ ...f.request, id: 'concurrent' })).rejects.toThrow('BUSY');
    expect(f.service.poll(f.principal, f.poll()).commands.map(c => c.id)).toEqual(['operation']);
    f.service.poll(f.principal, f.poll({ receipts: [f.receipt()] }));
    expect((await result).outcome).toBe('completed');
    expect(worker.safe('execution')).toBe(true);
  });
  it('requires native atomic stop proof and actual stopped state', async () => {
    const f = fixture(), result = f.service.execute({ ...f.request, action: 'stop' });
    f.service.poll(f.principal, f.poll());
    const receipt = f.receipt({ action: 'stop', state: f.state() });
    expect(f.service.poll(f.principal, f.poll({ receipts: [receipt] })).acknowledged).toEqual([]);
    const stale = new Date(Date.parse(f.store.command('operation')!.issuedAt) - 1).toISOString();
    const proof = { admissionClosed: true as const, otherPlayers: 0 as const, checkedAt: receipt.observedAt };
    for (const invalid of [{ ...receipt, observedAt: stale, stopGuard: proof }, { ...receipt, state: f.state({ observedAt: stale }), stopGuard: proof }, { ...receipt, stopGuard: { ...proof, checkedAt: stale } }])
      expect(f.service.poll(f.principal, f.poll({ receipts: [invalid] })).acknowledged).toEqual([]);
    expect(f.service.poll(f.principal, f.poll({ receipts: [{ ...receipt, stopGuard: { admissionClosed: true, otherPlayers: 0, checkedAt: receipt.observedAt } }] })).acknowledged).toEqual(['operation']);
    expect((await result).outcome).toBe('completed');
  });
  it('distinguishes server start from authenticated bot login', async () => {
    const f = fixture(), result = f.service.execute({ ...f.request, action: 'login' });
    f.service.poll(f.principal, f.poll());
    expect(f.service.poll(f.principal, f.poll({ receipts: [f.receipt({ action: 'login' })] })).acknowledged).toEqual([]);
    f.service.poll(f.principal, f.poll({ receipts: [f.receipt({ action: 'login', state: f.state({ running: 'running', bot: 'joined' }) })] }));
    expect((await result).state.bot).toBe('joined');
  });
  it('revokes native permit when original lease/sources/own-time pause gate changes', async () => {
    const f = fixture(), result = f.service.execute(f.request).catch(error => error.message);
    f.service.poll(f.principal, f.poll()); f.revoke();
    expect(f.service.authorize(f.principal, 'operation')).toBe(false);
    expect(f.service.poll(f.principal, f.poll()).cancel).toEqual(['operation']);
    expect(await result).toContain('UNKNOWN');
    expect(f.service.safe('execution')).toBe(false);
  });
  it('knows cancellation before dispatch and holds uncertain delivered work across restart', async () => {
    const f = fixture(), before = new AbortController(), first = f.service.execute(f.request, before.signal);
    before.abort(); expect((await first).outcome).toBe('cancelled');
    expect(f.service.safe('execution')).toBe(true);
    const request = { ...f.request, id: 'delivered' }, after = new AbortController(), result = f.service.execute(request, after.signal).catch(error => error.message);
    f.service.poll(f.principal, f.poll()); after.abort(); expect(await result).toContain('UNKNOWN');
    const restarted = new MinecraftLifecycle(new MinecraftLifecycleStore(f.db), f.configuration, f.options);
    expect(restarted.poll(f.principal, f.poll({ connectionId: 'new_connection' })).commands).toEqual([]);
    await expect(restarted.execute(request)).rejects.toThrow('UNKNOWN');
    await expect(restarted.execute({ ...request, id: 'replacement', authority: { ...request.authority, executionId: 'new_execution' } })).rejects.toThrow('BUSY');
  });
  it('accepts only original connection receipts, preserving old receipts after delayed transport recovery', async () => {
    const f = fixture(), result = f.service.execute(f.request);
    f.service.poll(f.principal, f.poll());
    expect(f.service.poll(f.principal, f.poll({ receipts: [f.receipt({ connectionId: 'forged' })] })).acknowledged).toEqual([]);
    const original = f.store.command('operation')!.issuedAt, receipt = f.receipt({ observedAt: original, state: f.state({ running: 'running', observedAt: original }) });
    const recoveredAt = Date.parse(original) + 60_000; f.options.now = () => recoveredAt;
    const recoveredPoll = () => f.poll({ states: [f.state({ observedAt: new Date(recoveredAt).toISOString() })], receipts: [receipt] });
    f.service.poll(f.principal, recoveredPoll()); expect(await result).toEqual(receipt);
    expect(f.service.poll(f.principal, recoveredPoll()).acknowledged).toEqual(['operation']);
  });
  it('reconciles only a later known native receipt for the original delivered ID, retaining immutable unknown evidence', async () => {
    const f = fixture(), result = f.service.execute(f.request).catch(error => error.message);
    f.service.poll(f.principal, f.poll());
    const earlier = f.store.command('operation')!.issuedAt;
    const unknown = f.receipt({ outcome: 'unknown', inputsReleased: false, code: 'state_unknown', observedAt: earlier, state: f.state({ observedAt: earlier }) });
    f.service.poll(f.principal, f.poll({ receipts: [unknown] }));
    expect(await result).toContain('UNKNOWN'); expect(f.service.safe('execution')).toBe(false);
    const lateAt = new Date(Date.parse(earlier) + 1).toISOString(), late = f.receipt({ observedAt: lateAt, state: f.state({ running: 'running', observedAt: lateAt }) });
    expect(f.service.poll(f.principal, f.poll({ receipts: [{ ...late, connectionId: 'replacement' }, { ...late, inputsReleased: false }, { ...late, observedAt: earlier }] })).acknowledged).toEqual([]);
    expect(f.service.poll(f.principal, f.poll({ receipts: [late] })).acknowledged).toEqual(['operation']);
    expect(f.service.safe('execution')).toBe(true);
    expect(await f.service.execute(f.request)).toEqual(late);
    expect(f.db.prepare('SELECT receipt_json FROM minecraft_lifecycle_receipt_events WHERE operation_id=? ORDER BY sequence').all('operation').map(r => JSON.parse(String(r.receipt_json)).outcome)).toEqual(['unknown', 'completed']);
    expect(f.service.poll(f.principal, f.poll({ receipts: [unknown] })).acknowledged).toEqual(['operation']);
    expect(f.service.receipt('operation')).toEqual(late);
    expect(f.service.poll(f.principal, f.poll({ receipts: [f.receipt({ code: 'error', outcome: 'cancelled' })] })).acknowledged).toEqual([]);
  });
  it('refuses stale/unbound/ambiguous state and wrong devices, preserving no player identities', () => {
    const f = fixture();
    expect(() => f.service.poll({ ...f.principal, deviceId: 'phone' }, f.poll())).toThrow('DENIED');
    expect(() => f.service.poll(f.principal, f.poll({ states: [f.state({ serverId: 'other' })] }))).toThrow('INVALID');
    expect(() => f.service.poll(f.principal, f.poll({ states: [f.state({ observedAt: new Date(Date.now() - 4000).toISOString() })] }))).toThrow('INVALID');
    const frame = f.poll(); f.service.poll(f.principal, frame); expect(() => f.service.poll(f.principal, frame)).toThrow('STALE');
    expect(f.service.available('stranger')).toBe(false);
    expect(JSON.stringify(f.db.prepare('SELECT * FROM minecraft_lifecycle_snapshot').all())).not.toContain('ownerUuid');
  });
});
