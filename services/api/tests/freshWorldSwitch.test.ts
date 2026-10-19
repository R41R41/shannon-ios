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
import { OpsCommandStore } from '../src/infra/ops/store/opsCommandStore.js';
import { createOpsRoute, isOpsPath, OPS_READ_PATH } from '../src/infra/ops/serverOpsRoutes.js';
import { OPS_SETTINGS_PATH, validatedOpsSettingsRequest } from '../src/contracts/opsSettingsContract.js';
import { validatedOpsSnapshot } from '../src/contracts/opsContract.js';
import { parseOperatorEnvelope } from '../src/contracts/operatorContract.js';
import { operatorEnvelope } from '../src/infra/ops/operatorCli.js';
import {
  createFreshWorldAdmission, freshWorldDecision, freshWorldIssuance, freshWorldOfReceipt, freshWorldOfSettlement, freshWorldReportOf, freshWorldResultSummary,
  freshWorldSettingRecorder, freshWorldSummary, freshWorldViaOfOperation, preparedWorldOfReceipt, FRESH_WORLD_REASONS, FRESH_WORLD_SERVER, type FreshWorldFacts, type FreshWorldRecord,
} from '../src/wiring/freshWorldWiring.js';
import { MinecraftLifecycle } from '../src/surfaces/minecraft/minecraftLifecycle.js';
import { MinecraftLifecycleStore } from '../src/surfaces/minecraft/store/minecraftLifecycleStore.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import { lifecycleCapabilities, validLifecyclePoll, withoutMalformedReceiptWorlds } from '../src/contracts/minecraftLifecycleContract.js';
import { neutralLifecycleOutcomeLine } from '../src/mind/action/respond/lifecycleOutcomeLine.js';
import type { LifecycleOutcomeReport } from '../src/wiring/lifecycleOutcomeTellingWiring.js';
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

describe('the result of a start that made a new world, on its Ops command', () => {
  const OLD_TABLE = `CREATE TABLE ops_commands (
    command_id TEXT NOT NULL PRIMARY KEY, scope_key TEXT NOT NULL, idempotency_key TEXT NOT NULL, type TEXT NOT NULL, target TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'done', 'failed', 'refused', 'expired')), created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL, claimed_at TEXT, report_by TEXT, finished_at TEXT, code TEXT, requested_by_device_id TEXT NOT NULL,
    UNIQUE (scope_key, idempotency_key))`;
  const T0 = '2026-10-19T00:00:00.000Z', T1 = '2026-10-19T00:01:00.000Z';
  function claimed(database: DatabaseSync, key: string) {
    const store = new OpsCommandStore(database);
    const created = store.create('owner', { idempotencyKey: key, type: 'service.start', target: 'twitter' }, 'desktop-1', T0);
    if (typeof created === 'string') throw new Error(created);
    store.claim('owner', T0);
    return { store, id: created.command.id };
  }
  it('adds its column to a table made before it, and keeps old rows as they were', () => {
    const database = new DatabaseSync(':memory:'); close.push(() => database.close());
    database.exec(OLD_TABLE);
    database.prepare("INSERT INTO ops_commands VALUES ('old','owner','k-old-0001','service.start','twitter','done',?,?,?,NULL,?,NULL,'desktop-1')").run(T0, T0, T0, T0);
    const store = new OpsCommandStore(database);
    expect(database.prepare('PRAGMA table_info(ops_commands)').all().some(row => row.name === 'fresh_world_json')).toBe(true);
    expect(store.recent('owner', T1).map(command => ({ id: command.id, status: command.status }))).toEqual([{ id: 'old', status: 'done' }]);
    expect(store.recent('owner', T1)[0]).not.toHaveProperty('freshWorld');
    new OpsCommandStore(database); // a second start finds the column and adds nothing
  });
  it('stores where the old world is kept for a done command only, and shows nothing otherwise', () => {
    const database = new DatabaseSync(':memory:'); close.push(() => database.close());
    const { store, id } = claimed(database, 'k-fresh-0001');
    expect(store.reportLifecycle('owner', id, 'done', undefined, T1, { movedTo: 'shannon_home.before-regen-20261019T1204' })).toMatchObject({ status: 'done' });
    expect(store.recent('owner', T1)[0]).toMatchObject({ id, status: 'done', freshWorld: { movedTo: 'shannon_home.before-regen-20261019T1204' } });
    // No previous world: the key is there with null.
    const none = claimed(new DatabaseSync(':memory:'), 'k-fresh-0002');
    none.store.reportLifecycle('owner', none.id, 'done', undefined, T1, { movedTo: null });
    expect(none.store.recent('owner', T1)[0]!.freshWorld).toEqual({ movedTo: null });
    // A failed or refused command never says a new world was made, whatever was passed.
    const failed = claimed(new DatabaseSync(':memory:'), 'k-fresh-0003');
    failed.store.reportLifecycle('owner', failed.id, 'failed', 'error', T1, { movedTo: 'x' });
    expect(failed.store.recent('owner', T1)[0]).not.toHaveProperty('freshWorld');
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
    expect(h.recorded).toEqual([{ scopeKey: 'owner', setting: 'freshWorld', value: true, at: '2026-10-19T03:00:00.000Z', deviceId: 'desktop-1' }]);
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
  const all: FreshWorldFacts = { action: 'start', serverId: SERVER, origin: 'owner_request', via: 'ops', existing: null, switchedOn: true, keepWorld: false,
    state: { running: 'stopped' }, bodySupports: true, bodyTasksOpen: false, unresolved: false };
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
      ['the operator keeps the world (--keep-world)', { keepWorld: true }, 'keep_world'],
      ['no fresh state', { state: undefined }, 'server_not_stopped'],
      ['server running', { state: { running: 'running' } }, 'server_not_stopped'],
      ['server unknown', { state: { running: 'unknown' } }, 'server_not_stopped'],
      ['a body that does not advertise the capability', { bodySupports: false }, 'unsupported'],
      ['an open task', { bodyTasksOpen: true }, 'tasks_open'],
      ['tasks cannot be read', { bodyTasksOpen: null }, 'tasks_unknown'],
      ['an unresolved lifecycle command', { unresolved: true }, 'unresolved_operation'],
    ];
    for (const [name, patch, reason] of cases) expect(decide(patch), name).toEqual({ reason });
  });

  it('puts the switch before the operator\'s opt-out, and says "unsupported" only for a start that would otherwise have been applied', () => {
    // With the switch off nothing is recorded, whatever else is true.
    expect(decide({ switchedOn: false, keepWorld: true, bodySupports: false })).toEqual({ reason: 'switch_off' });
    expect(decide({ keepWorld: true, bodySupports: false, state: { running: 'running' } })).toEqual({ reason: 'keep_world' });
    expect(decide({ bodySupports: false, bodyTasksOpen: true })).toEqual({ reason: 'unsupported' });
  });

  it('never decides again for a command that exists: it keeps what it was issued with', () => {
    expect(decide({ existing: {} })).toEqual({ reason: 'existing_command' });
    expect(decide({ existing: { options: { freshWorld: true } } })).toEqual({ reason: 'existing_command', options: { freshWorld: true } });
    expect(decide({ existing: {}, switchedOn: true })).not.toHaveProperty('options');
  });
});

describe('the shared admission', () => {
  function admission(patch: { on?: boolean; running?: 'stopped' | 'running'; tasks?: boolean | null; unresolved?: boolean; existing?: { options?: { freshWorld?: true } } | null;
    record?: (record: FreshWorldRecord) => void; policy?: null; status?: () => never; supports?: boolean } = {}) {
    const records: FreshWorldRecord[] = [];
    const decide = createFreshWorldAdmission({
      scopeKey: 'owner', policy: patch.policy === null ? null : { freshWorld: () => patch.on ?? true },
      status: patch.status ?? ((): readonly MinecraftLifecycleState[] => [{ serverId: SERVER, observedAt: 'x', running: patch.running ?? 'stopped', bot: 'absent', otherPlayers: 0 }]),
      supports: () => patch.supports ?? true,
      command: () => (patch.existing === undefined ? null : patch.existing), unresolved: () => patch.unresolved ?? false,
      bodyTasksOpen: () => patch.tasks === undefined ? false : patch.tasks, now: () => '2026-10-19T00:00:00.000Z',
      record: patch.record ?? (record => { records.push(record); }),
    });
    return { decide, records };
  }
  const request = { id: 'ops-lifecycle:one', serverId: SERVER, action: 'start' as const, origin: 'owner_request' as const, via: 'ops' as const };

  it('answers the options and records nothing yet: an applied decision is written when the command is stored', () => {
    const { decide, records } = admission();
    expect(decide(request)).toEqual({ freshWorld: true });
    expect(records).toEqual([]);
  });

  it('records why a body that cannot do it, or an operator\'s --keep-world, kept the world', () => {
    const old = admission({ supports: false });
    expect(old.decide(request)).toBeUndefined();
    expect(old.records).toMatchObject([{ applied: false, reason: 'unsupported', via: 'ops' }]);
    expect(freshWorldSummary(old.records[0]!)).toBe('「新しいワールドで始める」はオンですが、マイクラの体がまだ新しいワールドに対応していないので、今のワールドのまま始めます。');
    const keep = admission();
    expect(keep.decide({ ...request, via: 'operator', keepWorld: true })).toBeUndefined();
    expect(keep.records).toMatchObject([{ applied: false, reason: 'keep_world', via: 'operator' }]);
    expect(admission({ on: false }).decide({ ...request, keepWorld: true })).toBeUndefined();
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

  it('is "no" on any doubt: no policy, an unreadable status, or no way to record', () => {
    expect(admission({ policy: null }).decide(request)).toBeUndefined();
    expect(admission({ status: () => { throw new Error('unreadable'); } }).decide(request)).toBeUndefined();
    // A kept-world line that cannot be written changes nothing about the (ordinary) start.
    expect(admission({ record: () => { throw new Error('activity unavailable'); }, running: 'running' }).decide(request)).toBeUndefined();
    const withoutRecord = createFreshWorldAdmission({ scopeKey: 'owner', policy: { freshWorld: () => true }, status: () => [{ serverId: SERVER, observedAt: 'x',
      running: 'stopped', bot: 'absent', otherPlayers: 0 }], supports: () => true, command: () => null, unresolved: () => false, bodyTasksOpen: () => false, now: () => 'x' });
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

describe('the poll capabilities and the receipt fields', () => {
  const state = (at: string) => ({ serverId: SERVER, observedAt: at, running: 'running', bot: 'absent', otherPlayers: 0 });
  it('accepts a poll with or without capabilities, and counts only well-formed names', () => {
    const at = new Date().toISOString(), now = Date.parse(at);
    const poll = (patch: object = {}) => ({ schemaVersion: 1, connectionId: 'c', sequence: 0, states: [state(at)], receipts: [], ...patch });
    expect(validLifecyclePoll(poll(), now)).toBe(true);
    expect(validLifecyclePoll(poll({ capabilities: ['freshWorld'] }), now)).toBe(true);
    // An odd list is not a reason to lose the channel (the old API ignores the key; this one ignores what it cannot read).
    expect(validLifecyclePoll(poll({ capabilities: [1, 'has space', 'freshWorld'] }), now)).toBe(true);
    for (const bad of ['freshWorld', {}, null, Array.from({ length: 65 }, (_, i) => `c${i}`)]) expect(validLifecyclePoll(poll({ capabilities: bad }), now), JSON.stringify(bad)).toBe(false);
    expect([...lifecycleCapabilities({ capabilities: [1 as never, 'has space', 'freshWorld', 'x_y'] })]).toEqual(['freshWorld']);
    expect([...lifecycleCapabilities(undefined)]).toEqual([]);
  });
  it('validates worldId and movedTo on a receipt, and accepts a receipt without them', () => {
    const at = new Date().toISOString(), now = Date.parse(at);
    const receipt = { id: 'a', connectionId: 'c', serverId: SERVER, action: 'start', outcome: 'completed', code: 'changed', observedAt: at, inputsReleased: true, state: state(at) };
    const poll = (patch: object = {}) => ({ schemaVersion: 1, connectionId: 'c', sequence: 0, states: [state(at)], receipts: [{ ...receipt, ...patch }] });
    expect(validLifecyclePoll(poll(), now)).toBe(true);
    expect(validLifecyclePoll(poll({ worldId: 'shannon-home-20261019T1204', movedTo: 'shannon_home.before-regen-20261019T1204' }), now)).toBe(true);
    expect(validLifecyclePoll(poll({ worldId: 'shannon-home-20261019T1204', movedTo: null }), now)).toBe(true);
    for (const bad of [{ worldId: 5 }, { worldId: '../x' }, { worldId: '' }, { movedTo: 5 }, { movedTo: '../x' }, { movedTo: 'a/b' }, { movedTo: '' }]) {
      expect(validLifecyclePoll(poll(bad), now), JSON.stringify(bad)).toBe(false);
    }
  });
  it('drops a malformed worldId or movedTo from one receipt and keeps the receipt, so the poll itself stays valid', () => {
    const at = new Date().toISOString(), now = Date.parse(at);
    const receipt = (id: string, patch: object = {}) => ({ id, connectionId: 'c', serverId: SERVER, action: 'start', outcome: 'completed', code: 'changed', observedAt: at, inputsReleased: true, state: state(at), ...patch });
    const poll = (...receipts: object[]) => ({ schemaVersion: 1, connectionId: 'c', sequence: 0, states: [state(at)], receipts });
    // Strictly: a bad value still makes `validLifecyclePoll` say no, which is why the poll is cleaned first.
    expect(validLifecyclePoll(poll(receipt('a', { movedTo: '../x' })), now)).toBe(false);
    const cleaned = withoutMalformedReceiptWorlds(poll(receipt('a', { worldId: 'w-1', movedTo: '../x' }), receipt('b', { worldId: 'bad id!', movedTo: 'ok 1' }),
      receipt('c', { worldId: 5, movedTo: 5 }), receipt('d', { worldId: 'w-2', movedTo: null }), receipt('e')));
    expect(validLifecyclePoll(cleaned.poll, now)).toBe(true);
    const receipts = (cleaned.poll as { receipts: Array<Record<string, unknown>> }).receipts;
    expect(receipts.map(r => r.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    // Only the bad field is dropped; a good one next to it stays, and a good receipt is untouched.
    expect(receipts[0]).toMatchObject({ worldId: 'w-1' }); expect(receipts[0]).not.toHaveProperty('movedTo');
    expect(receipts[1]).toMatchObject({ movedTo: 'ok 1' }); expect(receipts[1]).not.toHaveProperty('worldId');
    expect(receipts[2]).not.toHaveProperty('worldId'); expect(receipts[2]).not.toHaveProperty('movedTo');
    expect(receipts[3]).toMatchObject({ worldId: 'w-2', movedTo: null });
    expect([...cleaned.dropped].sort()).toEqual(['a', 'b', 'c']);
    // A clean poll comes back as the very same object; things that are not polls are left for validLifecyclePoll to refuse.
    const clean = poll(receipt('a', { worldId: 'w', movedTo: 'old' }));
    expect(withoutMalformedReceiptWorlds(clean)).toEqual({ poll: clean, dropped: new Set() }); expect(withoutMalformedReceiptWorlds(clean).poll).toBe(clean);
    for (const odd of [null, 'x', 5, [], {}, { receipts: 'no' }, { receipts: Array.from({ length: 17 }, () => receipt('z', { worldId: '../x' })) }]) {
      expect(withoutMalformedReceiptWorlds(odd).poll, JSON.stringify(odd)?.slice(0, 40)).toBe(odd);
      expect(validLifecyclePoll(withoutMalformedReceiptWorlds(odd).poll, now)).toBe(false);
    }
  });
  it('tells a new world from the accepted receipt only, and only for a command that asked for one', () => {
    const base = { action: 'start' as const, outcome: 'completed' as const };
    const asked = { options: { freshWorld: true as const } };
    expect(freshWorldOfReceipt({ ...base, worldId: 'w', movedTo: 'old' }, asked)).toEqual({ worldId: 'w', movedTo: 'old' });
    expect(freshWorldOfReceipt({ ...base, worldId: 'w' }, asked)).toEqual({ worldId: 'w', movedTo: null });
    expect(freshWorldOfReceipt({ ...base }, asked)).toBeUndefined();
    expect(freshWorldOfReceipt({ ...base, outcome: 'unknown', worldId: 'w', movedTo: 'old' }, asked)).toBeUndefined();
    expect(freshWorldOfReceipt({ ...base, action: 'login', worldId: 'w', movedTo: 'old' }, asked)).toBeUndefined();
    expect(freshWorldOfReceipt(null, asked)).toBeUndefined();
    // A receipt that names a world for a command that did not ask for one (an ordinary start; the option was dropped) claims nothing.
    for (const command of [{}, { options: {} }, null, undefined]) expect(freshWorldOfReceipt({ ...base, worldId: 'w', movedTo: 'old' }, command as never), JSON.stringify(command)).toBeUndefined();
  });
  it('tells a world that moved while the start could not be confirmed, from an unknown receipt that names it', () => {
    const asked = { options: { freshWorld: true as const } };
    const unknown = { action: 'start' as const, outcome: 'unknown' as const };
    expect(preparedWorldOfReceipt({ ...unknown, worldId: 'w', movedTo: 'old' }, asked)).toEqual({ worldId: 'w', movedTo: 'old', started: false });
    expect(preparedWorldOfReceipt({ ...unknown, worldId: 'w', movedTo: null }, asked)).toEqual({ worldId: 'w', movedTo: null, started: false });
    // The ids that survived a malformed sibling are enough: a moved name alone still says the world moved.
    expect(preparedWorldOfReceipt({ ...unknown, movedTo: 'old' }, asked)).toEqual({ movedTo: 'old', started: false });
    // A value left out is not "there was no old world": the key is absent, not null.
    expect(preparedWorldOfReceipt({ ...unknown, worldId: 'w' }, asked)).toEqual({ worldId: 'w', started: false });
    expect(preparedWorldOfReceipt({ ...unknown }, asked)).toBeUndefined();
    expect(preparedWorldOfReceipt({ ...unknown, outcome: 'refused', worldId: 'w' }, asked)).toBeUndefined();
    expect(preparedWorldOfReceipt({ ...unknown, outcome: 'cancelled', worldId: 'w' }, asked)).toBeUndefined();
    expect(preparedWorldOfReceipt({ ...unknown, worldId: 'w', movedTo: 'old' }, {})).toBeUndefined();
    expect(freshWorldReportOf({ ...unknown, worldId: 'w', movedTo: 'old' }, asked)).toEqual({ movedTo: 'old', started: false });
    expect(freshWorldReportOf({ ...unknown, outcome: 'completed', worldId: 'w', movedTo: 'old' }, asked)).toEqual({ movedTo: 'old' });
    // A settlement reads the accepted receipt first, else the unconfirmed one.
    const receipt = { id: 'a', connectionId: 'c', serverId: SERVER, action: 'start', outcome: 'unknown', code: 'error', observedAt: 'x', inputsReleased: false, worldId: 'w', movedTo: 'old' } as never;
    expect(freshWorldOfSettlement({ receipt: null, unconfirmed: receipt, command: asked as never })).toEqual({ movedTo: 'old', started: false });
    expect(freshWorldOfSettlement({ receipt: null, unconfirmed: receipt, command: null })).toBeUndefined();
    expect(freshWorldOfSettlement({ receipt: null })).toBeUndefined();
  });
  it('words the outcome line with where the old world is kept, and leaves the parenthesis out when there was none', () => {
    const line = (freshWorld?: { movedTo: string | null }, patch: object = {}) => neutralLifecycleOutcomeLine({ action: 'start', outcome: 'completed', others: false, ...(freshWorld ? { freshWorld } : {}), ...patch });
    expect(line()).toBe('マイクラのサーバーを起動しました。');
    expect(line({ movedTo: 'shannon_home.before-regen-20261019T1204' })).toBe(
      'マイクラのサーバーを起動しました。新しいワールドで始めました（前のワールドは shannon_home.before-regen-20261019T1204 として残しています）。');
    expect(line({ movedTo: null })).toBe('マイクラのサーバーを起動しました。新しいワールドで始めました。');
    // Never beside anyone else, and never for another action or end.
    expect(line({ movedTo: 'x' }, { others: true })).toBe('頼まれていた作業の結果が出ました（内容はアプリで確認できます）。');
    expect(line({ movedTo: 'x' }, { outcome: 'refused' })).toBe('マイクラのサーバーの起動は、体に断られてできませんでした。');
    expect(line({ movedTo: 'x' }, { action: 'login' })).toBe('マイクラにログインしました。');
  });
  it('words a start whose world moved but could not be confirmed: the new world was prepared, the old one is kept, the start is unknown', () => {
    const line = (freshWorld?: { movedTo: string | null; started?: false }, patch: object = {}) =>
      neutralLifecycleOutcomeLine({ action: 'start', outcome: 'unknown', others: false, ...(freshWorld ? { freshWorld } : {}), ...patch });
    expect(line()).toBe('マイクラのサーバーの起動は、結果を確かめられませんでした。');
    expect(line({ movedTo: 'shannon_home.before-regen-20261019T1204', started: false })).toBe(
      '新しいワールドを用意しましたが、起動を確かめられませんでした（前のワールドは shannon_home.before-regen-20261019T1204 として残しています）。');
    expect(line({ movedTo: null, started: false })).toBe('新しいワールドを用意しましたが、起動を確かめられませんでした。サーバーの状態を確かめてください。');
    // Never beside anyone else, never for another end or action, and a started world is not worded as unconfirmed.
    expect(line({ movedTo: 'x', started: false }, { others: true })).toBe('頼まれていた作業の結果が出ました（内容はアプリで確認できます）。');
    expect(line({ movedTo: 'x', started: false }, { action: 'login' })).toBe('マイクラのログインは、結果を確かめられませんでした。');
    expect(line({ movedTo: 'x', started: false }, { outcome: 'refused' })).toBe('マイクラのサーバーの起動は、体に断られてできませんでした。');
    expect(line({ movedTo: 'x' })).toBe('マイクラのサーバーの起動は、結果を確かめられませんでした。');
    expect(neutralLifecycleOutcomeLine({ action: 'start', outcome: 'completed', others: false, freshWorld: { movedTo: 'x', started: false } })).toBe('マイクラのサーバーを起動しました。');
    expect(freshWorldResultSummary({ result: 'moved_unconfirmed', movedTo: 'old' })).toBe('新しいワールドを用意しましたが、起動を確かめられませんでした（前のワールドは old として残しています）。');
  });
  it('words the activity lines with the old world kept, never deleted', () => {
    expect(freshWorldSummary({ applied: true, reason: 'applied', via: 'ops' })).toBe('ライ氏の運用ページからの開始の頼みで、「新しいワールドで始める」を体に伝えました（今のワールドは別の名前で残り、消えません）。');
    expect(freshWorldResultSummary({ result: 'started', movedTo: 'old' })).toBe('新しいワールドで始めました（前のワールドは old として残しています）。');
    for (const reason of FRESH_WORLD_REASONS) expect(freshWorldSummary({ applied: reason === 'applied', reason, via: 'conversation' }), reason).not.toMatch(/消えます|削除|元に戻せ/u);
    expect(freshWorldViaOfOperation(`lifecycle:${'a'.repeat(64)}`)).toBe('conversation');
    expect(freshWorldViaOfOperation(`ops-lifecycle:${randomUUID()}`)).toBe('ops');
    expect(freshWorldViaOfOperation(`operator:${randomUUID()}`)).toBe('operator');
    for (const other of ['lifecycle:abc', 'x', 'operator:abc', `ops:${randomUUID()}`, '']) expect(freshWorldViaOfOperation(other), other).toBeNull();
  });
});

describe('the lifecycle service and the new-world command', () => {
  const at = '2026-10-19T00:00:00.000Z';
  const OPS = () => `ops-lifecycle:${randomUUID()}`;
  function service(hooks: Parameters<typeof freshWorldIssuance>[0] | 'none' = undefined) {
    const database = new DatabaseSync(':memory:'); close.push(() => database.close());
    const configuration = configuredMinecraftBody(environment)!;
    const records: Array<{ reasonCode?: string; detail?: string }> = [];
    const ports = hooks === 'none' ? undefined : hooks ?? { policy: { freshWorld: () => true }, activity: { append: ((...args: unknown[]) => { records.push(args[3] as never); }) as never },
      config: { timeZone: 'Asia/Tokyo' } as never, bodyTasksOpen: () => false };
    let nowMs = Date.parse(at);
    const lifecycle = new MinecraftLifecycle(new MinecraftLifecycleStore(database), configuration, { now: () => nowMs, allowed: () => true,
      servers: new Set([SERVER]), pollMilliseconds: 1, cancelWaitMilliseconds: 5, freshWorld: freshWorldIssuance(ports, { scopeKey: 'owner', now: () => at }) });
    let sequence = 0;
    const body: { capabilities: unknown } = { capabilities: ['freshWorld'] };
    const poll = (receipts: unknown[] = []) => lifecycle.poll({ scopeKey: 'owner', deviceId: 'operator' },
      { schemaVersion: 1, connectionId: 'connection', sequence: sequence++, receipts, ...(body.capabilities === undefined ? {} : { capabilities: body.capabilities }),
        states: [{ serverId: SERVER, observedAt: new Date(nowMs).toISOString(), running: 'stopped', bot: 'absent', otherPlayers: 0 }] });
    /** Time moves on (the clock the service reads), as it does between a receipt and the one that later replaces it. */
    const advance = (milliseconds: number) => { nowMs += milliseconds; return new Date(nowMs).toISOString(); };
    const authority = { scopeKey: 'owner', origin: 'owner_request' as const, executionId: 'execution', lease: { id: 'execution', holder: 'h', generation: 1 }, sourceIds: ['s'] };
    const receiptFor = (command: MinecraftLifecycleCommand, patch: object = {}): MinecraftLifecycleReceipt => ({ id: command.id, connectionId: command.connectionId, serverId: SERVER,
      action: 'start', outcome: 'completed', code: 'changed', observedAt: at, inputsReleased: true,
      state: { serverId: SERVER, observedAt: at, running: 'running', bot: 'absent', otherPlayers: 0 }, ...patch } as MinecraftLifecycleReceipt);
    /** One start from request to accepted receipt, as the operator would have it: stored, delivered, then settled. */
    const start = async (id: string, options?: { freshWorld: true }, patch?: object) => {
      const done = lifecycle.execute({ id, serverId: SERVER, action: 'start', authority, ...(options ? { options } : {}) }).catch(() => undefined);
      await until(() => lifecycle.store.command(id) !== null);
      const command = lifecycle.store.command(id)!;
      poll();
      poll([receiptFor(command, patch)]);
      await done;
      return command;
    };
    return { lifecycle, poll, start, records, body, receiptFor, advance };
  }

  it('knows what the connected body can do from its latest fresh frame only', () => {
    const f = service();
    expect(f.lifecycle.supports('owner', 'freshWorld')).toBe(false); // no frame yet
    f.body.capabilities = undefined; f.poll(); expect(f.lifecycle.supports('owner', 'freshWorld')).toBe(false); // a body that predates the field
    f.body.capabilities = ['freshWorld']; f.poll(); expect(f.lifecycle.supports('owner', 'freshWorld')).toBe(true);
    expect(f.lifecycle.supports('someone-else', 'freshWorld')).toBe(false);
    f.body.capabilities = ['somethingElse']; f.poll(); expect(f.lifecycle.supports('owner', 'freshWorld')).toBe(false); // an older build took over
  });

  it('stores the option and records the decision only when the connected body says it can, and drops it otherwise', async () => {
    const f = service();
    f.poll();
    const withOption = await f.start(OPS(), { freshWorld: true });
    expect(withOption.options).toEqual({ freshWorld: true });
    expect(f.records.map(r => r.reasonCode)).toContain('fresh_world_applied');
    // The body no longer advertises it by the time the command is stored: an ordinary start, nothing claimed.
    const g = service(); g.body.capabilities = ['somethingElse']; g.poll();
    const dropped = await g.start(OPS(), { freshWorld: true });
    expect('options' in dropped).toBe(false); expect(g.records).toEqual([]);
  });

  it('sends an ordinary start when the decision cannot be written down, and without ports', async () => {
    const failing = service({ policy: { freshWorld: () => true }, activity: { append: (() => { throw new Error('activity unavailable'); }) as never }, config: { timeZone: 'Asia/Tokyo' } as never, bodyTasksOpen: () => false });
    failing.poll();
    expect('options' in await failing.start(OPS(), { freshWorld: true })).toBe(false);
    const bare = service('none'); bare.poll();
    expect('options' in await bare.start(OPS(), { freshWorld: true })).toBe(false);
    // An operation id that is not one of the three ways of asking never carries it.
    const other = service(); other.poll();
    expect('options' in await other.start('agent-task:step', { freshWorld: true })).toBe(false); expect(other.records).toEqual([]);
  });

  it('records the result when the receipt is accepted: the new world and where the old one is kept', async () => {
    const f = service(); f.poll();
    const id = OPS();
    await f.start(id, { freshWorld: true }, { worldId: 'shannon-home-20261019T1204', movedTo: 'shannon_home.before-regen-20261019T1204' });
    expect(f.records.map(r => r.reasonCode)).toEqual(['fresh_world_applied', 'fresh_world_started']);
    expect(f.records[1]!.detail).toBe(`operation=${id} server=${SERVER} via=ops world=shannon-home-20261019T1204 movedTo=shannon_home.before-regen-20261019T1204`);
    // A refused one says nothing was changed.
    const h = service(); h.poll();
    await h.start(OPS(), { freshWorld: true }, { outcome: 'refused', code: 'error', state: { serverId: SERVER, observedAt: at, running: 'stopped', bot: 'absent', otherPlayers: 0 } });
    expect(h.records.map(r => r.reasonCode)).toEqual(['fresh_world_applied', 'fresh_world_refused']);
    // A start that did not ask for a new world records nothing, even when its receipt names none.
    const plain = service(); plain.poll(); await plain.start(OPS());
    expect(plain.records).toEqual([]);
  });

  it('records the result once: the same receipt sent again (a lost acknowledgement, a restarted operator) is only acknowledged again', async () => {
    const f = service(); f.poll();
    const id = OPS(), world = { worldId: 'shannon-home-20261019T1204', movedTo: 'shannon_home.before-regen-20261019T1204' };
    const command = await f.start(id, { freshWorld: true }, world);
    expect(f.records.map(r => r.reasonCode)).toEqual(['fresh_world_applied', 'fresh_world_started']);
    const again = f.receiptFor(command, world);
    for (let index = 0; index < 3; index += 1) expect(f.poll([again]).acknowledged, String(index)).toEqual([id]);
    // Several receipts in one poll, the same one twice, count once too.
    expect(f.poll([again, again]).acknowledged).toEqual([id, id]);
    expect(f.records.map(r => r.reasonCode)).toEqual(['fresh_world_applied', 'fresh_world_started']);
    expect(f.lifecycle.store.receipt(id)).toMatchObject({ outcome: 'completed', ...world });
  });

  it('records a world that moved while the start could not be confirmed, with both names; the confirmed start is recorded once, later', async () => {
    const f = service(); f.poll();
    const id = OPS(), world = { worldId: 'shannon-home-20261019T1204', movedTo: 'shannon_home.before-regen-20261019T1204' };
    const command = await f.start(id, { freshWorld: true }, { outcome: 'unknown', code: 'error', inputsReleased: false, ...world,
      state: { serverId: SERVER, observedAt: at, running: 'unknown', bot: 'unknown', otherPlayers: null } });
    expect(f.records.map(r => r.reasonCode)).toEqual(['fresh_world_applied', 'fresh_world_moved_unconfirmed']);
    expect(f.records[1]).toMatchObject({ outcome: 'recorded', summary: '新しいワールドを用意しましたが、起動を確かめられませんでした（前のワールドは shannon_home.before-regen-20261019T1204 として残しています）。',
      detail: `operation=${id} server=${SERVER} via=ops world=shannon-home-20261019T1204 movedTo=shannon_home.before-regen-20261019T1204` });
    // The same unknown receipt sent again records nothing more.
    f.poll([f.receiptFor(command, { outcome: 'unknown', code: 'error', inputsReleased: false, ...world, state: { serverId: SERVER, observedAt: at, running: 'unknown', bot: 'unknown', otherPlayers: null } })]);
    expect(f.records).toHaveLength(2);
    // The operator later proves the original start completed: that replaces the unknown receipt and is recorded once.
    const later = f.advance(2000), confirmed = f.receiptFor(command, { observedAt: later, ...world });
    expect(f.poll([confirmed]).acknowledged).toEqual([id]); f.poll([confirmed]);
    expect(f.records.map(r => r.reasonCode)).toEqual(['fresh_world_applied', 'fresh_world_moved_unconfirmed', 'fresh_world_started']);
    // And the older unknown receipt arriving again changes nothing and is not told again.
    f.poll([f.receiptFor(command, { outcome: 'unknown', code: 'error', inputsReleased: false, ...world, state: { serverId: SERVER, observedAt: at, running: 'unknown', bot: 'unknown', otherPlayers: null } })]);
    expect(f.records).toHaveLength(3); expect(f.lifecycle.store.receipt(id)?.outcome).toBe('completed');
  });

  it('keeps a receipt whose world name is malformed: the poll stands, the bad value is left out, and a warning without the value is recorded once', async () => {
    const f = service(); f.poll();
    const id = OPS(), good = 'shannon-home-20261019T1204';
    const command = await f.start(id, { freshWorld: true }, { worldId: good, movedTo: '../escape/old' });
    expect(f.lifecycle.store.receipt(id)).toMatchObject({ outcome: 'completed', worldId: good }); expect(f.lifecycle.store.receipt(id)).not.toHaveProperty('movedTo');
    expect(f.records.map(r => r.reasonCode)).toEqual(['fresh_world_applied', 'fresh_world_started', 'fresh_world_receipt_world_dropped']);
    expect(f.records[2]).toMatchObject({ outcome: 'recorded', detail: `operation=${id} server=${SERVER} via=ops` });
    // The result does not say there was no old world: the name was left out, not absent.
    expect(f.records[1]).toMatchObject({ outcome: 'done', detail: `operation=${id} server=${SERVER} via=ops world=${good} movedTo=unknown`,
      summary: expect.stringContaining('前のワールドの名前は確かめられませんでした') });
    expect(JSON.stringify(f.records)).not.toContain('escape');
    // Sent again with the bad value: acknowledged, and neither told nor warned a second time.
    expect(f.poll([f.receiptFor(command, { worldId: good, movedTo: '../escape/old' })]).acknowledged).toEqual([id]);
    expect(f.records).toHaveLength(3);
    // A bad name on a receipt nobody asked for does not stop the channel either (it is just not adopted).
    expect(() => f.poll([f.receiptFor({ ...command, id: 'ops-lifecycle:unknown-command' }, { worldId: '../x' })])).not.toThrow();
    expect(f.poll([f.receiptFor({ ...command, id: 'ops-lifecycle:unknown-command' }, { worldId: '../x' })]).acknowledged).toEqual([]);
    // What is not a receipt list is still refused.
    expect(() => f.lifecycle.poll({ scopeKey: 'owner', deviceId: 'operator' }, { schemaVersion: 1, connectionId: 'connection', sequence: 99, receipts: 'no', states: [] })).toThrow('MINECRAFT_LIFECYCLE_POLL_INVALID');
  });

  it('writes a compensating line when a command that was recorded as applied could not be stored', () => {
    const records: string[] = [];
    const hooks = freshWorldIssuance({ policy: { freshWorld: () => true }, activity: { append: ((...args: unknown[]) => { records.push((args[3] as { reasonCode: string }).reasonCode); }) as never },
      config: { timeZone: 'Asia/Tokyo' } as never, bodyTasksOpen: () => false }, { scopeKey: 'owner', now: () => at })!;
    const command = { id: OPS(), serverId: SERVER, action: 'start' } as MinecraftLifecycleCommand;
    expect(hooks.issue(command)).toBe(true); hooks.aborted(command);
    expect(records).toEqual(['fresh_world_applied', 'fresh_world_not_issued']);
    expect(freshWorldResultSummary({ result: 'not_issued' })).toContain('今のワールドのまま');
  });
});

describe('the lifecycle command, from each way of asking', () => {
  function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'fresh-world-')), path = join(directory, 'store.sqlite');
    close.push(() => rmSync(directory, { recursive: true, force: true }));
    let at = '2026-10-19T00:00:00.000Z', sequence = 0, alone = true, running: 'running' | 'stopped' | 'unknown' = 'stopped';
    let tasksOpen: boolean | null = false, recordFails = false, taskAllowed = true, advertise = true;
    const reports: LifecycleOutcomeReport[] = [];
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
      told: async report => { reports.push(report); },
      freshWorld: { policy: opsStore.worldPolicy, activity, config, bodyTasksOpen: () => tasksOpen } })!;
    close.push(async () => { const ticking = setInterval(() => { at = new Date(Date.parse(at) + 1000).toISOString(); }, 20);
      try { await configured.close(); } finally { clearInterval(ticking); } });
    const principal = { scopeKey: 'owner', deviceId: 'operator' };
    const state = (patch: Partial<MinecraftLifecycleState> = {}): MinecraftLifecycleState => ({ serverId: SERVER, observedAt: at, running, bot: 'absent', otherPlayers: 0, ...patch });
    const poll = (receipts: MinecraftLifecycleReceipt[] = []) => configured.service.poll(principal,
      { schemaVersion: 1, connectionId: 'operator-connection', sequence: sequence++, states: [state()], receipts, ...(advertise ? { capabilities: ['freshWorld'] } : {}) });
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
    const receipt = (command: MinecraftLifecycleCommand, extra: object = {}): MinecraftLifecycleReceipt => ({ id: command.id, connectionId: command.connectionId, serverId: command.serverId,
      action: command.action, outcome: 'completed', code: 'changed', observedAt: at, inputsReleased: true,
      state: state({ running: command.action === 'stop' ? 'stopped' : 'running', bot: command.action === 'login' ? 'joined' : 'absent' }),
      ...(command.action === 'stop' ? { stopGuard: { admissionClosed: true as const, otherPlayers: 0 as const, checkedAt: at } } : {}),
      // A body that made the new world says so in its receipt (pass worldId: undefined to leave it out).
      ...(command.options?.freshWorld ? { worldId: 'shannon-home-20261019T1204', movedTo: 'shannon_home.before-regen-20261019T1204' } : {}), ...extra });
    /** The one command the operator receives next; the native acknowledgement (with `extra` fields, e.g. the new world) then ends it. */
    const issued = async (extra: object = {}): Promise<MinecraftLifecycleCommand> => {
      await until(() => configured.service.store.pending().length === 1);
      const command = poll().commands[0]!;
      expect(poll([receipt(command, extra)]).acknowledged).toEqual([command.id]);
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
    const operatorStart = async (action: 'start' | 'login', keepWorld = false) => {
      const id = `operator:${randomUUID()}`;
      audit.append({ operationId: id, scopeKey: 'owner', at, operator: 'ops', command: 'lifecycle', event: 'invoked', code: 'invoked', argsJson: '{}', action, serverId: SERVER });
      const settled: unknown[] = [];
      const admission = await configured.operator.execute({ id, serverId: SERVER, action, ...(keepWorld ? { keepWorld: true } : {}) }, value => settled.push(value));
      return { id, admission, settled };
    };
    const records = () => autonomyStore.activity.days('owner', { sinceDayKey: '' }).flatMap(day => day.entries).filter(entry => entry.tool === 'minecraft.fresh_world');
    const settings = () => autonomyStore.activity.days('owner', { sinceDayKey: '' }).flatMap(day => day.entries).filter(entry => entry.tool === 'ops.settings.freshWorld');
    return { ...h, opsStore, configured, poll, state, send, setSwitch, issued, converse, step, operatorStart, records, settings, receipt, reports,
      advertise(value: boolean) { advertise = value; poll(); },
      /** Time moves on, as between an unknown receipt and the one that later replaces it. */
      tick(milliseconds: number) { at = new Date(Date.parse(at) + milliseconds).toISOString(); },
      running(value: typeof running) { running = value; poll(); }, tasksOpen(value: boolean | null) { tasksOpen = value; },
      recordFails(value: boolean) { recordFails = value; }, alone(value: boolean) { alone = value; }, taskAllowed(value: boolean) { taskAllowed = value; } };
  }

  describe('Ops minecraft.start', () => {
    it('carries options.freshWorld after the switch was turned on over HTTP, and records the settings change and the decision', async () => {
      const f = fixture();
      expect((await f.setSwitch(true)).body).toEqual({ settings: { freshWorld: true } });
      expect(f.settings().map(entry => entry.reasonCode)).toEqual(['fresh_world_on']);
      // The paired device that made the change is named, and the sentence says the old world is kept, not deleted.
      expect(f.settings()[0]).toMatchObject({ detail: 'device=desktop-1', summary: expect.stringContaining('別の名前で残して') });
      expect(f.settings()[0]!.summary).not.toMatch(/消します|削除/u);
      const sent = await f.send('minecraft.start', SERVER);
      expect(sent.status).toBe(201);
      const command = await f.issued();
      expect(command).toMatchObject({ id: `ops-lifecycle:${sent.body.command.id}`, serverId: SERVER, action: 'start', options: { freshWorld: true } });
      expect(f.configured.service.store.command(command.id)?.options).toEqual({ freshWorld: true });
      const entries = f.records().filter(entry => entry.reasonCode === 'fresh_world_applied');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ reasonCode: 'fresh_world_applied', outcome: 'done', actor: 'owner' });
      expect(f.records().map(entry => entry.reasonCode).sort()).toEqual(['fresh_world_applied', 'fresh_world_started']);
      expect(entries[0]!.detail).toBe(`operation=${command.id} server=${SERVER} via=ops`);
    });

    it('starts normally and records why, without saying a new world was made, when the connected body does not advertise the capability', async () => {
      const f = fixture();
      await f.setSwitch(true); f.advertise(false);
      await f.send('minecraft.start', SERVER);
      const command = await f.issued();
      expect('options' in command).toBe(false);
      expect(f.records().map(entry => entry.reasonCode)).toEqual(['fresh_world_unsupported']);
      expect(f.records()[0]).toMatchObject({ outcome: 'recorded', summary: expect.stringContaining('対応していない') });
      // The finished Ops command carries no new-world result.
      await until(() => f.opsStore.commands.recent('owner', '2999-01-01T00:00:00.000Z')[0]?.status === 'done');
      expect(f.opsStore.commands.recent('owner', '2999-01-01T00:00:00.000Z')[0]).not.toHaveProperty('freshWorld');
      // The same body, once it says it can, gets the option.
      f.advertise(true); f.running('stopped');
      await f.send('minecraft.start', SERVER);
      expect((await f.issued()).options).toEqual({ freshWorld: true });
    });

    it('records the decision when the command is stored and its result when the receipt arrives; the finished Ops command says where the old world is kept', async () => {
      const f = fixture();
      await f.setSwitch(true);
      await f.send('minecraft.start', SERVER);
      const MOVED = 'shannon_home.before-regen-20261019T1204';
      const command = await f.issued({ worldId: 'shannon-home-20261019T1204', movedTo: MOVED });
      expect(f.records().map(entry => entry.reasonCode).sort()).toEqual(['fresh_world_applied', 'fresh_world_started']);
      expect(f.records().find(entry => entry.reasonCode === 'fresh_world_started')).toMatchObject({ outcome: 'done', summary: `新しいワールドで始めました（前のワールドは ${MOVED} として残しています）。` });
      expect(f.records().find(entry => entry.reasonCode === 'fresh_world_started')!.detail).toBe(`operation=${command.id} server=${SERVER} via=ops world=shannon-home-20261019T1204 movedTo=${MOVED}`);
      await until(() => f.opsStore.commands.recent('owner', '2999-01-01T00:00:00.000Z')[0]?.status === 'done');
      const finished = f.opsStore.commands.recent('owner', '2999-01-01T00:00:00.000Z')[0]!;
      expect(finished.freshWorld).toEqual({ movedTo: MOVED });
      expect(JSON.parse(JSON.stringify(finished)).freshWorld).toEqual({ movedTo: MOVED });
    });

    const FAR = '2999-01-01T00:00:00.000Z', MOVED = 'shannon_home.before-regen-20261019T1204';
    const UNKNOWN = { outcome: 'unknown', code: 'error', inputsReleased: false, worldId: 'shannon-home-20261019T1204', movedTo: MOVED };

    it('says on the finished Ops command that the new world was prepared but the start could not be confirmed; a later proof replaces it', async () => {
      const f = fixture();
      await f.setSwitch(true);
      await f.send('minecraft.start', SERVER);
      const command = await f.issued(UNKNOWN);
      await until(() => f.opsStore.commands.recent('owner', FAR)[0]?.status === 'failed');
      expect(f.opsStore.commands.recent('owner', FAR)[0]).toMatchObject({ status: 'failed', code: 'no_report', freshWorld: { movedTo: MOVED, started: false } });
      expect(JSON.parse(JSON.stringify(f.opsStore.commands.recent('owner', FAR)[0])).freshWorld).toEqual({ movedTo: MOVED, started: false });
      expect(f.records().map(entry => entry.reasonCode).sort()).toEqual(['fresh_world_applied', 'fresh_world_moved_unconfirmed']);
      expect(f.records().find(entry => entry.reasonCode === 'fresh_world_moved_unconfirmed')).toMatchObject({ outcome: 'recorded',
        summary: `新しいワールドを用意しましたが、起動を確かめられませんでした（前のワールドは ${MOVED} として残しています）。` });
      // The operator later proves the original start completed: the same command becomes done, and says the world started.
      f.tick(2000);
      expect(f.poll([f.receipt(command)]).acknowledged).toEqual([command.id]);
      f.configured.ops!.wake();
      await until(() => f.opsStore.commands.recent('owner', FAR)[0]?.status === 'done');
      expect(f.opsStore.commands.recent('owner', FAR)[0]!.freshWorld).toEqual({ movedTo: MOVED });
      expect(f.records().map(entry => entry.reasonCode).sort()).toEqual(['fresh_world_applied', 'fresh_world_moved_unconfirmed', 'fresh_world_started']);
    });

    it('does not claim a new world on an Ops start that did not ask for one, whatever its receipt names', async () => {
      const f = fixture();
      await f.setSwitch(true); f.advertise(false);
      await f.send('minecraft.start', SERVER);
      const command = await f.issued({ worldId: 'shannon-home-20261019T1204', movedTo: MOVED });
      expect('options' in command).toBe(false);
      await until(() => f.opsStore.commands.recent('owner', FAR)[0]?.status === 'done');
      expect(f.opsStore.commands.recent('owner', FAR)[0]).not.toHaveProperty('freshWorld');
      expect(f.records().map(entry => entry.reasonCode)).toEqual(['fresh_world_unsupported']);
    });

    it('says nothing of a new world for a finished Ops start whose receipt names none', async () => {
      const f = fixture();
      await f.setSwitch(true);
      await f.send('minecraft.start', SERVER);
      await f.issued({ worldId: undefined, movedTo: undefined });
      await until(() => f.opsStore.commands.recent('owner', '2999-01-01T00:00:00.000Z')[0]?.status === 'done');
      expect(f.opsStore.commands.recent('owner', '2999-01-01T00:00:00.000Z')[0]).not.toHaveProperty('freshWorld');
      expect(f.records().map(entry => entry.reasonCode).sort()).toEqual(['fresh_world_applied', 'fresh_world_unknown']);
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

    it('does not make a new world it could not record: a failing activity record leaves the legacy command', async () => {
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
    it('follows the switch by default, and --keep-world opts out of a new world for that one start', async () => {
      const f = fixture();
      await f.setSwitch(true);
      const kept = await f.operatorStart('start', true);
      expect(kept.admission).toMatchObject({ ok: true });
      const command = await f.issued();
      expect('options' in command).toBe(false);
      expect(f.records().map(entry => entry.reasonCode)).toEqual(['fresh_world_keep_world']);
      expect(f.records()[0]!.detail).toBe(`operation=${kept.id} server=${SERVER} via=operator`);
      // Without the flag the same switch gives a new world.
      f.running('stopped');
      const followed = await f.operatorStart('start');
      expect(followed.admission).toMatchObject({ ok: true });
      expect((await f.issued()).options).toEqual({ freshWorld: true });
    });

    it('knows from the settlement that a new world moved even when its start could not be confirmed', async () => {
      const f = fixture();
      await f.setSwitch(true);
      const started = await f.operatorStart('start');
      await f.issued({ outcome: 'unknown', code: 'error', inputsReleased: false, worldId: 'shannon-home-20261019T1204', movedTo: 'shannon_home.before-regen-20261019T1204' });
      await until(() => started.settled.length === 1);
      const settlement = started.settled[0] as Parameters<typeof freshWorldOfSettlement>[0] & { receipt: unknown; issued: boolean };
      expect(settlement).toMatchObject({ receipt: null, issued: true });
      expect(freshWorldOfSettlement(settlement)).toEqual({ movedTo: 'shannon_home.before-regen-20261019T1204', started: false });
    });

    it('takes --keep-world as a bare flag only: any value, even false, is a usage error and never "not given"', () => {
      const env = { SHANNON_OPERATOR: 'ryo' };
      for (const bad of ['--keep-world=false', '--keep-world=true', '--keep-world=0', '--keep-world=']) {
        expect(() => operatorEnvelope(['minecraft', 'start', bad], env), bad).toThrow('--keep-world takes no value');
      }
      // Separated by a space, the word is a stray word, which a start never takes.
      expect(() => operatorEnvelope(['minecraft', 'start', '--keep-world', 'false'], env)).toThrow('start takes no words');
      expect(() => operatorEnvelope(['minecraft', 'cancel', '--latest=true'], env)).toThrow('--latest takes no value');
      expect(operatorEnvelope(['minecraft', 'start', '--keep-world'], env).args).toEqual({ keepWorld: true });
      expect(operatorEnvelope(['minecraft', 'cancel', '--latest'], env).args).toEqual({ latest: true });
      // A flag that takes a value still takes it either way.
      expect(operatorEnvelope(['minecraft', 'start', '--server=shannon-home'], env).args).toEqual({ serverId: 'shannon-home' });
    });

    it('parses --keep-world for start only, from the command line to the envelope', () => {
      const env = { SHANNON_OPERATOR: 'ryo' };
      expect(operatorEnvelope(['minecraft', 'start', '--server', SERVER, '--keep-world'], env)).toMatchObject({ op: 'start', args: { serverId: SERVER, keepWorld: true } });
      expect(operatorEnvelope(['minecraft', 'start'], env).args).toEqual({});
      expect(() => operatorEnvelope(['minecraft', 'login', '--keep-world'], env)).toThrow('--keep-world is not an option of this command');
      expect(parseOperatorEnvelope({ v: 1, operator: 'ryo', domain: 'minecraft', op: 'start', args: { keepWorld: true } }))
        .toMatchObject({ ok: true, input: { command: 'lifecycle', action: 'start', keepWorld: true } });
      expect(parseOperatorEnvelope({ v: 1, operator: 'ryo', domain: 'minecraft', op: 'start', args: {} }))
        .toMatchObject({ ok: true, input: { command: 'lifecycle', action: 'start', keepWorld: false } });
      for (const bad of [{ keepWorld: 'yes' }, { keepWorld: 1 }, { keepWorld: null }]) {
        expect(parseOperatorEnvelope({ v: 1, operator: 'ryo', domain: 'minecraft', op: 'start', args: bad }), JSON.stringify(bad)).toMatchObject({ ok: false, code: 'invalid_input' });
      }
      for (const op of ['stop', 'login', 'logout', 'set_day', 'release']) {
        expect(parseOperatorEnvelope({ v: 1, operator: 'ryo', domain: 'minecraft', op, args: { keepWorld: true } }), op).toMatchObject({ ok: false, code: 'invalid_input' });
      }
    });

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
      expect(f.records().filter(entry => entry.reasonCode === 'fresh_world_applied').map(entry => entry.detail)).toEqual([`operation=${on.id} server=${SERVER} via=operator`]);
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
      expect(f.records().filter(entry => entry.reasonCode === 'fresh_world_applied').map(entry => entry.detail)).toEqual([`operation=${command.id} server=${SERVER} via=conversation`]);
      f.running('stopped');
      await f.converse('minecraft.login', 'login-1');
      expect('options' in await f.issued()).toBe(false);
    });

    it('tells him a new world was made, and where the old one is kept, when the start ends', async () => {
      const f = fixture();
      await f.setSwitch(true);
      await f.converse('minecraft.start', 'start-told');
      await f.issued({ worldId: 'shannon-home-20261019T1204', movedTo: 'shannon_home.before-regen-20261019T1204' });
      await until(() => f.reports.length === 1);
      expect(f.reports[0]).toMatchObject({ action: 'start', outcome: 'completed', freshWorld: { movedTo: 'shannon_home.before-regen-20261019T1204' } });
    });

    it('tells him the new world was prepared, and where the old one is kept, even though the start could not be confirmed', async () => {
      const f = fixture();
      await f.setSwitch(true);
      await f.converse('minecraft.start', 'start-unconfirmed');
      const MOVED = 'shannon_home.before-regen-20261019T1204';
      await f.issued({ outcome: 'unknown', code: 'error', inputsReleased: false, worldId: 'shannon-home-20261019T1204', movedTo: MOVED });
      await until(() => f.reports.length === 1);
      expect(f.reports[0]).toMatchObject({ action: 'start', outcome: 'unknown', freshWorld: { movedTo: MOVED, started: false } });
      expect(neutralLifecycleOutcomeLine({ action: 'start', outcome: f.reports[0]!.outcome, others: false, freshWorld: f.reports[0]!.freshWorld })).toBe(
        `新しいワールドを用意しましたが、起動を確かめられませんでした（前のワールドは ${MOVED} として残しています）。`);
    });

    it('does not tell him of a new world on a start that did not ask for one, even if the receipt names a world', async () => {
      const f = fixture();
      await f.setSwitch(true); f.advertise(false);
      await f.converse('minecraft.start', 'start-plain-with-names');
      const command = await f.issued({ worldId: 'shannon-home-20261019T1204', movedTo: 'shannon_home.before-regen-20261019T1204' });
      expect('options' in command).toBe(false);
      await until(() => f.reports.length === 1);
      expect(f.reports[0]).toMatchObject({ action: 'start', outcome: 'completed' });
      expect(f.reports[0]).not.toHaveProperty('freshWorld');
    });

    it('does not tell him of a new world when the start made none', async () => {
      const f = fixture();
      await f.setSwitch(true); f.advertise(false);
      await f.converse('minecraft.start', 'start-unsupported');
      await f.issued();
      await until(() => f.reports.length === 1);
      expect(f.reports[0]).toMatchObject({ action: 'start', outcome: 'completed' });
      expect(f.reports[0]).not.toHaveProperty('freshWorld');
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
