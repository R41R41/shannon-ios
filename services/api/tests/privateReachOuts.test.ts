import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { AutonomyLoopObservations } from '../src/autonomyLoopObservations.js';
import { reachOutHappenedLines, reachOutMemoryLine } from '../src/autonomyLoopObservePrompts.js';
import { SQLiteBodyStore } from '../src/bodyStore.js';
import { SQLiteInitiativeStore } from '../src/initiativeStore.js';
import { PRIVATE_REACH_OUT_LIMITS, privateReachOutListenSeconds, privateReachOutsEnabled } from '../src/privateListeningContract.js';
import { dispatchPrivateListeningRequest } from '../src/privateListeningRoutes.js';
import { SQLitePrivateListeningStore, type PrivateListener } from '../src/privateListeningStore.js';
import { PrivateReachOuts, chosenSpeaker } from '../src/privateReachOuts.js';
import { SQLiteReachOutClaims } from '../src/reachOutClaims.js';
import { SQLiteReachOutSpeaker } from '../src/reachOutDelivery.js';
import { SQLiteReachOutReports } from '../src/reachOutReports.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';

const scope = 'owner';
const START = '2026-10-02T03:00:00.000Z';
const SECOND = 1_000;
const MINUTE = 60_000;
const MAC = 'mac-1';
const PHONE = 'phone-1';
const BODY = 'body-pc';
const TEXT = 'ライ氏、いま何をしていますか。';

const directory = mkdtempSync(join(tmpdir(), 'shannon-private-reach-outs-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let databases = 0;

function world(options: { enabled?: boolean; reportsEnabled?: boolean; path?: string } = {}) {
  const path = options.path ?? join(directory, `reach-outs-${databases += 1}.sqlite`);
  const clock = { at: START };
  const now = () => clock.at;
  const advance = (milliseconds: number) => { clock.at = new Date(Date.parse(clock.at) + milliseconds).toISOString(); };
  const persistent = new SQLiteShannonStore({ path, now });
  const initiatives = new SQLiteInitiativeStore(path, now);
  const body = new SQLiteBodyStore(path);
  const reports = new SQLiteReachOutReports(path);
  const speaker = new SQLiteReachOutSpeaker(path);
  const listening = new SQLitePrivateListeningStore(path);
  const claims = new SQLiteReachOutClaims(path);
  const reachOuts = new PrivateReachOuts({
    listening, claims, reports, isBody: (scopeKey, deviceId) => body.capabilities(scopeKey, deviceId) !== null,
    enabled: options.enabled ?? true, reportsEnabled: options.reportsEnabled ?? true, listenSeconds: 8, now,
  });
  const dependencies = { store: listening, enabled: true, ownerScopeKey: scope, reachOuts, now };
  const post = (path_: string, body_: Record<string, unknown>, deviceId: string | null, scopeKey = scope) =>
    dispatchPrivateListeningRequest({ method: 'POST', path: path_, body: { scopeKey, ...body_ }, ...(deviceId ? { deviceId } : {}) }, dependencies);
  /** One heartbeat of an app that is privately listening. */
  const beat = (deviceId: string, kind: 'mac' | 'iphone', extra: Record<string, unknown> = {}) =>
    post('/v1/private-listening', { kind, listening: true, speaks: true, ...extra }, deviceId);
  const claim = (id: string, deviceId: string | null, scopeKey = scope) => post(`/v1/private-listening/reach-outs/${id}/claim`, {}, deviceId, scopeKey);
  const deliver = (id: string, outcome: unknown, deviceId: string, extra: Record<string, unknown> = {}) =>
    post(`/v1/private-listening/reach-outs/${id}/delivery`, { outcome, ...extra }, deviceId);
  // The API as server.ts wires it: her body is told about her messages through the surface rule.
  const api = createLocalApiKernel(now, {
    stateStore: persistent, conversationStore: persistent, initiativeInbox: initiatives,
    body: {
      store: body, reachOuts: (scopeKey, deviceId) => reachOuts.bodyPresence(scopeKey, deviceId, speaker.pending(scopeKey)),
      reachOutReports: { report: (s, d, i, o, at) => reachOuts.bodyReported(s, d, i, o, at), markPresence: (s, d, at) => reports.markPresence(s, d, at) },
    },
  });
  const bodyOnline = () => api.dispatch({ method: 'PUT', path: '/v1/body/capabilities', body: { scopeKey: scope, expressions: ['smile'], gestures: [] }, deviceId: BODY });
  const bodyPresence = async (deviceId = BODY) =>
    ((await api.dispatch({ method: 'GET', path: '/v1/body/presence', query: new URLSearchParams({ scopeKey: scope }), deviceId })).body as { reachOut?: { pending: number; latestId?: string } }).reachOut;
  const bodyInitiatives = async (deviceId = BODY) => {
    const inbox = await api.dispatch({ method: 'GET', path: '/v1/initiatives', query: new URLSearchParams({ scopeKey: scope }), deviceId });
    return reachOuts.bodyInitiatives(scope, deviceId, inbox.body) as { unreadCount: number; messages: Array<{ id: string }> };
  };
  const bodyReport = (id: string, outcome: string) =>
    api.dispatch({ method: 'POST', path: `/v1/body/reach-outs/${id}/delivery`, body: { scopeKey: scope, outcome }, deviceId: BODY });
  /** She starts a message on her own; returns its initiative id. */
  const say = (text = TEXT) => {
    const day = clock.at.slice(0, 10);
    expect(speaker.say(scope, { reason: 'wonder', text, dayKey: day, maximumPerDay: 20 }, clock.at)).toBe('sent');
    return speaker.latest(scope)!.id;
  };
  const ownerSpeaks = () => {
    const database = new DatabaseSync(path);
    try {
      database.prepare(`
        INSERT INTO conversation_messages (message_id, scope_key, thread_id, turn_id, ordinal, role, content, observed_at, metadata_json)
        VALUES (?, ?, ?, ?, 0, 'user', 'うん', ?, '{}')
      `).run(randomUUID(), scope, persistent.threadId(scope), randomUUID(), clock.at);
    } finally { database.close(); }
  };
  const close = () => { for (const store of [listening, claims, reports, speaker, body, initiatives, persistent]) store.close(); };
  return { path, clock, advance, persistent, initiatives, body, reports, speaker, listening, claims, reachOuts, post, beat, claim, deliver, api, bodyOnline, bodyPresence, bodyInitiatives, bodyReport, say, ownerSpeaks, close };
}

const errorOf = (response: { body: unknown }) => (response.body as { error?: string }).error;
const offerOf = (response: { body: unknown }) => (response.body as { reachOut?: { id: string } | null }).reachOut;

describe('which surface speaks', () => {
  const listener = (deviceId: string, extra: Partial<PrivateListener> = {}): PrivateListener =>
    ({ deviceId, kind: 'mac', since: START, seenAt: START, ownerActiveAt: null, speaks: true, ...extra });

  it('is the app whose device the owner used most recently', () => {
    expect(chosenSpeaker([])).toBeNull();
    expect(chosenSpeaker([listener('a', { speaks: false })])).toBeNull();
    expect(chosenSpeaker([listener('a', { ownerActiveAt: '2026-10-02T02:00:00.000Z' }), listener('b', { ownerActiveAt: '2026-10-02T02:59:00.000Z' })])?.deviceId).toBe('b');
    // An app that cannot speak now is not chosen, however recently its device was used.
    expect(chosenSpeaker([listener('a', { ownerActiveAt: '2026-10-02T02:00:00.000Z' }), listener('b', { ownerActiveAt: '2026-10-02T02:59:00.000Z', speaks: false })])?.deviceId).toBe('a');
    // A device with a known last use is before one without; then the run that began later; then the id, so the answer is always one.
    expect(chosenSpeaker([listener('a'), listener('b', { ownerActiveAt: '2026-10-02T01:00:00.000Z' })])?.deviceId).toBe('b');
    expect(chosenSpeaker([listener('a'), listener('b', { since: '2026-10-02T03:00:30.000Z' })])?.deviceId).toBe('b');
    expect(chosenSpeaker([listener('b'), listener('a')])?.deviceId).toBe('a');
  });

  it('offers her message to that app only, and never to an app that is not privately listening', () => {
    const w = world();
    w.beat(MAC, 'mac', { ownerActiveAt: START });
    w.beat(PHONE, 'iphone', { ownerActiveAt: '2026-10-02T02:30:00.000Z' });
    const id = w.say();
    w.advance(5 * SECOND);
    expect(offerOf(w.beat(PHONE, 'iphone'))).toBeNull();
    expect(offerOf(w.beat(MAC, 'mac'))).toEqual({ id, createdAt: START });
    // The phone's claim is refused: the Mac speaks now.
    expect(errorOf(w.claim(id, PHONE))).toBe('REACH_OUT_NOT_YOURS');
    expect(w.claim(id, 'tablet-9').status).toBe(409);
    expect(errorOf(w.claim(id, 'tablet-9'))).toBe('REACH_OUT_NOT_LISTENING');
    w.close();
  });

  it('offers nothing to an app that reports private listening without being able to speak', () => {
    const w = world();
    w.beat(MAC, 'mac', { speaks: false });
    const id = w.say();
    const beat = w.beat(MAC, 'mac', { speaks: false });
    expect(offerOf(beat)).toBeNull();
    expect((beat.body as { speaks: boolean }).speaks).toBe(false);
    expect(errorOf(w.claim(id, MAC))).toBe('REACH_OUT_NOT_LISTENING');
    w.close();
  });
});

describe('POST /v1/private-listening/reach-outs/{id}/claim', () => {
  it('hands the chosen app her words once, with how long to listen', () => {
    const w = world();
    w.beat(MAC, 'mac');
    const id = w.say();
    const claimed = w.claim(id, MAC);
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({
      schemaVersion: 1, id, status: 'claimed', surface: 'mac', spoken: false, listenSeconds: 8,
      message: { id, threadId: w.persistent.threadId(scope), content: TEXT, expression: 'curious', reason: 'wonder', createdAt: START },
    });
    // Asked again by the same device (a lost reply): the same words, marked as already held.
    expect(w.claim(id, MAC).body).toMatchObject({ status: 'held', spoken: false, message: { content: TEXT } });
    // Once claimed it is offered to nobody else.
    w.beat(PHONE, 'iphone', { ownerActiveAt: START });
    expect(offerOf(w.beat(PHONE, 'iphone'))).toBeNull();
    w.close();
  });

  it('never lets two devices take the same message, also when both ask at once through separate connections', () => {
    const w = world();
    const id = w.say();
    const other = new SQLiteReachOutClaims(w.path);
    const results = [w.claims.claim(scope, id, MAC, 'mac', START), other.claim(scope, id, PHONE, 'iphone', START)];
    expect(results.sort()).toEqual(['claimed', 'taken']);
    expect(w.claims.holder(scope, id)?.deviceId).toBe(MAC);
    // The phone becomes the chosen app, and still cannot take what the Mac holds.
    w.beat(PHONE, 'iphone', { ownerActiveAt: START });
    expect(errorOf(w.claim(id, PHONE))).toBe('REACH_OUT_TAKEN');
    other.close();
    w.close();
  });

  it('keeps a claim through a restart of the server', () => {
    const w = world();
    w.beat(MAC, 'mac');
    const id = w.say();
    expect(w.claim(id, MAC).status).toBe(200);
    w.close();
    const again = world({ path: w.path });
    again.beat(PHONE, 'iphone', { ownerActiveAt: START });
    expect(errorOf(again.claim(id, PHONE))).toBe('REACH_OUT_TAKEN');
    expect(again.claims.holder(scope, id)).toMatchObject({ deviceId: MAC, surface: 'mac', spokenAt: null });
    again.close();
  });

  it('refuses a message that is too old, already read, or already answered: she does not speak over a conversation', () => {
    const w = world();
    w.beat(MAC, 'mac');
    const old = w.say('古い話です。');
    w.advance(PRIVATE_REACH_OUT_LIMITS.freshMilliseconds + SECOND);
    w.beat(MAC, 'mac');
    expect(offerOf(w.beat(MAC, 'mac'))).toBeNull();
    expect(w.claim(old, MAC).status).toBe(410);

    w.advance(60 * MINUTE);
    w.beat(MAC, 'mac');
    const read = w.say('読まれた話です。');
    w.initiatives.markRead(scope, undefined, w.clock.at);
    expect(errorOf(w.claim(read, MAC))).toBe('REACH_OUT_ALREADY_READ');

    w.advance(60 * MINUTE);
    w.beat(MAC, 'mac');
    const answered = w.say('返事のあった話です。');
    w.advance(10 * SECOND);
    w.ownerSpeaks();
    w.advance(SECOND);
    expect(offerOf(w.beat(MAC, 'mac'))).toBeNull();
    expect(errorOf(w.claim(answered, MAC))).toBe('REACH_OUT_ANSWERED');
    expect(w.claims.holder(scope, answered)).toBeNull();
    w.close();
  });

  it('refuses once the app stopped reporting, or said it is no longer privately listening', () => {
    const w = world();
    w.beat(MAC, 'mac');
    const id = w.say();
    w.post('/v1/private-listening', { kind: 'mac', listening: false }, MAC);
    expect(errorOf(w.claim(id, MAC))).toBe('REACH_OUT_NOT_LISTENING');
    w.beat(MAC, 'mac');
    w.advance(46 * SECOND);
    expect(errorOf(w.claim(id, MAC))).toBe('REACH_OUT_NOT_LISTENING');
    w.close();
  });

  it('refuses a guest, a caller without a paired device, an unknown id, and any extra field', () => {
    const w = world();
    w.beat(MAC, 'mac');
    const id = w.say();
    expect(errorOf(w.claim(id, 'guest-phone', 'guest'))).toBe('PRIVATE_LISTENING_OWNER_ONLY');
    expect(errorOf(w.claim(id, null))).toBe('PAIRED_DEVICE_REQUIRED');
    expect(w.claim('no-such-message', MAC).status).toBe(404);
    expect(w.post(`/v1/private-listening/reach-outs/${id}/claim`, { text: 'x' }, MAC).status).toBe(400);
    expect(w.post(`/v1/private-listening/reach-outs/${id}/else`, {}, MAC).status).toBe(404);
    // A message that is not one she started on her own cannot be taken.
    expect(w.claims.message(scope, 'study:1')).toBeNull();
    expect(w.claims.holder(scope, id)).toBeNull();
    w.close();
  });
});

describe('POST /v1/private-listening/reach-outs/{id}/delivery', () => {
  it('stores "spoken" in the body\'s own report table with the surface named, once', () => {
    const w = world();
    w.beat(PHONE, 'iphone');
    const id = w.say();
    w.claim(id, PHONE);
    expect(w.deliver(id, 'shown_spoken', PHONE).body).toEqual({ schemaVersion: 1, id, status: 'stored' });
    expect(w.deliver(id, 'shown_spoken', PHONE).body).toMatchObject({ status: 'duplicate' });
    expect(w.reports.delivery(scope, id)).toBe('shown_spoken');
    expect(w.reports.deliverySurface(scope, id)).toBe('iphone');
    expect(w.claim(id, PHONE).body).toMatchObject({ status: 'held', spoken: true });
    // Having spoken, it cannot give the message back for someone else to say again.
    expect(errorOf(w.deliver(id, 'not_spoken', PHONE))).toBe('REACH_OUT_ALREADY_REPORTED');
    expect(w.claims.holder(scope, id)?.spokenAt).toBe(START);
    w.close();
  });

  it('gives the message back when private listening ended before it was spoken, and stores nothing', () => {
    const w = world();
    w.beat(MAC, 'mac');
    const id = w.say();
    w.claim(id, MAC);
    expect(w.deliver(id, 'not_spoken', MAC).body).toEqual({ schemaVersion: 1, id, status: 'released' });
    expect(w.claims.holder(scope, id)).toBeNull();
    expect(w.reports.delivery(scope, id)).toBeNull();
    // The device that gave it back is not offered it again, and cannot take it again.
    expect(offerOf(w.beat(MAC, 'mac'))).toBeNull();
    expect(errorOf(w.claim(id, MAC))).toBe('REACH_OUT_NOT_YOURS');
    // Another app may take it while it is fresh, although the Mac was used more recently.
    w.beat(MAC, 'mac', { ownerActiveAt: START });
    expect(offerOf(w.beat(PHONE, 'iphone'))).toEqual({ id, createdAt: START });
    expect(w.claim(id, PHONE).status).toBe(200);
    w.close();
  });

  it('an app that gave a message back no longer keeps it from her body', async () => {
    const w = world();
    await w.bodyOnline();
    w.beat(MAC, 'mac');
    const id = w.say();
    expect(await w.bodyPresence()).toEqual({ pending: 0 });
    w.claim(id, MAC);
    w.deliver(id, 'not_spoken', MAC);
    // The Mac goes on listening; the message is the body's now.
    w.beat(MAC, 'mac');
    expect(await w.bodyPresence()).toEqual({ pending: 1, latestId: id });
    expect(w.claims.holder(scope, id)).toMatchObject({ deviceId: BODY, surface: 'body' });
    w.close();
  });

  it('offers a message again to the device that took it and has not spoken, so a lost answer is not stuck', () => {
    const w = world();
    w.beat(MAC, 'mac');
    const id = w.say();
    // The claim reached the server; its answer never reached the app.
    expect(w.claim(id, MAC).status).toBe(200);
    w.advance(15 * SECOND);
    expect(offerOf(w.beat(MAC, 'mac'))).toEqual({ id, createdAt: START });
    expect(w.claim(id, MAC).body).toMatchObject({ status: 'held', spoken: false, message: { content: TEXT } });
    w.deliver(id, 'shown_spoken', MAC);
    // Spoken: never offered again.
    expect(offerOf(w.beat(MAC, 'mac'))).toBeNull();
    w.close();
  });

  it('accepts a report only from the device that holds the message, and only the two outcomes', () => {
    const w = world();
    w.beat(MAC, 'mac');
    const id = w.say();
    expect(errorOf(w.deliver(id, 'shown_spoken', MAC))).toBe('REACH_OUT_NOT_CLAIMED');
    w.claim(id, MAC);
    expect(errorOf(w.deliver(id, 'shown_spoken', PHONE))).toBe('REACH_OUT_NOT_CLAIMED');
    for (const outcome of ['shown', 'away', 'heard', '', null]) expect(w.deliver(id, outcome, MAC).status).toBe(400);
    expect(w.deliver(id, 'shown_spoken', MAC, { said: 'ライ氏、' }).status).toBe(400);
    expect(w.reports.delivery(scope, id)).toBeNull();
    w.close();
  });

  it('keeps no report while her observing is switched off, and still never lets it be spoken twice', () => {
    const w = world({ reportsEnabled: false });
    w.beat(MAC, 'mac');
    const id = w.say();
    w.claim(id, MAC);
    expect(w.deliver(id, 'shown_spoken', MAC).body).toMatchObject({ status: 'ignored' });
    expect(w.reports.delivery(scope, id)).toBeNull();
    expect(errorOf(w.deliver(id, 'not_spoken', MAC))).toBe('REACH_OUT_ALREADY_REPORTED');
    w.close();
  });
});

describe('her body and the apps', () => {
  it('her body is not told about a fresh message while an app is privately listening, and the app speaks it', async () => {
    const w = world();
    await w.bodyOnline();
    w.beat(MAC, 'mac');
    const id = w.say();
    expect(await w.bodyPresence()).toEqual({ pending: 0 });
    expect((await w.bodyInitiatives()).messages).toEqual([]);
    expect(w.claim(id, MAC).status).toBe(200);
    w.deliver(id, 'shown_spoken', MAC);
    // Also long after: what an app spoke is never handed to the body.
    w.advance(30 * MINUTE);
    expect(await w.bodyPresence()).toEqual({ pending: 0 });
    expect((await w.bodyInitiatives()).unreadCount).toBe(0);
    // The owner's own apps still see the unread message.
    const inbox = await w.api.dispatch({ method: 'GET', path: '/v1/initiatives', query: new URLSearchParams({ scopeKey: scope }), deviceId: PHONE });
    expect((w.reachOuts.bodyInitiatives(scope, PHONE, inbox.body) as { unreadCount: number }).unreadCount).toBe(1);
    w.close();
  });

  it('her body speaks when no app is privately listening, and an app that starts listening a moment later does not say it again', async () => {
    const w = world();
    await w.bodyOnline();
    const id = w.say();
    expect(await w.bodyPresence()).toEqual({ pending: 1, latestId: id });
    expect(w.claims.holder(scope, id)).toMatchObject({ deviceId: BODY, surface: 'body' });
    expect((await w.bodyInitiatives()).messages.map(message => message.id)).toEqual([id]);
    w.advance(5 * SECOND);
    expect(offerOf(w.beat(MAC, 'mac'))).toBeNull();
    expect(errorOf(w.claim(id, MAC))).toBe('REACH_OUT_TAKEN');
    // The body goes on seeing its own message.
    expect(await w.bodyPresence()).toEqual({ pending: 1, latestId: id });
    expect((await w.bodyReport(id, 'shown_spoken')).status).toBe(200);
    expect(errorOf(w.claim(id, MAC))).toBe('REACH_OUT_TAKEN');
    w.close();
  });

  it('a body that did not show the message gives it back, so an app in his ears may still say it', async () => {
    const w = world();
    await w.bodyOnline();
    const id = w.say();
    await w.bodyPresence();
    expect((await w.bodyReport(id, 'away')).body).toMatchObject({ status: 'stored' });
    expect(w.claims.holder(scope, id)).toBeNull();
    w.advance(10 * SECOND);
    w.beat(PHONE, 'iphone');
    expect(offerOf(w.beat(PHONE, 'iphone'))).toEqual({ id, createdAt: START });
    expect(w.claim(id, PHONE).status).toBe(200);
    w.deliver(id, 'shown_spoken', PHONE);
    // The report that got furthest stands, and it names the app.
    expect(w.reports.delivery(scope, id)).toBe('shown_spoken');
    expect(w.reports.deliverySurface(scope, id)).toBe('iphone');
    w.close();
  });

  it('with two bodies, one that did not show the message cannot give back what the other holds', async () => {
    const w = world();
    await w.bodyOnline();
    await w.api.dispatch({ method: 'PUT', path: '/v1/body/capabilities', body: { scopeKey: scope, expressions: [], gestures: [] }, deviceId: 'body-2' });
    const id = w.say();
    await w.bodyPresence();
    expect(w.claims.holder(scope, id)?.deviceId).toBe(BODY);
    // The second body sees it too, as bodies always did, and reports that its window is hidden.
    expect(await w.bodyPresence('body-2')).toEqual({ pending: 1, latestId: id });
    const hidden = await w.api.dispatch({ method: 'POST', path: `/v1/body/reach-outs/${id}/delivery`, body: { scopeKey: scope, outcome: 'hidden' }, deviceId: 'body-2' });
    expect(hidden.status).toBe(200);
    expect(w.claims.holder(scope, id)?.deviceId).toBe(BODY);
    w.beat(MAC, 'mac');
    expect(offerOf(w.beat(MAC, 'mac'))).toBeNull();
    w.close();
  });

  it('an app that took a message and was never heard from again keeps it from her body only until it is long stale', async () => {
    const w = world();
    await w.bodyOnline();
    w.beat(MAC, 'mac');
    const id = w.say();
    w.claim(id, MAC);
    // The Mac app is closed before it speaks or reports.
    w.advance(PRIVATE_REACH_OUT_LIMITS.abandonedMilliseconds);
    expect(await w.bodyPresence()).toEqual({ pending: 0 });
    w.advance(SECOND);
    expect(await w.bodyPresence()).toEqual({ pending: 1, latestId: id });
    expect((await w.bodyInitiatives()).messages.map(message => message.id)).toEqual([id]);
    // A message that was spoken stays the app's for good.
    w.advance(60 * MINUTE);
    w.beat(MAC, 'mac');
    const spoken = w.say('話した話です。');
    w.claim(spoken, MAC);
    w.deliver(spoken, 'shown_spoken', MAC);
    w.advance(60 * MINUTE);
    expect((await w.bodyInitiatives()).messages.map(message => message.id)).toEqual([id]);
    w.close();
  });

  it('counts the five minutes from the claim, not from the message, so a late claim is not handed to the body while it is being said', async () => {
    const w = world();
    await w.bodyOnline();
    w.beat(MAC, 'mac');
    const id = w.say();
    w.advance(170 * SECOND);
    w.beat(MAC, 'mac');
    expect(w.claim(id, MAC).status).toBe(200);
    // Five minutes after the message, two after the claim: still the app's.
    w.advance(131 * SECOND);
    expect(await w.bodyPresence()).toEqual({ pending: 0 });
    // Past its freshness an unspoken claim is no longer offered for speaking,
    w.beat(MAC, 'mac');
    expect(offerOf(w.beat(MAC, 'mac'))).toBeNull();
    // and a report that arrives late is still taken: the message was said and stays the app's.
    expect(w.deliver(id, 'shown_spoken', MAC).body).toMatchObject({ status: 'stored' });
    w.advance(60 * MINUTE);
    expect(await w.bodyPresence()).toEqual({ pending: 0 });
    expect((await w.bodyInitiatives()).messages).toEqual([]);
    w.close();
  });

  it('does not offer a message again to the app that holds it once the owner answered', () => {
    const w = world();
    w.beat(MAC, 'mac');
    const id = w.say();
    w.claim(id, MAC);
    w.advance(5 * SECOND);
    w.ownerSpeaks();
    w.advance(SECOND);
    expect(offerOf(w.beat(MAC, 'mac'))).toBeNull();
    w.close();
  });

  it('keeps a message an app spoke out of the body\'s inbox however many unread messages of hers there are', () => {
    const w = world();
    w.body.saveCapabilities(scope, BODY, { expressions: [], gestures: [], flags: {} }, START);
    w.beat(MAC, 'mac');
    const id = w.say();
    w.claim(id, MAC);
    w.deliver(id, 'shown_spoken', MAC);
    // The inbox may hold a message of hers that is not among the newest twenty the surface rule looks at:
    // here it is simply no longer in that set. Who holds it still decides.
    w.initiatives.markRead(scope, undefined, w.clock.at);
    const inbox = { unreadCount: 2, messages: [{ id, kind: 'reach_out' }, { id: 'held-by-nobody', kind: 'reach_out' }] };
    expect(w.reachOuts.bodyInitiatives(scope, BODY, inbox)).toEqual({ unreadCount: 1, messages: [{ id: 'held-by-nobody', kind: 'reach_out' }] });
    w.close();
  });

  it('takes out of the body\'s inbox only what is an app\'s, and leaves every other initiative alone', () => {
    const w = world();
    w.body.saveCapabilities(scope, BODY, { expressions: [], gestures: [], flags: {} }, START);
    w.beat(MAC, 'mac');
    const id = w.say();
    const inbox = { unreadCount: 3, messages: [{ id: 'story-1' }, { id, kind: 'reach_out' }, { id: 'older-reach-out-not-in-the-newest-twenty', kind: 'reach_out' }] };
    expect(w.reachOuts.bodyInitiatives(scope, BODY, inbox)).toEqual({
      unreadCount: 2, messages: [{ id: 'story-1' }, { id: 'older-reach-out-not-in-the-newest-twenty', kind: 'reach_out' }],
    });
    w.close();
  });

  it('a message nobody took while it was fresh stays the body\'s as before, and is never spoken by an app', async () => {
    const w = world();
    await w.bodyOnline();
    w.beat(MAC, 'mac');
    const id = w.say();
    // The Mac app is closed before it asks; its report lapses.
    w.advance(PRIVATE_REACH_OUT_LIMITS.freshMilliseconds + MINUTE);
    expect(await w.bodyPresence()).toEqual({ pending: 1, latestId: id });
    expect(w.claims.holder(scope, id)).toBeNull();
    w.beat(MAC, 'mac');
    expect(offerOf(w.beat(MAC, 'mac'))).toBeNull();
    w.close();
  });

  it('a device that is not her body reads presence unchanged and claims nothing', async () => {
    const w = world();
    const id = w.say();
    expect(await w.bodyPresence('some-other-device')).toEqual({ pending: 1, latestId: id });
    expect(w.claims.holder(scope, id)).toBeNull();
    w.close();
  });
});

describe('switches', () => {
  it('SHANNON_PRIVATE_LISTENING_REACH_OUTS=off: no app is offered or given a message, and her body is told everything as before', async () => {
    expect(privateReachOutsEnabled({})).toBe(true);
    expect(privateReachOutsEnabled({ SHANNON_PRIVATE_LISTENING_REACH_OUTS: 'off' })).toBe(false);
    expect(privateReachOutsEnabled({ SHANNON_PRIVATE_LISTENING: 'off' })).toBe(false);
    const w = world({ enabled: false });
    await w.bodyOnline();
    const beat = w.beat(MAC, 'mac');
    expect(beat.status).toBe(200);
    // Neither field is in the answer, which is how an app knows that standing by would be pointless.
    expect(beat.body).not.toHaveProperty('reachOut');
    expect(beat.body).not.toHaveProperty('speaks');
    const id = w.say();
    expect(errorOf(w.claim(id, MAC))).toBe('PRIVATE_REACH_OUTS_DISABLED');
    expect(errorOf(w.deliver(id, 'shown_spoken', MAC))).toBe('PRIVATE_REACH_OUTS_DISABLED');
    expect(await w.bodyPresence()).toEqual({ pending: 1, latestId: id });
    expect((await w.bodyInitiatives()).unreadCount).toBe(1);
    expect(w.claims.holder(scope, id)).toBeNull();
    w.close();
  });

  it('SHANNON_PRIVATE_LISTENING_LISTEN_SECONDS is held to 0–30', () => {
    expect(privateReachOutListenSeconds({})).toBe(8);
    expect(privateReachOutListenSeconds({ SHANNON_PRIVATE_LISTENING_LISTEN_SECONDS: '0' })).toBe(0);
    expect(privateReachOutListenSeconds({ SHANNON_PRIVATE_LISTENING_LISTEN_SECONDS: '30' })).toBe(30);
    for (const value of ['31', '-1', '2.5', 'long']) expect(privateReachOutListenSeconds({ SHANNON_PRIVATE_LISTENING_LISTEN_SECONDS: value })).toBe(8);
  });
});

describe('what she observes', () => {
  const facts = { id: 'a1', reason: 'wonder' as const, sentAt: START, waitedSeconds: 180, replied: false, delivery: 'shown_spoken' as const, windowVisible: false, owner: 'unknown' as const, others: false };

  it('is told that an app said it through his earphones, in fixed words that name the device', () => {
    const lines = reachOutHappenedLines({ ...facts, surface: 'mac' }, { at: '2026-10-02T03:03:00.000Z', timeZone: 'Asia/Tokyo' });
    expect(lines.join('\n')).toContain('- イヤホンからの知らせ: Macのイヤホンで、ライ氏にだけ聞こえる声で伝えた。');
    expect(lines.join('\n')).not.toContain('体からの知らせ');
    expect(lines.join('\n')).toContain('3分待ったが、返事はまだない。');
    expect(reachOutMemoryLine({ facts: { ...facts, surface: 'iphone' }, after: [], repliedSince: false }, 'Asia/Tokyo'))
      .toContain('iPhoneのイヤホンで、ライ氏にだけ聞こえる声で伝えた。');
    // Her body's own report reads as before.
    expect(reachOutHappenedLines(facts, { at: '2026-10-02T03:03:00.000Z', timeZone: 'Asia/Tokyo' }).join('\n')).toContain('- 体からの知らせ: 画面に出して、声でも読み上げた。');
  });

  it('keeps the surface as a closed value in the observation, and drops anything else', () => {
    const database = new DatabaseSync(':memory:');
    const observations = new AutonomyLoopObservations(database);
    observations.add(scope, { cycleId: 'c1', ordinal: 0, step: 'reach_out', outcome: 'done', reachOut: { ...facts, surface: 'mac' } }, START);
    observations.add(scope, { cycleId: 'c1', ordinal: 1, step: 'reach_out', outcome: 'done', reachOut: { ...facts, surface: 'AirPods Pro' as never } }, START);
    observations.add(scope, { cycleId: 'c1', ordinal: 2, step: 'reach_out', outcome: 'done', reachOut: { ...facts, delivery: 'unknown', surface: 'mac' } }, START);
    expect(observations.ofCycle('c1').map(item => item.reachOut?.surface)).toEqual(['mac', undefined, undefined]);
    database.close();
  });
});

describe('tables that already exist', () => {
  it('gain their new column without losing a row, and opening them twice is harmless', () => {
    const path = join(directory, 'earlier.sqlite');
    const earlier = new DatabaseSync(path);
    // The tables as they were before this change.
    earlier.exec(`
      CREATE TABLE private_listening (
        scope_key TEXT NOT NULL, device_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('mac', 'iphone')),
        since TEXT NOT NULL, seen_at TEXT NOT NULL, owner_active_at TEXT, PRIMARY KEY (scope_key, device_id)
      );
      CREATE TABLE reach_out_deliveries (
        scope_key TEXT NOT NULL, initiative_id TEXT NOT NULL, device_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('shown_spoken', 'shown', 'away', 'hidden', 'muted')),
        reported_at TEXT NOT NULL, PRIMARY KEY (scope_key, initiative_id, device_id)
      );
      INSERT INTO private_listening VALUES ('owner', 'mac-1', 'mac', '${START}', '${START}', NULL);
      INSERT INTO reach_out_deliveries VALUES ('owner', 'm1', 'body-pc', 'shown', '${START}');
    `);
    earlier.close();
    for (let round = 0; round < 2; round += 1) {
      const listening = new SQLitePrivateListeningStore(path);
      const reports = new SQLiteReachOutReports(path);
      expect(listening.listeners(scope, START)).toEqual([{ deviceId: 'mac-1', kind: 'mac', since: START, seenAt: START, ownerActiveAt: null, speaks: false }]);
      // A report of her body from before has no surface, and reads as her body's.
      expect(reports.delivery(scope, 'm1')).toBe('shown');
      expect(reports.deliverySurface(scope, 'm1')).toBeNull();
      listening.close();
      reports.close();
    }
  });
});

describe('documents', () => {
  it('describes the claim, the delivery report, the surface rule and the switches', () => {
    const document = readFileSync(new URL('../../../docs/private-listening-contract.md', import.meta.url), 'utf8');
    for (const word of [
      'POST /v1/private-listening/reach-outs/{id}/claim', 'POST /v1/private-listening/reach-outs/{id}/delivery', 'speaks', 'listenSeconds', 'shown_spoken', 'not_spoken',
      'REACH_OUT_TAKEN', 'REACH_OUT_NOT_YOURS', 'REACH_OUT_NOT_LISTENING', 'REACH_OUT_ANSWERED', 'REACH_OUT_ALREADY_READ', 'REACH_OUT_EXPIRED', 'REACH_OUT_NOT_CLAIMED',
      'PRIVATE_REACH_OUTS_DISABLED', 'reach_out_claims', 'reach_out_declines', 'SHANNON_PRIVATE_LISTENING_REACH_OUTS', 'SHANNON_PRIVATE_LISTENING_LISTEN_SECONDS',
    ]) expect(document, word).toContain(word);
    expect(readFileSync(new URL('../../../docs/body-contract.md', import.meta.url), 'utf8')).toContain('private-listening-contract.md');
    expect(PRIVATE_REACH_OUT_LIMITS).toMatchObject({ freshMilliseconds: 180_000, abandonedMilliseconds: 300_000, listenSeconds: 8, maximumListenSeconds: 30 });
    for (const path of ['../../../deploy/azure/api.env.example', '../../../.env.example']) {
      const example = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(example, path).toMatch(/^SHANNON_PRIVATE_LISTENING_REACH_OUTS=on$/mu);
      expect(example, path).toMatch(/^SHANNON_PRIVATE_LISTENING_LISTEN_SECONDS=8$/mu);
    }
  });
});
