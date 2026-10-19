import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OPS_COMMAND_LIMITS, OPS_COMMAND_REPORT_CODES, OPS_COMMAND_TYPES, OPS_FORBIDDEN_TARGET_PREFIXES, OPS_SERVICE_START_ALLOWED,
  OPS_SERVICE_START_WITHHELD, OPS_SERVICE_STOP_ALLOWED, opsCommandsAllowed, opsCommandsEnabled, validatedOpsCommandRequest,
} from '../src/contracts/opsCommandContract.js';
import { OPS_LIMITS, opsIngestEnabled, validatedOpsSnapshot, type OpsSnapshot } from '../src/contracts/opsContract.js';
import { SQLiteOpsStore } from '../src/infra/ops/store/opsStore.js';
import { OPS_COMMAND_CLAIM_PATH, OPS_COMMANDS_PATH } from '../src/infra/ops/serverOpsCommandRoutes.js';
import { createOpsRoute, isOpsPath, OPS_READ_PATH, OPS_SNAPSHOT_PATH } from '../src/infra/ops/serverOpsRoutes.js';

const BRIDGE_TOKEN = 'b'.repeat(40);
const DEVICE_TOKEN = 'device-token-of-the-desktop';
const OTHER_DEVICE_TOKEN = 'device-token-of-the-phone';
const START = '2026-10-02T03:00:00.000Z';
const SECOND = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const servers: Array<ReturnType<typeof createServer>> = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const service = (id: string, status = 'running') => ({ id, label: id, category: 'platform', status });

/** What the legacy runtime reports: its registered services, the five managed servers, and (never in practice) a lab server. */
function snapshot(): Record<string, any> {
  return {
    scopeKey: 'owner',
    reportedAt: '2026-10-02T02:59:58.000Z',
    runtime: { release: 'v2026.10.02-1', startedAt: '2026-10-01T20:00:00.000Z' },
    services: [
      service('discord'), service('twitter'), service('youtube'), service('youtube:live_chat'), service('notion'),
      service('minebot', 'stopped'), service('minebot:bot', 'stopped'), service('minecraft'),
      service('minecraft:main'), service('minecraft:creative', 'stopped'),
      service('minecraft:progressive-lab-7'), service('progressive-lab-runner'), service('reporter'),
    ],
    minebot: [],
    schedules: [{ name: 'morning-post', time: '08:00', postedToday: true }, { name: '夜の投稿', time: '0 21 * * *' }],
    skills: [],
  };
}

async function harness(options: { environment?: Record<string, string>; store?: SQLiteOpsStore; fixedToken?: boolean; bridge?: boolean } = {}) {
  const clock = { at: START };
  const store = options.store ?? new SQLiteOpsStore(':memory:');
  const environment = options.environment ?? { SHANNON_PLATFORM_OPS_COMMANDS: 'on' };
  const route = createOpsRoute({
    store, now: () => clock.at, ingestEnabled: () => opsIngestEnabled(environment), commandsEnabled: () => opsCommandsEnabled(environment),
    bridge: options.bridge === false ? null : { token: BRIDGE_TOKEN, scopeKey: 'owner' },
    device: authorization => authorization === `Bearer ${DEVICE_TOKEN}` ? { scopeKey: options.fixedToken ? null : 'owner', ...(options.fixedToken ? {} : { deviceId: 'desktop-1' }) }
      : authorization === `Bearer ${OTHER_DEVICE_TOKEN}` ? { scopeKey: 'owner', deviceId: 'phone-1' } : null,
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!isOpsPath(url.pathname)) { response.writeHead(404).end('{"error":"NOT_ROUTED"}'); return; }
    void route(url.pathname, request, response, url.searchParams);
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (method: string, path: string, token: string | null, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  let keys = 0;
  const report = (body: unknown = snapshot()) => call('POST', OPS_SNAPSHOT_PATH, BRIDGE_TOKEN, body);
  const read = async () => (await call('GET', `${OPS_READ_PATH}?scopeKey=owner`, DEVICE_TOKEN)).body;
  const send = (type: string, target: unknown, extra: Record<string, unknown> = {}, token: string | null = DEVICE_TOKEN) =>
    call('POST', OPS_COMMANDS_PATH, token, { scopeKey: 'owner', idempotencyKey: `key-${String(keys += 1).padStart(6, '0')}`, type, target, ...extra });
  const claim = (token: string | null = BRIDGE_TOKEN, body: unknown = { scopeKey: 'owner' }) => call('POST', OPS_COMMAND_CLAIM_PATH, token, body);
  const finish = (id: string, body: Record<string, unknown>, token: string | null = BRIDGE_TOKEN) =>
    call('POST', `/v1/platform/ops/commands/${id}/report`, token, { scopeKey: 'owner', ...body });
  const advance = (milliseconds: number) => { clock.at = new Date(Date.parse(clock.at) + milliseconds).toISOString(); };
  return { store, environment, call, report, read, send, claim, finish, advance };
}

describe('SHANNON_PLATFORM_OPS_COMMANDS', () => {
  it('is off unless switched on', () => {
    expect(opsCommandsEnabled({})).toBe(false);
    for (const value of ['off', 'false', '0', '', 'yes', 'disabled']) expect(opsCommandsEnabled({ SHANNON_PLATFORM_OPS_COMMANDS: value })).toBe(false);
    for (const value of ['on', ' ON ', 'true', '1', 'enabled']) expect(opsCommandsEnabled({ SHANNON_PLATFORM_OPS_COMMANDS: value })).toBe(true);
  });

  it('refuses a command, hands nothing out and shows no control when off', async () => {
    const environment: Record<string, string> = {};
    const { report, read, send, claim, store } = await harness({ environment });
    await report();
    expect(await send('service.stop', 'twitter')).toMatchObject({ status: 403, body: { error: 'OPS_COMMANDS_DISABLED' } });
    expect(await claim()).toEqual({ status: 200, body: { command: null, pollAfterSeconds: 60 } });
    expect(await read()).toMatchObject({
      commandsSupported: false, commands: [], allowed: { serviceStart: [], serviceStop: [], minecraft: false, scheduleRun: false, minebotStart: false },
    });
    expect(store.commands.count()).toBe(0);
    // Authentication still comes first.
    expect((await send('service.stop', 'twitter', {}, null)).status).toBe(401);
    expect((await claim(null)).status).toBe(401);
  });

  it('stops handing out a waiting command when switched off, lets a claimed one finish, and lists again when back on', async () => {
    const { report, read, send, claim, finish, environment } = await harness();
    await report();
    await send('service.stop', 'twitter');
    await send('service.stop', 'youtube');
    const claimed = (await claim()).body.command;
    environment.SHANNON_PLATFORM_OPS_COMMANDS = 'off';
    expect((await claim()).body.command).toBeNull();
    expect((await finish(claimed.id, { outcome: 'done' })).status).toBe(200);
    expect((await read()).commands).toEqual([]);
    environment.SHANNON_PLATFORM_OPS_COMMANDS = 'on';
    expect((await read()).commands.map((command: any) => command.status)).toEqual(['pending', 'done']);
  });

  it('is in both environment examples, off', () => {
    for (const path of ['../../../.env.example', '../../../deploy/azure/api.env.example']) {
      expect(readFileSync(resolve(import.meta.dirname, path), 'utf8')).toContain('\nSHANNON_PLATFORM_OPS_COMMANDS=off\n');
    }
  });
});

describe('authentication', () => {
  it('accepts a command from a device credential only', async () => {
    const { report, send, store } = await harness();
    await report();
    expect(await send('service.stop', 'twitter', {}, null)).toMatchObject({ status: 401, body: { error: 'PAIRING_REQUIRED' } });
    expect(await send('service.stop', 'twitter', {}, BRIDGE_TOKEN)).toMatchObject({ status: 401, body: { error: 'PAIRING_REQUIRED' } });
    expect(store.commands.count()).toBe(0);
    expect((await send('service.stop', 'twitter')).status).toBe(201);
  });

  it('lets only the bridge credential claim and report', async () => {
    const { report, send, claim, finish } = await harness();
    await report();
    const { id } = (await send('service.stop', 'twitter')).body.command;
    expect(await claim(null)).toEqual({ status: 401, body: { error: 'PLATFORM_BRIDGE_UNAUTHORIZED' } });
    expect(await claim(DEVICE_TOKEN)).toEqual({ status: 401, body: { error: 'PLATFORM_BRIDGE_UNAUTHORIZED' } });
    expect(await finish(id, { outcome: 'done' }, DEVICE_TOKEN)).toEqual({ status: 401, body: { error: 'PLATFORM_BRIDGE_UNAUTHORIZED' } });
    expect((await claim()).body.command.id).toBe(id);
    expect(await finish(id, { outcome: 'done' }, null)).toEqual({ status: 401, body: { error: 'PLATFORM_BRIDGE_UNAUTHORIZED' } });
    expect((await finish(id, { outcome: 'done' })).status).toBe(200);
  });

  it('answers 503 to the bridge routes when the bridge is not configured, and 405 to the wrong method', async () => {
    const unconfigured = await harness({ bridge: false });
    expect(await unconfigured.claim()).toEqual({ status: 503, body: { error: 'PLATFORM_BRIDGE_NOT_CONFIGURED' } });
    const { call } = await harness();
    expect((await call('GET', OPS_COMMANDS_PATH, DEVICE_TOKEN)).status).toBe(405);
    expect((await call('GET', OPS_COMMAND_CLAIM_PATH, BRIDGE_TOKEN)).status).toBe(405);
    expect((await call('GET', '/v1/platform/ops/commands/3f2b8c1e-7a4d-4e9b-9c1a-5d6e7f8a9b0c/report', BRIDGE_TOKEN)).status).toBe(405);
  });

  it('routes exactly the three command paths', () => {
    expect(isOpsPath(OPS_COMMANDS_PATH)).toBe(true);
    expect(isOpsPath(OPS_COMMAND_CLAIM_PATH)).toBe(true);
    expect(isOpsPath('/v1/platform/ops/commands/3f2b8c1e-7a4d-4e9b-9c1a-5d6e7f8a9b0c/report')).toBe(true);
    for (const path of ['/v1/ops/commands/', '/v1/ops/commands/x', '/v1/platform/ops/commands', '/v1/platform/ops/commands/not-a-uuid/report',
      '/v1/platform/ops/commands/3f2b8c1e-7a4d-4e9b-9c1a-5d6e7f8a9b0c', '/v1/platform/ops/commands/3f2b8c1e-7a4d-4e9b-9c1a-5d6e7f8a9b0c/report/x']) {
      expect(isOpsPath(path)).toBe(false);
    }
  });

  it('records the device that asked, and the scope of the credential rather than the one named', async () => {
    const { report, send, read, store } = await harness();
    await report();
    const first = await send('service.stop', 'twitter', { scopeKey: 'someone-else' });
    expect(first.body.command.requestedByDeviceId).toBe('desktop-1');
    expect((await send('service.stop', 'youtube', {}, OTHER_DEVICE_TOKEN)).body.command.requestedByDeviceId).toBe('phone-1');
    expect((await read()).commands).toHaveLength(2);
    expect(store.commands.recent('someone-else', START)).toEqual([]);
    const fixed = await harness({ fixedToken: true });
    await fixed.report();
    expect((await fixed.send('service.stop', 'twitter')).body.command.requestedByDeviceId).toBe('local');
    expect((await fixed.send('service.stop', 'twitter', { scopeKey: undefined })).status).toBe(400);
    expect(await fixed.send('service.stop', 'twitter', { scopeKey: 'someone-else' })).toMatchObject({ status: 409, body: { error: 'OPS_STALE' } });
  });
});

describe('POST /v1/ops/commands: fields', () => {
  it('answers with the command', async () => {
    const { report, send } = await harness();
    await report();
    const answer = await send('service.stop', 'twitter');
    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({ created: true, command: {
      id: expect.stringMatching(UUID), type: 'service.stop', target: 'twitter', status: 'pending',
      createdAt: START, expiresAt: '2026-10-02T03:05:00.000Z', requestedByDeviceId: 'desktop-1',
    } });
  });

  it.each([
    ['an unknown field', { arguments: ['--force'] }, 'arguments is not allowed'],
    ['a text field', { text: 'please' }, 'text is not allowed'],
    ['an unknown type', { type: 'service.restart' }, 'type must be one of'],
    ['a shell-shaped type', { type: 'exec' }, 'type must be one of'],
    ['a missing type', { type: undefined }, 'type must be one of'],
    ['a missing idempotencyKey', { idempotencyKey: undefined }, 'idempotencyKey'],
    ['a short idempotencyKey', { idempotencyKey: 'short' }, 'idempotencyKey'],
    ['a long idempotencyKey', { idempotencyKey: 'k'.repeat(81) }, 'idempotencyKey'],
    ['an idempotencyKey with a space', { idempotencyKey: 'key with space' }, 'idempotencyKey'],
    ['a numeric idempotencyKey', { idempotencyKey: 12_345_678 }, 'idempotencyKey'],
    ['a missing target', { target: undefined }, 'target'],
    ['a target that is an object', { target: { id: 'twitter' } }, 'target'],
    ['a target with a space', { target: 'twitter; rm -rf' }, 'target'],
    ['a target with a newline', { target: 'twitter\n' }, 'target'],
    ['a long target', { target: 't'.repeat(OPS_LIMITS.id + 1) }, 'target'],
    ['a credential-shaped target', { target: 'a1b2c3d4'.repeat(4) }, 'target'],
  ])('refuses %s with 400 and records nothing', async (_name, edit, message) => {
    const { report, send, store } = await harness();
    await report();
    const answer = await send('service.stop', 'twitter', edit);
    expect(answer).toMatchObject({ status: 400, body: { error: 'INVALID_REQUEST' } });
    expect(answer.body.message).toContain(message);
    expect(store.commands.count()).toBe(0);
  });

  it('refuses a body that is not a JSON object, and one that is too large', async () => {
    const { report, call, store } = await harness();
    await report();
    expect(await call('POST', OPS_COMMANDS_PATH, DEVICE_TOKEN, '{"type":')).toMatchObject({ status: 400, body: { error: 'INVALID_REQUEST' } });
    expect(await call('POST', OPS_COMMANDS_PATH, DEVICE_TOKEN, '[]')).toMatchObject({ status: 400, body: { error: 'INVALID_REQUEST' } });
    expect(await call('POST', OPS_COMMANDS_PATH, DEVICE_TOKEN, '')).toMatchObject({ status: 400, body: { error: 'INVALID_REQUEST' } });
    expect(await call('POST', OPS_COMMANDS_PATH, DEVICE_TOKEN, { scopeKey: 'owner', idempotencyKey: 'key-000001', type: 'service.stop', target: 'x'.repeat(5000) }))
      .toMatchObject({ status: 413, body: { error: 'REQUEST_TOO_LARGE' } });
    expect(store.commands.count()).toBe(0);
  });

  it('applies the label rule to a schedule name', async () => {
    const { report, send } = await harness();
    await report();
    expect((await send('schedule.run', '夜の投稿')).status).toBe(201);
    expect((await send('schedule.run', '  morning-post  ')).body.command.target).toBe('morning-post');
    for (const target of ['', '  ', 'line\nbreak', 'n'.repeat(OPS_LIMITS.scheduleName + 1), `sk-${'a1B2'.repeat(6)}`, 7]) {
      expect(await send('schedule.run', target)).toMatchObject({ status: 400, body: { error: 'INVALID_REQUEST' } });
    }
  });
});

describe('POST /v1/ops/commands: the allowlist', () => {
  it('is these constants', () => {
    expect(OPS_COMMAND_TYPES).toEqual(['service.start', 'service.stop', 'schedule.run', 'minecraft.start', 'minecraft.stop', 'minebot.start']);
    expect(OPS_SERVICE_START_ALLOWED).toEqual(['discord', 'twitter', 'youtube', 'youtube:live_chat', 'notion', 'minecraft', 'minebot']);
    expect(OPS_SERVICE_STOP_ALLOWED).toEqual(['twitter', 'youtube', 'youtube:live_chat', 'notion', 'minebot', 'minebot:bot', 'minecraft']);
    expect(OPS_SERVICE_START_WITHHELD).toEqual(['minebot:bot']);
    expect(OPS_FORBIDDEN_TARGET_PREFIXES).toEqual(['progressive-lab-', 'minecraft:progressive-lab-']);
  });

  it('accepts every allowed start and stop that the snapshot names', async () => {
    const { report, send, claim, finish } = await harness();
    await report();
    for (const [type, targets] of [['service.start', OPS_SERVICE_START_ALLOWED], ['service.stop', OPS_SERVICE_STOP_ALLOWED]] as const) {
      for (const target of targets) {
        const answer = await send(type, target);
        expect(answer).toMatchObject({ status: 201, body: { command: { type, target } } });
        await finish((await claim()).body.command.id, { outcome: 'done' });
      }
    }
  });

  it('starts Discord and refuses to stop it', async () => {
    const { report, send, store } = await harness();
    await report();
    const refused = await send('service.stop', 'discord');
    expect(refused).toMatchObject({ status: 403, body: { error: 'TARGET_NOT_ALLOWED' } });
    expect(refused.body.message).toContain('Discord cannot be stopped from here');
    expect(store.commands.count()).toBe(0);
    expect((await send('service.start', 'discord')).status).toBe(201);
  });

  it('starts the Minebot manager, and the body only with the server it joins (owner decision 2026-10-02)', async () => {
    const { report, send, store } = await harness();
    await report();
    // The body is not a plain service: it needs a server.
    const refused = await send('service.start', 'minebot:bot');
    expect(refused).toMatchObject({ status: 403, body: { error: 'TARGET_NOT_ALLOWED' } });
    expect(refused.body.message).toContain('minebot.start');
    expect(store.commands.count()).toBe(0);
    expect((await send('service.start', 'minebot')).status).toBe(201);
    expect((await send('service.stop', 'minebot')).status).toBe(201);
    expect((await send('service.stop', 'minebot:bot')).status).toBe(201);
    expect(await send('minebot.start', 'minecraft:progressive-lab-1')).toMatchObject({ status: 403, body: { error: 'TARGET_NOT_ALLOWED' } });
    expect(await send('minebot.start', 'minecraft:not-reported')).toMatchObject({ status: 422, body: { error: 'TARGET_UNKNOWN' } });
  });

  it('refuses a lab target for every type, even when the snapshot names it', async () => {
    const { report, send, store } = await harness();
    const body = snapshot();
    body.schedules.push({ name: 'progressive-lab-nightly', time: '03:00' });
    await report(body);
    for (const [type, target] of [
      ['service.start', 'progressive-lab-runner'], ['service.stop', 'progressive-lab-runner'],
      ['service.start', 'minecraft:progressive-lab-7'], ['service.stop', 'minecraft:progressive-lab-7'],
      ['minecraft.start', 'minecraft:progressive-lab-7'], ['minecraft.stop', 'minecraft:progressive-lab-7'],
      ['minecraft.start', 'progressive-lab-7'], ['minecraft.stop', 'progressive-lab-7'],
      ['schedule.run', 'progressive-lab-nightly'], ['schedule.run', 'minecraft:progressive-lab-7'],
    ] as const) {
      const refused = await send(type, target);
      expect(refused, `${type} ${target}`).toMatchObject({ status: 403, body: { error: 'TARGET_NOT_ALLOWED' } });
      expect(refused.body.message).toContain('progressive-lab-');
    }
    expect(store.commands.count()).toBe(0);
  });

  it('refuses a service that is reported and not on the list', async () => {
    const { report, send } = await harness();
    await report();
    for (const target of ['reporter', 'minecraft:main', 'Discord', 'discord:voice']) {
      expect(await send('service.stop', target), target).toMatchObject({ status: 403, body: { error: 'TARGET_NOT_ALLOWED' } });
      expect(await send('service.start', target), target).toMatchObject({ status: 403, body: { error: 'TARGET_NOT_ALLOWED' } });
    }
  });

  it('refuses a target the snapshot does not name', async () => {
    const { report, send, store } = await harness();
    const body = snapshot();
    body.services = body.services.filter((entry: { id: string }) => entry.id !== 'notion');
    await report(body);
    expect(await send('service.stop', 'notion')).toMatchObject({ status: 422, body: { error: 'TARGET_UNKNOWN' } });
    expect(await send('schedule.run', 'noon-post')).toMatchObject({ status: 422, body: { error: 'TARGET_UNKNOWN' } });
    expect(await send('schedule.run', 'Morning-Post')).toMatchObject({ status: 422, body: { error: 'TARGET_UNKNOWN' } });
    expect(await send('minecraft.start', 'survival')).toMatchObject({ status: 422, body: { error: 'TARGET_UNKNOWN' } });
    // A schedule name is not a service, and the server manager is not a server.
    expect(await send('minecraft.start', 'morning-post')).toMatchObject({ status: 422, body: { error: 'TARGET_UNKNOWN' } });
    expect(await send('minecraft.stop', 'minecraft')).toMatchObject({ status: 422, body: { error: 'TARGET_UNKNOWN' } });
    expect(store.commands.count()).toBe(0);
  });

  it('takes a Minecraft server with or without the prefix and records it with the prefix', async () => {
    const { report, send } = await harness();
    await report();
    expect((await send('minecraft.start', 'creative')).body.command.target).toBe('minecraft:creative');
    expect((await send('minecraft.stop', 'minecraft:main')).body.command.target).toBe('minecraft:main');
    expect(await send('minecraft.start', 'minecraft:')).toMatchObject({ status: 400, body: { error: 'INVALID_REQUEST' } });
    expect(await send('minecraft.start', 'm'.repeat(OPS_LIMITS.id - 5))).toMatchObject({ status: 400, body: { error: 'INVALID_REQUEST' } });
    // The same server under both spellings is one command for an idempotency key.
    const first = await send('minecraft.stop', 'creative', { idempotencyKey: 'same-key-1' });
    const second = await send('minecraft.stop', 'minecraft:creative', { idempotencyKey: 'same-key-1' });
    expect(second).toMatchObject({ status: 200, body: { created: false, command: { id: first.body.command.id } } });
  });

  it('validates without a snapshot the same way', () => {
    const request = (type: string, target: unknown) => validatedOpsCommandRequest({ scopeKey: 'owner', idempotencyKey: 'key-000001', type, target });
    expect(request('service.stop', 'twitter')).toEqual({ idempotencyKey: 'key-000001', type: 'service.stop', target: 'twitter' });
    expect(request('service.stop', 'discord')).toMatchObject({ status: 403, error: 'TARGET_NOT_ALLOWED' });
    expect(request('minecraft.start', 'progressive-lab-1')).toMatchObject({ status: 403, error: 'TARGET_NOT_ALLOWED' });
    for (const value of [undefined, null, [], 'text', 3]) expect(validatedOpsCommandRequest(value)).toMatchObject({ status: 400 });
  });
});

describe('POST /v1/ops/commands: the runtime must be there', () => {
  it('refuses when there is no snapshot, a stale one, or ingest is off', async () => {
    const environment: Record<string, string> = { SHANNON_PLATFORM_OPS_COMMANDS: 'on' };
    const { report, send, advance, store } = await harness({ environment });
    expect(await send('service.stop', 'twitter')).toMatchObject({ status: 409, body: { error: 'OPS_STALE' } });
    await report();
    advance(OPS_LIMITS.staleAfterSeconds * SECOND);
    expect((await send('service.stop', 'twitter')).status).toBe(201);
    advance(SECOND);
    expect(await send('service.stop', 'youtube')).toMatchObject({ status: 409, body: { error: 'OPS_STALE' } });
    await report();
    environment.SHANNON_PLATFORM_OPS_INGEST = 'off';
    expect(await send('service.stop', 'youtube')).toMatchObject({ status: 409, body: { error: 'OPS_STALE' } });
    expect(store.commands.count()).toBe(1);
  });

  it('answers the allowlist refusal before the stale one', async () => {
    const { send } = await harness();
    expect(await send('service.stop', 'discord')).toMatchObject({ status: 403, body: { error: 'TARGET_NOT_ALLOWED' } });
  });
});

describe('POST /v1/ops/commands: idempotency and bounds', () => {
  it('returns the same command for the same key and makes no second one', async () => {
    const { report, send, claim, finish, advance, store } = await harness();
    await report();
    const first = await send('schedule.run', 'morning-post', { idempotencyKey: 'press-0001' });
    const again = await send('schedule.run', 'morning-post', { idempotencyKey: 'press-0001' });
    expect(again).toEqual({ status: 200, body: { created: false, command: first.body.command } });
    expect(store.commands.count()).toBe(1);
    await finish((await claim()).body.command.id, { outcome: 'done' });
    // Later, with the runtime gone, the key still answers with the command as it ended, and never runs it again.
    advance(600 * SECOND);
    const later = await send('schedule.run', 'morning-post', { idempotencyKey: 'press-0001' });
    expect(later).toMatchObject({ status: 200, body: { created: false, command: { id: first.body.command.id, status: 'done' } } });
    expect((await claim()).body.command).toBeNull();
    expect(store.commands.count()).toBe(1);
  });

  it('refuses a key that already made a different command', async () => {
    const { report, send, store } = await harness();
    await report();
    await send('service.stop', 'twitter', { idempotencyKey: 'press-0001' });
    expect(await send('service.stop', 'youtube', { idempotencyKey: 'press-0001' })).toMatchObject({ status: 409, body: { error: 'IDEMPOTENCY_KEY_REUSED' } });
    expect(await send('service.start', 'twitter', { idempotencyKey: 'press-0001' })).toMatchObject({ status: 409, body: { error: 'IDEMPOTENCY_KEY_REUSED' } });
    expect(store.commands.count()).toBe(1);
  });

  it('holds at most five open commands', async () => {
    const { report, send, claim, finish, advance } = await harness();
    await report();
    for (let index = 0; index < OPS_COMMAND_LIMITS.open; index += 1) expect((await send('service.stop', 'twitter')).status).toBe(201);
    expect(await send('service.stop', 'twitter')).toMatchObject({ status: 429, body: { error: 'TOO_MANY_OPEN_COMMANDS' } });
    // A claimed command is still open; a finished one is not.
    const claimed = (await claim()).body.command;
    expect((await send('service.stop', 'twitter')).status).toBe(429);
    await finish(claimed.id, { outcome: 'done' });
    expect((await send('service.stop', 'twitter')).status).toBe(201);
    expect((await send('service.stop', 'twitter')).status).toBe(429);
    // Expired commands are not open either.
    advance(OPS_COMMAND_LIMITS.claimWithinSeconds * SECOND);
    await report();
    expect((await send('service.stop', 'twitter')).status).toBe(201);
  });

  it('accepts at most twenty commands in an hour, counted from the record', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-ops-commands-'));
    directories.push(directory);
    const path = join(directory, 'ops.sqlite');
    const first = new SQLiteOpsStore(path);
    const { report, send, claim, finish, advance } = await harness({ store: first });
    await report();
    for (let index = 0; index < OPS_COMMAND_LIMITS.perHour; index += 1) {
      expect((await send('service.stop', 'twitter')).status).toBe(201);
      await finish((await claim()).body.command.id, { outcome: 'done' });
      advance(SECOND);
    }
    expect(await send('service.stop', 'twitter')).toMatchObject({ status: 429, body: { error: 'RATE_LIMITED' } });
    first.close();
    // A restart does not reset the count.
    const reopened = new SQLiteOpsStore(path);
    const restarted = await harness({ store: reopened });
    restarted.advance(OPS_COMMAND_LIMITS.perHour * SECOND);
    await restarted.report();
    expect(await restarted.send('service.stop', 'twitter', { idempotencyKey: 'after-restart-1' })).toMatchObject({ status: 429, body: { error: 'RATE_LIMITED' } });
    restarted.advance(3600 * SECOND);
    await restarted.report();
    expect((await restarted.send('service.stop', 'twitter', { idempotencyKey: 'after-restart-2' })).status).toBe(201);
    expect(reopened.commands.count()).toBe(OPS_COMMAND_LIMITS.perHour + 1);
    reopened.close();
  });
});

describe('POST /v1/platform/ops/commands/claim', () => {
  it('answers null when nothing waits', async () => {
    const { claim } = await harness();
    expect(await claim()).toEqual({ status: 200, body: { command: null, pollAfterSeconds: 10 } });
  });

  it('hands out the oldest command first, each one once', async () => {
    const { report, send, claim, advance, read } = await harness();
    await report();
    const ids: string[] = [];
    for (const target of ['twitter', 'youtube', 'notion']) {
      ids.push((await send('service.stop', target)).body.command.id);
      advance(SECOND);
    }
    const first = await claim();
    expect(first.body).toEqual({ pollAfterSeconds: 10, command: {
      id: ids[0], type: 'service.stop', target: 'twitter', createdAt: START, expiresAt: '2026-10-02T03:02:03.000Z',
    } });
    expect((await claim()).body.command.id).toBe(ids[1]);
    expect((await claim()).body.command.id).toBe(ids[2]);
    expect((await claim()).body.command).toBeNull();
    expect((await read()).commands.map((command: any) => [command.target, command.status, command.claimedAt])).toEqual([
      ['notion', 'claimed', '2026-10-02T03:00:03.000Z'], ['youtube', 'claimed', '2026-10-02T03:00:03.000Z'], ['twitter', 'claimed', '2026-10-02T03:00:03.000Z'],
    ]);
  });

  it('keeps first-in-first-out order for commands created in the same instant', async () => {
    const { report, send, claim } = await harness();
    await report();
    const ids = [];
    for (const target of ['notion', 'twitter', 'youtube']) ids.push((await send('service.stop', target)).body.command.id);
    expect([(await claim()).body.command.id, (await claim()).body.command.id, (await claim()).body.command.id]).toEqual(ids);
  });

  it('never hands out a command that waited five minutes', async () => {
    const { report, send, claim, read, advance } = await harness();
    await report();
    const old = (await send('schedule.run', 'morning-post')).body.command;
    advance((OPS_COMMAND_LIMITS.claimWithinSeconds - 1) * SECOND);
    await report();
    const fresh = (await send('service.stop', 'twitter')).body.command;
    advance(SECOND);
    // Exactly at the deadline the old one is gone; the newer one is handed out instead.
    expect((await claim()).body.command.id).toBe(fresh.id);
    expect((await claim()).body.command).toBeNull();
    const listed = (await read()).commands.find((command: any) => command.id === old.id);
    expect(listed).toEqual({ ...old, status: 'expired', finishedAt: old.expiresAt });
    advance(3600 * SECOND);
    expect((await claim()).body.command).toBeNull();
  });

  it('can still claim one second before the deadline', async () => {
    const { report, send, claim, advance } = await harness();
    await report();
    const { id } = (await send('schedule.run', 'morning-post')).body.command;
    advance((OPS_COMMAND_LIMITS.claimWithinSeconds - 1) * SECOND);
    expect((await claim()).body.command.id).toBe(id);
  });

  it('fails a claimed command that is not reported in two minutes and never hands it out again', async () => {
    const { report, send, claim, read, advance } = await harness();
    await report();
    const { id } = (await send('minecraft.start', 'creative')).body.command;
    await claim();
    advance((OPS_COMMAND_LIMITS.reportWithinSeconds - 1) * SECOND);
    expect((await read()).commands[0].status).toBe('claimed');
    expect((await claim()).body.command).toBeNull();
    advance(SECOND);
    expect((await read()).commands[0]).toMatchObject({ id, status: 'failed', code: 'no_report', finishedAt: '2026-10-02T03:02:00.000Z' });
    for (let index = 0; index < 3; index += 1) {
      expect((await claim()).body.command).toBeNull();
      advance(60 * SECOND);
    }
  });

  it('stores under the scope of the credential and refuses any other field', async () => {
    const { report, send, claim } = await harness();
    await report();
    const { id } = (await send('service.stop', 'twitter')).body.command;
    expect(await claim(BRIDGE_TOKEN, { scopeKey: 'owner', limit: 5 })).toMatchObject({ status: 400, body: { error: 'INVALID_REQUEST', message: 'limit is not allowed' } });
    expect(await claim(BRIDGE_TOKEN, {})).toMatchObject({ status: 400, body: { error: 'INVALID_REQUEST', message: 'scopeKey is required' } });
    expect(await claim(BRIDGE_TOKEN, '')).toMatchObject({ status: 400, body: { error: 'INVALID_REQUEST' } });
    expect((await claim(BRIDGE_TOKEN, { scopeKey: 'another-name' })).body.command.id).toBe(id);
  });

  it('limits how often the runtime may poll', async () => {
    const { claim } = await harness();
    for (let index = 0; index < OPS_COMMAND_LIMITS.claimsPerMinute; index += 1) expect((await claim()).status).toBe(200);
    expect(await claim()).toMatchObject({ status: 429, body: { error: 'RATE_LIMITED' } });
  });
});

describe('POST /v1/platform/ops/commands/{id}/report', () => {
  async function claimed(target = 'twitter') {
    const context = await harness();
    await context.report();
    const { id } = (await context.send('service.stop', target)).body.command;
    await context.claim();
    return { ...context, id };
  }

  it('records the outcome and its code', async () => {
    const { id, finish, read, advance } = await claimed();
    advance(7 * SECOND);
    expect(await finish(id, { outcome: 'refused', code: 'lab_running' })).toEqual({ status: 200, body: { id, status: 'refused', code: 'lab_running', duplicate: false } });
    expect((await read()).commands[0]).toEqual({
      id, type: 'service.stop', target: 'twitter', status: 'refused', code: 'lab_running', requestedByDeviceId: 'desktop-1',
      createdAt: START, expiresAt: '2026-10-02T03:05:00.000Z', claimedAt: START, finishedAt: '2026-10-02T03:00:07.000Z',
    });
  });

  it('accepts each outcome, with or without each code of the fixed set', async () => {
    expect(OPS_COMMAND_REPORT_CODES).toEqual(['not_registered', 'already_running', 'already_stopped', 'busy', 'lab_running', 'timeout', 'error', 'unsupported', 'not_allowed']);
    const { id, finish } = await claimed();
    expect(await finish(id, { outcome: 'done' })).toEqual({ status: 200, body: { id, status: 'done', duplicate: false } });
    for (const code of OPS_COMMAND_REPORT_CODES) {
      const next = await claimed();
      expect(await next.finish(next.id, { outcome: 'failed', code })).toEqual({ status: 200, body: { id: next.id, status: 'failed', code, duplicate: false } });
    }
  });

  it.each([
    ['an unknown outcome', { outcome: 'succeeded' }],
    ['a missing outcome', {}],
    ['a status the server owns', { outcome: 'expired' }],
    ['a code outside the set', { outcome: 'failed', code: 'out_of_memory' }],
    ['the server code', { outcome: 'failed', code: 'no_report' }],
    ['a code that is text', { outcome: 'failed', code: 'the server said: hello' }],
    ['a null code', { outcome: 'failed', code: null }],
    ['a message', { outcome: 'failed', message: 'it broke' }],
    ['a log', { outcome: 'done', log: ['line'] }],
  ])('refuses %s and leaves the command claimed', async (_name, body) => {
    const { id, finish, read } = await claimed();
    expect(await finish(id, body)).toMatchObject({ status: 400, body: { error: 'INVALID_REQUEST' } });
    expect((await read()).commands[0].status).toBe('claimed');
  });

  it('treats the same report again as a duplicate, and refuses a different one', async () => {
    const { id, finish, read, advance } = await claimed();
    await finish(id, { outcome: 'failed', code: 'timeout' });
    advance(30 * SECOND);
    expect(await finish(id, { outcome: 'failed', code: 'timeout' })).toEqual({ status: 200, body: { id, status: 'failed', code: 'timeout', duplicate: true } });
    expect(await finish(id, { outcome: 'done' })).toEqual({ status: 409, body: { error: 'OPS_COMMAND_FINISHED' } });
    expect(await finish(id, { outcome: 'failed' })).toEqual({ status: 409, body: { error: 'OPS_COMMAND_FINISHED' } });
    expect(await finish(id, { outcome: 'failed', code: 'error' })).toEqual({ status: 409, body: { error: 'OPS_COMMAND_FINISHED' } });
    expect((await read()).commands[0]).toMatchObject({ status: 'failed', code: 'timeout', finishedAt: START });
  });

  it('refuses a report for a command that was not claimed, expired, or does not exist', async () => {
    const { report, send, finish, advance } = await harness();
    await report();
    const { id } = (await send('service.stop', 'twitter')).body.command;
    expect(await finish(id, { outcome: 'done' })).toEqual({ status: 409, body: { error: 'OPS_COMMAND_NOT_CLAIMED' } });
    expect(await finish('3f2b8c1e-7a4d-4e9b-9c1a-5d6e7f8a9b0c', { outcome: 'done' })).toEqual({ status: 404, body: { error: 'OPS_COMMAND_NOT_FOUND' } });
    advance(OPS_COMMAND_LIMITS.claimWithinSeconds * SECOND);
    expect(await finish(id, { outcome: 'done' })).toEqual({ status: 409, body: { error: 'OPS_COMMAND_FINISHED' } });
  });

  it('lets a late report replace no_report, once, without handing the command out again', async () => {
    const { id, finish, read, claim, advance } = await claimed();
    advance(OPS_COMMAND_LIMITS.reportWithinSeconds * SECOND);
    expect((await read()).commands[0]).toMatchObject({ status: 'failed', code: 'no_report' });
    advance(5 * SECOND);
    expect(await finish(id, { outcome: 'done', code: 'already_stopped' })).toEqual({ status: 200, body: { id, status: 'done', code: 'already_stopped', duplicate: false } });
    expect((await read()).commands[0]).toMatchObject({ status: 'done', code: 'already_stopped', finishedAt: '2026-10-02T03:02:05.000Z' });
    expect(await finish(id, { outcome: 'failed', code: 'error' })).toEqual({ status: 409, body: { error: 'OPS_COMMAND_FINISHED' } });
    expect((await claim()).body.command).toBeNull();
  });
});

describe('GET /v1/ops with commands on', () => {
  it('keeps every stage 1 field and adds the commands and what is allowed', async () => {
    const { report, read } = await harness();
    expect(await read()).toEqual({
      schemaVersion: 1, snapshot: null, receivedAt: null, stale: true, staleAfterSeconds: 180,
      commands: [], commandsSupported: true, allowed: { serviceStart: [], serviceStop: [], minecraft: false, scheduleRun: false, minebotStart: false },
      settings: { freshWorld: false },
    });
    await report();
    const body = await read();
    expect(Object.keys(body).sort()).toEqual(['allowed', 'commands', 'commandsSupported', 'receivedAt', 'schemaVersion', 'settings', 'snapshot', 'stale', 'staleAfterSeconds']);
    expect(body).toMatchObject({ stale: false, commandsSupported: true, commands: [] });
    expect(body.allowed).toEqual({
      serviceStart: ['discord', 'twitter', 'youtube', 'youtube:live_chat', 'notion', 'minebot', 'minecraft'],
      serviceStop: ['twitter', 'youtube', 'youtube:live_chat', 'notion', 'minebot', 'minebot:bot', 'minecraft'],
      minecraft: true, scheduleRun: true, minebotStart: true,
    });
  });

  it('offers only what the snapshot names, and nothing when it is stale', async () => {
    const { report, read, advance } = await harness();
    const body = snapshot();
    body.services = [service('twitter'), service('discord'), service('minecraft:progressive-lab-7'), service('reporter')];
    body.schedules = [];
    await report(body);
    expect((await read()).allowed).toEqual({ serviceStart: ['twitter', 'discord'], serviceStop: ['twitter'], minecraft: false, scheduleRun: false, minebotStart: false });
    advance((OPS_LIMITS.staleAfterSeconds + 1) * SECOND);
    expect(await read()).toMatchObject({ stale: true, commandsSupported: true, allowed: { serviceStart: [], serviceStop: [], minecraft: false, scheduleRun: false, minebotStart: false } });
  });

  it('accepts every command that `allowed` offers', async () => {
    const accepted = validatedOpsSnapshot(snapshot()) as OpsSnapshot;
    const allowed = opsCommandsAllowed(accepted);
    const request = (type: string, target: string) => validatedOpsCommandRequest({ scopeKey: 'owner', idempotencyKey: 'key-000001', type, target });
    for (const target of allowed.serviceStart) expect(request('service.start', target)).toMatchObject({ target });
    for (const target of allowed.serviceStop) expect(request('service.stop', target)).toMatchObject({ target });
    expect(opsCommandsAllowed(null)).toEqual({ serviceStart: [], serviceStop: [], minecraft: false, scheduleRun: false, minebotStart: false });
  });

  it('lists the last twenty commands, newest first', async () => {
    const { report, send, claim, finish, read, advance } = await harness();
    const targets: string[] = [];
    for (let index = 0; index < 23; index += 1) {
      await report();
      const target = index % 2 ? 'twitter' : 'youtube';
      const { id } = (await send('service.stop', target, { idempotencyKey: `press-${String(index).padStart(4, '0')}` })).body.command;
      targets.unshift(id);
      await claim();
      await finish(id, { outcome: 'done' });
      advance(181 * SECOND);
    }
    const listed = (await read()).commands;
    expect(listed).toHaveLength(OPS_COMMAND_LIMITS.recent);
    expect(listed.map((command: any) => command.id)).toEqual(targets.slice(0, OPS_COMMAND_LIMITS.recent));
    for (const command of listed) {
      expect(Object.keys(command).sort()).toEqual(['claimedAt', 'createdAt', 'expiresAt', 'finishedAt', 'id', 'requestedByDeviceId', 'status', 'target', 'type']);
    }
  });

  it('keeps the record across a restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-ops-commands-'));
    directories.push(directory);
    const path = join(directory, 'ops.sqlite');
    const first = new SQLiteOpsStore(path);
    const before = await harness({ store: first });
    await before.report();
    const { id } = (await before.send('schedule.run', 'morning-post')).body.command;
    await before.claim();
    await before.finish(id, { outcome: 'done' });
    first.close();
    const reopened = new SQLiteOpsStore(path);
    expect(reopened.commands.recent('owner', START)).toMatchObject([{ id, type: 'schedule.run', target: 'morning-post', status: 'done' }]);
    reopened.close();
  });
});
