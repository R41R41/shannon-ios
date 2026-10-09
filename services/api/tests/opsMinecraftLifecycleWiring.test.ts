import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredMinecraftLifecycle } from '../src/wiring/minecraftLifecycleWiring.js';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { ShannonAutonomyService } from '../src/mind/action/ownTime/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { SQLiteOpsStore } from '../src/infra/ops/store/opsStore.js';
import { OpsCommandStore } from '../src/infra/ops/store/opsCommandStore.js';
import { createOpsRoute } from '../src/infra/ops/serverOpsRoutes.js';
import { validatedOpsSnapshot } from '../src/contracts/opsContract.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { actionHarness } from './support/actionThreadHarness.js';
import type { MinecraftLifecycleCommand, MinecraftLifecycleReceipt, MinecraftLifecycleState } from '../src/contracts/minecraftLifecycleContract.js';

const close: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const finish of close.splice(0).reverse()) await finish(); });
async function until(test: () => boolean) { for (let i = 0; i < 500; i++) { if (test()) return; await delay(2); } expect(test()).toBe(true); }
async function fixture(legacy?: { id: string; at: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'ops-lifecycle-')), path = join(dir, 'db.sqlite'); close.push(() => rmSync(dir, { recursive: true, force: true }));
  let at = '2026-10-10T00:00:00.000Z', sequence = 0, enabled = true, alone = true;
  if (legacy) {
    // The preceding production schema, including a queued action created before this migration.
    const previous = new DatabaseSync(path);
    new OpsCommandStore(previous);
    previous.exec('DROP TRIGGER ops_lifecycle_execution_kind_immutable; ALTER TABLE ops_lifecycle_dispatches DROP COLUMN execution_kind;');
    previous.prepare(`INSERT INTO ops_commands(command_id,scope_key,idempotency_key,type,target,status,created_at,expires_at,requested_by_device_id)
      VALUES(?,'owner','legacy-key','minecraft.start','minecraft:shannon-home','pending',?,?,'desktop-1')`).run(legacy.id, legacy.at, '2026-10-10T00:00:05.000Z');
    previous.prepare("INSERT INTO ops_lifecycle_dispatches(command_id,server_id,action,lifecycle_id) VALUES(?,'shannon-home','start',?)").run(legacy.id,`ops-lifecycle:${legacy.id}`);
    previous.close();
    const originalActions=actionHarness(()=>legacy.at,path);
    originalActions.store.enqueue({scopeKey:'owner',kind:'minecraft',origin:'owner_request',sourceId:`ops:${legacy.id}`,
      deadline:'2026-10-10T00:00:05.000Z'},legacy.at);originalActions.close();
  }
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
    expect(f.db.prepare('SELECT source_id,kind FROM mind_actions WHERE id=?').get(c.authority.executionId)).toMatchObject({ source_id: `ops:${sent.body.command.id}`, kind: 'respond' });
    expect(f.db.prepare('SELECT execution_kind FROM ops_lifecycle_dispatches WHERE command_id=?').get(sent.body.command.id)?.execution_kind).toBe('respond');
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

  it.each(['minecraft','respond'] as const)('does not grant generic %s actions authority from a guessed Ops source prefix', async kind => {
    const f = await fixture();
    const a = await f.actions.claim((await f.actions.enqueue({ scopeKey: 'owner', kind, origin: 'owner_request', sourceId: 'ops:guessed-command' })).id);
    await expect(f.configured.service.execute({ id: 'ops-lifecycle:guessed-command', action: 'start', serverId: 'shannon-home',
      authority: { scopeKey: 'owner', origin: 'owner_request', executionId: a!.id, lease: leaseOf(a!), sourceIds: ['ops-command:guessed-command'] } })).rejects.toThrow('MINECRAFT_LIFECYCLE_AUTHORITY_DENIED');
    expect(f.configured.service.store.pending()).toEqual([]);
  });

  it('rejects a forged Ops source on an otherwise ordinary conversation lease', async () => {
    const f=await fixture(), a=await f.actions.admitRespond({scopeKey:'owner',kind:'respond',origin:'owner_request',sourceId:'turn-ordinary'});
    await expect(f.configured.service.execute({id:'ops-lifecycle:guessed',action:'start',serverId:'shannon-home',
      authority:{scopeKey:'owner',origin:'owner_request',executionId:a!.id,lease:leaseOf(a!),sourceIds:['ops-command:guessed']}})).rejects.toThrow('MINECRAFT_LIFECYCLE_AUTHORITY_DENIED');
    expect(f.configured.service.store.pending()).toEqual([]);
  });

  it('admits a new owner Ops request with both background slots held while preserving unknown resources and every budget', async () => {
    const f=await fixture();const ids:string[]=[];
    for(const kind of ['agentTask','ownTime'] as const){
      const a=await f.actions.claim((await f.actions.enqueue({scopeKey:'owner',kind,origin:kind==='ownTime'?'own_time':'maintenance',sourceId:`held-${kind}`,resources:[actionResource('owner',kind)]})).id);
      expect(a).not.toBeNull();ids.push(a!.id);
      if(kind==='ownTime')expect(await f.actions.reserve(leaseOf(a!),`budget-${kind}`,'2026-10-10',1,100,0)).toBe(true);
      expect(await f.actions.dispatch(leaseOf(a!))).toBe(true);
      await f.actions.finish(leaseOf(a!),'unknown','model_result_unknown');
    }
    const rows=()=>ids.map(id=>f.db.prepare('SELECT * FROM mind_actions WHERE id=?').get(id));
    const original=rows(), budgets=f.db.prepare('SELECT * FROM mind_action_budget').all();
    expect(budgets.map(row=>row.state)).toEqual(['held']);
    const background=await f.actions.enqueue({scopeKey:'owner',kind:'agentTask',origin:'owner_request',sourceId:'other-background'});
    expect(await f.actions.claim(background.id)).toBeNull();
    const sent=await f.send('minecraft.start','shannon-home','new-owner-op'), c=await f.command();
    expect(f.db.prepare('SELECT kind FROM mind_actions WHERE id=?').get(c.authority.executionId)?.kind).toBe('respond');
    await f.acknowledge(c);
    expect(f.recent(sent.body.command.id).status).toBe('done');
    expect(rows()).toEqual(original);expect(f.db.prepare('SELECT * FROM mind_action_budget').all()).toEqual(budgets);
    expect(f.db.prepare('SELECT state FROM mind_actions WHERE id=?').get(background.id)?.state).toBe('queued');
    expect((await f.send('minecraft.start','shannon-home','new-owner-op')).status).toBe(200);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM minecraft_lifecycle_operations').get()?.n).toBe(1);
  });

  it('retains old queued Ops actions and mappings through additive migration without adopting or replaying the original request', async () => {
    const id='11111111-1111-4111-8111-111111111111', f=await fixture({id,at:'2026-10-09T23:59:59.000Z'});
    const old=await f.actions.enqueue({scopeKey:'owner',kind:'minecraft',origin:'owner_request',sourceId:`ops:${id}`,deadline:'2026-10-10T00:00:05.000Z'});
    const mapping=()=>f.db.prepare('SELECT * FROM ops_lifecycle_dispatches WHERE command_id=?').get(id);
    expect(mapping()).toMatchObject({execution_kind:'minecraft',action_id:null});
    new OpsCommandStore(f.db);expect(mapping()).toMatchObject({execution_kind:'minecraft',action_id:null});
    for(let i=0;i<3;i++)f.configured.ops!.wake();
    await delay(40);expect(f.recent(id).status).toBe('pending');
    expect(f.db.prepare('SELECT state FROM mind_actions WHERE id=?').get(old.id)?.state).toBe('queued');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM mind_actions WHERE source_id=?').get(`ops:${id}`)?.n).toBe(1);
    expect(f.configured.service.store.pending()).toEqual([]);expect((await f.claim()).body.command).toBeNull();
    expect(()=>f.db.prepare("UPDATE ops_lifecycle_dispatches SET execution_kind='respond' WHERE command_id=?").run(id)).toThrow('OPS_EXECUTION_KIND_IMMUTABLE');
    f.advance(6000);f.poll();f.configured.ops!.wake();expect(f.recent(id).status).toBe('expired');
    expect((await f.send('minecraft.start','shannon-home','legacy-key')).status).toBe(200);
    expect(f.configured.service.store.pending()).toEqual([]);expect(mapping()).toMatchObject({execution_kind:'minecraft',action_id:null});
    const next=await f.send('minecraft.start','shannon-home','explicit-new-key'), c=await f.command();await f.acknowledge(c);
    expect(f.recent(next.body.command.id).status).toBe('done');expect(f.recent(id).status).toBe('expired');
    expect(f.db.prepare('SELECT kind FROM mind_actions WHERE source_id=?').get(`ops:${id}`)?.kind).toBe('minecraft');
  });

  it('requires the immutable Ops execution kind and original request kind to match at native authorization', async () => {
    const f=await fixture(), sent=await f.send('minecraft.start','shannon-home'), c=await f.command();
    expect(()=>f.db.prepare("UPDATE ops_lifecycle_dispatches SET execution_kind='minecraft' WHERE command_id=?").run(sent.body.command.id)).toThrow('OPS_EXECUTION_KIND_IMMUTABLE');
    f.db.prepare("UPDATE mind_actions SET kind='minecraft' WHERE id=?").run(c.authority.executionId);
    expect(f.configured.service.authorize({scopeKey:'owner',deviceId:'operator'},c.id)).toBe(false);
    f.db.prepare("UPDATE mind_actions SET kind='respond' WHERE id=?").run(c.authority.executionId);
    f.db.prepare("UPDATE ops_commands SET type='minecraft.stop' WHERE command_id=?").run(sent.body.command.id);
    expect(f.configured.service.authorize({scopeKey:'owner',deviceId:'operator'},c.id)).toBe(false);
    f.poll([f.receipt(c,{outcome:'cancelled',code:'authority_revoked'})]);
    await until(()=>f.recent(sent.body.command.id).status==='failed');
  });

  it('still blocks native work behind an unknown body resource even through foreground admission', async () => {
    const f=await fixture(), resource=actionResource('operator','minecraft-body');
    const a=await f.actions.admitRespond({scopeKey:'owner',kind:'respond',origin:'owner_request',sourceId:'lost-body-response'});
    expect(await f.actions.dispatch(leaseOf(a!),[resource])).toBe(true);
    await f.actions.finish(leaseOf(a!),'unknown','body_result_unknown');
    const original=f.db.prepare('SELECT * FROM mind_actions WHERE id=?').get(a!.id);
    const sent=await f.send('minecraft.start','shannon-home');
    await until(()=>f.recent(sent.body.command.id).status==='refused');
    expect(f.recent(sent.body.command.id).code).toBe('not_allowed');
    expect(f.configured.service.store.pending()).toEqual([]);expect((await f.claim()).body.command).toBeNull();
    expect(f.db.prepare('SELECT * FROM mind_actions WHERE id=?').get(a!.id)).toEqual(original);
    const conversation=await f.actions.admitRespond({scopeKey:'owner',kind:'respond',origin:'owner_request',sourceId:'next-conversation'});
    expect(conversation).not.toBeNull();
  });

  it('bounds foreground native waiting by the original report window and retains an unknown delivered effect after cancellation drain', async () => {
    const f=await fixture(), timeout=new AbortController();
    const timer=vi.spyOn(AbortSignal,'timeout').mockImplementation(milliseconds=>{
      expect(milliseconds).toBe(120_000);return timeout.signal;
    });
    try {
      const sent=await f.send('minecraft.start','shannon-home'), c=await f.command();
      expect(f.store.commands.lifecycleReportBy('owner',sent.body.command.id,c.authority.lease)).toBe('2026-10-10T00:02:00.000Z');
      timeout.abort();
      await until(()=>f.configured.service.store.pending()[0]?.cancelled===true);
      f.advance(5001);
      await until(()=>f.db.prepare('SELECT state FROM mind_actions WHERE id=?').get(c.authority.executionId)?.state==='unknown');
      expect(f.recent(sent.body.command.id)).toMatchObject({status:'failed',code:'no_report'});
      expect(f.db.prepare('SELECT state,resources_json FROM mind_actions WHERE id=?').get(c.authority.executionId)).toMatchObject({
        state:'unknown',resources_json:JSON.stringify([actionResource('operator','minecraft-body')])});
      expect(f.configured.service.store.delivered(c.id)).toBe(true);
      f.configured.ops!.wake();expect((await f.claim()).body.command).toBeNull();
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM minecraft_lifecycle_operations').get()?.n).toBe(1);
      const chat=await f.actions.admitRespond({scopeKey:'owner',kind:'respond',origin:'owner_request',sourceId:'chat-after-unknown'});
      expect(chat).not.toBeNull();
    } finally {timer.mockRestore();}
  });

  it('serializes admission with a live foreground conversation before acquiring the shared body resource', async () => {
    const f = await fixture(), resource = actionResource('operator', 'minecraft-body');
    const foreground = await f.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: 'body-conversation' });
    expect(await f.actions.dispatch(leaseOf(foreground!), [resource])).toBe(true);
    const sent = await f.send('minecraft.start', 'shannon-home');
    await delay(40);
    expect(f.recent(sent.body.command.id).status).toBe('pending');
    expect(f.configured.service.store.pending()).toEqual([]);
    expect((await f.claim()).body.command).toBeNull();
    expect(f.db.prepare('SELECT resources_json FROM mind_actions WHERE id=?').get(foreground!.id)?.resources_json).toBe(JSON.stringify([resource]));
    await f.actions.finish(leaseOf(foreground!), 'completed', 'original_body_acknowledged');
    f.configured.ops!.wake();
    const c = await f.command(); await f.acknowledge(c);
    expect(f.recent(sent.body.command.id).status).toBe('done');
  });
});
