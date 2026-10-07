import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { SQLiteInitiativeStore } from '../src/surfaces/outreach/store/initiativeStore.js';
import { SQLiteReachOutSpeaker } from '../src/surfaces/outreach/reachOutDelivery.js';
import { SQLiteReachOutClaims } from '../src/surfaces/outreach/store/reachOutClaims.js';
import { SQLiteIncomingCallStore } from '../src/surfaces/outreach/store/incomingCallStore.js';
import { IncomingCallRequests } from '../src/surfaces/outreach/incomingCallRequests.js';
import { IncomingCalls } from '../src/surfaces/outreach/incomingCalls.js';
import { dispatchIncomingCallRequest } from '../src/surfaces/outreach/incomingCallRoutes.js';
import { configuredMind, configuredMindInbox } from '../src/wiring/mindWiring.js';
import { configuredProactiveGate } from '../src/wiring/proactiveGateWiring.js';
import { configuredWithheldActions } from '../src/wiring/withheldWiring.js';

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
  return { path, clock, now, persistent, speaker, plain, initiatives, gate, count, reasons, notices, ownerSpeaks, day, close, advance: (ms: number) => { clock.at += ms; } };
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

  it('holds the same intent within 30 minutes, and a reused topic', () => {
    const w = world();
    expect(w.speaker.say(SCOPE, { reason: 'wonder', text: WONDER, dayKey: w.day(), maximumPerDay: 20 }, w.now())).toBe('sent');
    w.advance(6 * MINUTE);
    expect(w.speaker.say(SCOPE, { reason: 'wonder', text: '今日はどんな一日ですか、ライ氏。', dayKey: w.day(), maximumPerDay: 20 }, w.now())).toBe('held:intent_repeat');
    // Another reason, the same words: the topic is reused (similarity 1 within 5 hours).
    expect(w.speaker.say(SCOPE, { reason: 'share', text: WONDER, dayKey: w.day(), maximumPerDay: 20 }, w.now())).toBe('held:topic_reused');
    expect(w.count('initiative_messages')).toBe(1);
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
    expect(w.speaker.say(SCOPE, { reason: 'share', text: 'これ、少し気になりました。\n\n星の観測の新しい記事\nhttps://example.org/stars', dayKey: w.day(), maximumPerDay: 20 }, w.now())).toBe('sent');
    w.advance(10 * MINUTE);
    const insert = (item: string, title: string) => (w.initiatives as unknown as { persistMessage(...args: unknown[]): boolean }).persistMessage(
      SCOPE, { version: 1 }, { item_id: item, source_id: 'world-hn', source_title: 'Hacker News', title, url: `https://example.org/${item}`, summary: null, published_at: null, discovered_at: w.now(), score: 0.5 },
      null, null, `${w.day()}:${item}`, w.now());
    expect(insert('stars', '星の観測の新しい記事')).toBe(false);
    expect(w.count('initiative_messages')).toBe(1);
    expect(w.reasons()).toEqual([{ tool: 'owner.initiative', reason: 'topic_reused', rail: 'gate' }]);
    // Positive control: another topic is written.
    expect(insert('bread', 'パンの発酵についての研究')).toBe(true);
    expect(w.count('initiative_messages')).toBe(2);
    w.close();
  });

  it('holds while the owner is active', () => {
    const w = world();
    w.ownerSpeaks();
    w.advance(MINUTE);
    const insert = () => (w.initiatives as unknown as { persistMessage(...args: unknown[]): boolean }).persistMessage(
      SCOPE, { version: 1 }, { item_id: 'bread', source_id: 'world-hn', source_title: 'Hacker News', title: 'パンの発酵', url: 'https://example.org/bread', summary: null, published_at: null, discovered_at: w.now(), score: 0.5 },
      null, null, w.day(), w.now());
    expect(insert()).toBe(false);
    expect(w.count('initiative_messages')).toBe(0);
    w.advance(10 * MINUTE);
    expect(insert()).toBe(true);
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
