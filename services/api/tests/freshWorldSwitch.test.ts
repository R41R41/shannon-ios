import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { configuredMinecraftLifecycle } from '../src/wiring/minecraftLifecycleWiring.js';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { ShannonAutonomyService } from '../src/mind/action/ownTime/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { OperatorAuditStore } from '../src/infra/ops/store/operatorAuditStore.js';
import { SQLiteOpsStore } from '../src/infra/ops/store/opsStore.js';
import { OpsWorldPolicyStore } from '../src/infra/ops/store/opsWorldPolicyStore.js';
import { createOpsRoute, isOpsPath, OPS_READ_PATH } from '../src/infra/ops/serverOpsRoutes.js';
import { OPS_SETTINGS_PATH, validatedOpsSettingsRequest } from '../src/contracts/opsSettingsContract.js';
import { validatedOpsSnapshot } from '../src/contracts/opsContract.js';
import {
  createFreshWorldAdmission, freshWorldDecision, freshWorldSettingRecorder, FRESH_WORLD_SERVER, type FreshWorldFacts, type FreshWorldRecord,
} from '../src/wiring/freshWorldWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { inActionExecution, type ActionExecution } from '../src/infra/context/actionExecution.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
import type { MinecraftLifecycleCommand, MinecraftLifecycleReceipt, MinecraftLifecycleState } from '../src/contracts/minecraftLifecycleContract.js';

// 「新しいワールドで始める」 (docs/ops-contract.md): the owner's switch, and the one decision that puts `options.freshWorld` on a start.
const close: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const finish of close.splice(0).reverse()) await finish(); });
async function until(test: () => boolean) { for (let i = 0; i < 500; i++) { if (test()) return; await delay(2); } expect(test()).toBe(true); }

const SERVER = FRESH_WORLD_SERVER;
const environment = { SHANNON_MINECRAFT_LIFECYCLE: 'on', SHANNON_ADR8_STAGE4: 'on', SHANNON_MINECRAFT_LIFECYCLE_SERVERS: `["${SERVER}"]`,
  SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'operator', servers: [{ serverId: SERVER, title: 'Home', onlineMode: true,
    ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) };

describe('the settings contract', () => {
  it('accepts exactly a boolean freshWorld (and scopeKey for a fixed local token)', () => {
    expect(validatedOpsSettingsRequest({ freshWorld: true })).toEqual({ freshWorld: true });
    expect(validatedOpsSettingsRequest({ freshWorld: false, scopeKey: 'owner' })).toEqual({ freshWorld: false });
    for (const bad of [null, [], 'true', 1, {}, { freshWorld: 'true' }, { freshWorld: 1 }, { freshWorld: null }, { freshWorld: true, other: 1 }]) {
      expect(validatedOpsSettingsRequest(bad), JSON.stringify(bad)).toMatchObject({ status: 400, error: 'INVALID_REQUEST' });
    }
    expect(isOpsPath(OPS_SETTINGS_PATH)).toBe(true);
    expect(OPS_SETTINGS_PATH).toBe('/v1/ops/settings');
  });
});

describe('the stored switch', () => {
  it('is off for a scope never set, persists, and keeps scopes apart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fresh-world-store-')); close.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'ops.sqlite');
    const first = new SQLiteOpsStore(path);
    expect(first.worldPolicy.freshWorld('owner')).toBe(false);
    first.worldPolicy.set('owner', true, '2026-10-19T00:00:00.000Z');
    expect(first.worldPolicy.freshWorld('owner')).toBe(true);
    expect(first.worldPolicy.freshWorld('someone-else')).toBe(false);
    first.close();
    const second = new SQLiteOpsStore(path);
    expect(second.worldPolicy.freshWorld('owner')).toBe(true);
    second.worldPolicy.set('owner', false, '2026-10-19T00:01:00.000Z');
    expect(second.worldPolicy.freshWorld('owner')).toBe(false);
    second.close();
    const raw = new DatabaseSync(path);
    expect(raw.prepare('PRAGMA table_info(ops_minecraft_world_policy)').all().map(row => [row.name, row.type, row.notnull, row.pk]))
      .toEqual([['scope_key', 'TEXT', 1, 1], ['fresh_world', 'INTEGER', 1, 0], ['changed_at', 'TEXT', 1, 0]]);
    expect(raw.prepare('SELECT * FROM ops_minecraft_world_policy').all()).toEqual([{ scope_key: 'owner', fresh_world: 0, changed_at: '2026-10-19T00:01:00.000Z' }]);
    raw.close();
  });

  it('fails closed: anything but a stored 1, and an unreadable table, is off', () => {
    const database = new DatabaseSync(':memory:');
    const policy = new OpsWorldPolicyStore(database);
    for (const value of [2, -1, 0]) {
      database.prepare('INSERT OR REPLACE INTO ops_minecraft_world_policy (scope_key, fresh_world, changed_at) VALUES (?, ?, ?)').run('owner', value, 'x');
      expect(policy.freshWorld('owner'), String(value)).toBe(false);
    }
    database.prepare("INSERT OR REPLACE INTO ops_minecraft_world_policy (scope_key, fresh_world, changed_at) VALUES ('owner', 1, 'x')").run();
    expect(policy.freshWorld('owner')).toBe(true);
    database.exec('DROP TABLE ops_minecraft_world_policy');
    expect(policy.freshWorld('owner')).toBe(false);
    database.close();
    expect(policy.freshWorld('owner')).toBe(false);
  });
});

describe('GET /v1/ops and POST /v1/ops/settings', () => {
  const DEVICE = 'device-token-of-the-owner';
  async function harness(options: { fixedToken?: boolean; failRecord?: 'on' | 'off' | 'any' } = {}) {
    const clock = { at: '2026-10-19T03:00:00.000Z' };
    const store = new SQLiteOpsStore(':memory:'); close.push(() => store.close());
    const recorded: Array<{ scopeKey: string; setting: string; value: boolean; at: string }> = [];
    const route = createOpsRoute({
      store, now: () => clock.at, ingestEnabled: () => true, bridge: { token: 'b'.repeat(40), scopeKey: 'owner' },
      device: authorization => authorization !== `Bearer ${DEVICE}` ? null : { scopeKey: options.fixedToken ? null : 'owner', deviceId: 'desktop-1' },
      recordSetting: (scopeKey, change) => {
        if (options.failRecord === 'any' || options.failRecord === 'on' && change.value || options.failRecord === 'off' && !change.value) throw new Error('record unavailable');
        recorded.push({ scopeKey, ...change });
      },
    });
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      route(url.pathname, request, response, url.searchParams).catch(() => { response.writeHead(500).end('{}'); });
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    close.push(() => new Promise<void>(done => server.close(() => done())));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('port');
    const call = async (method: string, path: string, token: string | null, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as any };
    };
    return { store, clock, recorded, call, read: () => call('GET', `${OPS_READ_PATH}?scopeKey=owner`, DEVICE), write: (body: unknown, token: string | null = DEVICE) => call('POST', OPS_SETTINGS_PATH, token, body) };
  }

  it('reads settings.freshWorld = false by default, whatever else the answer holds', async () => {
    const h = await harness();
    const answer = await h.read();
    expect(answer.status).toBe(200);
    expect(answer.body.settings).toEqual({ freshWorld: false });
    expect(Object.keys(answer.body)).toEqual(expect.arrayContaining(['schemaVersion', 'snapshot', 'receivedAt', 'stale', 'staleAfterSeconds', 'commands', 'commandsSupported', 'allowed', 'settings']));
  });

  it('stores a change, answers the stored value, shows it in GET, and records each change once', async () => {
    const h = await harness();
    expect(await h.write({ freshWorld: true })).toEqual({ status: 200, body: { settings: { freshWorld: true } } });
    expect((await h.read()).body.settings).toEqual({ freshWorld: true });
    expect(h.store.worldPolicy.freshWorld('owner')).toBe(true);
    // The same value again changes nothing and records nothing.
    expect(await h.write({ freshWorld: true })).toEqual({ status: 200, body: { settings: { freshWorld: true } } });
    expect(h.recorded).toEqual([{ scopeKey: 'owner', setting: 'freshWorld', value: true, at: '2026-10-19T03:00:00.000Z' }]);
    h.clock.at = '2026-10-19T03:05:00.000Z';
    expect(await h.write({ freshWorld: false })).toEqual({ status: 200, body: { settings: { freshWorld: false } } });
    expect((await h.read()).body.settings).toEqual({ freshWorld: false });
    expect(h.recorded.map(item => item.value)).toEqual([true, false]);
  });

  it('refuses a body that is not exactly a boolean, and changes nothing', async () => {
    const h = await harness();
    for (const bad of [{}, { freshWorld: 'true' }, { freshWorld: 1 }, { freshWorld: null }, [true], { freshWorld: true, extra: 1 }, 'true', 'not json {']) {
      expect(await h.write(bad), JSON.stringify(bad)).toMatchObject({ status: 400, body: { error: 'INVALID_REQUEST' } });
    }
    expect(h.store.worldPolicy.freshWorld('owner')).toBe(false);
    expect(h.recorded).toEqual([]);
  });

  it('wants a paired device, the POST method, and a scopeKey from a fixed local token', async () => {
    const h = await harness();
    expect(await h.write({ freshWorld: true }, null)).toMatchObject({ status: 401, body: { error: 'PAIRING_REQUIRED' } });
    expect((await h.write({ freshWorld: true }, 'b'.repeat(40))).status).toBe(401);
    expect((await h.call('GET', OPS_SETTINGS_PATH, DEVICE)).status).toBe(405);
    expect(h.store.worldPolicy.freshWorld('owner')).toBe(false);
    const fixed = await harness({ fixedToken: true });
    expect(await fixed.write({ freshWorld: true })).toMatchObject({ status: 400, body: { error: 'INVALID_REQUEST' } });
    expect(await fixed.write({ freshWorld: true, scopeKey: 'owner' })).toEqual({ status: 200, body: { settings: { freshWorld: true } } });
  });

  it('turns ON only if the change could be recorded; turning OFF is never undone by a failing record', async () => {
    const on = await harness({ failRecord: 'on' });
    expect((await on.write({ freshWorld: true })).status).toBe(500);
    expect(on.store.worldPolicy.freshWorld('owner')).toBe(false);
    const off = await harness({ failRecord: 'off' });
    expect((await off.write({ freshWorld: true })).status).toBe(200);
    expect(await off.write({ freshWorld: false })).toEqual({ status: 200, body: { settings: { freshWorld: false } } });
    expect(off.store.worldPolicy.freshWorld('owner')).toBe(false);
  });

  it('limits the writes of a minute', async () => {
    const h = await harness();
    let last = 200;
    for (let index = 0; index < 31; index += 1) last = (await h.write({ freshWorld: index % 2 === 0 })).status;
    expect(last).toBe(429);
  });
});

describe('the decision, as a truth table', () => {
  const all: FreshWorldFacts = { action: 'start', serverId: SERVER, origin: 'owner_request', via: 'ops', existing: null, switchedOn: true,
    state: { running: 'stopped' }, bodyTasksOpen: false, unresolved: false };
  const decide = (patch: Partial<FreshWorldFacts>) => freshWorldDecision({ ...all, ...patch });

  it('applies only when every condition holds, for each of the three ways the owner asks', () => {
    for (const via of ['conversation', 'ops', 'operator'] as const) expect(decide({ via })).toEqual({ reason: 'applied', options: { freshWorld: true } });
  });

  it('refuses each missing condition on its own, with its own reason and no options', () => {
    const cases: Array<[string, Partial<FreshWorldFacts>, string]> = [
      ['a task step or own time or recovery (no via)', { via: null }, 'not_owner_request'],
      ['own-time origin', { origin: 'own_time' }, 'not_owner_request'],
      ['stop', { action: 'stop' }, 'not_start'], ['login', { action: 'login' }, 'not_start'], ['logout', { action: 'logout' }, 'not_start'],
      ['set_day', { action: 'set_day' }, 'not_start'],
      ['another server', { serverId: 'other' }, 'other_server'],
      ['switch off', { switchedOn: false }, 'switch_off'],
      ['no fresh state', { state: undefined }, 'server_not_stopped'],
      ['server running', { state: { running: 'running' } }, 'server_not_stopped'],
      ['server unknown', { state: { running: 'unknown' } }, 'server_not_stopped'],
      ['an open task', { bodyTasksOpen: true }, 'tasks_open'],
      ['tasks cannot be read', { bodyTasksOpen: null }, 'tasks_unknown'],
      ['an unresolved lifecycle command', { unresolved: true }, 'unresolved_operation'],
    ];
    for (const [name, patch, reason] of cases) expect(decide(patch), name).toEqual({ reason });
  });

  it('never decides again for a command that exists: it keeps what it was issued with', () => {
    expect(decide({ existing: {} })).toEqual({ reason: 'existing_command' });
    expect(decide({ existing: { options: { freshWorld: true } } })).toEqual({ reason: 'existing_command', options: { freshWorld: true } });
    expect(decide({ existing: {}, switchedOn: true })).not.toHaveProperty('options');
  });
});

describe('the shared admission', () => {
  function admission(patch: { on?: boolean; running?: 'stopped' | 'running'; tasks?: boolean | null; unresolved?: boolean; existing?: { options?: { freshWorld?: true } } | null;
    record?: (record: FreshWorldRecord) => void; policy?: null; status?: () => never } = {}) {
    const records: FreshWorldRecord[] = [];
    const decide = createFreshWorldAdmission({
      scopeKey: 'owner', policy: patch.policy === null ? null : { freshWorld: () => patch.on ?? true },
      status: patch.status ?? ((): readonly MinecraftLifecycleState[] => [{ serverId: SERVER, observedAt: 'x', running: patch.running ?? 'stopped', bot: 'absent', otherPlayers: 0 }]),
      command: () => (patch.existing === undefined ? null : patch.existing), unresolved: () => patch.unresolved ?? false,
      bodyTasksOpen: () => patch.tasks === undefined ? false : patch.tasks, now: () => '2026-10-19T00:00:00.000Z',
      record: patch.record ?? (record => { records.push(record); }),
    });
    return { decide, records };
  }
  const request = { id: 'ops-lifecycle:one', serverId: SERVER, action: 'start' as const, origin: 'owner_request' as const, via: 'ops' as const };

  it('answers the options and writes a content-free record of the decision', () => {
    const { decide, records } = admission();
    expect(decide(request)).toEqual({ freshWorld: true });
    expect(records).toEqual([{ at: '2026-10-19T00:00:00.000Z', applied: true, reason: 'applied', via: 'ops', operationId: 'ops-lifecycle:one', serverId: SERVER }]);
    expect(Object.keys(records[0]!).sort()).toEqual(['applied', 'at', 'operationId', 'reason', 'serverId', 'via']);
  });

  it('records why a start the owner newly asked for kept its world, but nothing while the switch is off or for other starts', () => {
    const open = admission({ tasks: true });
    expect(open.decide(request)).toBeUndefined();
    expect(open.records).toMatchObject([{ applied: false, reason: 'tasks_open' }]);
    const off = admission({ on: false });
    expect(off.decide(request)).toBeUndefined();
    expect(off.records).toEqual([]);
    const other = admission();
    for (const patch of [{ action: 'login' as const }, { via: null }, { origin: 'own_time' as const }, { serverId: 'x' }]) expect(other.decide({ ...request, ...patch })).toBeUndefined();
    expect(other.records).toEqual([]);
  });

  it('is "no" on any doubt: no policy, an unreadable status, or a record that cannot be written', () => {
    expect(admission({ policy: null }).decide(request)).toBeUndefined();
    expect(admission({ status: () => { throw new Error('unreadable'); } }).decide(request)).toBeUndefined();
    expect(admission({ record: () => { throw new Error('activity unavailable'); } }).decide(request)).toBeUndefined();
    expect(admission({ record: () => { throw new Error('activity unavailable'); }, running: 'running' }).decide(request)).toBeUndefined();
    const withoutRecord = createFreshWorldAdmission({ scopeKey: 'owner', policy: { freshWorld: () => true }, status: () => [{ serverId: SERVER, observedAt: 'x',
      running: 'stopped', bot: 'absent', otherPlayers: 0 }], command: () => null, unresolved: () => false, bodyTasksOpen: () => false, now: () => 'x' });
    expect(withoutRecord(request)).toBeUndefined();
  });

  it('hands back what an existing command carries, without deciding or recording', () => {
    const stored = admission({ existing: { options: { freshWorld: true } }, on: false });
    expect(stored.decide(request)).toEqual({ freshWorld: true });
    const plain = admission({ existing: {} });
    expect(plain.decide(request)).toBeUndefined();
    expect(stored.records).toEqual([]);
    expect(plain.records).toEqual([]);
  });
});

describe('the lifecycle command, from each way of asking', () => {
  function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'fresh-world-')), path = join(directory, 'store.sqlite');
    close.push(() => rmSync(directory, { recursive: true, force: true }));
    let at = '2026-10-19T00:00:00.000Z', sequence = 0, alone = true, running: 'running' | 'stopped' | 'unknown' = 'stopped';
    let tasksOpen: boolean | null = false, recordFails = false, taskAllowed = true;
    const opsStore = new SQLiteOpsStore(path); close.push(() => opsStore.close());
    const autonomyStore = new SQLiteAutonomyStore(path); close.push(() => autonomyStore.close());
    const config = configuredAutonomy({ SHANNON_AUTONOMY_ENABLED: 'true' });
    const autonomy = new ShannonAutonomyService({ store: autonomyStore, config, now: () => at });
    const h = actionHarness(() => at, path); close.push(h.close);
    const auditDb = new DatabaseSync(path); close.push(() => auditDb.close());
    const audit = new OperatorAuditStore(auditDb);
    const activity = { append: ((...args: Parameters<typeof autonomyStore.activity.append>) => {
      if (recordFails) throw new Error('activity unavailable');
      return autonomyStore.activity.append(...args);
    }) as typeof autonomyStore.activity.append };
    const configured = configuredMinecraftLifecycle(environment, { path, autonomy, actions: h.actions, now: () => at, ownerAlone: () => alone,
      taskAllowed: () => taskAllowed, taskSources: () => [], ops: { commands: opsStore.commands, actions: h.actions, enabled: () => true },
      freshWorld: { policy: opsStore.worldPolicy, activity, config, bodyTasksOpen: () => tasksOpen } })!;
    close.push(async () => { const ticking = setInterval(() => { at = new Date(Date.parse(at) + 1000).toISOString(); }, 20);
      try { await configured.close(); } finally { clearInterval(ticking); } });
    const principal = { scopeKey: 'owner', deviceId: 'operator' };
    const state = (patch: Partial<MinecraftLifecycleState> = {}): MinecraftLifecycleState => ({ serverId: SERVER, observedAt: at, running, bot: 'absent', otherPlayers: 0, ...patch });
    const poll = (receipts: MinecraftLifecycleReceipt[] = []) => configured.service.poll(principal,
      { schemaVersion: 1, connectionId: 'operator-connection', sequence: sequence++, states: [state()], receipts });
    poll();
    const snapshot = validatedOpsSnapshot({ scopeKey: 'owner', reportedAt: at, runtime: { release: 'test', startedAt: at },
      services: ['minecraft', 'minebot', 'minebot:bot', `minecraft:${SERVER}`].map(id => ({ id, label: id, category: 'platform', status: 'running' })),
      minebot: [], skills: [], schedules: [] });
    if (typeof snapshot === 'string') throw new Error(snapshot);
    opsStore.replace('owner', 1, snapshot, at);
    const route = createOpsRoute({ store: opsStore, now: () => at, ingestEnabled: () => true, commandsEnabled: () => true, minecraftLifecycle: () => configured.ops,
      bridge: { token: 'legacy-bridge', scopeKey: 'owner' }, recordSetting: freshWorldSettingRecorder(autonomyStore.activity, config),
      device: authorization => authorization === 'Bearer desktop' ? { scopeKey: 'owner', deviceId: 'desktop-1' } : null });
    const server = createServer((req, res) => { const url = new URL(req.url!, 'http://localhost'); route(url.pathname, req, res, url.searchParams).catch(() => { res.writeHead(500).end('{}'); }); });
    const ready = new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    close.push(() => new Promise<void>(done => server.close(() => done())));
    const post = async (url: string, body: unknown) => {
      await ready;
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('port');
      const response = await fetch(`http://127.0.0.1:${address.port}${url}`, { method: 'POST', headers: { authorization: 'Bearer desktop', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    };
    let key = 0;
    const send = (type: string, target: string) => post('/v1/ops/commands', { type, target, idempotencyKey: `command-${++key}-${randomUUID()}` });
    const setSwitch = (freshWorld: boolean) => post(OPS_SETTINGS_PATH, { freshWorld });
    const receipt = (command: MinecraftLifecycleCommand): MinecraftLifecycleReceipt => ({ id: command.id, connectionId: command.connectionId, serverId: command.serverId,
      action: command.action, outcome: 'completed', code: 'changed', observedAt: at, inputsReleased: true,
      state: state({ running: command.action === 'stop' ? 'stopped' : 'running', bot: command.action === 'login' ? 'joined' : 'absent' }),
      ...(command.action === 'stop' ? { stopGuard: { admissionClosed: true as const, otherPlayers: 0 as const, checkedAt: at } } : {}) });
    /** The one command the operator receives next; the native acknowledgement then ends it. */
    const issued = async (): Promise<MinecraftLifecycleCommand> => {
      await until(() => configured.service.store.pending().length === 1);
      const command = poll().commands[0]!;
      expect(poll([receipt(command)]).acknowledged).toEqual([command.id]);
      await until(() => h.store.get(command.authority.executionId)?.state !== 'running');
      return command;
    };
    const turn = async () => {
      const view = (await h.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: `turn-${sequence++}` }))!;
      const controller = new AbortController();
      const execution: ActionExecution = { lease: leaseOf(view), signal: controller.signal, permit: async resources => h.actions.dispatch(execution.lease, resources) };
      return { view, controller, execution };
    };
    const converse = async (name: string, identity: string) => {
      const t = await turn();
      const result = await inActionExecution(t.execution, () => autonomy.tools.call(name, {}, { scopeKey: 'owner', surface: 'text', audience: 'owner_alone',
        threadId: 'thread', memory: { ...toolSessionMemory(), turnKey: identity }, acknowledgementOwner: 'fca' }, t.execution.signal));
      t.controller.abort(); await h.actions.finish(t.execution.lease, 'completed', 'turn_finished');
      return result;
    };
    const step = async (kind: 'agentTask' | 'ownTime', name: string) => {
      const draft = { scopeKey: 'owner', kind, origin: kind === 'ownTime' ? 'own_time' as const : 'owner_request' as const, sourceId: `step-${kind}-${sequence++}` };
      const view = (await h.actions.claim((await h.actions.enqueue(draft)).id))!;
      const controller = new AbortController(), lease = leaseOf(view);
      const execution: ActionExecution = { lease, signal: controller.signal, permit: async resources => h.actions.dispatch(execution.lease, resources) };
      const surface = kind === 'ownTime' ? 'autonomy' as const : 'text' as const;
      const result = inActionExecution(execution, () => autonomy.tools.call(name, {}, { scopeKey: 'owner', surface, audience: 'owner_alone',
        memory: { ...toolSessionMemory(), turnKey: `${name}-${sequence}` }, acknowledgementOwner: 'fca' }, execution.signal));
      return { result, execution };
    };
    const operatorStart = async (action: 'start' | 'login') => {
      const id = `operator:${randomUUID()}`;
      audit.append({ operationId: id, scopeKey: 'owner', at, operator: 'ops', command: 'lifecycle', event: 'invoked', code: 'invoked', argsJson: '{}', action, serverId: SERVER });
      const settled: unknown[] = [];
      const admission = await configured.operator.execute({ id, serverId: SERVER, action }, value => settled.push(value));
      return { id, admission };
    };
    const records = () => autonomyStore.activity.days('owner', { sinceDayKey: '' }).flatMap(day => day.entries).filter(entry => entry.tool === 'minecraft.fresh_world');
    const settings = () => autonomyStore.activity.days('owner', { sinceDayKey: '' }).flatMap(day => day.entries).filter(entry => entry.tool === 'ops.settings.freshWorld');
    return { ...h, opsStore, configured, poll, state, send, setSwitch, issued, converse, step, operatorStart, records, settings, receipt,
      running(value: typeof running) { running = value; poll(); }, tasksOpen(value: boolean | null) { tasksOpen = value; },
      recordFails(value: boolean) { recordFails = value; }, alone(value: boolean) { alone = value; }, taskAllowed(value: boolean) { taskAllowed = value; } };
  }

  describe('Ops minecraft.start', () => {
    it('carries options.freshWorld after the switch was turned on over HTTP, and records the settings change and the decision', async () => {
      const f = fixture();
      expect((await f.setSwitch(true)).body).toEqual({ settings: { freshWorld: true } });
      expect(f.settings().map(entry => entry.reasonCode)).toEqual(['fresh_world_on']);
      const sent = await f.send('minecraft.start', SERVER);
      expect(sent.status).toBe(201);
      const command = await f.issued();
      expect(command).toMatchObject({ id: `ops-lifecycle:${sent.body.command.id}`, serverId: SERVER, action: 'start', options: { freshWorld: true } });
      expect(f.configured.service.store.command(command.id)?.options).toEqual({ freshWorld: true });
      const entries = f.records();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ reasonCode: 'fresh_world_applied', outcome: 'done', actor: 'owner' });
      expect(entries[0]!.detail).toBe(`operation=${command.id} server=${SERVER} via=ops`);
    });

    it('is the legacy command when the switch is off: no options key at all, and nothing recorded', async () => {
      const f = fixture();
      await f.send('minecraft.start', SERVER);
      const command = await f.issued();
      expect(command).toMatchObject({ action: 'start', serverId: SERVER });
      expect('options' in command).toBe(false);
      expect(JSON.stringify(command)).not.toContain('freshWorld');
      expect(f.records()).toEqual([]);
      // Turned on and back off over HTTP before the request: still the legacy command.
      await f.setSwitch(true); await f.setSwitch(false);
      await f.send('minecraft.start', SERVER);
      expect('options' in await f.issued()).toBe(false);
    });

    it.each([
      ['the server is running', (f: ReturnType<typeof fixture>) => f.running('running'), 'server_not_stopped'],
      ['the server state is unknown', (f: ReturnType<typeof fixture>) => f.running('unknown'), 'server_not_stopped'],
      ['a Minecraft task is still open', (f: ReturnType<typeof fixture>) => f.tasksOpen(true), 'tasks_open'],
      ['the open tasks cannot be read', (f: ReturnType<typeof fixture>) => f.tasksOpen(null), 'tasks_unknown'],
    ])('keeps the world when %s, and says why in the record', async (_name, arrange, reason) => {
      const f = fixture();
      await f.setSwitch(true); arrange(f);
      await f.send('minecraft.start', SERVER);
      const command = await f.issued();
      expect('options' in command).toBe(false);
      expect(f.records().map(entry => entry.reasonCode)).toEqual([`fresh_world_${reason}`]);
      expect(f.records()[0]).toMatchObject({ outcome: 'recorded' });
    });

    it('does not delete a world it could not record: a failing activity record leaves the legacy command', async () => {
      const f = fixture();
      await f.setSwitch(true); f.recordFails(true);
      await f.send('minecraft.start', SERVER);
      expect('options' in await f.issued()).toBe(false);
    });

    it.each([
      ['minebot.start', SERVER, 'login'], ['minecraft.stop', SERVER, 'stop'], ['service.stop', 'minebot:bot', 'logout'],
    ])('never adds it to %s (%s) even with the switch on', async (type, target, action) => {
      const f = fixture();
      await f.setSwitch(true);
      if (action !== 'login') f.running('running');
      await f.send(type, target);
      const command = await f.issued();
      expect(command.action).toBe(action);
      expect('options' in command).toBe(false);
      expect(f.records()).toEqual([]);
    });
  });

  describe('the operator CLI', () => {
    it('adds it to a start, not to a login, and only with the switch on', async () => {
      const f = fixture();
      const off = await f.operatorStart('start');
      expect(off.admission).toMatchObject({ ok: true });
      expect('options' in await f.issued()).toBe(false);
      await f.setSwitch(true);
      const on = await f.operatorStart('start');
      expect(on.admission).toMatchObject({ ok: true });
      const command = await f.issued();
      expect(command).toMatchObject({ id: on.id, action: 'start', options: { freshWorld: true } });
      expect(f.records().map(entry => entry.detail)).toEqual([`operation=${on.id} server=${SERVER} via=operator`]);
      f.running('stopped');
      const login = await f.operatorStart('login');
      expect(login.admission).toMatchObject({ ok: true });
      expect('options' in await f.issued()).toBe(false);
    });
  });

  describe('a conversation request', () => {
    it('adds it to minecraft.start, not to minecraft.login', async () => {
      const f = fixture();
      await f.setSwitch(true);
      const asked = await f.converse('minecraft.start', 'start-1');
      expect(asked).toMatchObject({ ok: true, evidence: { outcome: 'queued', action: 'start' } });
      const command = await f.issued();
      expect(command).toMatchObject({ action: 'start', serverId: SERVER, options: { freshWorld: true }, authority: { origin: 'owner_request' } });
      expect(f.records().map(entry => entry.detail)).toEqual([`operation=${command.id} server=${SERVER} via=conversation`]);
      f.running('stopped');
      await f.converse('minecraft.login', 'login-1');
      expect('options' in await f.issued()).toBe(false);
    });

    it('is the legacy command when the switch is off', async () => {
      const f = fixture();
      await f.converse('minecraft.start', 'start-off');
      const command = await f.issued();
      expect(command.action).toBe('start');
      expect('options' in command).toBe(false);
      expect(f.records()).toEqual([]);
    });
  });

  describe('everything that is not a new request of the owner', () => {
    it.each(['agentTask', 'ownTime'] as const)('never puts it on a start from a %s step, with the switch on and the server stopped', async kind => {
      const f = fixture();
      await f.setSwitch(true);
      const { result, execution } = await f.step(kind, 'minecraft.start');
      await until(() => f.configured.service.store.pending().length === 1);
      const command = f.poll().commands[0]!;
      expect(command).toMatchObject({ action: 'start', authority: { origin: kind === 'ownTime' ? 'own_time' : 'owner_request', executionId: execution.lease.id } });
      expect('options' in command).toBe(false);
      f.poll([f.receipt(command)]);
      await result;
      expect(f.records()).toEqual([]);
    });

    it('does not turn a command that already exists into another: a resend with other options is a conflict, never a second command', async () => {
      const f = fixture();
      await f.setSwitch(true);
      await f.converse('minecraft.start', 'start-resend');
      const command = await f.issued();
      expect(command.options).toEqual({ freshWorld: true });
      const authority = command.authority;
      // The same id without the option, or with it added to a legacy command, is not the same operation.
      await expect(f.configured.service.execute({ id: command.id, serverId: SERVER, action: 'start', authority }))
        .rejects.toThrow('MINECRAFT_LIFECYCLE_OPERATION_CONFLICT');
      expect(f.configured.service.store.command(command.id)?.options).toEqual({ freshWorld: true });
      expect(f.configured.service.store.pending()).toEqual([]);
      // The identical request is the original operation and returns its accepted receipt.
      await expect(f.configured.service.execute({ id: command.id, serverId: SERVER, action: 'start', authority, options: { freshWorld: true } }))
        .resolves.toMatchObject({ id: command.id, outcome: 'completed' });
    });

    it('keeps a legacy command legacy: options cannot be added to its id afterwards', async () => {
      const f = fixture();
      await f.converse('minecraft.start', 'start-legacy');
      const command = await f.issued();
      expect('options' in command).toBe(false);
      await f.setSwitch(true);
      await expect(f.configured.service.execute({ id: command.id, serverId: SERVER, action: 'start', authority: command.authority, options: { freshWorld: true } }))
        .rejects.toThrow('MINECRAFT_LIFECYCLE_OPERATION_CONFLICT');
      await expect(f.configured.service.execute({ id: command.id, serverId: SERVER, action: 'start', authority: command.authority }))
        .resolves.toMatchObject({ id: command.id });
    });
  });
});
