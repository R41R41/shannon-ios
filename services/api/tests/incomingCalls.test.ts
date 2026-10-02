import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { reachOutHappenedLines, reachOutMemoryLine } from '../src/autonomyLoopObservePrompts.js';
import { AutonomyLoopObservations, type ReachOutFacts } from '../src/autonomyLoopObservations.js';
import { SQLiteBodyStore } from '../src/bodyStore.js';
import { INCOMING_CALL_LIMITS, incomingCallPushBody, incomingCallsEnabled, type IncomingCallPayload } from '../src/incomingCallContract.js';
import { dispatchIncomingCallRequest } from '../src/incomingCallRoutes.js';
import { IncomingCalls } from '../src/incomingCalls.js';
import { SQLiteIncomingCallStore } from '../src/incomingCallStore.js';
import { SQLiteInitiativeStore } from '../src/initiativeStore.js';
import { dispatchPrivateListeningRequest } from '../src/privateListeningRoutes.js';
import { SQLitePrivateListeningStore } from '../src/privateListeningStore.js';
import { PrivateReachOuts } from '../src/privateReachOuts.js';
import { SQLiteReachOutClaims } from '../src/reachOutClaims.js';
import { SQLiteReachOutSpeaker } from '../src/reachOutDelivery.js';
import { SQLiteReachOutReports } from '../src/reachOutReports.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';
import { APNsVoipPushSender, createConfiguredVoipPushSender, type VoipPushResult, type VoipPushSender, type VoipPushTarget } from '../src/voipPushSender.js';

const scope = 'owner';
const START = '2026-10-03T03:00:00.000Z';
const SECOND = 1_000;
const MINUTE = 60_000;
const PHONE = 'phone-1';
const MAC = 'mac-1';
const BODY = 'body-pc';
const TEXT = 'ライ氏、さっき読んだ話をしてもいいですか。';
const TOKEN = 'ab'.repeat(32);
const BUNDLE = 'com.r41r41.shannon';
const CALL_IDS = Array.from({ length: 9 }, (_, index) => `00000000-0000-4000-8000-00000000000${index + 1}`);

const directory = mkdtempSync(join(tmpdir(), 'shannon-incoming-calls-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let databases = 0;

/** APNs as a list: every push the server tried to send, and the answer it gets. Nothing reaches a network. */
class FakeApns implements VoipPushSender {
  enabled = true;
  sent: Array<{ target: VoipPushTarget; payload: IncomingCallPayload }> = [];
  next: VoipPushResult | Error = { delivered: true, invalidToken: false, status: 200, reason: null };
  async send(target: VoipPushTarget, payload: IncomingCallPayload): Promise<VoipPushResult> {
    this.sent.push({ target, payload });
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

function world(options: { enabled?: boolean; path?: string; paired?: string[] } = {}) {
  const path = options.path ?? join(directory, `calls-${databases += 1}.sqlite`);
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
  const store = new SQLiteIncomingCallStore(path);
  const apns = new FakeApns();
  const paired = new Set(options.paired ?? [PHONE]);
  const logged: unknown[] = [];
  const reachOuts = new PrivateReachOuts({
    listening, claims, reports, isBody: (scopeKey, deviceId) => body.capabilities(scopeKey, deviceId) !== null,
    enabled: true, reportsEnabled: true, listenSeconds: 8, now,
  });
  let ids = 0;
  const makeCalls = () => new IncomingCalls({
    store, claims, sender: apns, enabled: options.enabled ?? true, ownerScopeKey: scope, now, isPaired: (_scope, deviceId) => paired.has(deviceId),
    appSpeaks: (scopeKey, at, id) => reachOuts.speaker(scopeKey, at, id) !== null, body: reports,
    newCallId: () => CALL_IDS[ids++]!, log: (event, detail) => logged.push([event, detail]),
  });
  let calls = makeCalls();
  const callRoutes = () => ({ calls, ownerScopeKey: scope, bundleId: BUNDLE });
  const listeningRoutes = () => ({ store: listening, enabled: true, ownerScopeKey: scope, reachOuts, calls: () => calls, now });
  const post = (path_: string, body_: Record<string, unknown>, deviceId: string | null, scopeKey = scope) =>
    dispatchIncomingCallRequest({ method: 'POST', path: path_, body: { scopeKey, ...body_ }, ...(deviceId ? { deviceId } : {}) }, callRoutes());
  const register = (deviceId: string | null = PHONE, extra: Record<string, unknown> = {}, scopeKey = scope) =>
    post('/v1/incoming-calls/registration', { deviceToken: TOKEN, environment: 'production', bundleId: BUNDLE, enabled: true, ...extra }, deviceId, scopeKey);
  const report = (callId: string, outcome: unknown, deviceId: string | null = PHONE) => post(`/v1/incoming-calls/${callId}/report`, { outcome }, deviceId);
  const listen = (path_: string, body_: Record<string, unknown>, deviceId: string) =>
    dispatchPrivateListeningRequest({ method: 'POST', path: path_, body: { scopeKey: scope, ...body_ }, deviceId }, listeningRoutes());
  const answer = (id: string, callId: string, deviceId = PHONE) => listen(`/v1/private-listening/reach-outs/${id}/claim`, { callId }, deviceId);
  const beat = (deviceId: string, kind: 'mac' | 'iphone', speaks = true) => listen('/v1/private-listening', { kind, listening: true, speaks }, deviceId);
  const api = createLocalApiKernel(now, {
    stateStore: persistent, conversationStore: persistent, initiativeInbox: initiatives,
    body: {
      store: body, reachOuts: (scopeKey, deviceId) => reachOuts.bodyPresence(scopeKey, deviceId, speaker.pending(scopeKey)),
      reachOutReports: { report: (s, d, i, o, at) => reachOuts.bodyReported(s, d, i, o, at), markPresence: (s, d, at) => reports.markPresence(s, d, at) },
    },
  });
  const bodyOnline = () => api.dispatch({ method: 'PUT', path: '/v1/body/capabilities', body: { scopeKey: scope, expressions: ['smile'], gestures: [] }, deviceId: BODY });
  const bodyPresence = async () =>
    ((await api.dispatch({ method: 'GET', path: '/v1/body/presence', query: new URLSearchParams({ scopeKey: scope }), deviceId: BODY })).body as { reachOut?: { pending: number; latestId?: string } }).reachOut;
  const bodyReport = (id: string, outcome: string) =>
    api.dispatch({ method: 'POST', path: `/v1/body/reach-outs/${id}/delivery`, body: { scopeKey: scope, outcome }, deviceId: BODY });
  const say = (text = TEXT) => {
    expect(speaker.say(scope, { reason: 'wonder', text, dayKey: clock.at.slice(0, 10), maximumPerDay: 20 }, clock.at)).toBe('sent');
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
  const close = () => { for (const item of [store, listening, claims, reports, speaker, body, initiatives, persistent]) item.close(); };
  return {
    path, clock, advance, persistent, initiatives, reports, speaker, claims, store, apns, paired, logged, reachOuts,
    get calls() { return calls; }, restart: () => { calls = makeCalls(); },
    post, register, report, answer, beat, bodyOnline, bodyPresence, bodyReport, say, ownerSpeaks, close,
  };
}

const errorOf = (response: { body: unknown }) => (response.body as { error?: string }).error;
const bodyOf = (response: { body: unknown }) => response.body as Record<string, unknown>;

describe('registering the call token', () => {
  it('takes it from a paired device of the owner, with his switch, and says truthfully whether the server can ring', () => {
    const w = world();
    const answer = w.register();
    expect(answer.status).toBe(200);
    expect(bodyOf(answer)).toEqual({ schemaVersion: 1, registered: true, enabled: true, available: true, ringSeconds: 30 });
    expect(w.store.devices(scope)).toEqual([{ deviceId: PHONE, deviceToken: TOKEN, environment: 'production', bundleId: BUNDLE, enabled: true, updatedAt: START }]);
    // Switched off, the token is kept and the device is not among those that may be rung.
    expect(bodyOf(w.register(PHONE, { enabled: false })).enabled).toBe(false);
    expect(w.store.devices(scope)).toEqual([]);
    w.close();
  });

  it('refuses a guest, an unpaired caller, another app, and anything that is not the closed set of fields', () => {
    const w = world();
    expect(errorOf(w.register(null))).toBe('PAIRED_DEVICE_REQUIRED');
    expect(errorOf(w.register('guest-phone', {}, 'guest-7'))).toBe('INCOMING_CALLS_OWNER_ONLY');
    expect(w.register(PHONE, { deviceToken: 'not-a-token' }).status).toBe(400);
    expect(w.register(PHONE, { environment: 'staging' }).status).toBe(400);
    expect(w.register(PHONE, { bundleId: 'com.example.other' }).status).toBe(400);
    expect(w.register(PHONE, { bundleId: `${BUNDLE}.voip` }).status).toBe(400);
    expect(w.register(PHONE, { enabled: 'yes' }).status).toBe(400);
    expect(w.register(PHONE, { text: 'hello' }).status).toBe(400);
    expect(w.store.devices(scope)).toEqual([]);
    expect(w.post('/v1/incoming-calls/unknown', {}, PHONE).status).toBe(404);
    // A guest can no more report on a call than register for one.
    expect(errorOf(w.post(`/v1/incoming-calls/${CALL_IDS[0]}/report`, { outcome: 'answered' }, 'guest-phone', 'guest-7'))).toBe('INCOMING_CALLS_OWNER_ONLY');
    w.close();
  });

  it('says the server is not ready without an APNs key or with the kill switch off, and rings nothing', async () => {
    const off = world({ enabled: false });
    expect(bodyOf(off.register()).available).toBe(false);
    off.say();
    await off.calls.tick();
    expect(off.apns.sent).toEqual([]);
    off.close();

    const noKey = world();
    noKey.apns.enabled = false;
    expect(bodyOf(noKey.register()).available).toBe(false);
    const id = noKey.say();
    await noKey.calls.tick();
    expect(noKey.apns.sent).toEqual([]);
    // Nothing was taken: her body or an app may still say it.
    expect(noKey.claims.holder(scope, id)).toBeNull();
    noKey.close();

    expect(incomingCallsEnabled({})).toBe(true);
    for (const value of ['off', 'false', '0', 'disabled', ' OFF ']) expect(incomingCallsEnabled({ SHANNON_INCOMING_CALLS: value })).toBe(false);
  });
});

describe('ringing', () => {
  it('rings his iPhone once with a message nobody can simply say, and the push carries no word of hers', async () => {
    const w = world();
    w.register();
    const id = w.say();
    w.advance(2 * SECOND);
    await w.calls.tick();
    expect(w.apns.sent).toHaveLength(1);
    const { target, payload } = w.apns.sent[0]!;
    expect(target).toEqual({ deviceToken: TOKEN, environment: 'production', bundleId: BUNDLE });
    expect(payload).toEqual({ callId: CALL_IDS[0], reachOutId: id, threadId: w.persistent.threadId(scope), expiresAt: '2026-10-03T03:00:32.000Z' });
    const wire = incomingCallPushBody(payload);
    expect(JSON.parse(wire)).toEqual({ aps: {}, shannonCall: 1, ...payload });
    expect(wire).not.toContain('ライ氏');
    // The call holds the message: exactly one surface.
    expect(w.claims.holder(scope, id)).toMatchObject({ deviceId: PHONE, surface: 'iphone_call', spokenAt: null });
    expect(w.store.ofMessage(scope, id)).toMatchObject({ callId: CALL_IDS[0], state: 'ringing', deviceId: PHONE });
    // Looking again, however often, rings nothing more.
    for (let index = 0; index < 5; index += 1) { w.advance(2 * SECOND); await w.calls.tick(); }
    expect(w.apns.sent).toHaveLength(1);
    // What is logged is a fixed word and a status.
    expect(JSON.stringify(w.logged)).toBe('[["ringing",{"status":200,"reason":null}]]');
    w.close();
  });

  it('does not ring again after a restart, whatever became of the call', async () => {
    const w = world();
    w.register();
    const id = w.say();
    await w.calls.tick();
    w.restart();
    await w.calls.tick();
    w.advance(50 * SECOND);
    await w.calls.tick();
    expect(w.store.ofMessage(scope, id)).toMatchObject({ state: 'unanswered', decidedBy: 'server' });
    w.restart();
    await w.calls.tick();
    expect(w.apns.sent).toHaveLength(1);
    w.close();
  });

  it('closes a call whose push was never confirmed when the process stopped, gives the message back, and never sends it', async () => {
    const w = world();
    w.register();
    const id = w.say();
    // What a process that stopped between the row and the push leaves behind.
    expect(w.claims.claim(scope, id, PHONE, 'iphone_call', w.clock.at)).toBe('claimed');
    expect(w.store.begin(scope, { callId: CALL_IDS[8]!, initiativeId: id, deviceId: PHONE, threadId: 't', expiresAt: '2026-10-03T03:00:30.000Z' }, w.clock.at)).toBe(true);
    w.restart();
    await w.calls.tick();
    expect(w.store.ofMessage(scope, id)?.state).toBe('pending');
    w.advance(11 * SECOND);
    await w.calls.tick();
    expect(w.store.ofMessage(scope, id)).toMatchObject({ state: 'failed', decidedBy: 'server' });
    expect(w.claims.holder(scope, id)).toBeNull();
    await w.calls.tick();
    expect(w.apns.sent).toEqual([]);
    w.close();
  });

  it('gives back a call claim that has no call row', async () => {
    const w = world();
    const id = w.say();
    expect(w.claims.claim(scope, id, PHONE, 'iphone_call', w.clock.at)).toBe('claimed');
    await w.calls.tick();
    expect(w.claims.holder(scope, id)).toBeNull();
    w.close();
  });

  it('never rings into a conversation, for a message he read, for an old one, or for her second call', async () => {
    const talking = world();
    talking.register();
    talking.ownerSpeaks();
    talking.advance(9 * MINUTE);
    talking.say();
    await talking.calls.tick();
    expect(talking.apns.sent).toEqual([]);
    talking.close();

    const answered = world();
    answered.register();
    answered.say();
    answered.advance(SECOND);
    answered.ownerSpeaks();
    await answered.calls.tick();
    expect(answered.apns.sent).toEqual([]);
    answered.close();

    const read = world();
    read.register();
    read.say();
    read.initiatives.markRead(scope, undefined, read.clock.at);
    await read.calls.tick();
    expect(read.apns.sent).toEqual([]);
    read.close();

    const old = world();
    const id = old.say();
    old.advance(3 * MINUTE + SECOND);
    old.register();
    await old.calls.tick();
    expect(old.apns.sent).toEqual([]);
    expect(old.claims.holder(scope, id)).toBeNull();
    old.close();

    const again = world();
    again.register();
    const first = again.say();
    await again.calls.tick();
    expect(again.report(CALL_IDS[0]!, 'unanswered').status).toBe(200);
    again.advance(4 * MINUTE);
    expect(again.speaker.sayAgain(scope, { originId: first, text: 'ライ氏、もう一度だけ。', dayKey: again.clock.at.slice(0, 10), maximumPerDay: 3 }, again.clock.at)).toBe('sent');
    await again.calls.tick();
    expect(again.apns.sent).toHaveLength(1);
    again.close();
  });

  it('rings only a device that is still paired and whose switch is on', async () => {
    const w = world({ paired: [] });
    w.register();
    w.say();
    await w.calls.tick();
    expect(w.apns.sent).toEqual([]);
    w.paired.add(PHONE);
    w.register(PHONE, { enabled: false });
    await w.calls.tick();
    expect(w.apns.sent).toEqual([]);
    // Unpairing drops the token.
    w.register();
    w.store.invalidateDevice(PHONE, w.clock.at);
    await w.calls.tick();
    expect(w.apns.sent).toEqual([]);
    w.close();
  });

  it('drops a token APNs no longer knows, gives the message back, and does not ring that message again', async () => {
    const w = world();
    w.register();
    const id = w.say();
    w.apns.next = { delivered: false, invalidToken: true, status: 410, reason: 'Unregistered' };
    await w.calls.tick();
    expect(w.store.ofMessage(scope, id)).toMatchObject({ state: 'failed', decidedBy: 'server' });
    expect(w.store.devices(scope)).toEqual([]);
    expect(w.claims.holder(scope, id)).toBeNull();
    // Registered anew, the device may be rung again, but not with that message.
    w.apns.next = { delivered: true, invalidToken: false, status: 200, reason: null };
    w.register();
    await w.calls.tick();
    expect(w.apns.sent).toHaveLength(1);
    w.close();

    const down = world();
    down.register();
    const other = down.say();
    down.apns.next = new Error(`socket hang up ${TOKEN}`);
    await down.calls.tick();
    expect(down.store.ofMessage(scope, other)?.state).toBe('failed');
    // A failure of the network keeps the token, and nothing of the error reaches the log.
    expect(down.store.devices(scope)).toHaveLength(1);
    expect(JSON.stringify(down.logged)).not.toContain(TOKEN);
    down.close();
  });
});

describe('one surface per message', () => {
  it('leaves it to an app in his ears, and offers a ringing message to no app', async () => {
    const w = world();
    w.register();
    w.beat(MAC, 'mac');
    const id = w.say();
    await w.calls.tick();
    expect(w.apns.sent).toEqual([]);
    // The app is gone (three missed reports): now the phone rings.
    w.advance(50 * SECOND);
    await w.calls.tick();
    expect(w.apns.sent).toHaveLength(1);
    // While it rings, and afterwards, no app is offered the message and none can take it.
    expect(bodyOf(w.beat(MAC, 'mac')).reachOut).toBeNull();
    expect(bodyOf(w.beat(PHONE, 'iphone')).reachOut).toBeNull();
    expect(errorOf(dispatchPrivateListeningRequest(
      { method: 'POST', path: `/v1/private-listening/reach-outs/${id}/claim`, body: { scopeKey: scope }, deviceId: PHONE },
      { store: new Proxy({}, {}) as never, enabled: true, ownerScopeKey: scope, reachOuts: w.reachOuts, now: () => w.clock.at },
    ))).toBe('REACH_OUT_TAKEN');
    // A report on the earphone route is not the call's.
    expect(w.reachOuts.report(scope, PHONE, id, 'shown_spoken')).toEqual({ kind: 'not_claimed' });
    w.close();
  });

  it('leaves it to her body when the body is there and shows it, and rings when the body did not', async () => {
    const shown = world();
    shown.register();
    await shown.bodyOnline();
    await shown.bodyPresence();
    const id = shown.say();
    shown.advance(2 * SECOND);
    // The body read presence a moment ago: the call waits for it.
    await shown.calls.tick();
    expect(shown.apns.sent).toEqual([]);
    expect((await shown.bodyPresence())?.latestId).toBe(id);
    expect(shown.claims.holder(scope, id)?.surface).toBe('body');
    await shown.bodyReport(id, 'shown_spoken');
    shown.advance(30 * SECOND);
    await shown.calls.tick();
    expect(shown.apns.sent).toEqual([]);
    shown.close();

    const away = world();
    away.register();
    await away.bodyOnline();
    const other = away.say();
    expect((await away.bodyPresence())?.latestId).toBe(other);
    await away.bodyReport(other, 'away');
    // The body gave it back: the phone rings at once, and her body is no longer told about it.
    await away.calls.tick();
    expect(away.apns.sent).toHaveLength(1);
    expect(away.claims.holder(scope, other)?.surface).toBe('iphone_call');
    expect((await away.bodyPresence())?.pending).toBe(0);
    away.close();

    const silent = world();
    silent.register();
    await silent.bodyOnline();
    silent.reports.markPresence(scope, BODY, silent.clock.at);
    silent.say();
    silent.advance(21 * SECOND);
    silent.reports.markPresence(scope, BODY, silent.clock.at);
    // A body that keeps reading and never takes it does not hold the call back for ever.
    await silent.calls.tick();
    expect(silent.apns.sent).toHaveLength(1);
    silent.close();
  });
});

describe('answering', () => {
  it('hands her words to the device that was rung, once he answered, and to nobody else', async () => {
    const w = world();
    w.register();
    const id = w.say();
    await w.calls.tick();
    w.advance(8 * SECOND);
    expect(errorOf(w.answer(id, CALL_IDS[0]!, MAC))).toBe('CALL_NOT_YOURS');
    expect(errorOf(w.answer(id, CALL_IDS[5]!))).toBe('CALL_NOT_FOUND');
    expect(w.answer(id, 'not-a-call').status).toBe(400);
    const taken = w.answer(id, CALL_IDS[0]!);
    expect(taken.status).toBe(200);
    expect(bodyOf(taken)).toMatchObject({ id, status: 'claimed', surface: 'iphone_call', spoken: false, listenSeconds: 0 });
    expect((bodyOf(taken).message as { content: string; threadId: string })).toMatchObject({ content: TEXT, threadId: w.persistent.threadId(scope) });
    // A lost reply is asked for again and gets the same words.
    expect(bodyOf(w.answer(id, CALL_IDS[0]!))).toMatchObject({ status: 'held' });
    expect(w.store.outcome(scope, id)).toBe('answered');
    // From here the message is said: the claim is never given back, and what went wrong later does not undo the answer.
    expect(w.claims.holder(scope, id)?.spokenAt).toBe(w.clock.at);
    expect(bodyOf(w.report(CALL_IDS[0]!, 'failed'))).toMatchObject({ status: 'kept' });
    expect(bodyOf(w.report(CALL_IDS[0]!, 'answered'))).toMatchObject({ status: 'duplicate' });
    expect(w.store.outcome(scope, id)).toBe('answered');
    // Her body is not told about it either, however much later it starts.
    w.advance(10 * MINUTE);
    await w.bodyOnline();
    expect((await w.bodyPresence())?.pending).toBe(0);
    w.close();
  });

  it('keeps what he chose: declined or not answered stays the call\'s, and a call that could not ring gives the message back', async () => {
    const declined = world();
    declined.register();
    const id = declined.say();
    await declined.calls.tick();
    expect(errorOf(declined.report(CALL_IDS[0]!, 'answered', MAC))).toBe('CALL_NOT_YOURS');
    expect(declined.report(CALL_IDS[0]!, 'hung_up').status).toBe(400);
    expect(declined.post(`/v1/incoming-calls/${CALL_IDS[0]}/report`, { outcome: 'declined', text: 'x' }, PHONE).status).toBe(400);
    expect(bodyOf(declined.report(CALL_IDS[0]!, 'declined'))).toMatchObject({ status: 'stored' });
    expect(bodyOf(declined.report(CALL_IDS[0]!, 'declined'))).toMatchObject({ status: 'duplicate' });
    expect(errorOf(declined.report(CALL_IDS[0]!, 'answered'))).toBe('CALL_ALREADY_REPORTED');
    expect(declined.store.outcome(scope, id)).toBe('declined');
    expect(declined.claims.holder(scope, id)?.surface).toBe('iphone_call');
    expect(errorOf(declined.answer(id, CALL_IDS[0]!))).toBe('CALL_ENDED');
    // Nobody says it after he chose not to hear it; the text stays in the Talk.
    expect(bodyOf(declined.beat(MAC, 'mac')).reachOut).toBeNull();
    expect(declined.speaker.text(scope, id)).toBe(TEXT);
    // Her body is not told about it either, also long after the ring.
    await declined.bodyOnline();
    declined.advance(6 * MINUTE);
    expect((await declined.bodyPresence())?.pending).toBe(0);
    declined.close();

    const failed = world();
    failed.register();
    const other = failed.say();
    await failed.calls.tick();
    expect(bodyOf(failed.report(CALL_IDS[0]!, 'failed'))).toMatchObject({ status: 'stored' });
    expect(failed.claims.holder(scope, other)).toBeNull();
    // An app in his ears may still say it; the phone is not rung with it again.
    expect(bodyOf(failed.beat(MAC, 'mac')).reachOut).toEqual({ id: other, createdAt: START });
    await failed.calls.tick();
    expect(failed.apns.sent).toHaveLength(1);
    failed.close();
  });

  it('counts a ring nobody reported on as not answered, refuses a late answer, and takes the app\'s word over its own guess', async () => {
    const w = world();
    w.register();
    const id = w.say();
    await w.calls.tick();
    w.advance(44 * SECOND);
    await w.calls.tick();
    expect(w.store.outcome(scope, id)).toBeNull();
    w.advance(2 * SECOND);
    await w.calls.tick();
    expect(w.store.ofMessage(scope, id)).toMatchObject({ state: 'unanswered', decidedBy: 'server' });
    expect(errorOf(w.answer(id, CALL_IDS[0]!))).toBe('CALL_EXPIRED');
    // The app's own report arrives late: it knows better than the server's guess.
    expect(bodyOf(w.report(CALL_IDS[0]!, 'declined'))).toMatchObject({ status: 'stored' });
    expect(w.store.ofMessage(scope, id)).toMatchObject({ state: 'declined', decidedBy: 'app' });
    expect(errorOf(w.report(CALL_IDS[0]!, 'unanswered'))).toBe('CALL_ALREADY_REPORTED');
    w.close();
  });

  it('refuses an answer once the kill switch is off', async () => {
    const path = join(directory, `calls-${databases += 1}.sqlite`);
    const on = world({ path });
    on.register();
    const id = on.say();
    await on.calls.tick();
    on.close();
    const off = world({ path, enabled: false });
    expect(errorOf(off.answer(id, CALL_IDS[0]!))).toBe('INCOMING_CALLS_DISABLED');
    off.close();
  });
});

describe('the APNs sender', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const payload: IncomingCallPayload = { callId: CALL_IDS[0]!, reachOutId: 'r-1', threadId: 't-1', expiresAt: '2026-10-03T03:00:30.000Z' };

  it('sends one VoIP push with token authentication, the .voip topic and a short expiry', async () => {
    const requests: Array<{ origin: string; headers: Readonly<Record<string, string>>; body: string }> = [];
    const sender = new APNsVoipPushSender({
      keyId: 'ABCDEFGHIJ', teamId: 'KLMNOPQRST', privateKey: pem, now: () => Date.parse(START),
      transport: async (origin, headers, body) => { requests.push({ origin, headers, body }); return { status: 200, body: '' }; },
    });
    expect(await sender.send({ deviceToken: TOKEN, environment: 'production', bundleId: BUNDLE }, payload))
      .toEqual({ delivered: true, invalidToken: false, status: 200, reason: null });
    await sender.send({ deviceToken: TOKEN, environment: 'sandbox', bundleId: BUNDLE }, payload);
    expect(requests.map(request => request.origin)).toEqual(['https://api.push.apple.com', 'https://api.sandbox.push.apple.com']);
    const { headers, body } = requests[0]!;
    expect(headers).toMatchObject({
      ':method': 'POST', ':path': `/3/device/${TOKEN}`, 'apns-topic': `${BUNDLE}.voip`, 'apns-push-type': 'voip', 'apns-priority': '10',
      'apns-expiration': String(Date.parse(payload.expiresAt) / 1_000),
    });
    const [header, claims, signature] = headers.authorization!.replace(/^bearer /u, '').split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'ABCDEFGHIJ' });
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({ iss: 'KLMNOPQRST', iat: Date.parse(START) / 1_000 });
    expect(Buffer.from(signature!, 'base64url')).toHaveLength(64);
    // The provider token is reused, not signed anew for every push.
    expect(requests[1]!.headers.authorization).toBe(headers.authorization);
    expect(JSON.parse(body)).toEqual({ aps: {}, shannonCall: 1, ...payload });
  });

  it('says when a token is gone', async () => {
    const answers = [{ status: 410, body: '{"reason":"Unregistered"}' }, { status: 400, body: '{"reason":"BadDeviceToken"}' }, { status: 429, body: '{"reason":"TooManyRequests"}' }];
    const sender = new APNsVoipPushSender({ keyId: 'ABCDEFGHIJ', teamId: 'KLMNOPQRST', privateKey: pem, transport: async () => answers.shift()! });
    const target = { deviceToken: TOKEN, environment: 'production' as const, bundleId: BUNDLE };
    expect(await sender.send(target, payload)).toMatchObject({ delivered: false, invalidToken: true, status: 410 });
    expect(await sender.send(target, payload)).toMatchObject({ delivered: false, invalidToken: true, reason: 'BadDeviceToken' });
    expect(await sender.send(target, payload)).toMatchObject({ delivered: false, invalidToken: false, status: 429 });
  });

  it('takes its credentials from the environment only, and is simply unavailable without them', () => {
    const keyFile = join(directory, 'AuthKey_TEST.p8');
    writeFileSync(keyFile, pem, { mode: 0o600 });
    const warnings: string[] = [];
    const warn = (code: string) => warnings.push(code);
    expect(createConfiguredVoipPushSender({}, { warn }).enabled).toBe(false);
    expect(createConfiguredVoipPushSender({ SHANNON_APNS_KEY_ID: 'ABCDEFGHIJ', SHANNON_APNS_TEAM_ID: 'KLMNOPQRST' }, { warn }).enabled).toBe(false);
    expect(warnings).toEqual([]);
    expect(createConfiguredVoipPushSender({ SHANNON_APNS_KEY_ID: 'ABCDEFGHIJ', SHANNON_APNS_TEAM_ID: 'KLMNOPQRST', SHANNON_APNS_PRIVATE_KEY_FILE: keyFile }, { warn }).enabled).toBe(true);
    // A key that cannot be used does not stop the API, and what is logged is a code: no path, no key material.
    const broken = join(directory, 'broken.p8');
    writeFileSync(broken, 'not a key at all');
    const environment = { SHANNON_APNS_KEY_ID: 'ABCDEFGHIJ', SHANNON_APNS_TEAM_ID: 'KLMNOPQRST' };
    expect(createConfiguredVoipPushSender({ ...environment, SHANNON_APNS_PRIVATE_KEY_FILE: broken }, { warn }).enabled).toBe(false);
    expect(createConfiguredVoipPushSender({ ...environment, SHANNON_APNS_PRIVATE_KEY_FILE: join(directory, 'missing.p8') }, { warn }).enabled).toBe(false);
    expect(createConfiguredVoipPushSender({ ...environment, SHANNON_APNS_KEY_ID: 'short', SHANNON_APNS_PRIVATE_KEY_FILE: keyFile }, { warn }).enabled).toBe(false);
    expect(warnings).toEqual(['SHANNON_APNS_PRIVATE_KEY_UNREADABLE', 'SHANNON_APNS_PRIVATE_KEY_FILE_MISSING', 'SHANNON_APNS_KEY_ID_INVALID']);
  });

  it('documents the kill switch in both environment examples, with no key in either', () => {
    for (const path of ['../../../deploy/azure/api.env.example', '../../../.env.example']) {
      const example = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(example).toContain('SHANNON_INCOMING_CALLS=on');
      expect(example).toMatch(/^SHANNON_APNS_KEY_ID=$/mu);
      expect(example).not.toContain('BEGIN PRIVATE KEY');
    }
  });

  it('keeps her words and the key out of every source file that sends or logs', () => {
    const source = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
    // The push body is built in one place, from identifiers and a time.
    expect(source('incomingCallContract.ts')).not.toMatch(/content|text:/u);
    expect(source('voipPushSender.ts')).not.toMatch(/console\.(log|warn|error)\([^)]*(privateKey|deviceToken|keyFile)/u);
    expect(source('incomingCalls.ts')).not.toMatch(/console\./u);
  });
});

describe('what she is told afterwards', () => {
  const facts = (call: ReachOutFacts['call'], extra: Partial<ReachOutFacts> = {}): ReachOutFacts => ({
    id: 'r-1', reason: 'wonder', sentAt: START, waitedSeconds: 180, replied: false, delivery: 'unknown',
    windowVisible: false, owner: 'unknown', others: false, ...(call ? { call } : {}), ...extra,
  });
  const lines = (value: ReachOutFacts) => reachOutHappenedLines(value, { at: '2026-10-03T03:03:00.000Z', timeZone: 'Asia/Tokyo' }).join('\n');

  it('has one fixed line for each outcome of a call', () => {
    expect(lines(facts('answered', { replied: true, repliedAfterSeconds: 20 }))).toContain('- 電話の知らせ: iPhoneに電話をかけたら、ライ氏が出てくれた。');
    expect(lines(facts('declined'))).toContain('- 電話の知らせ: iPhoneに電話をかけたが、ライ氏はいまは出ないことを選んだ。');
    expect(lines(facts('unanswered'))).toContain('- 電話の知らせ: iPhoneに電話をかけたが、ライ氏は出なかった。');
    expect(lines(facts('unanswered'))).toContain('3分待ったが、返事はまだない。');
    // A call that rang says where the message went; the body's line is left out.
    expect(lines(facts('unanswered'))).not.toContain('体からの知らせ');
    expect(lines(facts('failed'))).toContain('- 電話の知らせ: iPhoneに電話をかけようとしたが、つながらなかった。');
    expect(lines(facts('failed'))).toContain('体からの知らせ');
    // Without a call nothing changes.
    expect(lines(facts(undefined))).not.toContain('電話');
    expect(reachOutMemoryLine({ facts: facts('unanswered'), after: [], repliedSince: false }, 'Asia/Tokyo'))
      .toBe('12:00に話しかけた（きっかけ: いま何をしているか気になった）。iPhoneに電話をかけたが、ライ氏は出なかった。3分待ったが返事はなかった。');
  });

  it('keeps the outcome as a closed value in her observations', () => {
    const database = new DatabaseSync(':memory:');
    const observations = new AutonomyLoopObservations(database);
    observations.add(scope, { cycleId: 'c-1', ordinal: 0, step: 'reach_out', outcome: 'done', reachOut: facts('declined') }, START);
    observations.add(scope, { cycleId: 'c-1', ordinal: 1, step: 'reach_out', outcome: 'done', reachOut: { ...facts(undefined), call: 'said something' as never } }, START);
    const [first, second] = observations.ofCycle('c-1');
    expect(first!.reachOut?.call).toBe('declined');
    expect(second!.reachOut).not.toHaveProperty('call');
    database.close();
  });

  it('reads the outcome of the call for the message she sent', async () => {
    const w = world();
    w.register();
    const id = w.say();
    expect(w.store.outcome(scope, id)).toBeNull();
    await w.calls.tick();
    // While it rings there is nothing to tell yet.
    expect(w.store.outcome(scope, id)).toBeNull();
    w.report(CALL_IDS[0]!, 'unanswered');
    expect(w.store.outcome(scope, id)).toBe('unanswered');
    expect(INCOMING_CALL_LIMITS.ringSeconds).toBe(30);
    w.close();
  });
});
