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
import { BODY_LIMITS } from '../src/contracts/bodyContract.js';
import { SQLiteBodyStore } from '../src/surfaces/body/store/bodyStore.js';
import { inboxPerception } from '../src/mind/perception/inboxPerception.js';
import { SQLiteReachOutSpeaker } from '../src/surfaces/outreach/reachOutDelivery.js';
import { SQLiteInitiativeStore } from '../src/surfaces/outreach/store/initiativeStore.js';
import { configuredMind, configuredMindInbox } from '../src/wiring/mindWiring.js';
import { configuredProactiveGate } from '../src/wiring/proactiveGateWiring.js';
import { configuredWithheldActions } from '../src/wiring/withheldWiring.js';
import { momentFacts } from '../src/wiring/proactiveMomentsWiring.js';
import { apiSourceFile } from './support/sources.js';
import { REACH_OUT_TOOL } from '../src/mind/action/ownTime/autonomyLoopReachOutStep.js';
import { FakeModel, FakeShowing, loopHarness, runUntilIdle, scope } from './autonomyLoopHarness.js';
import { unannouncedShowing } from '../src/mind/action/ownTime/autonomyShowing.js';
import { authoredWorldOpening } from '../src/integrations/world/worldInterestRelevance.js';

/**
 * Moments instead of scripted lines (owner decision 2026-10-14): the body's fixed lines are gone, the situations behind them are
 * percepts of hers, a small decision asks whether she would want to say something, and what she says is her own message through
 * her reach-out and the proactive gate. No moment is of her mood, and no rule decides what she says of her feelings.
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
    quietLong: false, presenceSteady: false, lastOwnerActiveAt: null, awaiting: null, ...overrides,
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

  it('perceives a long quiet only when he was there the whole time, once per quiet (keyed on his last word)', () => {
    expect(perceiveMoments(facts({ quietLong: true, presenceSteady: false }))).toEqual([]);
    const last = '2026-10-02T00:30:00.000Z';
    const at13 = perceiveMoments(facts({ quietLong: true, presenceSteady: true, localHour: 13, lastOwnerActiveAt: last }));
    const at17 = perceiveMoments(facts({ quietLong: true, presenceSteady: true, localHour: 17, lastOwnerActiveAt: last }));
    expect(at13).toEqual([{ kind: 'long_quiet', key: `quiet:${last}`, minutes: 120 }]);
    expect(at17.map(moment => moment.key)).toEqual(at13.map(moment => moment.key));
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
      ownerActiveSince: () => false, ownerLastActiveAt: () => '2026-10-01T20:00:00.000Z',
      awaiting: () => null,
    }, scope, new Date(Date.parse(START) + 2 * MINUTE).toISOString());
    expect(read).toMatchObject({
      localHour: 10, localDate: '2026-10-02', eveningDate: '2026-10-02', owner: 'returned', quietLong: true, presenceSteady: false,
      lastOwnerActiveAt: '2026-10-01T20:00:00.000Z',
    });
    expect(perceiveMoments(read).map(moment => moment.kind)).toEqual(['owner_returned']);
  });
});

describe('no scripted line, and no rule about her feelings', () => {
  it('has no line to say: a fact for each moment, never a greeting, and rules that ask for her own words or silence', () => {
    const lines = PROACTIVE_MOMENT_KINDS.map(kind => momentFactLine({ kind, minutes: 30 }));
    for (const text of [...lines, ...MOMENT_MESSAGE_RULES]) for (const canned of CANNED) expect(text).not.toContain(canned);
    expect(MOMENT_MESSAGE_RULES.join('\n')).toMatch(/message を空にする/u);
    const source = readFileSync(apiSourceFile('proactiveMoments.ts'), 'utf8');
    for (const canned of CANNED) expect(source).not.toContain(canned);
  });

  it('has no sulk among its moments, and no hard-coded rule about sulking or making up (the owner, 2026-10-14)', () => {
    expect(PROACTIVE_MOMENT_KINDS.some(kind => /sulk|reconcil|mood|emotion/u.test(kind))).toBe(false);
    expect(PROACTIVE_MOMENT_QUESTION.instructions).not.toMatch(/sulk|make up|reconcil/iu);
    expect(MOMENT_MESSAGE_RULES.join('\n')).not.toMatch(/すね|仲直り/u);
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

  it('hands the decision her inner note as closed facts when a moment is there; whether she speaks is the decision\'s', async () => {
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

describe('with anyone else there, a stream included (an infrastructure privacy guard, not a persona rule)', () => {
  it('perceives nothing and hands the mind nothing while others may see or hear her', async () => {
    const asked: ProactiveMomentState[] = [];
    const desk = deskWorld({ facts: () => facts({ ...returnedAt(START), localHour: 7 }), others: () => true, ask: async state => { asked.push(state); return 1; } });
    await desk.moments.consider(scope, START);
    expect(desk.emitted).toEqual([]);
    expect(desk.status('returned:r1')).toBeUndefined();
    expect(asked).toEqual([]);
    desk.close();
  });

  it('waits on a moment when someone comes, and never hands her loop a moment while they are there', async () => {
    let others = false;
    const desk = deskWorld({ facts: () => facts(returnedAt(START)), others: () => others, ask: async () => 0.9 });
    desk.moments.perceive(scope, START);
    others = true;
    await desk.moments.decideNewest(scope, START);
    expect(desk.status('returned:r1')).toBe('perceived');
    others = false;
    await desk.moments.decideNewest(scope, START);
    expect(desk.status('returned:r1')).toBe('wanted');
    others = true;
    expect(desk.moments.take(scope, START)).toBeNull();
    others = false;
    const taken = desk.moments.take(scope, START)!;
    others = true;
    expect(desk.moments.get(scope, taken.key, START)).toBeNull();
    desk.close();
  });

  it('reads a live stream as others: the body reports `others` on its presence reads while its stream output is on', async () => {
    const path = join(directory, `stream-${databases += 1}.sqlite`);
    const body = new SQLiteBodyStore(path);
    body.noteAudience(scope, 'windows-body', 'others', START);
    const streaming = () => body.othersPresent(scope, START, BODY_LIMITS.audienceFreshMilliseconds, BODY_LIMITS.audienceEventWindowMilliseconds);
    const desk = deskWorld({ facts: () => facts({ ...returnedAt(START), localHour: 7 }), others: streaming, ask: async () => 1 });
    await desk.moments.consider(scope, START);
    expect(desk.emitted).toEqual([]);
    body.noteAudience(scope, 'windows-body', 'owner', START);
    await desk.moments.consider(scope, START);
    expect(desk.emitted.map(draft => draft.code)).toEqual(['owner_returned', 'morning']);
    desk.close();
    body.close();
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

  it('stays quiet without Jev (fail closed), and drops a wanted moment that is no longer fresh', async () => {
    const quiet = deskWorld({ facts: () => facts(returnedAt(START)) });
    await quiet.moments.consider(scope, START);
    expect(quiet.status('returned:r1')).toBe('quiet');
    expect(quiet.moments.take(scope, START)).toBeNull();
    quiet.close();
    const desk = deskWorld({ facts: () => facts(returnedAt(START)), ask: async () => 0.9 });
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

describe('the templated lines are retired (owner decision 2026-10-14)', () => {
  it('makes a piece readable and shown without writing any line, even at night or with the day\'s slot used', async () => {
    const showing = new FakeShowing();
    showing.may = 'quiet-hours';
    const { loop, model, store, advance } = loopHarness({ showing: unannouncedShowing(showing) as FakeShowing, loop: { cycleIntervalMilliseconds: 60 * MINUTE, cyclesPerDay: 6 } });
    model.plans = [{ thought: '書きます。', steps: [{ action: 'draft', idea: '傘の話' }] }];
    await runUntilIdle(loop);
    const piece = store.study.list(scope)[0]!;
    advance(60 * MINUTE);
    model.plans = [{ thought: '見せます。', steps: [{ action: 'ready', pieceId: piece.id }] }];
    await runUntilIdle(loop);
    expect(showing.told).toEqual([]);
    expect(store.study.get(scope, piece.id)).toMatchObject({ status: 'shown', readableVersion: 1 });
    expect(await loop.tick()).not.toBe('stepped');
    expect(showing.told).toEqual([]);
  });

  it('writes a topic of the world only in her own words, and a goal\'s state as neutral text', () => {
    expect(authoredWorldOpening('写真の光の捉え方、ちょっと気になる。', '写真の撮り方', '写真')).toBe('写真の光の捉え方、ちょっと気になる。');
    expect(authoredWorldOpening('昨日の写真の話とつながっていた。', '写真の撮り方', '写真')).toBeNull();
    const initiatives = readFileSync(apiSourceFile('initiativeStore.ts'), 'utf8');
    const intents = readFileSync(apiSourceFile('initiativeIntentCandidates.ts'), 'utf8');
    for (const fixed of ['これ、少し気になりました', 'に近くて、これが少し気になりました', '目的を覚えています', '一緒に確認しませんか', '修正方針を一緒に決めませんか']) {
      expect(initiatives + intents, fixed).not.toContain(fixed);
    }
  });
});
