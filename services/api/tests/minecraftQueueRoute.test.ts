import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MINECRAFT_QUEUE_PATH, parsedMinecraftQueueRequest } from '../src/contracts/minecraftQueueContract.js';
import { createMinecraftBodyWiring } from '../src/wiring/serverMinecraftBodyWiring.js';
import { fcaMinecraftQueue } from '../src/wiring/fcaMinecraftQueue.js';
import { underWriteLock } from '../src/infra/sqlite/lockWaits.js';

const DEVICE = 'minebot-dev';
const CONFIGURATION = JSON.stringify({ deviceId: DEVICE, servers: [{ serverId: 'lab', ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146', title: 'ラボ', onlineMode: true }] });
const directories: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-minecraft-queue-'));
  directories.push(directory);
  const wiring = createMinecraftBodyWiring({ SHANNON_MINECRAFT_BODY_JSON: CONFIGURATION }, join(directory, 'shannon.sqlite'));
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  const tasks = new Map<string, string>();
  let counter = 0;
  const queue = fcaMinecraftQueue({
    db, scopeKey: 'owner', atomic: work => underWriteLock(db, null, '', work, 'queue_route_test'),
    phase: id => tasks.get(id) ?? null,
    open: () => [...tasks].filter(([, phase]) => phase === 'executing').map(([taskId]) => ({ taskId, goal: taskId, phase: 'executing', origin: null })),
    bodyReady: () => true,
    stop: async id => { tasks.set(id, 'stopped'); },
    resume: id => { tasks.set(id, 'executing'); return true; },
    start: async () => { counter += 1; tasks.set(`task-${counter}`, 'executing'); return `task-${counter}`; },
    now: () => '2026-11-21T00:00:00.000Z', log: () => undefined,
  });
  const call = (method: string, url: string, body = '', who = DEVICE, scope = 'owner') => {
    const done: { status?: number; body?: unknown } = {};
    const response = { writeHead: (status: number) => { done.status = status; }, end: (text: string) => { done.body = JSON.parse(text); } } as unknown as ServerResponse;
    const incoming = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method, url, headers: { authorization: '' } }) as unknown as IncomingMessage;
    return wiring.serve(incoming, response, MINECRAFT_QUEUE_PATH, { deviceId: who, scopeKey: scope, displayName: who })
      .then(handled => ({ handled, ...done }));
  };
  return { wiring, queue, call };
}

describe('the owner\'s list of requests on the game device\'s route', () => {
  it('is not enabled before the list is connected, and is for the body device of the owner only', async () => {
    const { wiring, queue, call } = setup();
    expect(await call('GET', MINECRAFT_QUEUE_PATH)).toMatchObject({ handled: true, status: 503, body: { error: 'FCA_BODY_NOT_ENABLED' } });
    wiring.connectControl({ control: { latest: () => null } as never, intent: async () => ({ kind: 'none', goal: '' }), queue });
    expect(await call('GET', MINECRAFT_QUEUE_PATH, '', 'owner-iphone')).toMatchObject({ status: 403, body: { error: 'FCA_BODY_DEVICE_DENIED' } });
    expect(await call('GET', MINECRAFT_QUEUE_PATH, '', DEVICE, 'someone')).toMatchObject({ status: 403 });
    expect(await call('DELETE', MINECRAFT_QUEUE_PATH)).toMatchObject({ status: 405 });
    wiring.close();
  });

  it('reads the list (and the same revision as unchanged) and takes the operations of the mod\'s screen', async () => {
    const { wiring, queue, call } = setup();
    wiring.connectControl({ control: { latest: () => null } as never, intent: async () => ({ kind: 'none', goal: '' }), queue });
    expect(await call('GET', MINECRAFT_QUEUE_PATH)).toMatchObject({ status: 200, body: { rev: 0, autoRun: true, entries: [], recent: [] } });
    const added = await call('POST', MINECRAFT_QUEUE_PATH, JSON.stringify({ op: 'add', goal: 'ケーキを作る' }));
    expect(added).toMatchObject({ status: 200, body: { ok: true, code: 'ok', queue: { entries: [{ goal: 'ケーキを作る', state: 'running', origin: 'mod', seq: 1, pos: 0 }] } } });
    await call('POST', MINECRAFT_QUEUE_PATH, JSON.stringify({ op: 'add', goal: '木材を1スタック集める', placement: 'next' }));
    const listed = (await call('GET', MINECRAFT_QUEUE_PATH)).body as { rev: number; entries: Array<{ id: string; goal: string }> };
    expect(listed.entries.map(entry => entry.goal)).toEqual(['ケーキを作る', '木材を1スタック集める']);
    expect(await call('GET', `${MINECRAFT_QUEUE_PATH}?since=${listed.rev}`)).toMatchObject({ status: 200, body: { rev: listed.rev, unchanged: true } });
    expect(await call('GET', `${MINECRAFT_QUEUE_PATH}?since=${listed.rev - 1}`)).toMatchObject({ body: { entries: [{}, {}] } });
    // By entry id, and by 「#2」.
    expect(await call('POST', MINECRAFT_QUEUE_PATH, JSON.stringify({ op: 'delete', id: listed.entries[0]!.id }))).toMatchObject({ body: { ok: false, code: 'running' } });
    expect(await call('POST', MINECRAFT_QUEUE_PATH, JSON.stringify({ op: 'hold', id: '#1' }))).toMatchObject({ body: { ok: true, queue: { entries: [{ goal: '木材を1スタック集める', state: 'running' }, { state: 'paused' }] } } });
    expect(await call('POST', MINECRAFT_QUEUE_PATH, JSON.stringify({ op: 'delete', id: '#9' }))).toMatchObject({ body: { ok: false, code: 'not_found' } });
    expect(await call('POST', MINECRAFT_QUEUE_PATH, JSON.stringify({ op: 'stop' }))).toMatchObject({ body: { ok: true, queue: { autoRun: false } } });
    expect(await call('POST', MINECRAFT_QUEUE_PATH, JSON.stringify({ op: 'start' }))).toMatchObject({ body: { ok: true, queue: { autoRun: true, entries: [{ state: 'running' }, { state: 'paused' }] } } });
    wiring.close();
  });

  it('refuses an input that is not an operation of the list', async () => {
    const { wiring, queue, call } = setup();
    wiring.connectControl({ control: { latest: () => null } as never, intent: async () => ({ kind: 'none', goal: '' }), queue });
    for (const body of ['', '[1]', '{bad', '{"op":"fly"}', '{"op":"add","goal":1}', '{"op":"add","extra":1}', '{"op":"delete","id":"a b"}', '{"op":"add","placement":"later"}']) {
      expect(await call('POST', MINECRAFT_QUEUE_PATH, body), body).toMatchObject({ status: 400, body: { error: 'MINECRAFT_QUEUE_INPUT_INVALID' } });
    }
    expect(await call('POST', MINECRAFT_QUEUE_PATH, '{"op":"add","goal":"  "}')).toMatchObject({ status: 200, body: { ok: false, code: 'invalid' } });
    wiring.close();
  });

  it('reads a request: only the fields of the contract', () => {
    expect(parsedMinecraftQueueRequest({ op: 'move', id: '#3', before: null })).toEqual({ op: 'move', id: '#3', before: null });
    expect(parsedMinecraftQueueRequest({ op: 'move', before: 'x' })).toEqual({ op: 'move', before: 'x' });
    expect(parsedMinecraftQueueRequest({ op: 'add', goal: 'x', placement: 'now', requestId: 'mod:1' })).toMatchObject({ placement: 'now' });
    expect(parsedMinecraftQueueRequest({ id: 'x' })).toBeNull();
    expect(parsedMinecraftQueueRequest({ op: 'add', toString: 'x' })).toBeNull();
    // A sender that fills what it does not mean with nothing (empty texts): the fields are not sent.
    expect(parsedMinecraftQueueRequest({ op: 'add', goal: 'x', id: '', before: '', requestId: '', placement: '' })).toEqual({ op: 'add', goal: 'x' });
    expect(parsedMinecraftQueueRequest({ op: 'cancel', id: null, requestId: null })).toEqual({ op: 'cancel' });
    expect(parsedMinecraftQueueRequest({ op: 'add', goal: 'x', sender: 'mod' })).toBeNull();
    expect(parsedMinecraftQueueRequest(null)).toBeNull();
  });
});
