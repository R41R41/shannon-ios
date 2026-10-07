import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { SQLiteAppLookStore } from '../src/surfaces/body/store/appLookStore.js';
import { SQLiteBodyLookActivityStore } from '../src/surfaces/body/store/bodyLookActivityStore.js';
import { SQLiteBodyLookStore } from '../src/surfaces/body/store/bodyLookStore.js';
import { SQLiteBodyReactionStore } from '../src/surfaces/body/store/bodyReactionStore.js';
import { SQLiteBodyStore } from '../src/surfaces/body/store/bodyStore.js';
import { SQLiteIncomingCallStore } from '../src/mind/attention/store/incomingCallStore.js';
import { SQLiteInitiativeStore } from '../src/surfaces/outreach/store/initiativeStore.js';
import { SQLiteReachOutReports } from '../src/mind/attention/store/reachOutReports.js';
import { createShannonNowRoute, shannonNowResponse } from '../src/infra/http/serverShannonNowRoute.js';
import { SHANNON_NOW_LIMITS, SHANNON_NOW_PATH, shannonNowEnabled, shannonNowOwnerScope, type ShannonNowResponse } from '../src/contracts/shannonNowContract.js';
import { SQLiteShannonNowReader, type ReachOutDeliverySource } from '../src/mind/self/store/shannonNowReader.js';
import { readApiSource } from './support/sources.js';

const NOW = '2026-10-03T07:00:00.000Z';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const OWNER = 'owner';
const ago = (milliseconds: number) => new Date(Date.parse(NOW) - milliseconds).toISOString();

const source = (name: string) => readApiSource(name);
const servers: Array<ReturnType<typeof createServer>> = [];
const directories: string[] = [];
const closers: Array<{ close(): void }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))));
  for (const handle of closers.splice(0)) handle.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-now-test-'));
  directories.push(directory);
  return join(directory, 'shannon.sqlite');
}

type Caller = { scopeKey: string; deviceId: string } | null;

async function harness(options: { path?: string; environment?: Record<string, string>; sources?: readonly ReachOutDeliverySource[] } = {}) {
  const path = options.path ?? databasePath();
  const clock = { at: NOW };
  const stateStore = new InMemoryCompanionStateStore(() => clock.at);
  const reader = new SQLiteShannonNowReader(path, options.sources);
  closers.push(reader);
  const environment = options.environment ?? {};
  const route = createShannonNowRoute({
    reader, snapshot: scopeKey => stateStore.snapshot(scopeKey), now: () => clock.at,
    enabled: () => shannonNowEnabled(environment), ownerScopeKey: shannonNowOwnerScope(environment),
  });
  const callers: Record<string, Caller> = {
    'Bearer owner-phone': { scopeKey: OWNER, deviceId: 'iphone' },
    'Bearer guest-phone': { scopeKey: 'guest-of-the-evening', deviceId: 'guest-iphone' },
    // A fixed local token is authorized by the server and is no paired device.
    'Bearer fixed-local-token': null,
  };
  const server = createServer((request, response) => {
    route(request, response, callers[request.headers.authorization ?? ''] ?? null);
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address() as { port: number };
  const read = async (authorization = 'Bearer owner-phone', method = 'GET', query = '') => {
    const response = await fetch(`http://127.0.0.1:${address.port}${SHANNON_NOW_PATH}${query}`, { method, headers: { authorization } });
    return { status: response.status, body: await response.json() as ShannonNowResponse & { error?: string } };
  };
  return { path, clock, stateStore, read };
}

/** The tables as their own stores create them, with one row of each kind for the owner. */
function seed(path: string) {
  const looks = new SQLiteBodyLookStore(path);
  const appLooks = new SQLiteAppLookStore(path);
  const lookActivity = new SQLiteBodyLookActivityStore(path);
  const reactions = new SQLiteBodyReactionStore(path);
  const body = new SQLiteBodyStore(path);
  const reports = new SQLiteReachOutReports(path);
  const initiatives = new SQLiteInitiativeStore(path, () => NOW);
  closers.push(looks, appLooks, lookActivity, reactions, body, reports, initiatives);
  const raw = new DatabaseSync(path);
  closers.push(raw);
  const reachOut = (id: string, sourceItemId: string, dayKey: string, createdAt: string, scopeKey = OWNER) => raw.prepare(`
    INSERT INTO initiative_messages (initiative_id, scope_key, thread_id, source_item_id, source_title, source_url, content, expression, day_key, created_at)
    VALUES (?, ?, 'thread-1', ?, 'シャノンから', '', ?, 'curious', ?, ?)
  `).run(id, scopeKey, sourceItemId, `SECRET WORDS OF ${id}`, dayKey, createdAt);
  return { looks, appLooks, lookActivity, reactions, body, reports, raw, reachOut };
}

describe('GET /v1/shannon/now: who may read', () => {
  it('answers the owner\'s paired device and nobody else', async () => {
    const { read } = await harness();
    expect((await read()).status).toBe(200);
    // A device paired into another scope is a guest.
    expect(await read('Bearer guest-phone')).toMatchObject({ status: 403, body: { error: 'SHANNON_NOW_OWNER_ONLY' } });
    // A caller without a paired device: the fixed local token, or anything the server does not know.
    expect(await read('Bearer fixed-local-token')).toMatchObject({ status: 403, body: { error: 'PAIRED_DEVICE_REQUIRED' } });
    expect(await read('Bearer nobody')).toMatchObject({ status: 403, body: { error: 'PAIRED_DEVICE_REQUIRED' } });
    expect((await read('Bearer owner-phone', 'POST')).status).toBe(405);
  });

  it('never takes the scope from the request', async () => {
    const { path, read } = await harness();
    const { looks } = seed(path);
    looks.open({ id: 'look-of-owner', scopeKey: OWNER, deviceId: 'pc', threadId: 't', requestedAt: ago(MINUTE), expiresAt: NOW, ownerAsked: true }, '2026-10-03');
    looks.open({ id: 'look-of-guest', scopeKey: 'guest-of-the-evening', deviceId: 'pc', threadId: 't', requestedAt: ago(MINUTE), expiresAt: NOW, ownerAsked: true }, '2026-10-03');
    const guest = await read('Bearer guest-phone', 'GET', `?scopeKey=${OWNER}`);
    expect(guest.status).toBe(403);
    expect(JSON.stringify(guest.body)).not.toContain('look-of');
    const owner = await read('Bearer owner-phone', 'GET', '?scopeKey=guest-of-the-evening');
    expect(owner.body.looks.map(look => look.id)).toEqual(['look-of-owner']);
  });

  it('is switched off by SHANNON_NOW_READ, and uses the owner scope the server is configured with', async () => {
    for (const value of ['off', 'false', '0', 'disabled', ' OFF ']) {
      expect(shannonNowEnabled({ SHANNON_NOW_READ: value })).toBe(false);
    }
    expect(shannonNowEnabled({})).toBe(true);
    expect(shannonNowEnabled({ SHANNON_NOW_READ: 'on' })).toBe(true);
    const off = await harness({ environment: { SHANNON_NOW_READ: 'off' } });
    expect(await off.read()).toMatchObject({ status: 403, body: { error: 'SHANNON_NOW_DISABLED' } });
    // Switched off, a guest still learns nothing about the switch.
    expect(await off.read('Bearer guest-phone')).toMatchObject({ status: 403, body: { error: 'SHANNON_NOW_OWNER_ONLY' } });

    const renamed = await harness({ environment: { SHANNON_OWNER_SCOPE_KEY: 'guest-of-the-evening' } });
    expect((await renamed.read('Bearer guest-phone')).status).toBe(200);
    expect((await renamed.read()).status).toBe(403);
  });

  it('limits reads per device', async () => {
    const { read } = await harness();
    for (let index = 0; index < SHANNON_NOW_LIMITS.readsPerMinute; index += 1) expect((await read()).status).toBe(200);
    expect(await read()).toMatchObject({ status: 429, body: { error: 'RATE_LIMITED' } });
  });
});

describe('GET /v1/shannon/now: what it answers', () => {
  it('is empty and truthful on a database with none of the tables', async () => {
    const { read } = await harness();
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body).toMatchObject({
      schemaVersion: 1, generatedAt: NOW, looks: [], touches: [], reachOuts: [],
      body: { known: false, present: false, lastReadAt: null, camera: null },
      feeling: { present: null, lingering: [] },
      limits: { items: 30, days: 14 },
    });
    expect(body.feeling.mood.expression).toEqual(expect.any(String));
  });

  it('never causes a first state to be stored, and leaves out a part whose table is in another shape', async () => {
    const path = databasePath();
    const { looks, raw } = seed(path);
    const reader = new SQLiteShannonNowReader(path);
    closers.push(reader);
    // No state table at all, then a table without a row for the owner: neither is a state.
    expect(reader.hasState(OWNER)).toBe(false);
    raw.exec('CREATE TABLE companion_states (scope_key TEXT PRIMARY KEY, version INTEGER, updated_at TEXT, snapshot_json TEXT)');
    expect(reader.hasState(OWNER)).toBe(false);
    let asked = 0;
    const answer = shannonNowResponse({ reader, now: () => NOW, snapshot: scopeKey => { asked += reader.hasState(scopeKey) ? 1 : 0; return null; } }, OWNER);
    expect(asked).toBe(0);
    expect(answer.feeling).toEqual({ mood: { expression: 'neutral' }, present: null, lingering: [] });
    raw.prepare('INSERT INTO companion_states VALUES (?, 1, ?, ?)').run(OWNER, NOW, '{}');
    expect(reader.hasState(OWNER)).toBe(true);
    // The server wires exactly this guard in front of the state store.
    expect(source('server.ts')).toContain('shannonNowReader.hasState(scopeKey) ? persistentStore.snapshot(scopeKey) : null');

    // The reader's own connection refuses a write.
    expect(() => (reader as unknown as { database: DatabaseSync }).database.exec('DELETE FROM body_looks')).toThrow();

    looks.open({ id: 'look-1', scopeKey: OWNER, deviceId: 'pc', threadId: 't', requestedAt: ago(MINUTE), expiresAt: NOW, ownerAsked: true }, '2026-10-03');
    raw.exec('DROP TABLE body_touch_bursts; CREATE TABLE body_touch_bursts (scope_key TEXT, something_else TEXT)');
    raw.exec('DROP TABLE app_looks; CREATE TABLE app_looks (scope_key TEXT)');
    expect(reader.touches(OWNER, ago(DAY))).toEqual([]);
    expect(reader.looks(OWNER, ago(DAY)).map(look => look.id)).toEqual(['look-1']);
  });

  it('says whether a desktop body read presence lately', async () => {
    const { path, read, clock } = await harness();
    const { reports, lookActivity, body } = seed(path);
    expect((await read()).body.body).toMatchObject({ known: false, present: false, camera: null });

    reports.markPresence(OWNER, 'pc', ago(20_000));
    body.saveCapabilities(OWNER, 'pc', { expressions: [], gestures: [], flags: { camera: true } }, NOW);
    expect((await read()).body.body).toEqual({ known: true, present: true, lastReadAt: ago(20_000), freshSeconds: 75, camera: true });

    // The newer of the two places a presence read is noted counts.
    lookActivity.markPresence(OWNER, 'pc', ago(5_000));
    expect((await read()).body.body.lastReadAt).toBe(ago(5_000));

    // A body of another scope says nothing about the owner's.
    reports.markPresence('guest-of-the-evening', 'pc', NOW);
    expect((await read()).body.body.lastReadAt).toBe(ago(5_000));

    clock.at = new Date(Date.parse(NOW) + 10 * MINUTE).toISOString();
    expect((await read()).body.body).toMatchObject({ known: true, present: false, lastReadAt: ago(5_000) });
  });

  it('lists looks of the body and of the app with who asked and how they ended, and nothing she saw', async () => {
    const { path, read } = await harness();
    const { looks, appLooks, lookActivity } = seed(path);
    looks.open({ id: 'look-asked', scopeKey: OWNER, deviceId: 'pc', threadId: 'thread-1', requestedAt: ago(40 * MINUTE), expiresAt: NOW, ownerAsked: true }, '2026-10-03');
    looks.advance(OWNER, 'look-asked', 'pending', 'seeing', ago(39 * MINUTE), { frameReceived: true });
    looks.advance(OWNER, 'look-asked', 'seeing', 'seen', ago(39 * MINUTE));
    looks.open({ id: 'look-own', scopeKey: OWNER, deviceId: 'pc', threadId: 'activity:own-time', requestedAt: ago(30 * MINUTE), expiresAt: NOW, ownerAsked: false }, '2026-10-03');
    looks.advance(OWNER, 'look-own', 'pending', 'refused', ago(30 * MINUTE), { code: 'camera_off' });
    // Her note about a look waits in the hand-off table for her loop; it is never read here.
    lookActivity.begin(OWNER, 'look-own', 'model', ago(30 * MINUTE));
    lookActivity.keepNote(OWNER, 'look-own', 'NOTE OF WHAT SHE SAW');
    appLooks.open({
      id: 'look-app', scopeKey: OWNER, deviceId: 'iphone', threadId: 'thread-1', camera: 'back', platform: 'ios',
      requestedAt: ago(20 * MINUTE), expiresAt: NOW, announced: true, guarded: false,
    }, ago(60 * MINUTE));
    looks.open({ id: 'look-open', scopeKey: OWNER, deviceId: 'pc', threadId: 'thread-1', requestedAt: ago(MINUTE), expiresAt: NOW, ownerAsked: false }, '2026-10-03');

    const { body } = await read();
    expect(body.looks).toEqual([
      { id: 'look-open', at: ago(MINUTE), askedBy: 'herself', surface: 'body', outcome: 'looking' },
      { id: 'look-app', at: ago(20 * MINUTE), askedBy: 'unknown', surface: 'app', outcome: 'looking' },
      { id: 'look-own', at: ago(30 * MINUTE), askedBy: 'herself', surface: 'body', outcome: 'refused', code: 'camera_off' },
      { id: 'look-asked', at: ago(40 * MINUTE), askedBy: 'owner', surface: 'body', outcome: 'seen' },
    ]);
    const text = JSON.stringify(body);
    expect(text).not.toContain('NOTE OF WHAT SHE SAW');
    for (const forbidden of ['image', 'base64', 'frame', 'note', 'thread']) expect(text.toLowerCase()).not.toContain(forbidden);
  });

  it('lists touches with their kind and whether she answered, never her line', async () => {
    const { path, read } = await harness();
    const { reactions } = seed(path);
    const first = reactions.recordTouch(OWNER, { id: 'touch-1', type: 'pet', audience: 'owner', occurredAt: ago(50 * MINUTE), durationMs: 900 }, ago(50 * MINUTE));
    reactions.recordTouch(OWNER, { id: 'touch-2', type: 'pet', audience: 'owner', occurredAt: ago(49 * MINUTE) }, ago(49 * MINUTE));
    reactions.addSaid(OWNER, first.burst.id, 'HER LINE AFTER THE TOUCH', false);
    const poke = reactions.recordTouch(OWNER, { id: 'touch-3', type: 'poke', audience: 'owner', occurredAt: ago(10 * MINUTE) }, ago(10 * MINUTE));
    reactions.recordTouch('guest-of-the-evening', { id: 'touch-4', type: 'tickle', audience: 'owner', occurredAt: ago(MINUTE) }, ago(MINUTE));

    const { body } = await read();
    expect(body.touches).toEqual([
      { id: poke.burst.id, at: ago(10 * MINUTE), kind: 'poke', count: 1, answered: false },
      { id: first.burst.id, at: ago(49 * MINUTE), kind: 'pet', count: 2, answered: true },
    ]);
    expect(JSON.stringify(body)).not.toContain('HER LINE');
  });

  it('says which part was touched and on which surface, in the words she is told, when the run knows them', async () => {
    const { path, read } = await harness();
    const { reactions } = seed(path);
    const cheek = reactions.recordTouch(OWNER, { id: 'p-1', type: 'poke', audience: 'owner', occurredAt: ago(30 * MINUTE), region: 'face', surface: 'iphone' }, ago(30 * MINUTE));
    const head = reactions.recordTouch(OWNER, { id: 'p-2', type: 'pet', audience: 'owner', occurredAt: ago(20 * MINUTE), region: 'head', surface: 'windows' }, ago(20 * MINUTE));
    // A run whose touches named different parts and surfaces names none.
    const mixed = reactions.recordTouch(OWNER, { id: 'p-3', type: 'tickle', audience: 'owner', occurredAt: ago(10 * MINUTE), region: 'side', surface: 'mac' }, ago(10 * MINUTE));
    reactions.recordTouch(OWNER, { id: 'p-4', type: 'tickle', audience: 'owner', occurredAt: ago(9 * MINUTE), region: 'face', surface: 'iphone' }, ago(9 * MINUTE));
    const hand = reactions.recordTouch(OWNER, { id: 'p-5', type: 'holdHand', audience: 'owner', occurredAt: ago(5 * MINUTE), region: 'hand', surface: 'mac' }, ago(5 * MINUTE));

    const { body } = await read();
    expect(body.touches).toEqual([
      // Holding hands names the hand already: the part is told, and no phrase replaces the client's own word.
      { id: hand.burst.id, at: ago(5 * MINUTE), kind: 'holdHand', count: 1, answered: false, region: 'hand', surface: 'mac', place: '（Macで）' },
      { id: mixed.burst.id, at: ago(9 * MINUTE), kind: 'tickle', count: 2, answered: false },
      { id: head.burst.id, at: ago(20 * MINUTE), kind: 'pet', count: 1, answered: false, region: 'head', surface: 'windows', place: '（Windowsで）', phrase: '頭をなでられた' },
      { id: cheek.burst.id, at: ago(30 * MINUTE), kind: 'poke', count: 1, answered: false, region: 'face', surface: 'iphone', place: '（iPhoneで）', phrase: '頬をつつかれた' },
    ]);
  });

  it('does not take a phone that only feels touch for her desktop body', async () => {
    const { path, read } = await harness();
    const { body } = seed(path);
    body.saveCapabilities(OWNER, 'iphone-1', { expressions: [], gestures: [], flags: { touchOnly: true, camera: true }, surface: 'iphone' }, NOW);
    // Only the phone registered: no body is known, none is present, and there is no body camera to speak of.
    expect((await read()).body.body).toMatchObject({ known: false, present: false, lastReadAt: null, camera: null });
    body.saveCapabilities(OWNER, 'pc', { expressions: [], gestures: [], flags: { camera: false } }, NOW);
    expect((await read()).body.body).toMatchObject({ camera: false });
  });

  it('lists messages she started with how each was delivered, never their words', async () => {
    const { path, read } = await harness();
    const { reports, raw, reachOut } = seed(path);
    reachOut('reach-1', 'reach-out:share:reach-1', 'reach-out:2026-10-03:1', ago(3 * 60 * MINUTE));
    reachOut('reach-2', 'reach-out:follow_up:reach-2', 'reach-out-follow-up:2026-10-03:reach-1', ago(2 * 60 * MINUTE));
    reachOut('reach-3', 'reach-out:a_reason_of_a_later_server:reach-3', 'reach-out:2026-10-03:2', ago(60 * MINUTE));
    reachOut('reach-guest', 'reach-out:share:reach-guest', 'reach-out:2026-10-03:1', ago(MINUTE), 'guest-of-the-evening');
    // Her daily topic is an initiative as well, and is not a message she started from her own activity.
    reachOut('topic-1', 'hn:123', '2026-10-03', ago(30 * MINUTE));
    expect(reports.report(OWNER, 'pc', 'reach-1', 'shown_spoken', ago(3 * 60 * MINUTE - 4_000))).toBe('stored');
    expect(reports.report(OWNER, 'laptop', 'reach-1', 'hidden', ago(3 * 60 * MINUTE - 5_000))).toBe('stored');
    expect(reports.report(OWNER, 'pc', 'reach-2', 'away', ago(2 * 60 * MINUTE - 5_000))).toBe('stored');
    // The iPhone said it in his earphones (private listening): the same table, with the surface named.
    expect(reports.report(OWNER, 'iphone', 'reach-3', 'shown_spoken', ago(60 * MINUTE - 3_000), 'iphone')).toBe('stored');
    raw.prepare('UPDATE initiative_messages SET read_at = ? WHERE initiative_id = ?').run(ago(2 * 60 * MINUTE + 30 * MINUTE), 'reach-1');

    const { body } = await read();
    expect(body.reachOuts).toEqual([
      { id: 'reach-3', at: ago(60 * MINUTE), deliveries: [{ surface: 'earphones', device: 'iphone', outcome: 'spoken', at: ago(60 * MINUTE - 3_000) }] },
      { id: 'reach-2', at: ago(2 * 60 * MINUTE), reason: 'follow_up', deliveries: [{ surface: 'body', outcome: 'away', at: ago(2 * 60 * MINUTE - 5_000) }] },
      {
        id: 'reach-1', at: ago(3 * 60 * MINUTE), reason: 'share', deliveries: [
          { surface: 'body', outcome: 'spoken', at: ago(3 * 60 * MINUTE - 4_000) },
          { surface: 'body', outcome: 'hidden', at: ago(3 * 60 * MINUTE - 5_000) },
          { surface: 'app', outcome: 'read', at: ago(2 * 60 * MINUTE + 30 * MINUTE) },
        ],
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('SECRET WORDS');
  });

  it('takes a later surface from its own source, and leaves a broken one out', async () => {
    const earphones: ReachOutDeliverySource = (database, scopeKey, ids, tableExists) => {
      if (!tableExists('private_listening_test')) return [];
      return (database.prepare('SELECT initiative_id, heard_at FROM private_listening_test WHERE scope_key = ?').all(scopeKey) as unknown as Array<{ initiative_id: string; heard_at: string }>)
        .filter(row => ids.includes(row.initiative_id)).map(row => ({ id: row.initiative_id, surface: 'earphones', outcome: 'spoken', at: row.heard_at }));
    };
    const broken: ReachOutDeliverySource = () => { throw new Error('a table in another shape'); };
    const { path, read } = await harness({ sources: [earphones, broken] });
    const { raw, reachOut } = seed(path);
    reachOut('reach-1', 'reach-out:wonder:reach-1', 'reach-out:2026-10-03:1', ago(10 * MINUTE));
    // The table of that surface does not exist yet: the message is listed without it.
    expect((await read()).body.reachOuts).toEqual([{ id: 'reach-1', at: ago(10 * MINUTE), reason: 'wonder', deliveries: [] }]);
    raw.exec('CREATE TABLE private_listening_test (scope_key TEXT, initiative_id TEXT, heard_at TEXT)');
    raw.prepare('INSERT INTO private_listening_test VALUES (?, ?, ?)').run(OWNER, 'reach-1', ago(9 * MINUTE));
    expect((await read()).body.reachOuts[0]!.deliveries).toEqual([{ surface: 'earphones', outcome: 'spoken', at: ago(9 * MINUTE) }]);
  });

  it('says how a call she rang him with ended', async () => {
    const { path, read } = await harness();
    const { raw, reachOut, reports } = seed(path);
    const calls = new SQLiteIncomingCallStore(path);
    closers.push(calls);
    const call = (id: string, state: string, minutesAgo: number, ended: number | null) => {
      reachOut(id, `reach-out:share:${id}`, `reach-out:2026-10-03:${id}`, ago(minutesAgo * MINUTE));
      raw.prepare(`
        INSERT INTO incoming_calls (call_id, scope_key, initiative_id, device_id, thread_id, state, created_at, expires_at, ended_at)
        VALUES (?, ?, ?, 'iphone', 'thread-1', ?, ?, ?, ?)
      `).run(`call-${id}`, OWNER, id, state, ago(minutesAgo * MINUTE - 1_000), NOW, ended === null ? null : ago(ended * MINUTE));
    };
    call('answered', 'answered', 50, 49);
    call('declined', 'declined', 40, 39.5);
    call('unanswered', 'unanswered', 30, 29);
    call('failed', 'failed', 20, 20);
    call('open', 'ringing', 1, null);
    // The iPhone also reported having said the answered one: the same event, listed once, as the call.
    expect(reports.report(OWNER, 'iphone', 'answered', 'shown_spoken', ago(48 * MINUTE), 'iphone')).toBe('stored');
    // A call of another scope is not the owner's.
    raw.prepare(`
      INSERT INTO incoming_calls (call_id, scope_key, initiative_id, device_id, thread_id, state, created_at, expires_at) VALUES ('x', 'guest-of-the-evening', 'open', 'g', 't', 'answered', ?, ?)
    `).run(NOW, NOW);

    const { body } = await read();
    const delivered = Object.fromEntries(body.reachOuts.map(item => [item.id, item.deliveries]));
    expect(delivered).toEqual({
      open: [{ surface: 'call', outcome: 'ringing', at: ago(MINUTE - 1_000) }],
      failed: [{ surface: 'call', outcome: 'failed', at: ago(20 * MINUTE) }],
      unanswered: [{ surface: 'call', outcome: 'unanswered', at: ago(29 * MINUTE) }],
      declined: [{ surface: 'call', outcome: 'declined', at: ago(39.5 * MINUTE) }],
      answered: [{ surface: 'call', outcome: 'answered', at: ago(49 * MINUTE) }],
    });
    expect(JSON.stringify(body)).not.toContain('SECRET WORDS');
  });

  it('holds each list to thirty entries and fourteen days', async () => {
    const { path, read } = await harness();
    const { reactions, reachOut, raw } = seed(path);
    for (let index = 0; index < 35; index += 1) {
      reachOut(`reach-${index}`, `reach-out:share:reach-${index}`, `reach-out:day-${index}:1`, ago((index + 1) * 60 * MINUTE));
      raw.prepare(`
        INSERT INTO body_touch_bursts (scope_key, burst_id, touch_type, started_at, last_at, touch_count) VALUES (?, ?, 'pet', ?, ?, 1)
      `).run(OWNER, `burst-${index}`, ago((index + 1) * 60 * MINUTE), ago((index + 1) * 60 * MINUTE));
    }
    reachOut('reach-old', 'reach-out:share:reach-old', 'reach-out:long-ago:1', ago(15 * DAY));
    reactions.recordTouch(OWNER, { id: 'touch-old', type: 'carry', audience: 'owner', occurredAt: ago(15 * DAY) }, ago(15 * DAY));
    const { body } = await read();
    expect(body.reachOuts).toHaveLength(30);
    expect(body.reachOuts[0]!.id).toBe('reach-0');
    expect(body.touches).toHaveLength(30);

    const quiet = await harness();
    const old = seed(quiet.path);
    old.reachOut('reach-old', 'reach-out:share:reach-old', 'reach-out:long-ago:1', ago(15 * DAY));
    old.reactions.recordTouch(OWNER, { id: 'touch-old', type: 'carry', audience: 'owner', occurredAt: ago(15 * DAY) }, ago(15 * DAY));
    expect((await quiet.read()).body).toMatchObject({ reachOuts: [], touches: [] });
  });

  it('gives her feeling as faces and strengths, and never why', async () => {
    const { read, stateStore, clock } = await harness();
    const felt = (primary: string, intensity: number, at: string) => stateStore.apply(OWNER, { type: 'expressive-emotion-updated', emotion: {
      primary, secondary: [], intensity, target: 'ライ氏', cause: 'CAUSE FROM THE CONVERSATION', arousal: 0.3, valence: -0.5,
      visibility: 'expressed', startedAt: at, decay: 0.24, carryover: 0.6, updatedAt: at,
    } as never });
    clock.at = ago(3 * 60 * MINUTE);
    felt('lonely', 0.8, clock.at);
    clock.at = ago(MINUTE);
    felt('happy', 0.7, clock.at);
    clock.at = NOW;

    const { body } = await read();
    expect(body.feeling.present).toMatchObject({ expression: 'joyful' });
    expect(body.feeling.present!.intensity).toBeGreaterThan(0.3);
    expect(body.feeling.lingering).toHaveLength(1);
    expect(body.feeling.lingering[0]).toMatchObject({ expression: 'sad', startedAt: ago(3 * 60 * MINUTE) });
    expect(body.feeling.lingering[0]!.strength).toBeGreaterThan(0);
    expect(body.feeling.lingering[0]!.strength).toBeLessThanOrEqual(0.8);
    const text = JSON.stringify(body);
    for (const forbidden of ['CAUSE FROM THE CONVERSATION', 'cause', 'target', 'ライ氏', 'lonely']) expect(text).not.toContain(forbidden);
    // Reading stored nothing.
    const before = stateStore.snapshot(OWNER);
    await read();
    expect(stateStore.snapshot(OWNER)).toEqual(before);
  });
});

describe('GET /v1/shannon/now: structure', () => {

  it('reads through a connection that cannot write, and selects no text column', () => {
    const reader = source('shannonNowReader.ts');
    expect(reader).toContain('PRAGMA query_only = ON');
    expect(reader).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/u);
    for (const column of ['content', 'line_text', 'answer_json', 'note', 'source_title']) {
      expect(reader).not.toMatch(new RegExp(`SELECT[^;\`]*\\b${column}\\b`, 'u'));
    }
    const path = databasePath();
    seed(path);
    const cannotWrite = new DatabaseSync(path);
    closers.push(cannotWrite);
    cannotWrite.exec('PRAGMA query_only = ON');
    expect(() => cannotWrite.exec(`DELETE FROM body_looks`)).toThrow();
  });

  it('is held by its own route only: not the kernel, not a prompt, not the activity loop', () => {
    for (const name of ['apiKernel.ts', 'autonomyLoop.ts', 'autonomyWorker.ts', 'worker.ts', 'apiPromptProjection.ts', 'serverPlatformBridgeRoute.ts']) {
      expect(source(name)).not.toMatch(/shannonNow/iu);
    }
    const server = source('server.ts');
    // The route is reached only after the device was authenticated.
    expect(server.indexOf('shannonNowRoute(request, response, principal)')).toBeGreaterThan(server.indexOf("error: 'PAIRING_REQUIRED'"));
  });
});
