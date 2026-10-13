import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { checkedMindInboxDraft, type MindInboxDraft } from '../src/contracts/mindInboxContract.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { ProactiveMoments, type ProactiveMomentPorts } from '../src/mind/attention/proactiveMomentDesk.js';
import {
  MOMENT_MESSAGE_RULES, PROACTIVE_MOMENT_KINDS, PROACTIVE_MOMENT_QUESTION, momentFactLine, momentIntent, perceiveMoments,
  type ProactiveMomentFacts, type ProactiveMomentState,
} from '../src/mind/attention/proactiveMoments.js';
import { SQLiteProactiveMoments } from '../src/mind/attention/store/proactiveMomentStore.js';
import { inboxPerception } from '../src/mind/perception/inboxPerception.js';
import { SQLiteReachOutSpeaker } from '../src/surfaces/outreach/reachOutDelivery.js';
import { SQLiteInitiativeStore } from '../src/surfaces/outreach/store/initiativeStore.js';
import { configuredMind, configuredMindInbox } from '../src/wiring/mindWiring.js';
import { configuredProactiveGate } from '../src/wiring/proactiveGateWiring.js';
import { configuredWithheldActions } from '../src/wiring/withheldWiring.js';
import { momentFacts } from '../src/wiring/proactiveMomentsWiring.js';
import { apiSourceFile } from './support/sources.js';
import { REACH_OUT_TOOL } from '../src/mind/action/ownTime/autonomyLoopReachOutStep.js';
import { FakeModel, loopHarness, runUntilIdle, scope } from './autonomyLoopHarness.js';

/**
 * Moments instead of scripted lines (owner decision 2026-10-14): the body's fixed lines are gone, the situations behind them are
 * percepts of hers, a small decision asks whether she would want to say something, and what she says is her own message through
 * her reach-out and the proactive gate. Sulking is never a moment.
 */
const directory = mkdtempSync(join(tmpdir(), 'shannon-moments-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const MINUTE = 60_000;
const START = '2026-10-02T01:00:00.000Z'; // 10:00 in Tokyo
const CANNED = ['おかえりなさい、ライ氏', '少し休憩しませんか', 'おはようございます、ライ氏', 'そろそろ休みませんか', '読んでほしいものがあります'];
let databases = 0;

function facts(overrides: Partial<ProactiveMomentFacts> = {}): ProactiveMomentFacts {
  return {
    at: START, localHour: 12, localDate: '2026-10-02', eveningDate: '2026-10-02', windowVisible: true, owner: 'unknown', returned: null,
    quietLong: false, presenceSteady: false, awaiting: null, ...overrides,
  };
}

const returnedAt = (at: string, id = 'r1', minutesAway = 40): Partial<ProactiveMomentFacts> => ({
  owner: 'returned', returned: { id, occurredAt: at, minutesAway },
});

describe('perceiving moments', () => {
  it('perceives nothing while he is not at her body', () => {
    expect(perceiveMoments(facts({ windowVisible: false, ...returnedAt(START), localHour: 7 }))).toEqual([]);
    expect(perceiveMoments(facts({ owner: 'away', localHour: 7, quietLong: true, presenceSteady: true }))).toEqual([]);
  });

  it('perceives his return after ten minutes away, only while it is recent', () => {
    expect(perceiveMoments(facts(returnedAt(START)))).toEqual([{ kind: 'owner_returned', key: 'returned:r1', minutes: 40 }]);
    expect(perceiveMoments(facts(returnedAt(START, 'r2', 9)))).toEqual([]);
    const later = new Date(Date.parse(START) + 11 * MINUTE).toISOString();
    expect(perceiveMoments(facts({ at: later, ...returnedAt(START) }))).toEqual([]);
  });

  it('perceives a long quiet only when he was there the whole time, once per two hours of a day', () => {
    expect(perceiveMoments(facts({ quietLong: true, presenceSteady: false }))).toEqual([]);
    expect(perceiveMoments(facts({ quietLong: true, presenceSteady: true, localHour: 13 }))).toEqual([{ kind: 'long_quiet', key: 'quiet:2026-10-02:6', minutes: 120 }]);
  });

  it('perceives the morning and the late night once each, a night keeping the date it began', () => {
    expect(perceiveMoments(facts({ localHour: 5 })).map(moment => moment.key)).toEqual(['morning:2026-10-02']);
    expect(perceiveMoments(facts({ localHour: 10 }))).toEqual([]);
    expect(perceiveMoments(facts({ localHour: 23 })).map(moment => moment.key)).toEqual(['night:2026-10-02']);
    expect(perceiveMoments(facts({ localHour: 2, localDate: '2026-10-03', eveningDate: '2026-10-02' })).map(moment => moment.key)).toEqual(['night:2026-10-02']);
  });

  it('perceives a story waiting for his reading, once per version', () => {
    expect(perceiveMoments(facts({ awaiting: { pieceId: 'p1', version: 2 } }))).toEqual([{ kind: 'awaiting_reaction', key: 'awaiting:p1:v2', minutes: null }]);
    expect(momentIntent({ kind: 'awaiting_reaction', key: 'awaiting:p1:v2' })).toEqual({ reason: 'share', subject: 'piece:p1' });
    expect(momentIntent({ kind: 'morning', key: 'morning:2026-10-02' })).toEqual({ reason: 'wonder', subject: 'moment:morning' });
  });

  it('reads the facts from the body, the conversation timestamps and her study', () => {
    const read = momentFacts({
      timeZone: 'Asia/Tokyo',
      body: {
        windowVisible: () => true, others: () => false,
        latestReturn: () => ({ id: 'r9', occurredAt: START, minutesAway: 25 }),
        latestOfTypes: (_scope, _types, since) => (since <= START ? { type: 'ownerReturned', occurredAt: START } : null),
      },
      ownerActiveSince: () => false,
      awaiting: () => null,
    }, scope, new Date(Date.parse(START) + 2 * MINUTE).toISOString());
    expect(read).toMatchObject({ localHour: 10, localDate: '2026-10-02', eveningDate: '2026-10-02', owner: 'returned', quietLong: true, presenceSteady: false });
    expect(perceiveMoments(read).map(moment => moment.kind)).toEqual(['owner_returned']);
  });
});

describe('no scripted line, and sulking is never a reason to speak', () => {
  it('has no line to say: a fact for each moment, never a greeting, and rules that ask for her own words or silence', () => {
    const lines = PROACTIVE_MOMENT_KINDS.map(kind => momentFactLine({ kind, minutes: 30 }));
    for (const text of [...lines, ...MOMENT_MESSAGE_RULES]) for (const canned of CANNED) expect(text).not.toContain(canned);
    expect(MOMENT_MESSAGE_RULES.join('\n')).toMatch(/message を空にする/u);
    const source = readFileSync(apiSourceFile('proactiveMoments.ts'), 'utf8');
    for (const canned of CANNED) expect(source).not.toContain(canned);
  });

  it('has no sulk among its moments, and says so to the decision and to her message', () => {
    expect(PROACTIVE_MOMENT_KINDS.some(kind => /sulk|reconcil|mood|emotion/u.test(kind))).toBe(false);
    expect(PROACTIVE_MOMENT_QUESTION.instructions).toMatch(/Sulking or wanting to make up is never a reason to start talking/u);
    expect(MOMENT_MESSAGE_RULES.join('\n')).toMatch(/すねていることや仲直りのことは、ここでは自分から切り出さない/u);
    // The facts carry nothing of her mood: there is no field through which a sulk could become a moment.
    expect(Object.keys(facts()).filter(key => /mood|emotion|sulk|note/u.test(key))).toEqual([]);
  });

  it('never decides or speaks from her inner note alone: a sulk without a moment asks nothing', async () => {
    const asked: ProactiveMomentState[] = [];
    const desk = deskWorld({ facts: () => facts({ localHour: 12 }), ask: async state => { asked.push(state); return 1; }, innerNote: () => ({ shown: 'sulky', intent: 'keep' }) });
    await desk.moments.consider(scope, START);
    expect(asked).toEqual([]);
    expect(desk.moments.take(scope, START)).toBeNull();
    desk.close();
  });

  it('hands the decision her inner note as closed facts when a moment is there, which may only keep her quiet', async () => {
    const asked: ProactiveMomentState[] = [];
    const desk = deskWorld({ facts: () => facts(returnedAt(START)), ask: async state => { asked.push(state); return 0.2; }, innerNote: () => ({ shown: 'sulky', intent: 'keep' }) });
    await desk.moments.consider(scope, START);
    expect(asked[0]).toMatchObject({ moment: 'owner_returned', inner_note_shown: 'sulky', inner_note_intent: 'keep' });
    expect(desk.status('returned:r1')).toBe('quiet');
    expect(desk.moments.take(scope, START)).toBeNull();
    desk.close();
  });
});

function deskWorld(overrides: Partial<ProactiveMomentPorts> = {}) {
  const path = join(directory, `desk-${databases += 1}.sqlite`);
  const store = new SQLiteProactiveMoments(path);
  const emitted: MindInboxDraft[] = [];
  const moments = new ProactiveMoments({
    store, facts: () => facts(), others: () => false, blocked: () => null,
    context: () => ({ owner_spoke_within_minutes: null, own_messages_today: 0, last_own_message_minutes_ago: null, stories_awaiting_reaction: false }),
    emit: (_scope, draft) => { emitted.push(draft); }, usdPerDecision: 0.001, maximumDecisionsPerDay: 24, maximumMessagesPerDay: 8, ...overrides,
  });
  const database = new DatabaseSync(path);
  const status = (key: string) => (database.prepare('SELECT status FROM proactive_moments WHERE moment_key = ?').get(key) as { status: string } | undefined)?.status;
  return { moments, store, emitted, status, close: () => { database.close(); store.close(); } };
}

describe('perception events', () => {
  it('hands each new moment to the mind once, as a closed row the conversation perceives as presence at her body', async () => {
    const desk = deskWorld({ facts: () => facts({ ...returnedAt(START), localHour: 7 }) });
    await desk.moments.consider(scope, START);
    await desk.moments.consider(scope, new Date(Date.parse(START) + MINUTE).toISOString());
    expect(desk.emitted.map(draft => [draft.kind, draft.code, draft.sourceId, draft.deltaMinutes])).toEqual([
      ['moment', 'owner_returned', 'returned:r1', 40], ['moment', 'morning', 'morning:2026-10-02', null],
    ]);
    for (const draft of desk.emitted) expect(() => checkedMindInboxDraft(draft)).not.toThrow();
    const event = inboxPerception({ draft: desk.emitted[0]!, at: START, seq: 1 });
    expect(event).toMatchObject({ kind: 'presence', surface: 'body', speaker: { kind: 'system' } });
    desk.close();
  });
});

describe('the decision', () => {
  it('waits while he is active and decides once he is not; Jev decides, a failure keeps her quiet', async () => {
    let blocked: string | null = 'owner_active';
    let answer: number | Error = 0.8;
    const desk = deskWorld({
      facts: () => facts(returnedAt(START)), blocked: () => blocked,
      ask: async () => { if (answer instanceof Error) throw answer; return answer; },
    });
    await desk.moments.consider(scope, START);
    expect(desk.status('returned:r1')).toBe('perceived');
    blocked = null;
    await desk.moments.consider(scope, new Date(Date.parse(START) + MINUTE).toISOString());
    expect(desk.status('returned:r1')).toBe('wanted');
    const taken = desk.moments.take(scope, new Date(Date.parse(START) + 2 * MINUTE).toISOString());
    expect(taken).toMatchObject({ key: 'returned:r1', reason: 'wonder', subject: 'moment:owner_returned', perceivedAt: START });
    expect(taken!.line).toContain('40分ほど席を外したあと');
    // Taken once.
    expect(desk.moments.take(scope, new Date(Date.parse(START) + 2 * MINUTE).toISOString())).toBeNull();
    answer = new Error('JEV_TIMEOUT');
    const second = deskWorld({ facts: () => facts(returnedAt(START, 'r2')), ask: async () => { throw answer; } });
    await second.moments.consider(scope, START);
    expect(second.status('returned:r2')).toBe('quiet');
    desk.close();
    second.close();
  });

  it('leaves the decision to her message\'s writer without Jev, and drops a moment that is no longer fresh', async () => {
    const desk = deskWorld({ facts: () => facts(returnedAt(START)) });
    await desk.moments.consider(scope, START);
    expect(desk.status('returned:r1')).toBe('wanted');
    expect(desk.moments.take(scope, new Date(Date.parse(START) + 11 * MINUTE).toISOString())).toBeNull();
    expect(desk.status('returned:r1')).toBe('expired');
    desk.close();
  });

  it('holds the day\'s caps', async () => {
    let n = 0;
    const desk = deskWorld({ facts: () => facts(returnedAt(START, `r${n}`)), ask: async () => 0.9, maximumDecisionsPerDay: 1 });
    await desk.moments.consider(scope, START);
    n = 1;
    await desk.moments.consider(scope, START);
    expect([desk.status('returned:r0'), desk.status('returned:r1')]).toEqual(['wanted', 'skipped']);
    desk.close();
  });
});

function gateWorld() {
  const path = join(directory, `gate-${databases += 1}.sqlite`);
  const clock = { at: START };
  const now = () => clock.at;
  const persistent = new SQLiteShannonStore({ path, now });
  persistent.threadId(scope);
  const withheld = configuredWithheldActions({}, { databasePath: path, createsSchema: true, defer: task => task() })!;
  const mind = configuredMind({}, { databasePath: path, now, schedule: task => task() })!;
  const inbox = configuredMindInbox({}, { databasePath: path })!;
  const gate = configuredProactiveGate({}, { databasePath: path, now, withheld: withheld.withheld.sink, emit: inbox.emit })!;
  const initiatives = new SQLiteInitiativeStore(path, now);
  const speaker = new SQLiteReachOutSpeaker(path, () => false, gate.gate);
  let current = facts(returnedAt(START));
  const store = new SQLiteProactiveMoments(path);
  const moments = new ProactiveMoments({
    store, facts: () => current, others: () => false, blocked: () => null,
    context: () => ({ owner_spoke_within_minutes: null, own_messages_today: 0, last_own_message_minutes_ago: null, stories_awaiting_reaction: false }),
    ask: async () => 0.9, usdPerDecision: 0.001, maximumDecisionsPerDay: 24, maximumMessagesPerDay: 8,
  });
  const model = new FakeModel();
  model.replies.reach_out = { message: 'ライ氏、さっきまでどこへ行っていたんですか。ボクはちょっと退屈でした。' };
  const harness = loopHarness({ path, clock, model, reachOuts: speaker, moments });
  const database = new DatabaseSync(path);
  const count = (sql: string) => Number((database.prepare(sql).get() as { n: number }).n);
  const holds = () => database.prepare('SELECT tool, reason FROM shannon_withheld_actions ORDER BY at').all() as Array<{ tool: string; reason: string }>;
  const ownerSpeaks = () => database.prepare(`
    INSERT INTO conversation_messages (message_id, scope_key, thread_id, turn_id, ordinal, role, content, observed_at, metadata_json)
    VALUES (?, ?, ?, ?, 0, 'user', 'うん', ?, '{}')
  `).run(randomUUID(), scope, persistent.threadId(scope), randomUUID(), now());
  const advance = (milliseconds: number) => { clock.at = new Date(Date.parse(clock.at) + milliseconds).toISOString(); };
  const close = () => { database.close(); store.close(); speaker.close(); initiatives.close(); gate.close(); inbox.close(); mind.close(); withheld.close(); persistent.close(); };
  return {
    ...harness, moments, model, count, holds, ownerSpeaks, advance, close, now,
    set: (next: ProactiveMomentFacts) => { current = next; },
  };
}

describe('speaking of a moment: her own words, through the proactive gate', () => {
  it('writes one message of hers in her own words, with the moment as a fact in front of her, recorded like any step', async () => {
    const w = gateWorld();
    await w.moments.consider(scope, w.now());
    expect(await runUntilIdle(w.loop)).toEqual(['stepped', 'cycle-ended']);
    expect(w.count(`SELECT COUNT(*) AS n FROM initiative_messages WHERE source_item_id LIKE 'reach-out:wonder:%'`)).toBe(1);
    const prompt = w.model.prompts('reach_out')[0]!;
    expect(prompt).toContain('[いま気づいたこと]');
    expect(prompt).toContain('40分ほど席を外したあと、いま体のそばに戻ってきた');
    for (const rule of MOMENT_MESSAGE_RULES) expect(prompt).toContain(rule);
    for (const canned of CANNED) expect(prompt).not.toContain(canned);
    expect(w.model.kinds()).toEqual(['reach_out']);
    const action = w.entries().find(entry => entry.kind === 'action' && entry.tool === REACH_OUT_TOOL);
    expect(action).toMatchObject({ outcome: 'done', domain: 'owner_message' });
    w.close();
  });

  it('is held by the gate for the same moment within 30 minutes, and while he has been active', async () => {
    const w = gateWorld();
    await w.moments.consider(scope, w.now());
    await runUntilIdle(w.loop);
    // He comes back again six minutes later: another moment of the same kind is the same intent within 30 minutes.
    w.advance(6 * MINUTE);
    w.set(facts({ at: w.now(), ...returnedAt(w.now(), 'r2') }));
    await w.moments.consider(scope, w.now());
    await runUntilIdle(w.loop);
    expect(w.count('SELECT COUNT(*) AS n FROM initiative_messages')).toBe(1);
    // He wrote two minutes before a third return: the owner-active hold.
    w.advance(40 * MINUTE);
    w.ownerSpeaks();
    w.advance(2 * MINUTE);
    w.set(facts({ at: w.now(), ...returnedAt(w.now(), 'r3') }));
    await w.moments.consider(scope, w.now());
    await runUntilIdle(w.loop);
    expect(w.count('SELECT COUNT(*) AS n FROM initiative_messages')).toBe(1);
    expect(w.holds()).toEqual([{ tool: 'owner.reach_out', reason: 'intent_repeat' }, { tool: 'owner.reach_out', reason: 'owner_active' }]);
    w.close();
  });

  it('leaves her loop as it was when she wanted no moment: her own thought comes first, not a message', async () => {
    const w = gateWorld();
    await w.loop.tick();
    expect(w.model.kinds()).toEqual(['think']);
    w.close();
  });
});
