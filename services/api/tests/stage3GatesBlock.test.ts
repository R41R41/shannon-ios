import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { SQLiteInitiativeStore } from '../src/surfaces/outreach/store/initiativeStore.js';
import { SQLiteReachOutSpeaker } from '../src/surfaces/outreach/reachOutDelivery.js';
import { SQLiteReachOutClaims } from '../src/mind/attention/store/reachOutClaims.js';
import { SQLiteIncomingCallStore } from '../src/surfaces/outreach/store/incomingCallStore.js';
import { IncomingCallRequests } from '../src/surfaces/outreach/incomingCallRequests.js';
import { IncomingCalls } from '../src/surfaces/outreach/incomingCalls.js';
import { dispatchIncomingCallRequest } from '../src/surfaces/outreach/incomingCallRoutes.js';
import { configuredMind, configuredMindInbox } from '../src/wiring/mindWiring.js';
import { configuredProactiveGate } from '../src/wiring/proactiveGateWiring.js';
import { configuredWithheldActions } from '../src/wiring/withheldWiring.js';
import { createProactiveGate } from '../src/mind/attention/attentionPorts.js';
import { SQLiteProactiveTopics as Topics, type SQLiteProactiveTopics } from '../src/mind/attention/store/proactiveTopicsStore.js';
import { SQLiteStudyShowing } from '../src/mind/action/ownTime/autonomyShowing.js';
import { firstWritten } from '../src/surfaces/outreach/initiativeIntent.js';
import { selectCandidate, type CandidateRow } from '../src/mind/action/respond/initiativeSelection.js';

/**
 * Every delivery point of stage 3's proactive gate really blocks (Syzygy ADR-0008 stage 3, owner answer 2; after Genesis, one of
 * whose gates never worked). Each test drives the delivery point the worker runs (`reachOuts.say`, `sayAgain`, `sayByPhone`, the
 * initiative insert, the call request) and checks that nothing of the message was written, that the hold is a withheld action with
 * its code and a notice for the workspace, beside a positive control on the same path. Spacing stays today's 5 minutes, in the step.
 */
const SCOPE = 'owner';
const START = Date.parse('2026-10-07T01:00:00.000Z');
const MINUTE = 60_000;
const directory = mkdtempSync(join(tmpdir(), 'shannon-stage3-gates-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let databases = 0;

function world(environment: Record<string, string> = {}) {
  const path = join(directory, `gates-${databases += 1}.sqlite`);
  const clock = { at: START };
  const now = () => new Date(clock.at).toISOString();
  const persistent = new SQLiteShannonStore({ path, now });
  persistent.threadId(SCOPE);
  const withheld = configuredWithheldActions({}, { databasePath: path, createsSchema: true, defer: task => task() })!;
  // The API process creates the mind's inbox; the worker's gate writes its notices there.
  const mind = configuredMind({}, { databasePath: path, now, schedule: task => task() })!;
  const inbox = configuredMindInbox({}, { databasePath: path })!;
  const gate = configuredProactiveGate(environment, { databasePath: path, withheld: withheld.withheld.sink, emit: inbox.emit });
  const initiatives = new SQLiteInitiativeStore(path, now, gate?.gate ?? null);
  const speaker = new SQLiteReachOutSpeaker(path, () => false, gate?.gate ?? null);
  const plain = new SQLiteReachOutSpeaker(path);
  const database = new DatabaseSync(path);
  const count = (table: string) => Number((database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  const reasons = () => (database.prepare('SELECT tool, reason, rail FROM shannon_withheld_actions ORDER BY at').all() as Array<Record<string, string>>);
  const notices = () => (database.prepare(`SELECT kind, code, tool, reason FROM mind_inbox ORDER BY seq`).all() as Array<Record<string, string>>);
  const ownerSpeaks = () => database.prepare(`
    INSERT INTO conversation_messages (message_id, scope_key, thread_id, turn_id, ordinal, role, content, observed_at, metadata_json)
    VALUES (?, ?, ?, ?, 0, 'user', 'うん', ?, '{}')
  `).run(randomUUID(), SCOPE, persistent.threadId(SCOPE), randomUUID(), now());
  const day = () => now().slice(0, 10);
  const close = () => { database.close(); plain.close(); speaker.close(); initiatives.close(); gate?.close(); inbox.close(); mind.close(); withheld.close(); persistent.close(); };
  return { path, clock, now, persistent, speaker, plain, initiatives, gate, count, reasons, notices, ownerSpeaks, day, close, advance: (ms: number) => { clock.at += ms; },
    sink: withheld.withheld.sink, emit: inbox.emit };
}

const WONDER = 'ライ氏はいま何をしているのでしょう。';
const SHARE = '書斎で新しい物語の続きを書きました。';

describe('reachOuts.say', () => {
  it('holds while the owner is active (10 minutes), and writes nothing', () => {
    const w = world();
    w.ownerSpeaks();
    w.advance(3 * MINUTE);
    expect(w.speaker.say(SCOPE, { reason: 'wonder', text: WONDER, dayKey: w.day(), maximumPerDay: 20 }, w.now())).toBe('held:owner_active');
    expect(w.count('initiative_messages')).toBe(0);
    expect(w.reasons()).toEqual([{ tool: 'owner.reach_out', reason: 'owner_active', rail: 'gate' }]);
    expect(w.notices()).toEqual([{ kind: 'notice', code: 'withheld', tool: 'owner.reach_out', reason: 'owner_active' }]);
    // Positive control: past the hold the same path writes it.
    w.advance(8 * MINUTE);
    expect(w.speaker.say(SCOPE, { reason: 'wonder', text: WONDER, dayKey: w.day(), maximumPerDay: 20 }, w.now())).toBe('sent');
    expect(w.count('initiative_messages')).toBe(1);
    w.close();
  });

  it('holds an expired intent (30 / 75 / 150 minutes by reason)', () => {
    const w = world();
    const arisen = w.now();
    w.advance(31 * MINUTE);
    expect(w.speaker.say(SCOPE, { reason: 'upcoming', text: '歯医者の時間が近いです。', dayKey: w.day(), maximumPerDay: 20, arisenAt: arisen }, w.now())).toBe('held:intent_expired');
    w.advance(45 * MINUTE);
    expect(w.speaker.say(SCOPE, { reason: 'share', text: SHARE, dayKey: w.day(), maximumPerDay: 20, arisenAt: arisen }, w.now())).toBe('held:intent_expired');
    expect(w.count('initiative_messages')).toBe(0);
    // Positive control: a wondering lasts 150 minutes.
    expect(w.speaker.say(SCOPE, { reason: 'wonder', text: WONDER, dayKey: w.day(), maximumPerDay: 20, arisenAt: arisen }, w.now())).toBe('sent');
    expect(w.reasons().map(row => row.reason)).toEqual(['intent_expired', 'intent_expired']);
    w.close();
  });

  it('holds the same intent (reason and subject) within 30 minutes, and a reused topic; no subject is never a repeat', () => {
    const w = world();
    expect(w.speaker.say(SCOPE, { reason: 'wonder', text: WONDER, dayKey: w.day(), maximumPerDay: 20, subject: 'piece:p1' }, w.now())).toBe('sent');
    w.advance(6 * MINUTE);
    expect(w.speaker.say(SCOPE, { reason: 'wonder', text: '今日はどんな一日ですか、ライ氏。', dayKey: w.day(), maximumPerDay: 20, subject: 'piece:p1' }, w.now())).toBe('held:intent_repeat');
    // Without a subject the reason alone is not a repeat (review M2): the topic decides.
    expect(w.speaker.say(SCOPE, { reason: 'wonder', text: 'ボクは雲の形を数えていました。', dayKey: w.day(), maximumPerDay: 20 }, w.now())).toBe('sent');
    // Another reason, the same words: the topic is reused (similarity 1 within 5 hours).
    expect(w.speaker.say(SCOPE, { reason: 'share', text: WONDER, dayKey: w.day(), maximumPerDay: 20 }, w.now())).toBe('held:topic_reused');
    expect(w.count('initiative_messages')).toBe(2);
    // Positive control: another reason and other words.
    expect(w.speaker.say(SCOPE, { reason: 'share', text: SHARE, dayKey: w.day(), maximumPerDay: 20 }, w.now())).toBe('sent');
    expect(w.reasons().map(row => row.reason)).toEqual(['intent_repeat', 'topic_reused']);
    // Only signatures are kept: no word of hers in the topics table.
    const database = new DatabaseSync(w.path, { readOnly: true });
    const topics = JSON.stringify(database.prepare('SELECT * FROM proactive_topics').all());
    database.close();
    expect(topics).not.toMatch(/ライ氏|書斎|物語/u);
    expect(topics).toMatch(/[0-9a-f]{512}/u);
    w.close();
  });
});

describe('reachOuts.sayAgain and sayByPhone', () => {
  it('hold their message while the owner is active, and write nothing', () => {
    const w = world();
    expect(w.speaker.say(SCOPE, { reason: 'wonder', text: WONDER, dayKey: w.day(), maximumPerDay: 20 }, w.now())).toBe('sent');
    const origin = w.speaker.latest(SCOPE)!.id;
    w.advance(2 * MINUTE);
    w.ownerSpeaks();
    expect(w.speaker.sayAgain(SCOPE, { originId: origin, text: 'さっきの続きですが、どうですか。', dayKey: w.day(), maximumPerDay: 3 }, w.now())).toBe('held:owner_active');
    expect(w.speaker.sayByPhone(SCOPE, { reason: 'share', text: SHARE, dayKey: w.day() }, w.now())).toBe('held:owner_active');
    expect(w.count('initiative_messages')).toBe(1);
    expect(w.reasons().map(row => `${row.tool}:${row.reason}`)).toEqual(['owner.reach_out:owner_active', 'owner.call:owner_active']);
    // Positive control: past the hold.
    w.advance(11 * MINUTE);
    expect(w.speaker.sayAgain(SCOPE, { originId: origin, text: 'さっきの続きですが、どうですか。', dayKey: w.day(), maximumPerDay: 3 }, w.now())).toBe('sent');
    expect(w.speaker.sayByPhone(SCOPE, { reason: 'share', text: SHARE, dayKey: w.day() }, w.now())).toBe('sent');
    expect(w.count('initiative_messages')).toBe(3);
    w.close();
  });

  it('hold a second call\'s words that repeat a topic, and an expired call line', () => {
    const w = world();
    expect(w.speaker.say(SCOPE, { reason: 'share', text: SHARE, dayKey: w.day(), maximumPerDay: 20 }, w.now())).toBe('sent');
    const origin = w.speaker.latest(SCOPE)!.id;
    w.advance(MINUTE);
    expect(w.speaker.sayAgain(SCOPE, { originId: origin, text: SHARE, dayKey: w.day(), maximumPerDay: 3 }, w.now())).toBe('held:topic_reused');
    const arisen = w.now();
    w.advance(31 * MINUTE);
    expect(w.speaker.sayByPhone(SCOPE, { reason: 'upcoming', text: '歯医者の時間です。', dayKey: w.day(), arisenAt: arisen }, w.now())).toBe('held:intent_expired');
    expect(w.count('initiative_messages')).toBe(1);
    w.close();
  });
});

describe('the initiative insert', () => {
  it('holds a world topic that repeats one of her messages, and writes nothing', () => {
    const w = world();
    // Her message was about the same article (the topic is its title, not the fixed words around it: review, low).
    expect(w.speaker.say(SCOPE, { reason: 'share', text: '星の観測の新しい記事', dayKey: w.day(), maximumPerDay: 20 }, w.now())).toBe('sent');
    w.advance(10 * MINUTE);
    const insert = (item: string, title: string) => (w.initiatives as unknown as { persistMessage(...args: unknown[]): string }).persistMessage(
      SCOPE, { version: 1 }, { item_id: item, source_id: 'world-hn', source_title: 'Hacker News', title, url: `https://example.org/${item}`, summary: null, published_at: null, discovered_at: w.now(), score: 0.5 },
      null, null, `${w.day()}:${item}`, w.now());
    expect(insert('stars', '星の観測の新しい記事')).toBe('held:topic_reused');
    expect(w.count('initiative_messages')).toBe(1);
    expect(w.reasons()).toEqual([{ tool: 'owner.initiative', reason: 'topic_reused', rail: 'gate' }]);
    // Positive control: another topic is written.
    expect(insert('bread', 'パンの発酵についての研究')).toBe('sent');
    expect(w.count('initiative_messages')).toBe(2);
    w.close();
  });

  it('holds while the owner is active', () => {
    const w = world();
    w.ownerSpeaks();
    w.advance(MINUTE);
    const insert = () => (w.initiatives as unknown as { persistMessage(...args: unknown[]): string }).persistMessage(
      SCOPE, { version: 1 }, { item_id: 'bread', source_id: 'world-hn', source_title: 'Hacker News', title: 'パンの発酵', url: 'https://example.org/bread', summary: null, published_at: null, discovered_at: w.now(), score: 0.5 },
      null, null, w.day(), w.now());
    expect(insert()).toBe('held:owner_active');
    expect(w.count('initiative_messages')).toBe(0);
    w.advance(10 * MINUTE);
    expect(insert()).toBe('sent');
    w.close();
  });
});

describe('the call request', () => {
  function phone(w: ReturnType<typeof world>) {
    const store = new SQLiteIncomingCallStore(w.path);
    const claims = new SQLiteReachOutClaims(w.path);
    const calls = new IncomingCalls({ store, claims, sender: { enabled: true, send: async () => ({ delivered: true, invalidToken: false, status: 200, reason: null }) },
      enabled: true, ownerScopeKey: SCOPE, now: w.now, isPaired: () => true, log: () => {} });
    void dispatchIncomingCallRequest({ method: 'POST', path: '/v1/incoming-calls/registration', body: { scopeKey: SCOPE, deviceToken: 'ab'.repeat(32), environment: 'production', bundleId: 'com.r41r41.shannon', enabled: true }, deviceId: 'phone-1' },
      { calls, ownerScopeKey: SCOPE, bundleId: 'com.r41r41.shannon' });
    const requests = new IncomingCallRequests({ store, claims, listeners: () => [], bodyVisible: () => false, serverReady: true, minimumIntervalMilliseconds: 0, gate: w.gate?.gate ?? null });
    return { store, claims, requests, close: () => { claims.close(); store.close(); } };
  }

  it('holds the call while the owner is active, and for a line that has expired; nothing rings', async () => {
    const w = world();
    const p = phone(w);
    // Her line is written (by a speaker without the gate, so that only the call is judged here).
    expect(w.plain.sayByPhone(SCOPE, { reason: 'upcoming', text: '歯医者の時間です。', dayKey: w.day() }, w.now())).toBe('sent');
    const line = w.plain.latest(SCOPE)!.id;
    w.advance(10_000);
    w.ownerSpeaks();
    w.advance(10_000);
    expect(p.requests.request(SCOPE, line, w.now())).toBe('held:owner_active');
    expect(p.store.ofMessage(SCOPE, line)).toBeFalsy();
    expect(p.claims.message(SCOPE, line)).not.toBeNull();
    // Past the hold, the line is older than an upcoming intent lasts.
    w.advance(30 * MINUTE);
    expect(p.requests.request(SCOPE, line, w.now())).toBe('held:intent_expired');
    expect(p.store.ofMessage(SCOPE, line)).toBeFalsy();
    expect(w.reasons().map(row => `${row.tool}:${row.reason}`)).toEqual(['owner.call:owner_active', 'owner.call:intent_expired']);
    // Positive control: a fresh line rings.
    expect(w.plain.sayByPhone(SCOPE, { reason: 'wonder', text: WONDER, dayKey: w.day() }, w.now())).toBe('sent');
    const fresh = w.plain.latest(SCOPE)!.id;
    expect(p.requests.request(SCOPE, fresh, w.now())).toBe('requested');
    expect(p.store.ofMessage(SCOPE, fresh)).toBeTruthy();
    p.close(); w.close();
  });
});

describe('the switch', () => {
  it('lets every point through as before with SHANNON_PROACTIVE_GATE=off: no check, no table, no withheld action', () => {
    const w = world({ SHANNON_PROACTIVE_GATE: 'off' });
    expect(w.gate).toBeNull();
    w.ownerSpeaks();
    expect(w.speaker.say(SCOPE, { reason: 'wonder', text: WONDER, dayKey: w.day(), maximumPerDay: 20 }, w.now())).toBe('sent');
    expect(w.speaker.say(SCOPE, { reason: 'wonder', text: WONDER, dayKey: w.day(), maximumPerDay: 20 }, w.now())).toBe('sent');
    const database = new DatabaseSync(w.path, { readOnly: true });
    expect(database.prepare(`SELECT name FROM sqlite_master WHERE name = 'proactive_topics'`).get()).toBeUndefined();
    database.close();
    expect(w.reasons()).toEqual([]);
    w.close();
  });
});

describe('a gate that fails holds (fail closed: proactive speech is inhibition)', () => {
  it('holds the message with gate_error at every point it guards, records the withheld action and the notice, and writes nothing', () => {
    const w = world();
    // The gate's own store breaks: every read throws.
    const broken = { since: () => { throw new Error('disk I/O error'); }, ownerLastActiveAt: () => { throw new Error('disk I/O error'); },
      record: () => { throw new Error('disk I/O error'); }, prune: () => undefined } as unknown as SQLiteProactiveTopics;
    const logged: string[] = [];
    const gate = createProactiveGate({ topics: broken, withheld: w.sink, emit: w.emit, log: line => logged.push(line) });
    expect(gate.check(SCOPE, { point: 'say', reason: 'wonder', subject: null, arisenAt: w.now(), text: WONDER }, w.now())).toEqual({ verdict: 'hold', code: 'gate_error' });
    const speaker = new SQLiteReachOutSpeaker(w.path, () => false, gate);
    const initiatives = new SQLiteInitiativeStore(w.path, w.now, gate);
    expect(speaker.say(SCOPE, { reason: 'wonder', text: WONDER, dayKey: w.day(), maximumPerDay: 20 }, w.now())).toBe('held:gate_error');
    const insert = (initiatives as unknown as { persistMessage(...args: unknown[]): string }).persistMessage(
      SCOPE, { version: 1 }, { item_id: 'bread', source_id: 'world-hn', source_title: 'Hacker News', title: 'パンの発酵', url: 'https://example.org/bread', summary: null, published_at: null, discovered_at: w.now(), score: 0.5 },
      null, null, w.day(), w.now());
    expect(insert).toBe('held:gate_error');
    expect(w.count('initiative_messages')).toBe(0);
    expect(w.reasons()).toEqual([
      { tool: 'owner.reach_out', reason: 'gate_error', rail: 'gate' }, { tool: 'owner.reach_out', reason: 'gate_error', rail: 'gate' },
      { tool: 'owner.initiative', reason: 'gate_error', rail: 'gate' },
    ]);
    expect(w.notices().map(notice => notice.reason)).toEqual(['gate_error', 'gate_error', 'gate_error']);
    // The log names the failure by its error class only, never a message's words.
    expect(logged.every(line => !line.includes(WONDER) && !line.includes('disk I/O'))).toBe(true);
    // Even with the withheld record and the notice broken too, it still holds.
    const worse = createProactiveGate({ topics: broken, withheld: () => { throw new Error('x'); }, emit: () => { throw new Error('x'); } });
    expect(worse.check(SCOPE, { point: 'call', reason: 'wonder', subject: null, arisenAt: w.now(), text: null }, w.now())).toEqual({ verdict: 'hold', code: 'gate_error' });
    // Positive control: the working gate of the same world lets it through.
    expect(w.speaker.say(SCOPE, { reason: 'wonder', text: WONDER, dayKey: w.day(), maximumPerDay: 20 }, w.now())).toBe('sent');
    speaker.close(); initiatives.close(); w.close();
  });
});

describe('the gate after the review (stage 3 review M1–M4)', () => {
  it('gates telling him a piece is ready (point share, its subject the piece), and leaves the budget request outside', () => {
    const w = world();
    const showing = new SQLiteStudyShowing(w.path, 'UTC', w.gate!.gate);
    w.clock.at = Date.parse('2026-10-07T12:00:00.000Z');
    w.ownerSpeaks();
    w.advance(3 * MINUTE);
    const piece = { id: 'story-1', title: '傘のある駅', version: 1, revised: false };
    // The cooldown of the desk itself (90 minutes) would answer first; the gate is asked with the desk's own checks passed.
    const tell = (desk: SQLiteStudyShowing) => (desk as unknown as { tell(...args: unknown[]): string }).tell.call(
      Object.assign(Object.create(desk), { mayMessageNow: () => 'ok' }), SCOPE, piece, w.now());
    expect(tell(showing)).toBe('held');
    expect(w.count('initiative_messages')).toBe(0);
    expect(w.reasons()).toEqual([{ tool: 'study.tell', reason: 'owner_active', rail: 'gate' }]);
    // Positive controls: past the hold it is told, and its delivery is noted with the piece as the subject.
    w.advance(11 * MINUTE);
    expect(tell(showing)).toBe('sent');
    const topics = new DatabaseSync(w.path, { readOnly: true });
    expect(topics.prepare(`SELECT point, reason, subject FROM proactive_topics`).all()).toEqual([{ point: 'share', reason: 'share', subject: 'piece:story-1' }]);
    topics.close();
    showing.close(); w.close();
  });

  it('records a hold once a day per subject and code, and a message the day\'s limit refuses records no hold', () => {
    const w = world();
    w.ownerSpeaks();
    w.advance(MINUTE);
    for (let index = 0; index < 3; index += 1) {
      expect(w.speaker.say(SCOPE, { reason: 'share', text: SHARE, dayKey: w.day(), maximumPerDay: 20, subject: 'piece:p1' }, w.now())).toBe('held:owner_active');
    }
    expect(w.reasons()).toHaveLength(1);
    expect(w.notices()).toHaveLength(1);
    // The limit first: no slot, so the gate is not asked and nothing is recorded.
    expect(w.speaker.say(SCOPE, { reason: 'share', text: SHARE, dayKey: w.day(), maximumPerDay: 0, subject: 'piece:p2' }, w.now())).toBe('limit');
    expect(w.reasons()).toHaveLength(1);
    w.close();
  });

  it('lets the call for a line just delivered ring (the same intent), and holds a second call of it', async () => {
    const w = world();
    const store = new SQLiteIncomingCallStore(w.path);
    const claims = new SQLiteReachOutClaims(w.path);
    const calls = new IncomingCalls({ store, claims, sender: { enabled: true, send: async () => ({ delivered: true, invalidToken: false, status: 200, reason: null }) },
      enabled: true, ownerScopeKey: SCOPE, now: w.now, isPaired: () => true, log: () => {} });
    await dispatchIncomingCallRequest({ method: 'POST', path: '/v1/incoming-calls/registration', body: { scopeKey: SCOPE, deviceToken: 'ab'.repeat(32), environment: 'production', bundleId: 'com.r41r41.shannon', enabled: true }, deviceId: 'phone-1' },
      { calls, ownerScopeKey: SCOPE, bundleId: 'com.r41r41.shannon' });
    const requests = new IncomingCallRequests({ store, claims, listeners: () => [], bodyVisible: () => false, serverReady: true, minimumIntervalMilliseconds: 0, gate: w.gate!.gate });
    const line = { reason: 'upcoming', subject: 'calendar:e1@2026-10-07T03:00:00.000Z', arisenAt: w.now() };
    expect(w.speaker.sayByPhone(SCOPE, { reason: 'upcoming', text: '歯医者の時間が近いです。', dayKey: w.day(), arisenAt: line.arisenAt, subject: line.subject }, w.now())).toBe('sent');
    const sent = w.speaker.latest(SCOPE)!.id;
    expect(requests.request(SCOPE, sent, w.now(), line)).toBe('requested');
    // A message about the same item within 30 minutes is a repeat of it.
    w.advance(MINUTE);
    expect(w.speaker.say(SCOPE, { reason: 'upcoming', text: 'もうすぐ歯医者ですね。', dayKey: w.day(), maximumPerDay: 20, subject: line.subject, arisenAt: w.now() }, w.now())).toBe('held:intent_repeat');
    claims.close(); store.close(); w.close();
  });

  it('notes the delivery in the message\'s transaction: a note that fails takes the message back (gate_error)', () => {
    const w = world();
    const failing = createProactiveGate({
      topics: new Topics(new DatabaseSync(w.path), { createSchema: true }), withheld: w.sink, emit: w.emit,
      topicsOn: connection => { const topics = new Topics(connection as DatabaseSync, { createSchema: false }); return { since: topics.since.bind(topics), ownerLastActiveAt: topics.ownerLastActiveAt.bind(topics), record: () => { throw new Error('disk'); } }; },
    });
    const speaker = new SQLiteReachOutSpeaker(w.path, () => false, failing);
    expect(speaker.say(SCOPE, { reason: 'wonder', text: WONDER, dayKey: w.day(), maximumPerDay: 20 }, w.now())).toBe('held:gate_error');
    expect(w.count('initiative_messages')).toBe(0);
    expect(w.count('conversation_messages')).toBe(0);
    expect(w.reasons().map(row => row.reason)).toEqual(['gate_error']);
    speaker.close(); w.close();
  });

  it('passes over a candidate held for a reason of its own and tries the next; the owner\'s activity stops the round', () => {
    const tried: string[] = [];
    const outcomes: Record<string, string> = { a: 'held:topic_reused', b: 'held:intent_repeat', c: 'sent', d: 'sent' };
    expect(firstWritten(['a', 'b', 'c', 'd'], item => { tried.push(item); return outcomes[item] as 'sent'; })).toBe('sent');
    expect(tried).toEqual(['a', 'b', 'c']);
    expect(firstWritten(['x', 'c'], item => (item === 'x' ? 'held:owner_active' : 'sent'))).toBe('held:owner_active');
    expect(firstWritten(['a'], () => 'held:topic_reused')).toBe('none');
    // A world topic close to one of her messages is damped by (1 − eff) and may fall below the line.
    const row = (item: string, title: string): CandidateRow => ({ item_id: item, source_id: 'world-hn', source_title: 'Hacker News', title, url: `https://example.org/${item}`,
      summary: 'x'.repeat(90), published_at: null, discovered_at: '2026-10-07T00:00:00.000Z' });
    const candidates = [row('stars', '星の観測の新しい記事'), row('bread', 'パンの発酵についての研究')];
    const at = '2026-10-07T01:00:00.000Z';
    const undamped = selectCandidate(candidates, [], null, 1, at);
    const damped = selectCandidate(candidates, [], null, 1, at, candidate => (candidate.item_id === undamped?.item_id ? 0.8 : 0));
    expect(undamped).not.toBeNull();
    expect(damped?.item_id ?? null).not.toBe(undamped!.item_id);
  });

  it('passes over an initiative candidate the gate held today', () => {
    const w = world();
    const intent = { reason: 'world' as const, subject: 'stars' };
    expect(w.gate!.gate.heldToday(SCOPE, 'initiative', intent, w.now())).toBe(false);
    w.gate!.gate.check(SCOPE, { point: 'initiative', ...intent, arisenAt: w.now(), text: SHARE }, w.now());
    w.ownerSpeaks();
    w.gate!.gate.check(SCOPE, { point: 'initiative', reason: 'world', subject: 'bread', arisenAt: w.now(), text: 'パン' }, w.now());
    // Held for the owner's activity: tried again later. Held for its topic: passed over today.
    expect(w.gate!.gate.heldToday(SCOPE, 'initiative', { reason: 'world', subject: 'bread' }, w.now())).toBe(false);
    w.gate!.gate.delivered(SCOPE, { point: 'say', reason: 'share', subject: null, arisenAt: w.now(), text: '星の観測の新しい記事' }, w.now());
    w.advance(11 * MINUTE);
    expect(w.gate!.gate.check(SCOPE, { point: 'initiative', ...intent, arisenAt: w.now(), text: '星の観測の新しい記事' }, w.now())).toEqual({ verdict: 'hold', code: 'topic_reused' });
    expect(w.gate!.gate.heldToday(SCOPE, 'initiative', intent, w.now())).toBe(true);
    w.close();
  });
});

