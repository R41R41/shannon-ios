import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OPS_COMMAND_LIMITS, OPS_COMMAND_REPORT_CODES, OPS_SERVICE_START_ALLOWED, OPS_SERVICE_STOP_ALLOWED } from '../src/contracts/opsCommandContract.js';
import { OPS_LIMITS, opsIngestEnabled, opsSecretLike, validatedOpsSnapshot } from '../src/contracts/opsContract.js';
import { SQLiteOpsStore } from '../src/infra/ops/store/opsStore.js';
import { createOpsRoute, isOpsPath, OPS_READ_PATH, OPS_SNAPSHOT_PATH } from '../src/infra/ops/serverOpsRoutes.js';
import { apiSourceFile, apiSourceFiles, apiSourcePath, readApiSource, resolvedImports } from './support/sources.js';

const BRIDGE_TOKEN = 'b'.repeat(40);
const DEVICE_TOKEN = 'device-token-of-the-desktop';
const START = '2026-10-02T03:00:00.000Z';
const SECOND = 1000;
// Stage 2 is off unless the owner switches it on: the stage 1 answer gains `allowed`, with nothing in it.
const NOTHING_ALLOWED = { serviceStart: [], serviceStop: [], minecraft: false, scheduleRun: false, minebotStart: false };

const servers: Array<ReturnType<typeof createServer>> = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function snapshot(): Record<string, any> {
  return {
    scopeKey: 'whatever-the-reporter-sends',
    reportedAt: '2026-10-02T02:59:58.000Z',
    runtime: { release: 'v2026.10.02-1', startedAt: '2026-10-01T20:00:00.000Z' },
    services: [
      { id: 'discord', label: 'Discord', category: 'platform', status: 'running' },
      { id: 'minecraft-main', label: 'Minecraft', category: 'game', status: 'degraded', detail: 'reconnecting (3rd attempt)' },
    ],
    minebot: [
      { id: 'bot-1', server: 'main', status: 'running', task: { title: 'Build a storage room', steps: [
        { title: 'Collect oak logs', status: 'done' }, { title: 'Place the chests', status: 'running' },
      ] } },
      { id: 'bot-2', server: 'creative', status: 'stopped' },
    ],
    schedules: [{ name: 'morning-post', time: '08:00', postedToday: true }, { name: 'evening-post', time: '0 21 * * *' }],
    kpi: { postsToday: 3, postsPlanned: 5, tokensToday: 182_340, apiCallsToday: 97 },
    skills: [{ name: 'get-weather', description: 'Reads the forecast for a city' }],
  };
}

async function harness(options: { bridge?: boolean; environment?: Record<string, string>; store?: SQLiteOpsStore; fixedToken?: boolean } = {}) {
  const clock = { at: START };
  const store = options.store ?? new SQLiteOpsStore(':memory:');
  const environment = options.environment ?? {};
  const route = createOpsRoute({
    store, now: () => clock.at, ingestEnabled: () => opsIngestEnabled(environment),
    bridge: options.bridge === false ? null : { token: BRIDGE_TOKEN, scopeKey: 'owner' },
    device: authorization => authorization !== `Bearer ${DEVICE_TOKEN}` ? null : { scopeKey: options.fixedToken ? null : 'owner' },
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
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
  const report = (body: unknown = snapshot(), token: string | null = BRIDGE_TOKEN) => call('POST', OPS_SNAPSHOT_PATH, token, body);
  const read = (token: string | null = DEVICE_TOKEN, query = '?scopeKey=anything') => call('GET', `${OPS_READ_PATH}${query}`, token);
  const advance = (milliseconds: number) => { clock.at = new Date(Date.parse(clock.at) + milliseconds).toISOString(); };
  return { store, clock, call, report, read, advance };
}

describe('authentication', () => {
  it('accepts a snapshot from the platform bridge credential only', async () => {
    const { report, store } = await harness();
    expect((await report(snapshot(), null)).status).toBe(401);
    expect(await report(snapshot(), DEVICE_TOKEN)).toEqual({ status: 401, body: { error: 'PLATFORM_BRIDGE_UNAUTHORIZED' } });
    expect((await report(snapshot(), `${BRIDGE_TOKEN}x`)).status).toBe(401);
    expect(store.count()).toBe(0);
    expect((await report()).status).toBe(200);
    expect(store.count()).toBe(1);
  });

  it('lets a device credential read and refuses the bridge credential', async () => {
    const { report, read } = await harness();
    await report();
    expect((await read(null)).status).toBe(401);
    expect(await read(BRIDGE_TOKEN)).toMatchObject({ status: 401, body: { error: 'PAIRING_REQUIRED' } });
    const answer = await read();
    expect(answer.status).toBe(200);
    expect(answer.body.snapshot.runtime.release).toBe('v2026.10.02-1');
  });

  it('refuses a snapshot when the bridge is not configured, and still answers a device', async () => {
    const { report, read } = await harness({ bridge: false });
    expect(await report()).toEqual({ status: 503, body: { error: 'PLATFORM_BRIDGE_NOT_CONFIGURED' } });
    expect((await read()).body).toMatchObject({ snapshot: null, receivedAt: null });
  });

  it('answers 405 to the wrong method on either path', async () => {
    const { call } = await harness();
    expect((await call('GET', OPS_SNAPSHOT_PATH, BRIDGE_TOKEN)).status).toBe(405);
    expect((await call('POST', OPS_READ_PATH, DEVICE_TOKEN, {})).status).toBe(405);
    expect(isOpsPath('/v1/ops')).toBe(true);
    expect(isOpsPath('/v1/platform/ops/snapshot')).toBe(true);
    // Stage 2 routes are dispatched by the same hook (`opsCommands.test.ts`).
    expect(isOpsPath('/v1/ops/commands')).toBe(true);
    expect(isOpsPath('/v1/platform/ops/commands/claim')).toBe(true);
    expect(isOpsPath('/v1/ops/status')).toBe(false);
    expect(isOpsPath('/v1/platform/ops')).toBe(false);
  });

  it('reads the scope of the paired device, and requires one from a fixed local token', async () => {
    const paired = await harness();
    await paired.report();
    expect((await paired.read(DEVICE_TOKEN, '?scopeKey=someone-else')).body.snapshot).not.toBeNull();
    expect((await paired.read(DEVICE_TOKEN, '')).body.snapshot).not.toBeNull();
    const fixed = await harness({ fixedToken: true });
    await fixed.report();
    expect((await fixed.read(DEVICE_TOKEN, '')).status).toBe(400);
    expect((await fixed.read(DEVICE_TOKEN, '?scopeKey=someone-else')).body.snapshot).toBeNull();
    expect((await fixed.read(DEVICE_TOKEN, '?scopeKey=owner')).body.snapshot).not.toBeNull();
  });

  it('is hooked before device authentication with the device store as the only reader credential', () => {
    const server = readApiSource('server.ts');
    expect(server.indexOf('if (isOpsPath(url.pathname))')).toBeGreaterThan(0);
    expect(server.indexOf('if (isOpsPath(url.pathname))')).toBeLessThan(server.indexOf('const principal = deviceAuth'));
    expect(server).toContain('device: authorization => deviceAuth ? deviceAuth.authenticate(authorization)');
    expect(server).toContain('bridge: platformBridge?.configuration ?? null');
  });
});

describe('snapshot validation', () => {
  const change = (edit: (body: Record<string, any>) => void) => { const body = snapshot(); edit(body); return body; };
  const long = (length: number) => 'あ'.repeat(length);

  it('accepts the documented snapshot and returns it normalized', () => {
    const body = snapshot();
    body.services[1].detail = '  reconnecting  ';
    body.reportedAt = '2026-10-02T11:59:58+09:00';
    const accepted = validatedOpsSnapshot(body);
    if (typeof accepted === 'string') throw new Error(accepted);
    expect(accepted.reportedAt).toBe('2026-10-02T02:59:58.000Z');
    expect(accepted.services[1]?.detail).toBe('reconnecting');
    expect(accepted).not.toHaveProperty('scopeKey');
    expect(accepted.minebot[0]?.task?.steps).toHaveLength(2);
    expect(accepted.schedules[1]).toEqual({ name: 'evening-post', time: '0 21 * * *' });
    expect(validatedOpsSnapshot({ ...snapshot(), schemaVersion: 1 })).toBeTypeOf('object');
    expect(validatedOpsSnapshot({ ...snapshot(), services: [], minebot: [], schedules: [], skills: [] })).toBeTypeOf('object');
    // A runtime that keeps no counters omits `kpi`; the stored snapshot then has none, never zeros.
    const { kpi: _kpi, ...withoutKpi } = snapshot();
    expect(validatedOpsSnapshot(withoutKpi)).not.toHaveProperty('kpi');
    // The shape the legacy runtime's reporter sends.
    expect(validatedOpsSnapshot({
      scopeKey: 'owner', reportedAt: '2026-10-02T01:00:00.000Z', runtime: { release: 'platform-people-20261002-cc7480f', startedAt: '2026-10-02T00:00:00.000Z' },
      services: [{ id: 'minecraft:lab', label: 'minecraft:lab', category: 'minecraft', status: 'degraded' }], minebot: [],
      schedules: [{ name: 'morning_post', time: '0 8 * * *' }], skills: [{ name: 'search', description: '検索する 二行目' }],
    })).toBeTypeOf('object');
  });

  it('accepts every bound at its maximum', () => {
    const body = change(value => {
      value.runtime.release = 'r'.repeat(OPS_LIMITS.release);
      value.services = Array.from({ length: OPS_LIMITS.services }, (_, index) => ({
        id: `s${index}`.padEnd(OPS_LIMITS.id, '-'), label: long(OPS_LIMITS.label), category: long(OPS_LIMITS.category), status: 'unknown', detail: long(OPS_LIMITS.shortLabel),
      }));
      value.minebot = Array.from({ length: OPS_LIMITS.minebot }, (_, index) => ({
        id: `bot-${index}`, server: long(OPS_LIMITS.server), status: 'running',
        task: { title: long(OPS_LIMITS.shortLabel), steps: Array.from({ length: OPS_LIMITS.steps }, () => ({ title: long(OPS_LIMITS.shortLabel), status: 'pending' })) },
      }));
      value.schedules = Array.from({ length: OPS_LIMITS.schedules }, () => ({ name: long(OPS_LIMITS.scheduleName), time: '0'.repeat(OPS_LIMITS.scheduleTime) }));
      value.kpi = { postsToday: 0, postsPlanned: OPS_LIMITS.counter, tokensToday: OPS_LIMITS.counter, apiCallsToday: 0 };
      value.skills = Array.from({ length: OPS_LIMITS.skills }, () => ({ name: long(OPS_LIMITS.skillName), description: long(OPS_LIMITS.skillDescription) }));
    });
    expect(validatedOpsSnapshot(body)).toBeTypeOf('object');
  });

  const refusals: Array<[string, (body: Record<string, any>) => void, string]> = [
    ['a missing scopeKey', body => { delete body.scopeKey; }, 'scopeKey'],
    ['an empty scopeKey', body => { body.scopeKey = '  '; }, 'scopeKey'],
    ['a long scopeKey', body => { body.scopeKey = 'k'.repeat(161); }, 'scopeKey'],
    ['another schemaVersion', body => { body.schemaVersion = 2; }, 'schemaVersion'],
    ['a missing reportedAt', body => { delete body.reportedAt; }, 'reportedAt'],
    ['a reportedAt that is not a timestamp', body => { body.reportedAt = 'yesterday'; }, 'reportedAt'],
    ['a numeric reportedAt', body => { body.reportedAt = 1_790_000_000; }, 'reportedAt'],
    ['a missing runtime', body => { delete body.runtime; }, 'runtime'],
    ['a runtime that is an array', body => { body.runtime = []; }, 'runtime'],
    ['an empty release', body => { body.runtime.release = ''; }, 'runtime.release'],
    ['a long release', body => { body.runtime.release = 'r'.repeat(OPS_LIMITS.release + 1); }, 'runtime.release'],
    ['a bad startedAt', body => { body.runtime.startedAt = '2026-13-40T00:00:00Z'; }, 'runtime.startedAt'],
    ['services that are not an array', body => { body.services = {}; }, 'services'],
    ['missing services', body => { delete body.services; }, 'services'],
    ['too many services', body => { body.services = Array.from({ length: OPS_LIMITS.services + 1 }, (_, i) => ({ id: `s${i}`, label: 'x', category: 'x', status: 'running' })); }, 'services'],
    ['a service that is not an object', body => { body.services[0] = 'discord'; }, 'services[0]'],
    ['a service id with a space', body => { body.services[0].id = 'dis cord'; }, 'services[0].id'],
    ['a long service id', body => { body.services[0].id = 'd'.repeat(OPS_LIMITS.id + 1); }, 'services[0].id'],
    ['a duplicate service id', body => { body.services[1].id = 'discord'; }, 'duplicate'],
    ['a missing label', body => { delete body.services[0].label; }, 'services[0].label'],
    ['a long label', body => { body.services[0].label = long(OPS_LIMITS.label + 1); }, 'services[0].label'],
    ['a long category', body => { body.services[0].category = long(OPS_LIMITS.category + 1); }, 'services[0].category'],
    ['an unknown service status', body => { body.services[0].status = 'online'; }, 'services[0].status'],
    ['a long detail', body => { body.services[1].detail = long(OPS_LIMITS.shortLabel + 1); }, 'services[1].detail'],
    ['a null detail', body => { body.services[1].detail = null; }, 'services[1].detail'],
    ['minebot that is not an array', body => { body.minebot = null; }, 'minebot'],
    ['too many bots', body => { body.minebot = Array.from({ length: OPS_LIMITS.minebot + 1 }, (_, i) => ({ id: `b${i}`, server: 'x', status: 'running' })); }, 'minebot'],
    ['a bot id that starts with a symbol', body => { body.minebot[0].id = '-bot'; }, 'minebot[0].id'],
    ['a duplicate bot id', body => { body.minebot[1].id = 'bot-1'; }, 'duplicate'],
    ['a long server', body => { body.minebot[0].server = long(OPS_LIMITS.server + 1); }, 'minebot[0].server'],
    ['an unknown bot status', body => { body.minebot[0].status = 'mining'; }, 'minebot[0].status'],
    ['a task that is a string', body => { body.minebot[0].task = 'mine'; }, 'minebot[0].task'],
    ['a long task title', body => { body.minebot[0].task.title = long(OPS_LIMITS.shortLabel + 1); }, 'minebot[0].task.title'],
    ['a task without steps', body => { delete body.minebot[0].task.steps; }, 'minebot[0].task.steps'],
    ['too many steps', body => { body.minebot[0].task.steps = Array.from({ length: OPS_LIMITS.steps + 1 }, () => ({ title: 'x', status: 'done' })); }, 'minebot[0].task.steps'],
    ['a long step title', body => { body.minebot[0].task.steps[0].title = long(OPS_LIMITS.shortLabel + 1); }, 'steps[0].title'],
    ['an unknown step status', body => { body.minebot[0].task.steps[0].status = 'ok'; }, 'steps[0].status'],
    ['schedules that are not an array', body => { body.schedules = 'none'; }, 'schedules'],
    ['too many schedules', body => { body.schedules = Array.from({ length: OPS_LIMITS.schedules + 1 }, () => ({ name: 'x', time: '08:00' })); }, 'schedules'],
    ['a long schedule name', body => { body.schedules[0].name = long(OPS_LIMITS.scheduleName + 1); }, 'schedules[0].name'],
    ['a long schedule time', body => { body.schedules[0].time = '0'.repeat(OPS_LIMITS.scheduleTime + 1); }, 'schedules[0].time'],
    ['a postedToday that is not a boolean', body => { body.schedules[0].postedToday = 'yes'; }, 'schedules[0].postedToday'],
    ['a null kpi', body => { body.kpi = null; }, 'kpi'],
    ['a negative counter', body => { body.kpi.postsToday = -1; }, 'kpi.postsToday'],
    ['a fractional counter', body => { body.kpi.postsPlanned = 1.5; }, 'kpi.postsPlanned'],
    ['a counter sent as text', body => { body.kpi.tokensToday = '12'; }, 'kpi.tokensToday'],
    ['a counter beyond the bound', body => { body.kpi.apiCallsToday = OPS_LIMITS.counter + 1; }, 'kpi.apiCallsToday'],
    ['a missing counter', body => { delete body.kpi.apiCallsToday; }, 'kpi.apiCallsToday'],
    ['skills that are not an array', body => { body.skills = {}; }, 'skills'],
    ['too many skills', body => { body.skills = Array.from({ length: OPS_LIMITS.skills + 1 }, () => ({ name: 'x', description: 'x' })); }, 'skills'],
    ['a long skill name', body => { body.skills[0].name = long(OPS_LIMITS.skillName + 1); }, 'skills[0].name'],
    ['a long skill description', body => { body.skills[0].description = long(OPS_LIMITS.skillDescription + 1); }, 'skills[0].description'],
    ['a missing skill description', body => { delete body.skills[0].description; }, 'skills[0].description'],
  ];
  it.each(refusals)('refuses %s', (_name, edit, field) => {
    const refusal = validatedOpsSnapshot(change(edit));
    expect(refusal).toBeTypeOf('string');
    expect(refusal).toContain(field);
  });

  it.each([
    ['the top level', (body: Record<string, any>) => { body.messages = []; }, 'messages is not allowed'],
    ['runtime', (body: Record<string, any>) => { body.runtime.host = 'vm'; }, 'runtime.host is not allowed'],
    ['a service', (body: Record<string, any>) => { body.services[0].log = 'x'; }, 'services[0].log is not allowed'],
    ['a bot', (body: Record<string, any>) => { body.minebot[0].chat = 'x'; }, 'minebot[0].chat is not allowed'],
    ['a task', (body: Record<string, any>) => { body.minebot[0].task.goal = 'x'; }, 'minebot[0].task.goal is not allowed'],
    ['a step', (body: Record<string, any>) => { body.minebot[0].task.steps[0].result = 'x'; }, 'minebot[0].task.steps[0].result is not allowed'],
    ['a schedule', (body: Record<string, any>) => { body.schedules[0].text = 'x'; }, 'schedules[0].text is not allowed'],
    ['kpi', (body: Record<string, any>) => { body.kpi.costYen = 1; }, 'kpi.costYen is not allowed'],
    ['a skill', (body: Record<string, any>) => { body.skills[0].prompt = 'x'; }, 'skills[0].prompt is not allowed'],
  ])('refuses an unknown field in %s', (_name, edit, message) => {
    expect(validatedOpsSnapshot(change(edit))).toBe(message);
  });

  it.each(['line\nbreak', 'tab\there', 'bell\u0007', 'escape\u001b[31m', 'zero​width', 'override‮', 'del\u007f', 'c1\u0085'])(
    'refuses a control character (%j)', value => {
      for (const edit of [
        (body: Record<string, any>) => { body.services[0].detail = value; },
        (body: Record<string, any>) => { body.minebot[0].task.title = value; },
        (body: Record<string, any>) => { body.minebot[0].task.steps[0].title = value; },
        (body: Record<string, any>) => { body.skills[0].description = value; },
        (body: Record<string, any>) => { body.runtime.release = value; },
      ]) expect(validatedOpsSnapshot(change(edit))).toContain('control character');
    });

  it('refuses a body that is not an object', () => {
    for (const body of [undefined, null, [], 'text', 3]) expect(validatedOpsSnapshot(body)).toBe('body must be an object');
  });
});

describe('credential-shaped strings', () => {
  const secrets = [
    `sk-${'a1B2'.repeat(6)}`, 'AKIAABCDEFGHIJKLMNOP', `ghp_${'a1'.repeat(12)}`, 'xoxb-1234567890-abcdef',
    `eyJ${'a1'.repeat(12)}.${'b2'.repeat(8)}.sig`, '-----BEGIN RSA PRIVATE KEY-----', 'password: hunter2hunter2', 'api key = abcdef123456',
    `${'Mz'.repeat(12)}.Gabc12.${'x9'.repeat(14)}`, 'a1b2c3d4'.repeat(4), `restart with ${'Zx9'.repeat(12)}`,
    '8e1c279f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d',
  ];
  it.each(secrets)('refuses %s in every free string', secret => {
    expect(opsSecretLike(secret)).toBe(true);
    for (const edit of [
      (body: Record<string, any>) => { body.runtime.release = secret; },
      (body: Record<string, any>) => { body.services[0].label = secret; },
      (body: Record<string, any>) => { body.services[0].detail = secret; },
      (body: Record<string, any>) => { body.minebot[0].server = secret; },
      (body: Record<string, any>) => { body.minebot[0].task.title = secret; },
      (body: Record<string, any>) => { body.minebot[0].task.steps[0].title = secret; },
      (body: Record<string, any>) => { body.schedules[0].name = secret; },
      (body: Record<string, any>) => { body.skills[0].description = secret; },
    ]) {
      const body = snapshot();
      edit(body);
      expect(validatedOpsSnapshot(body)).toContain('looks like a credential');
    }
  });

  it('leaves ordinary operator labels alone', () => {
    for (const label of ['reconnecting (3rd attempt)', 'v2026.10.02-1', '8e1c279', '3f2b8c1e-7a4d-4e9b-9c1a-5d6e7f8a9b0c',
      'PM2 再起動 12 回・メモリ 512MB', 'progressive-lab-2026-10-02', 'a'.repeat(60), '1'.repeat(60)]) {
      expect(opsSecretLike(label)).toBe(false);
    }
  });

  it('answers 400 over HTTP and stores nothing', async () => {
    const { report, store } = await harness();
    const body = snapshot();
    body.services[0].detail = `token ${BRIDGE_TOKEN.slice(0, 20)}${'9'.repeat(20)}`;
    const answer = await report(body);
    expect(answer).toMatchObject({ status: 400, body: { error: 'OPS_SNAPSHOT_INVALID', message: 'services[0].detail looks like a credential' } });
    expect(answer.body.message).not.toContain('9999');
    expect(store.count()).toBe(0);
  });
});

describe('POST /v1/platform/ops/snapshot', () => {
  it('answers with the receipt and nothing of the snapshot', async () => {
    const { report } = await harness();
    expect(await report()).toEqual({ status: 200, body: { schemaVersion: 1, receivedAt: START, reportAfterSeconds: 60, staleAfterSeconds: 180 } });
  });

  it('refuses a body over 64 KiB and keeps the stored snapshot', async () => {
    const { report, read, store } = await harness();
    await report();
    const body = snapshot();
    body.skills = Array.from({ length: 700 }, (_, index) => ({ name: `skill-${index}`, description: 'x'.repeat(100) }));
    expect(JSON.stringify(body).length).toBeGreaterThan(OPS_LIMITS.bodyBytes);
    expect(await report(body)).toMatchObject({ status: 413, body: { error: 'REQUEST_TOO_LARGE' } });
    expect(store.count()).toBe(1);
    expect((await read()).body.snapshot.skills).toHaveLength(1);
  });

  it('refuses malformed JSON, an empty body and an invalid snapshot with 400', async () => {
    const { report, store } = await harness();
    expect(await report('{"scopeKey":')).toMatchObject({ status: 400, body: { error: 'OPS_SNAPSHOT_INVALID' } });
    expect(await report('')).toMatchObject({ status: 400, body: { error: 'OPS_SNAPSHOT_INVALID', message: 'body must be an object' } });
    const body = snapshot();
    body.conversation = [{ text: 'hello' }];
    expect(await report(body)).toEqual({ status: 400, body: { error: 'OPS_SNAPSHOT_INVALID', message: 'conversation is not allowed' } });
    expect(store.count()).toBe(0);
  });

  it('keeps one row per scope and replaces it with the latest report', async () => {
    const { report, read, store, advance } = await harness();
    await report();
    advance(60 * SECOND);
    const next = snapshot();
    next.scopeKey = 'another-name';
    next.services = [{ id: 'discord', label: 'Discord', category: 'platform', status: 'stopped' }];
    next.minebot = [];
    next.kpi.postsToday = 4;
    expect((await report(next)).status).toBe(200);
    expect(store.count()).toBe(1);
    const answer = (await read()).body;
    expect(answer.receivedAt).toBe('2026-10-02T03:01:00.000Z');
    expect(answer.snapshot.services).toEqual([{ id: 'discord', label: 'Discord', category: 'platform', status: 'stopped' }]);
    expect(answer.snapshot.minebot).toEqual([]);
    expect(answer.snapshot.kpi?.postsToday).toBe(4);
    // The scope is the bridge's, whatever the reporter names.
    expect(store.latest('another-name')).toBeNull();
    expect(store.latest('owner')).not.toBeNull();
  });

  it('survives a restart in the database file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-ops-'));
    directories.push(directory);
    const path = join(directory, 'ops.sqlite');
    const first = new SQLiteOpsStore(path);
    const { report } = await harness({ store: first });
    await report();
    first.close();
    const reopened = new SQLiteOpsStore(path);
    expect(reopened.latest('owner')?.snapshot.kpi?.apiCallsToday).toBe(97);
    expect(reopened.count()).toBe(1);
    reopened.close();
  });

  it('limits how often a snapshot is accepted', async () => {
    const { report } = await harness();
    for (let index = 0; index < OPS_LIMITS.snapshotsPerMinute; index += 1) expect((await report()).status).toBe(200);
    expect(await report()).toMatchObject({ status: 429, body: { error: 'RATE_LIMITED' } });
  });
});

describe('GET /v1/ops', () => {
  it('answers 200 with a null snapshot before any report', async () => {
    const { read } = await harness();
    expect(await read()).toEqual({ status: 200, body: {
      schemaVersion: 1, snapshot: null, receivedAt: null, stale: true, staleAfterSeconds: 180, commands: [], commandsSupported: false, allowed: NOTHING_ALLOWED,
    } });
  });

  it('returns the snapshot without the reported scope key', async () => {
    const { report, read } = await harness();
    await report();
    const { scopeKey: _scopeKey, ...expected } = snapshot();
    expect((await read()).body).toEqual({
      schemaVersion: 1, snapshot: expected, receivedAt: START, stale: false, staleAfterSeconds: 180, commands: [], commandsSupported: false, allowed: NOTHING_ALLOWED,
    });
  });

  it('marks the snapshot stale after the window and fresh again on the next report', async () => {
    const { report, read, advance } = await harness();
    await report();
    advance(OPS_LIMITS.staleAfterSeconds * SECOND);
    expect((await read()).body.stale).toBe(false);
    advance(SECOND);
    const stale = (await read()).body;
    expect(stale.stale).toBe(true);
    expect(stale.snapshot).not.toBeNull();
    expect(stale.receivedAt).toBe(START);
    await report();
    expect((await read()).body.stale).toBe(false);
  });

  it('judges staleness by the server arrival time, not the reported time', async () => {
    const { report, read } = await harness();
    const body = snapshot();
    body.reportedAt = '2026-09-01T00:00:00.000Z';
    await report(body);
    expect((await read()).body).toMatchObject({ stale: false, receivedAt: START, snapshot: { reportedAt: '2026-09-01T00:00:00.000Z' } });
  });
});

describe('SHANNON_PLATFORM_OPS_INGEST', () => {
  it('is on unless switched off', () => {
    expect(opsIngestEnabled({})).toBe(true);
    expect(opsIngestEnabled({ SHANNON_PLATFORM_OPS_INGEST: 'on' })).toBe(true);
    for (const value of ['off', 'OFF', 'false', '0', ' disabled ']) expect(opsIngestEnabled({ SHANNON_PLATFORM_OPS_INGEST: value })).toBe(false);
  });

  it('refuses a snapshot and hides a stored one when off', async () => {
    const environment: Record<string, string> = {};
    const { report, read, store } = await harness({ environment });
    await report();
    environment.SHANNON_PLATFORM_OPS_INGEST = 'off';
    expect(await report()).toMatchObject({ status: 403, body: { error: 'OPS_INGEST_DISABLED' } });
    expect((await report(snapshot(), null)).status).toBe(401);
    expect(await read()).toEqual({ status: 200, body: {
      schemaVersion: 1, snapshot: null, receivedAt: null, stale: true, staleAfterSeconds: 180, commands: [], commandsSupported: false, allowed: NOTHING_ALLOWED,
    } });
    expect(store.count()).toBe(1);
    delete environment.SHANNON_PLATFORM_OPS_INGEST;
    expect((await read()).body.snapshot).not.toBeNull();
  });
});

describe('the snapshot stays out of every prompt', () => {
  const cognitionRoot = resolve(import.meta.dirname, '../../../packages/cognition/src');
  const owners = new Set(['opsContract.ts', 'opsStore.ts', 'serverOpsRoutes.ts', 'opsCommandContract.ts', 'opsCommandStore.ts', 'serverOpsCommandRoutes.ts', 'opsMinecraftLifecycleContract.ts', 'opsLifecycleAuthority.ts']);
  const markers = /opsStore|opsContract|serverOpsRoutes|ops_snapshots|OpsSnapshot|SQLiteOpsStore|opsReadResponse|opsCommand|OpsCommand|ops_commands|OPS_COMMAND|serverOpsCommandRoutes/u;

  it('is referenced by the ops files and the server entry point only', () => {
    const files = apiSourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(300);
    const referencing = files.filter(path => !owners.has(basename(path)) && markers.test(readFileSync(path, 'utf8'))).map(path => basename(path));
    expect(referencing.sort()).toEqual(['minecraftLifecycleWiring.ts', 'opsMinecraftLifecycleWiring.ts', 'server.ts']);
    for (const file of ['minecraftLifecycleWiring.ts', 'opsMinecraftLifecycleWiring.ts', 'opsLifecycleAuthority.ts']) {
      expect(readApiSource(file)).not.toMatch(/ops_snapshots|OpsSnapshot|SQLiteOpsStore|opsReadResponse/u);
    }
    for (const name of owners) expect(apiSourceFile(name), name).toBeTruthy();
    expect(readdirSync(cognitionRoot).length).toBeGreaterThanOrEqual(30);
    expect(readdirSync(cognitionRoot).filter(name => markers.test(readFileSync(join(cognitionRoot, name), 'utf8')))).toEqual([]);
  });

  it('is never handed to the kernel, a worker or the platform bridge by the server', () => {
    const server = readApiSource('server.ts');
    const uses = server.split('\n').filter(line => /\bopsStore\b/u.test(line) && !line.startsWith('import ')).map(line => line.trim());
    const commandBridge = uses.find(line => line.startsWith('const lifecycle = configuredMinecraftLifecycle('));
    expect(commandBridge).toContain('ops: mind?.actions ? { commands: opsStore.commands, actions: mind.actions, enabled: () => opsCommandsEnabled(process.env) } : undefined');
    expect(commandBridge!.replace('opsStore.commands', '')).not.toMatch(/\bopsStore\b/u);
    expect(uses.filter(line => line !== commandBridge)).toEqual([
      'const opsStore = new SQLiteOpsStore(configuredDatabasePath());',
      'store: opsStore, bridge: platformBridge?.configuration ?? null, ingestEnabled: () => opsIngestEnabled(process.env), now,',
      'opsStore.close();',
    ]);
    expect(server.split('\n').filter(line => /\bopsRoute\b/u.test(line))).toHaveLength(2);
    // The lifecycle bridge receives only the command journal, never the operational snapshot.
    // The import is compared without its specifier, which names a folder; where it leads is checked as a resolved path.
    expect(server.split('\n').filter(line => /opsCommand/iu.test(line) && line.trim() !== commandBridge).map(line => line.trim().replace(/ from '[^']+';$/u, " from '…';"))).toEqual([
      "import { opsCommandsEnabled } from '…';",
      'commandsEnabled: () => opsCommandsEnabled(process.env), minecraftLifecycle: () => lifecycle?.ops ?? null,',
    ]);
    expect(resolvedImports('server.ts')).toContain(apiSourcePath('opsCommandContract.ts'));
  });

  it('imports nothing that builds a prompt or calls a model', () => {
    const allowed = ['node:http', 'node:sqlite', 'node:crypto', '@shannon/cognition', ...['apiAuth.ts', 'apiValidation.ts', 'opsContract.ts',
      'opsStore.ts', 'serverHttp.ts', 'sqliteStoreContext.ts', 'opsCommandContract.ts', 'opsCommandStore.ts',
      'serverOpsCommandRoutes.ts', 'opsMinecraftLifecycleContract.ts', 'minecraftLifecycleContract.ts', 'actionThreadContract.ts',
      // The one read path of action leases (Syzygy ADR-0009 stage 1, S1): synchronous reads, no prompt, no model.
      'actionLeaseReader.ts'].map(apiSourcePath)];
    for (const name of owners) {
      const imports = resolvedImports(name);
      expect(imports.length, name).toBeGreaterThan(0);
      for (const source of imports) expect(allowed, `${name} imports ${source}`).toContain(source);
    }
    expect(readApiSource('opsContract.ts')).toContain("import { looksSecret } from '@shannon/cognition';");
  });
});

describe('docs/ops-contract.md', () => {
  it('states the routes, the bounds, the errors, the commands and what is still open', () => {
    const document = readFileSync(resolve(import.meta.dirname, '../../../docs/ops-contract.md'), 'utf8');
    for (const word of ['/v1/platform/ops/snapshot', '/v1/ops', 'SHANNON_PLATFORM_OPS_INGEST', 'OPS_SNAPSHOT_INVALID', 'OPS_INGEST_DISABLED',
      'PLATFORM_BRIDGE_UNAUTHORIZED', 'PLATFORM_BRIDGE_NOT_CONFIGURED', 'REQUEST_TOO_LARGE', 'RATE_LIMITED', 'PAIRING_REQUIRED',
      'commandsSupported', 'staleAfterSeconds', '/v1/ops/commands', '/v1/platform/ops/commands/claim', '/v1/platform/ops/commands/{id}/report',
      'schedule.run', 'service.start', 'service.stop', 'minecraft.start', 'minecraft.stop', 'progressive-lab-', 'idempotencyKey',
      'SHANNON_PLATFORM_OPS_COMMANDS', 'OPS_COMMANDS_DISABLED', 'OPS_STALE', 'TARGET_UNKNOWN', 'TARGET_NOT_ALLOWED', 'IDEMPOTENCY_KEY_REUSED',
      'TOO_MANY_OPEN_COMMANDS', 'OPS_COMMAND_NOT_FOUND', 'OPS_COMMAND_NOT_CLAIMED', 'OPS_COMMAND_FINISHED', 'no_report', 'ops_commands',
      'Open questions', ...OPS_COMMAND_REPORT_CODES.map(code => `\`${code}\``),
      ...[...OPS_SERVICE_START_ALLOWED, ...OPS_SERVICE_STOP_ALLOWED].map(id => `\`${id}\``),
      `${OPS_COMMAND_LIMITS.open} open`, `${OPS_COMMAND_LIMITS.perHour} an hour`, `${OPS_COMMAND_LIMITS.claimWithinSeconds} seconds`,
      `${OPS_COMMAND_LIMITS.reportWithinSeconds} seconds`, `last ${OPS_COMMAND_LIMITS.recent}`,
      `${OPS_LIMITS.shortLabel} `, `${OPS_LIMITS.staleAfterSeconds} `]) expect(document, word).toContain(word);
    expect(document).not.toContain('not built');
  });
});
