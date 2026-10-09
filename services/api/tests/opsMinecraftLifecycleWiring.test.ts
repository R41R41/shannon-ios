import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { configuredMinecraftLifecycle } from '../src/wiring/minecraftLifecycleWiring.js';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { ShannonAutonomyService } from '../src/mind/action/ownTime/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { SQLiteOpsStore } from '../src/infra/ops/store/opsStore.js';
import { createOpsRoute } from '../src/infra/ops/serverOpsRoutes.js';
import { validatedOpsSnapshot } from '../src/contracts/opsContract.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { actionHarness } from './support/actionThreadHarness.js';
import type { MinecraftLifecycleCommand, MinecraftLifecycleReceipt, MinecraftLifecycleState } from '../src/contracts/minecraftLifecycleContract.js';

const close: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const finish of close.splice(0).reverse()) await finish(); });
async function until(test: () => boolean) { for (let i = 0; i < 500; i++) { if (test()) return; await delay(2); } expect(test()).toBe(true); }
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ops-lifecycle-')), path = join(dir, 'db.sqlite'); close.push(() => rmSync(dir, { recursive: true, force: true }));
  let at = '2026-10-10T00:00:00.000Z', sequence = 0, enabled = true, alone = true;
  const store = new SQLiteOpsStore(path); close.push(() => store.close());
  const autonomyStore = new SQLiteAutonomyStore(path); close.push(() => autonomyStore.close());
  const autonomy = new ShannonAutonomyService({ store: autonomyStore, config: configuredAutonomy({ SHANNON_AUTONOMY_ENABLED: 'true' }), now: () => at });
  const h = actionHarness(() => at, path); close.push(h.close);
  const configuration = { SHANNON_MINECRAFT_LIFECYCLE: 'on', SHANNON_ADR8_STAGE4: 'on', SHANNON_MINECRAFT_LIFECYCLE_SERVERS: '["shannon-home"]',
    SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'operator', servers: [{ serverId: 'shannon-home', title: 'Home', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) };
  const configured = configuredMinecraftLifecycle(configuration, { path, autonomy, now: () => at, ownerAlone: () => alone, taskAllowed: () => false,
    ops: { commands: store.commands, actions: h.actions, enabled: () => enabled } })!; close.push(async () => { const ticking = setInterval(() => { at = new Date(Date.parse(at) + 1000).toISOString(); }, 100); try { await configured.close(); } finally { clearInterval(ticking); } });
  const principal = { scopeKey: 'owner', deviceId: 'operator' };
  const state = (patch: Partial<MinecraftLifecycleState> = {}): MinecraftLifecycleState => ({ serverId: 'shannon-home', observedAt: at, running: 'stopped', bot: 'absent', otherPlayers: 0, ...patch });
  const poll = (receipts: MinecraftLifecycleReceipt[] = [], patch: Partial<MinecraftLifecycleState> = {}) => configured.service.poll(principal,
    { schemaVersion: 1, connectionId: 'operator-connection', sequence: sequence++, states: [state(patch)], receipts });
  poll();
  const snapshot = validatedOpsSnapshot({ scopeKey: 'owner', reportedAt: at, runtime: { release: 'test', startedAt: at },
    services: ['minecraft', 'minebot', 'minebot:bot', 'minecraft:shannon-home', 'minecraft:other'].map(id => ({ id, label: id, category: 'platform', status: 'running' })),
    minebot: [], skills: [], schedules: [] });
  if (typeof snapshot === 'string') throw new Error(snapshot);
  store.replace('owner', 1, snapshot, at);
  const route = createOpsRoute({ store, now: () => at, ingestEnabled: () => true, commandsEnabled: () => enabled,
    minecraftLifecycle: () => configured.ops, bridge: { token: 'legacy-bridge', scopeKey: 'owner' },
    device: authorization => authorization === 'Bearer desktop' ? { scopeKey: 'owner', deviceId: 'desktop-1' } : null });
  const server = createServer((req, res) => { const url = new URL(req.url!, 'http://localhost'); void route(url.pathname, req, res, url.searchParams); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  close.push(() => new Promise<void>(done => server.close(() => done())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('port');
  const call = async (url: string, body: unknown, token = 'desktop') => {
    const response = await fetch(`http://127.0.0.1:${address.port}${url}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  let key = 0;
  const send = (type: string, target: string, idempotencyKey = `command-${++key}`) => call('/v1/ops/commands', { type, target, idempotencyKey });
  const claim = () => call('/v1/platform/ops/commands/claim', { scopeKey: 'owner' }, 'legacy-bridge');
  const receipt = (command: MinecraftLifecycleCommand, patch: Partial<MinecraftLifecycleReceipt> = {}): MinecraftLifecycleReceipt => ({ id: command.id, connectionId: command.connectionId,
    serverId: command.serverId, action: command.action, outcome: 'completed', code: 'changed', observedAt: at, inputsReleased: true,
    state: state({ running: command.action === 'stop' ? 'stopped' : 'running', bot: command.action === 'login' ? 'joined' : 'absent' }),
    ...(command.action === 'stop' ? { stopGuard: { admissionClosed: true as const, otherPlayers: 0 as const, checkedAt: at } } : {}), ...patch });
  const command = async () => { await until(() => configured.service.store.pending().length === 1); return poll().commands[0]!; };
  const recent = (id: string) => store.commands.recent('owner', at).find(c => c.id === id)!;
  const acknowledge = async (c: MinecraftLifecycleCommand, r = receipt(c)) => { expect(poll([r]).acknowledged).toEqual([c.id]); await until(() => h.store.get(c.authority.executionId)?.state !== 'running'); };
  return { ...h, store, configured, call, send, claim, poll, state, receipt, command, recent, acknowledge,
    advance(ms: number) { at = new Date(Date.parse(at) + ms).toISOString(); }, enabled(value: boolean) { enabled = value; }, alone(value: boolean) { alone = value; } };
}

describe('Windows Ops requests through canonical lifecycle, original action and native receipt', () => {
  it.each([
    ['minecraft.start', 'shannon-home', 'start'], ['minecraft.stop', 'minecraft:shannon-home', 'stop'],
    ['minebot.start', 'shannon-home', 'login'], ['service.stop', 'minebot:bot', 'logout'],
  ])('maps %s/%s without changing the desktop DTO or duplicating original operations', async (type, target, action) => {
    const f = await fixture(), sent = await f.send(type, target, 'original-command');
    expect(sent.status).toBe(201); expect(sent.body.command).toMatchObject({ type, requestedByDeviceId: 'desktop-1' });
    expect((await f.claim()).body.command).toBeNull();
    const c = await f.command();
    expect(c).toMatchObject({ id: `ops-lifecycle:${sent.body.command.id}`, serverId: 'shannon-home', action,
      authority: { origin: 'owner_request', sourceIds: [`ops-command:${sent.body.command.id}`] } });
    expect(f.store.commands.report('owner', sent.body.command.id, 'done', undefined, f.state().observedAt)).toBe('OPS_COMMAND_FINISHED');
    expect(f.store.commands.lifecyclePending('owner', f.state().observedAt)).toEqual([]);
    const original = f.store.commands.replay('owner', { type: type as any, target: target.startsWith('minecraft:') || type === 'service.stop' ? target : `minecraft:${target}`, idempotencyKey: 'original-command' }, f.state().observedAt);
    expect(original).toMatchObject({ created: false, command: { id: sent.body.command.id } });
    expect(f.configured.service.authorize({ scopeKey: 'owner', deviceId: 'operator' }, c.id)).toBe(true);
    expect(f.store.commands.recent('owner', f.state().observedAt)).toHaveLength(1);
    expect(f.store.commands.lifecycleAwaiting('owner', f.state().observedAt)).toHaveLength(1);
    expect(f.db.prepare('SELECT source_id,kind FROM mind_actions WHERE id=?').get(c.authority.executionId)).toMatchObject({ source_id: `ops:${sent.body.command.id}`, kind: 'minecraft' });
    expect(f.store.commands.recent('owner', f.state().observedAt)[0]?.status).toBe('claimed');
    expect(f.store.commands.claim('owner', f.state().observedAt)).toBeNull();
    await f.acknowledge(c);
    expect(f.recent(sent.body.command.id).status).toBe('done');
    expect(f.store.commands.count()).toBe(1);
    expect(f.store.commands.lifecyclePending('owner', f.state().observedAt)).toEqual([]);
    expect(f.store.commands.lifecycleAwaiting('owner', f.state().observedAt)).toEqual([]);
    expect((await f.send(type, target, 'original-command')).status).toBe(200);
    expect(f.configured.service.store.pending()).toEqual([]);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM minecraft_lifecycle_operations').get()?.n).toBe(1);
  });

  it('keeps manager meanings, other servers and pre-existing legacy commands on their existing path', async () => {
    const f = await fixture();
    const at = f.state().observedAt;
    const old = f.store.commands.create('owner', { type: 'minecraft.stop', target: 'minecraft:shannon-home', idempotencyKey: 'preexisting-command' }, 'desktop-1', at);
    expect(typeof old).not.toBe('string');
    expect((await f.claim()).body.command).toMatchObject({ target: 'minecraft:shannon-home' });
    for (const [type, target] of [['service.stop', 'minecraft'], ['service.stop', 'minebot'], ['minecraft.start', 'other']]) {
      const sent = await f.send(type!, target!); expect(sent.status).toBe(201);
      expect((await f.claim()).body.command.id).toBe(sent.body.command.id);
      expect(f.configured.service.store.pending()).toEqual([]);
      await f.call(`/v1/platform/ops/commands/${sent.body.command.id}/report`, { scopeKey: 'owner', outcome: 'done' }, 'legacy-bridge');
    }
  });

  it('accepts no stop success without atomic no-human evidence, and projects native players-present refusal truthfully', async () => {
    const f = await fixture(), sent = await f.send('minecraft.stop', 'shannon-home'), c = await f.command();
    const unguarded = f.receipt(c); delete unguarded.stopGuard;
    expect(f.poll([unguarded]).acknowledged).toEqual([]);
    expect(f.recent(sent.body.command.id).status).toBe('claimed');
    const refusal = f.receipt(c, { outcome: 'refused', code: 'players_present', state: f.state({ running: 'running', otherPlayers: 1 }) });
    await f.acknowledge(c, refusal);
    expect(f.recent(sent.body.command.id)).toMatchObject({ status: 'refused', code: 'not_allowed' });
    expect(f.store.commands.claim('owner', f.state().observedAt)).toBeNull();
    expect(f.store.commands.lifecycleAwaiting('owner', f.state().observedAt)).toEqual([]);
  });

  it('holds an unknown original body/resource and unrelated budget and accepts late original ACK without replay or whole-action completion', async () => {
    const f = await fixture(), sent = await f.send('minecraft.start', 'shannon-home'), c = await f.command();
    const lease = c.authority.lease;
    const budgetAction = await f.actions.claim((await f.actions.enqueue({ scopeKey: 'owner', kind: 'ownTime', origin: 'own_time', sourceId: 'unrelated-paid-call' })).id);
    expect(await f.actions.reserve(leaseOf(budgetAction!), 'unrelated-budget', '2026-10-10', 1, 100, 0)).toBe(true);
    await f.actions.finish(leaseOf(budgetAction!), 'unknown', 'model_result_unknown');
    await f.acknowledge(c, f.receipt(c, { outcome: 'unknown', code: 'error', inputsReleased: false, state: f.state({ running: 'unknown' }) }));
    expect(f.recent(sent.body.command.id)).toMatchObject({ status: 'failed', code: 'no_report' });
    const before = f.store.commands.count(), held = f.db.prepare('SELECT * FROM mind_action_budget').all();
    expect(f.db.prepare('SELECT state,resources_json FROM mind_actions WHERE id=?').get(lease.id)).toMatchObject({ state: 'unknown', resources_json: JSON.stringify([actionResource('operator', 'minecraft-body')]) });
    for (let i = 0; i < 3; i++) { f.configured.ops!.wake(); expect((await f.claim()).body.command).toBeNull(); }
    expect((await f.send('minecraft.start', 'shannon-home', 'command-1')).status).toBe(200);
    f.advance(1); expect(f.poll([f.receipt(c)]).acknowledged).toEqual([c.id]); f.configured.ops!.wake();
    expect(f.recent(sent.body.command.id)).toMatchObject({ status: 'done' });
    expect(f.store.commands.count()).toBe(before);
    expect(f.db.prepare('SELECT state,resources_json FROM mind_actions WHERE id=?').get(lease.id)).toMatchObject({ state: 'unknown', resources_json: JSON.stringify([actionResource('operator', 'minecraft-body')]) });
    expect(f.db.prepare('SELECT * FROM mind_action_budget').all()).toEqual(held);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM minecraft_lifecycle_operations').get()?.n).toBe(1);
  });

  it('gates waiting mapped requests on fresh operator and owner context, and rechecks original lease/kill switch before native dispatch', async () => {
    const f = await fixture(); f.advance(3001);
    const sent = await f.send('minecraft.start', 'shannon-home');
    expect(sent.status).toBe(201); expect((await f.claim()).body.command).toBeNull(); expect(f.configured.service.store.pending()).toEqual([]);
    f.alone(false); f.poll(); f.configured.ops!.wake(); expect(f.configured.service.store.pending()).toEqual([]);
    f.alone(true); f.configured.ops!.wake();
    await until(() => f.configured.service.store.pending().length === 1);
    const original = f.configured.service.store.pending()[0]!.command;
    f.enabled(false); const denied = f.poll();
    expect(denied.commands).toEqual([]); expect(f.configured.service.authorize({ scopeKey: 'owner', deviceId: 'operator' }, original.id)).toBe(false);
    await until(() => f.recent(sent.body.command.id).status !== 'claimed');
    expect(f.recent(sent.body.command.id).status).toBe('failed');
    expect((await f.claim()).body.command).toBeNull();
    f.enabled(true);
    const second = await f.send('minecraft.start', 'shannon-home'), c = await f.command();
    f.advance(30001); await f.actions.claim('missing');
    expect(f.configured.service.authorize({ scopeKey: 'owner', deviceId: 'operator' }, c.id)).toBe(false);
    f.poll([f.receipt(c, { outcome: 'cancelled', code: 'authority_revoked' })]);
    await until(() => f.recent(second.body.command.id).status === 'failed');
  });

  it('does not grant generic minecraft actions authority from a guessed source prefix', async () => {
    const f = await fixture();
    const a = await f.actions.claim((await f.actions.enqueue({ scopeKey: 'owner', kind: 'minecraft', origin: 'owner_request', sourceId: 'ops:guessed-command' })).id);
    await expect(f.configured.service.execute({ id: 'ops-lifecycle:guessed-command', action: 'start', serverId: 'shannon-home',
      authority: { scopeKey: 'owner', origin: 'owner_request', executionId: a!.id, lease: leaseOf(a!), sourceIds: ['ops-command:guessed-command'] } })).rejects.toThrow('MINECRAFT_LIFECYCLE_AUTHORITY_DENIED');
    expect(f.configured.service.store.pending()).toEqual([]);
  });

  it('waits for the common body resource instead of racing a live conversation action', async () => {
    const f = await fixture(), resource = actionResource('operator', 'minecraft-body');
    const foreground = await f.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: 'body-conversation' });
    expect(await f.actions.dispatch(leaseOf(foreground!), [resource])).toBe(true);
    const sent = await f.send('minecraft.start', 'shannon-home');
    await until(() => f.recent(sent.body.command.id).status === 'claimed');
    await delay(40);
    expect(f.configured.service.store.pending()).toEqual([]);
    expect((await f.claim()).body.command).toBeNull();
    expect(f.db.prepare('SELECT resources_json FROM mind_actions WHERE id=?').get(foreground!.id)?.resources_json).toBe(JSON.stringify([resource]));
    await f.actions.finish(leaseOf(foreground!), 'completed', 'original_body_acknowledged');
    const c = await f.command(); await f.acknowledge(c);
    expect(f.recent(sent.body.command.id).status).toBe('done');
  });
});
