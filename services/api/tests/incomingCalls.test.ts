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
import { INCOMING_CALL_LIMITS, incomingCallMinimumIntervalMilliseconds, incomingCallPushBody, incomingCallsEnabled, type IncomingCallPayload } from '../src/contracts/incomingCallContract.js';
import { dispatchIncomingCallRequest } from '../src/incomingCallRoutes.js';
import { IncomingCallRequests, incomingCallsConfigured } from '../src/incomingCallRequests.js';
import { IncomingCalls } from '../src/incomingCalls.js';
import { SQLiteIncomingCallStore } from '../src/incomingCallStore.js';
import { SQLiteInitiativeStore } from '../src/initiativeStore.js';
import { dispatchPrivateListeningRequest } from '../src/privateListeningRoutes.js';
import { SQLitePrivateListeningStore } from '../src/privateListeningStore.js';
import { PrivateReachOuts } from '../src/privateReachOuts.js';
import { SQLiteReachOutClaims } from '../src/reachOutClaims.js';
import { SQLiteReachOutSpeaker } from '../src/reachOutDelivery.js';
import { SQLiteReachOutReports } from '../src/reachOutReports.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { APNsVoipPushSender, createConfiguredVoipPushSender, type VoipPushResult, type VoipPushSender, type VoipPushTarget } from '../src/voipPushSender.js';
import { readApiSource } from './support/sources.js';

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

function world(options: { enabled?: boolean; path?: string; paired?: string[]; intervalMinutes?: number } = {}) {
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
    log: (event, detail) => logged.push([event, detail]),
  });
  /** Her loop's side: the facts she chooses with, and asking for the call. */
  const requests = new IncomingCallRequests({
    store, claims, listeners: (scopeKey, at) => listening.listeners(scopeKey, at), bodyVisible: (scopeKey, at) => reports.windowVisible(scopeKey, at),
    serverReady: options.enabled ?? true, minimumIntervalMilliseconds: (options.intervalMinutes ?? 0) * MINUTE, newCallId: () => CALL_IDS[ids++]!,
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
  /** She chose to phone him: her line is written as a message of hers, and the call is asked for. */
  const ask = (text = TEXT) => {
    expect(speaker.sayByPhone(scope, { reason: 'wonder', text, dayKey: clock.at.slice(0, 10) }, clock.at)).toBe('sent');
    const id = speaker.latest(scope)!.id;
    expect(requests.request(scope, id, clock.at)).toBe('requested');
    return id;
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
    path, clock, advance, persistent, initiatives, reports, speaker, claims, store, apns, paired, logged, reachOuts, requests, ask,
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
    // She is not offered the call, and asking for one is refused.
    const message = off.say();
    expect(off.requests.facts(scope, off.clock.at)).toMatchObject({ switchedOn: true, serverReady: false });
    expect(off.requests.request(scope, message, off.clock.at)).toBe('unavailable');
    await off.calls.tick();
    expect(off.apns.sent).toEqual([]);
    off.close();

    // The loop's process and the API process disagree for a moment (a restart applied the switch to one of them only).
    const noKey = world();
    noKey.register();
    const id = noKey.ask();
    noKey.apns.enabled = false;
    await noKey.calls.tick();
    expect(noKey.apns.sent).toEqual([]);
    expect(noKey.store.ofMessage(scope, id)).toMatchObject({ state: 'failed', decidedBy: 'server' });
    // Nothing is held: her body or an app may still say it.
    expect(noKey.claims.holder(scope, id)).toBeNull();
    noKey.close();

    expect(incomingCallsEnabled({})).toBe(true);
    for (const value of ['off', 'false', '0', 'disabled', ' OFF ']) expect(incomingCallsEnabled({ SHANNON_INCOMING_CALLS: value })).toBe(false);
    // What her process is told about the server: the switches and the three values, with a key file that exists. The key is not read.
    const keyFile = join(directory, 'configured.p8');
    writeFileSync(keyFile, 'not read here');
    const environment = { SHANNON_APNS_KEY_ID: 'ABCDEFGHIJ', SHANNON_APNS_TEAM_ID: 'KLMNOPQRST', SHANNON_APNS_PRIVATE_KEY_FILE: keyFile };
    expect(incomingCallsConfigured(environment)).toBe(true);
    expect(incomingCallsConfigured({})).toBe(false);
    expect(incomingCallsConfigured({ ...environment, SHANNON_APNS_PRIVATE_KEY_FILE: join(directory, 'nowhere.p8') })).toBe(false);
    expect(incomingCallsConfigured({ ...environment, SHANNON_INCOMING_CALLS: 'off' })).toBe(false);
    expect(incomingCallsConfigured({ ...environment, SHANNON_PRIVATE_LISTENING_REACH_OUTS: 'off' })).toBe(false);
    expect(incomingCallMinimumIntervalMilliseconds({})).toBe(5 * MINUTE);
    expect(incomingCallMinimumIntervalMilliseconds({ SHANNON_INCOMING_CALL_MIN_INTERVAL_MINUTES: '30' })).toBe(30 * MINUTE);
    expect(incomingCallMinimumIntervalMilliseconds({ SHANNON_INCOMING_CALL_MIN_INTERVAL_MINUTES: '-1' })).toBe(5 * MINUTE);
  });
});

describe('ringing', () => {
  it('never rings by itself: an ordinary message of hers is delivered as before, however long nobody says it', async () => {
    const w = world();
    w.register();
    const id = w.say();
    for (let index = 0; index < 10; index += 1) { w.advance(10 * SECOND); await w.calls.tick(); }
    expect(w.apns.sent).toEqual([]);
    expect(w.store.ofMessage(scope, id)).toBeNull();
    expect(w.claims.holder(scope, id)).toBeNull();
    // An app in his ears is offered it, as before.
    const fresh = w.say('ライ氏、もうひとつ。');
    expect(bodyOf(w.beat(MAC, 'mac')).reachOut).toMatchObject({ id: fresh });
    w.close();
  });

  it('rings his iPhone once when she asked for the call, and the push carries no word of hers', async () => {
    const w = world();
    w.register();
    const id = w.ask();
    // From the moment she asked, the message is the call's: exactly one surface.
    expect(w.claims.holder(scope, id)).toMatchObject({ deviceId: PHONE, surface: 'iphone_call', spokenAt: null });
    expect(w.store.ofMessage(scope, id)).toMatchObject({ callId: CALL_IDS[0], state: 'pending', deviceId: PHONE });
    w.advance(2 * SECOND);
    await w.calls.tick();
    expect(w.apns.sent).toHaveLength(1);
    const { target, payload } = w.apns.sent[0]!;
    expect(target).toEqual({ deviceToken: TOKEN, environment: 'production', bundleId: BUNDLE });
    expect(payload).toEqual({ callId: CALL_IDS[0], reachOutId: id, threadId: w.persistent.threadId(scope), expiresAt: '2026-10-03T03:00:32.000Z' });
    const wire = incomingCallPushBody(payload);
    expect(JSON.parse(wire)).toEqual({ aps: {}, shannonCall: 1, ...payload });
    expect(wire).not.toContain('ライ氏');
    expect(w.store.ofMessage(scope, id)).toMatchObject({ state: 'ringing', expiresAt: '2026-10-03T03:00:32.000Z' });
    // Her line is in the Talk as a message of hers, outside the day's count of messages.
    expect(w.speaker.text(scope, id)).toBe(TEXT);
    expect(w.speaker.sentOn(scope, '2026-10-03')).toBe(0);
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
    const id = w.ask();
    await w.calls.tick();
    w.restart();
    await w.calls.tick();
    w.advance(50 * SECOND);
    await w.calls.tick();
    expect(w.store.ofMessage(scope, id)).toMatchObject({ state: 'unanswered', decidedBy: 'server' });
    w.restart();
    await w.calls.tick();
    expect(w.apns.sent).toHaveLength(1);
    // The same message cannot be asked for twice.
    expect(w.requests.request(scope, id, w.clock.at)).toBe('unavailable');
    w.close();
  });

  it('never sends a call the API did not get to in time, or one a stopped process left half-sent', async () => {
    const late = world();
    late.register();
    const id = late.ask();
    // The API process was down while she asked.
    late.advance(11 * SECOND);
    await late.calls.tick();
    expect(late.apns.sent).toEqual([]);
    expect(late.store.ofMessage(scope, id)).toMatchObject({ state: 'failed', decidedBy: 'server' });
    expect(late.claims.holder(scope, id)).toBeNull();
    late.close();

    const stopped = world();
    stopped.register();
    const other = stopped.ask();
    // A process took the call to send it and stopped: whether the push left is not known.
    expect(stopped.store.take(CALL_IDS[0]!, '2026-10-03T03:00:30.000Z')).toBe(true);
    stopped.restart();
    await stopped.calls.tick();
    expect(stopped.apns.sent).toEqual([]);
    // If the phone does ring, he can still answer.
    expect(stopped.answer(other, CALL_IDS[0]!).status).toBe(200);
    stopped.close();

    const lost = world();
    lost.register();
    const third = lost.ask();
    expect(lost.store.take(CALL_IDS[0]!, '2026-10-03T03:00:30.000Z')).toBe(true);
    lost.restart();
    lost.advance(46 * SECOND);
    await lost.calls.tick();
    expect(lost.apns.sent).toEqual([]);
    expect(lost.store.ofMessage(scope, third)).toMatchObject({ state: 'failed', decidedBy: 'server' });
    expect(lost.claims.holder(scope, third)).toBeNull();
    lost.close();
  });

  it('refuses, a moment after she asked, a call into a conversation, for a message he read, or while another rings', async () => {
    const talking = world();
    talking.register();
    const id = talking.ask();
    talking.ownerSpeaks();
    await talking.calls.tick();
    expect(talking.apns.sent).toEqual([]);
    expect(talking.store.ofMessage(scope, id)?.state).toBe('failed');
    expect(talking.claims.holder(scope, id)).toBeNull();
    expect(JSON.stringify(talking.logged)).toBe('[["failed",{"status":0,"reason":"conversation"}]]');
    talking.close();

    const read = world();
    read.register();
    read.ask();
    read.initiatives.markRead(scope, undefined, read.clock.at);
    await read.calls.tick();
    expect(read.apns.sent).toEqual([]);
    read.close();

    // While a call rings she cannot ask for another, and neither can a second row slip through.
    const ringing = world();
    ringing.register();
    ringing.ask();
    await ringing.calls.tick();
    const second = ringing.say('ライ氏、もうひとつ。');
    expect(ringing.requests.facts(scope, ringing.clock.at)).toMatchObject({ ringing: true, last: { outcome: 'ringing' } });
    expect(ringing.requests.request(scope, second, ringing.clock.at)).toBe('ringing');
    expect(ringing.claims.holder(scope, second)).toBeNull();
    ringing.close();
  });

  it('keeps a minimum interval between two calls, whatever became of the first, and has no count of calls a day', async () => {
    const w = world({ intervalMinutes: 5 });
    w.register();
    w.ask();
    await w.calls.tick();
    expect(w.report(CALL_IDS[0]!, 'declined').status).toBe(200);
    w.advance(4 * MINUTE);
    const soon = w.say('ライ氏、もう一度。');
    expect(w.requests.facts(scope, w.clock.at)).toMatchObject({ ringing: false, waitMinutes: 1, last: { outcome: 'declined' } });
    expect(w.requests.request(scope, soon, w.clock.at)).toBe('too_soon');
    w.advance(MINUTE);
    expect(w.requests.facts(scope, w.clock.at).waitMinutes).toBe(0);
    // Five more, each after the interval: nothing counts them.
    for (let index = 1; index <= 5; index += 1) {
      w.ask(`ライ氏、${index}回目です。`);
      await w.calls.tick();
      expect(w.report(CALL_IDS[index]!, 'unanswered').status).toBe(200);
      w.advance(5 * MINUTE);
    }
    expect(w.apns.sent).toHaveLength(6);
    w.close();
  });

  it('rings only a device that is still paired and whose switch is on', async () => {
    const w = world({ paired: [] });
    w.register();
    const id = w.ask();
    await w.calls.tick();
    expect(w.apns.sent).toEqual([]);
    expect(w.store.ofMessage(scope, id)?.state).toBe('failed');
    // Switched off, she is told so and cannot ask.
    w.paired.add(PHONE);
    w.register(PHONE, { enabled: false });
    const other = w.say();
    expect(w.requests.facts(scope, w.clock.at).switchedOn).toBe(false);
    expect(w.requests.request(scope, other, w.clock.at)).toBe('unavailable');
    // Unpairing drops the token.
    w.register();
    w.store.invalidateDevice(PHONE, w.clock.at);
    expect(w.requests.request(scope, other, w.clock.at)).toBe('unavailable');
    await w.calls.tick();
    expect(w.apns.sent).toEqual([]);
    w.close();
  });

  it('drops a token APNs no longer knows, gives the message back, and does not ring that message again', async () => {
    const w = world();
    w.register();
    const id = w.ask();
    w.apns.next = { delivered: false, invalidToken: true, status: 410, reason: 'Unregistered' };
    await w.calls.tick();
    expect(w.store.ofMessage(scope, id)).toMatchObject({ state: 'failed', decidedBy: 'server' });
    expect(w.store.devices(scope)).toEqual([]);
    expect(w.claims.holder(scope, id)).toBeNull();
    w.apns.next = { delivered: true, invalidToken: false, status: 200, reason: null };
    w.register();
    await w.calls.tick();
    expect(w.apns.sent).toHaveLength(1);
    w.close();

    const down = world();
    down.register();
    const other = down.ask();
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
  it('offers a message she phones with to no app and not to her body, from the moment she asked', async () => {
    const w = world();
    w.register();
    await w.bodyOnline();
    w.beat(MAC, 'mac');
    // An app is in his ears and her body is there: she chose the phone anyway, and only the phone has it.
    const id = w.ask();
    expect(bodyOf(w.beat(MAC, 'mac')).reachOut).toBeNull();
    expect(bodyOf(w.beat(PHONE, 'iphone')).reachOut).toBeNull();
    expect((await w.bodyPresence())?.pending).toBe(0);
    await w.calls.tick();
    expect(w.apns.sent).toHaveLength(1);
    expect(bodyOf(w.beat(MAC, 'mac')).reachOut).toBeNull();
    expect(errorOf(dispatchPrivateListeningRequest(
      { method: 'POST', path: `/v1/private-listening/reach-outs/${id}/claim`, body: { scopeKey: scope }, deviceId: MAC },
      { store: new Proxy({}, {}) as never, enabled: true, ownerScopeKey: scope, reachOuts: w.reachOuts, now: () => w.clock.at },
    ))).toBe('REACH_OUT_TAKEN');
    // A report on the earphone route is not the call's.
    expect(w.reachOuts.report(scope, PHONE, id, 'shown_spoken')).toEqual({ kind: 'not_claimed' });
    w.close();
  });

  it('does not ring with a message another surface took in the instant after it was written, and counts the attempt', async () => {
    const w = world({ intervalMinutes: 5 });
    w.register();
    const id = w.say();
    expect(w.claims.claim(scope, id, MAC, 'mac', w.clock.at)).toBe('claimed');
    expect(w.requests.request(scope, id, w.clock.at)).toBe('taken');
    // Kept as a call that could not connect: the interval counts from it, and nothing is ever sent for it.
    expect(w.store.ofMessage(scope, id)).toMatchObject({ state: 'failed', decidedBy: 'server' });
    expect(w.claims.holder(scope, id)?.surface).toBe('mac');
    expect(w.requests.facts(scope, w.clock.at)).toMatchObject({ waitMinutes: 5, last: { outcome: 'failed' } });
    await w.calls.tick();
    expect(w.apns.sent).toEqual([]);
    w.close();
  });

  it('gives back a call claim whose request was never written, and is told by the API process whether it can ring', async () => {
    const w = world();
    w.register();
    const id = w.say();
    // Her process stopped between taking the claim and writing the request.
    expect(w.claims.claim(scope, id, PHONE, 'iphone_call', w.clock.at)).toBe('claimed');
    await w.calls.tick();
    expect(w.claims.holder(scope, id)?.surface).toBe('iphone_call');
    w.advance(11 * SECOND);
    await w.calls.tick();
    expect(w.claims.holder(scope, id)).toBeNull();
    // The API process found it cannot ring (a key it could not read): she is not offered the call, whatever her own environment says.
    expect(w.requests.facts(scope, w.clock.at).serverReady).toBe(true);
    w.store.setServerAvailable(false, w.clock.at);
    expect(w.requests.facts(scope, w.clock.at).serverReady).toBe(false);
    expect(w.requests.request(scope, id, w.clock.at)).toBe('unavailable');
    w.store.setServerAvailable(true, w.clock.at);
    expect(w.requests.facts(scope, w.clock.at).serverReady).toBe(true);
    w.close();
  });

  it('does not ring into the conversation of a call he answered, also before he has said a word in it', async () => {
    const w = world({ intervalMinutes: 5 });
    w.register();
    const id = w.ask();
    await w.calls.tick();
    expect(w.answer(id, CALL_IDS[0]!).status).toBe(200);
    w.advance(6 * MINUTE);
    expect(w.requests.facts(scope, w.clock.at)).toMatchObject({ waitMinutes: 4, last: { outcome: 'answered' } });
    expect(w.requests.request(scope, w.say('ライ氏、もうひとつ。'), w.clock.at)).toBe('too_soon');
    w.close();
  });

  it('tells her the facts of the moment as yes or no and times', async () => {
    const w = world();
    expect(w.requests.facts(scope, w.clock.at)).toEqual({
      switchedOn: false, serverReady: true, ringing: false, waitMinutes: 0, earphones: false, body: false, ownerLastActiveAt: null, last: null,
    });
    w.register();
    // An app that is privately listening and would not say her message aloud is not "in his ears" for her.
    w.beat(MAC, 'mac', false);
    expect(w.requests.facts(scope, w.clock.at).earphones).toBe(false);
    w.beat(MAC, 'mac', true);
    w.reports.markPresence(scope, BODY, w.clock.at);
    w.ownerSpeaks();
    expect(w.requests.facts(scope, w.clock.at)).toEqual({
      switchedOn: true, serverReady: true, ringing: false, waitMinutes: 0, earphones: true, body: true, ownerLastActiveAt: START, last: null,
    });
    w.close();
  });
});

describe('answering', () => {
  it('hands her words to the device that was rung, once he answered, and to nobody else', async () => {
    const w = world();
    w.register();
    const id = w.ask();
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
    const id = declined.ask();
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
    const other = failed.ask();
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
    const id = w.ask();
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
    const id = on.ask();
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

  it('documents the kill switch and the interval in both environment examples, with no key in either', () => {
    for (const path of ['../../../deploy/azure/api.env.example', '../../../.env.example']) {
      const example = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(example).toContain('SHANNON_INCOMING_CALLS=on');
      expect(example).toContain('SHANNON_INCOMING_CALL_MIN_INTERVAL_MINUTES=5');
      expect(example).toMatch(/^SHANNON_APNS_KEY_ID=$/mu);
      expect(example).not.toContain('BEGIN PRIVATE KEY');
    }
  });

  it('keeps her words and the key out of every source file that sends or logs', () => {
    const source = (name: string) => readApiSource(name);
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
    const id = w.ask();
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
