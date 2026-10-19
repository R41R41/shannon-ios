import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { CHARACTER_CORE, characterCoreBlock, innerNoteDay, type InnerNote } from '@shannon/cognition';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { ProactiveMoments } from '../src/mind/attention/proactiveMomentDesk.js';
import { momentFactLine, type ProactiveMomentFacts } from '../src/mind/attention/proactiveMoments.js';
import { SQLiteProactiveMoments } from '../src/mind/attention/store/proactiveMomentStore.js';
import { SQLiteReachOutSpeaker } from '../src/surfaces/outreach/reachOutDelivery.js';
import { SQLiteInitiativeStore } from '../src/surfaces/outreach/store/initiativeStore.js';
import { SQLiteInitiativeSources } from '../src/surfaces/outreach/store/initiativeSources.js';
import { initiativeDelivery } from '../src/surfaces/outreach/initiativeFreshness.js';
import { configuredMind, configuredMindInbox } from '../src/wiring/mindWiring.js';
import { configuredProactiveGate } from '../src/wiring/proactiveGateWiring.js';
import { configuredWithheldActions } from '../src/wiring/withheldWiring.js';
import { configuredProactiveMoments, proactiveSelfEnabled } from '../src/wiring/proactiveMomentsWiring.js';
import { configuredMomentSpeech } from '../src/wiring/momentSpeechWiring.js';
import { SQLiteInnerNoteStore } from '../src/mind/emotion/store/innerNoteStore.js';
import {
  MOMENT_SPEECH_INSTRUCTIONS, OWN_MOMENT_SPEECH_V1, momentInnerNoteBlock, momentSpeechPrompt, momentSpeechSystem, ownDayBlock,
} from '../src/mind/action/ownTime/ownMomentSpeech.js';
import { ownerPrivateRule } from '../src/mind/action/ownTime/autonomyLoopOwnerContext.js';
import { REACH_OUT_HELD_TOOL } from '../src/mind/action/ownTime/autonomyLoopReachOutStep.js';
import { autonomyModelCostUsd } from '../src/mind/action/ownTime/autonomyModels.js';
import { commitmentFactSentence, promisePhraseChoice, type CommitmentLineWriter } from '../src/mind/action/respond/commitmentLine.js';
import { commitmentLinePreparer } from '../src/wiring/commitmentLinesWiring.js';
import { extractProspectiveMemories } from '../src/mind/memory/prospectiveMemory.js';
import { apiSourceFile } from './support/sources.js';
import { SQLiteWorldStore } from '../src/integrations/world/store/worldStore.js';
import { FakeModel, STORY_BODY, loopHarness, runUntilIdle, scope } from './autonomyLoopHarness.js';

/**
 * She decides herself whether to speak (owner decision 2026-10-14, by form: 「シャノン本人が決める」). Measured before: six moments of
 * one morning were all judged silent by a Jev question that saw only closed facts. Now the moment's one call is hers, with her core,
 * her inner note, her own day and their recent talk; the system keeps only the audience and spam bounds. And a promise is told at
 * its time (a 09:20 promise had been told at 10:07, in the neutral line).
 */
const directory = mkdtempSync(join(tmpdir(), 'shannon-proactive-self-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const MINUTE = 60_000;
const START = '2026-10-14T00:22:43.000Z'; // 09:22 in Tokyo
const CANNED = ['おかえりなさい', '少し休憩しませんか', 'おはようございます', 'そろそろ休みませんか', '読んでほしいものがあります'];
let databases = 0;
const later = (at: string, minutes: number) => new Date(Date.parse(at) + minutes * MINUTE).toISOString();

function facts(overrides: Partial<ProactiveMomentFacts> = {}): ProactiveMomentFacts {
  return {
    // Hour 12: no morning moment beside his return (the morning is its own moment, tested in proactiveMoments.test.ts).
    at: START, localHour: 12, localDate: '2026-10-14', eveningDate: '2026-10-14', windowVisible: true, owner: 'unknown', returned: null,
    quietLong: false, presenceSteady: false, lastOwnerActiveAt: null, awaiting: null, ...overrides,
  };
}
const returnedAt = (at: string, id = 'r1', minutesAway = 242): Partial<ProactiveMomentFacts> => ({ owner: 'returned', returned: { id, occurredAt: at, minutesAway } });

function note(overrides: Partial<InnerNote> = {}): InnerNote {
  const day = innerNoteDay(START, 'Asia/Tokyo');
  return {
    id: 'n1', sequence: 1, dayId: 'n1', dayKey: day.dayKey, dayEndsAt: day.endsAt,
    text: { honne: 'SENTINEL-HONNE 本当は戻ってきてくれて嬉しい', tatemae: 'べつに待ってなかった顔', reason: '簡単になびくのはいや', plan: 'しばらくはツンとしておく', bottom: 'ライ氏のことは大事' },
    hooks: { shown: 'pouting', tell: 'blush', until: later(START, 40), scale: 'ordinary', dayReason: null, intent: 'keep', routeSummary: 'a little sulky' },
    triggers: ['touch'], changeReason: null, summary: null, flags: {}, createdAt: later(START, -5), replacedAt: null, closedAt: null, coreVersion: 'v1',
    episodeStartedAt: later(START, -5), ...overrides,
  } as InnerNote;
}

function deskWorld(options: { self?: boolean; others?: () => boolean; maximumDecisionsPerDay?: number; ask?: () => Promise<number>; current?: () => ProactiveMomentFacts }) {
  const path = join(directory, `desk-${databases += 1}.sqlite`);
  const store = new SQLiteProactiveMoments(path);
  let asked = 0;
  const moments = new ProactiveMoments({
    store, facts: options.current ?? (() => facts(returnedAt(START))), others: options.others ?? (() => false), blocked: () => null,
    context: () => ({ owner_spoke_within_minutes: null, own_messages_today: 0, last_own_message_minutes_ago: null, stories_awaiting_reaction: false }),
    ...(options.self ? { self: true } : {}),
    ...(options.ask ? { ask: async () => { asked += 1; return options.ask!(); } } : {}),
    usdPerDecision: 0, maximumDecisionsPerDay: options.maximumDecisionsPerDay ?? 24, maximumMessagesPerDay: 8,
  });
  const database = new DatabaseSync(path);
  const row = (key: string) => database.prepare('SELECT status, decider FROM proactive_moments WHERE moment_key = ?').get(key) as { status: string; decider: string | null } | undefined;
  return { moments, row, asked: () => asked, close: () => { database.close(); store.close(); } };
}

function speakingWorld(options: { innerNote?: () => string | null; ownerContext?: string } = {}) {
  const path = join(directory, `speak-${databases += 1}.sqlite`);
  const clock = { at: START };
  const now = () => clock.at;
  const persistent = new SQLiteShannonStore({ path, now });
  persistent.threadId(scope);
  const withheld = configuredWithheldActions({}, { databasePath: path, createsSchema: true, defer: task => task() })!;
  const mind = configuredMind({}, { databasePath: path, now, schedule: task => task() })!;
  const inbox = configuredMindInbox({}, { databasePath: path })!;
  const gate = configuredProactiveGate({}, { databasePath: path, now, withheld: withheld.withheld.sink, emit: inbox.emit })!;
  const initiatives = new SQLiteInitiativeStore(path, now);
  let others = false;
  const speaker = new SQLiteReachOutSpeaker(path, () => others, gate.gate);
  let current = facts(returnedAt(START));
  const store = new SQLiteProactiveMoments(path);
  const moments = new ProactiveMoments({
    store, facts: () => current, others: () => others, blocked: () => null, self: true,
    context: () => ({ owner_spoke_within_minutes: null, own_messages_today: 0, last_own_message_minutes_ago: null, stories_awaiting_reaction: false }),
    usdPerDecision: 0, maximumDecisionsPerDay: 24, maximumMessagesPerDay: 8,
  });
  const model = new FakeModel();
  model.replies.reach_out = { message: 'SENTINEL-HER-WORDS', where: 'voice' };
  const ownerContext = options.ownerContext;
  const harness = loopHarness({
    path, clock, model, reachOuts: speaker, moments, momentSpeech: { innerNote: options.innerNote ?? (() => null) },
    ...(ownerContext ? { ownerContext: { forThinking: () => null, forWriting: () => null, forMessage: () => ({ section: ownerContext, secrets: [] }) } } : {}),
  });
  const database = new DatabaseSync(path);
  const count = (sql: string) => Number((database.prepare(sql).get() as { n: number }).n);
  const holds = () => database.prepare('SELECT tool, reason FROM shannon_withheld_actions ORDER BY at').all() as Array<{ tool: string; reason: string }>;
  const metadata = () => (database.prepare(`SELECT metadata_json FROM conversation_messages WHERE turn_id LIKE 'initiative:%' ORDER BY observed_at DESC LIMIT 1`).get() as { metadata_json: string } | undefined)?.metadata_json;
  const ownerSpeaks = () => database.prepare(`
    INSERT INTO conversation_messages (message_id, scope_key, thread_id, turn_id, ordinal, role, content, observed_at, metadata_json)
    VALUES (?, ?, ?, ?, 0, 'user', 'うん', ?, '{}')
  `).run(randomUUID(), scope, persistent.threadId(scope), randomUUID(), now());
  const advance = (milliseconds: number) => { clock.at = new Date(Date.parse(clock.at) + milliseconds).toISOString(); };
  const close = () => { database.close(); store.close(); speaker.close(); initiatives.close(); gate.close(); inbox.close(); mind.close(); withheld.close(); persistent.close(); };
  return {
    ...harness, path, moments, model, count, holds, metadata, ownerSpeaks, advance, close, now,
    set: (next: ProactiveMomentFacts) => { current = next; },
    setOthers: (value: boolean) => { others = value; },
  };
}

describe('she decides herself at a moment (SHANNON_PROACTIVE_SELF)', () => {
  it('asks no Jev: a moment past the free checks is hers to decide, and her decisions keep the day\'s cap', async () => {
    let n = 0;
    const desk = deskWorld({ self: true, ask: async () => 0, maximumDecisionsPerDay: 1, current: () => facts(returnedAt(START, `r${n}`)) });
    await desk.moments.consider(scope, START);
    expect(desk.row('returned:r0')).toEqual({ status: 'wanted', decider: 'writer' });
    n = 1;
    await desk.moments.consider(scope, START);
    expect(desk.row('returned:r1')).toEqual({ status: 'skipped', decider: null });
    expect(desk.asked()).toBe(0);
    desk.close();
    // The switch: on by default, and only while moments (and her own time) are on; off, the Jev judge as before.
    expect(proactiveSelfEnabled({ SHANNON_AUTONOMY_ENABLED: 'true' })).toBe(true);
    expect(proactiveSelfEnabled({ SHANNON_AUTONOMY_ENABLED: 'true', SHANNON_PROACTIVE_SELF: 'off' })).toBe(false);
    expect(proactiveSelfEnabled({ SHANNON_AUTONOMY_ENABLED: 'true', SHANNON_PROACTIVE_MOMENTS: 'off' })).toBe(false);
    const path = join(directory, `wiring-${databases += 1}.sqlite`);
    const parts = {
      databasePath: path, timeZone: 'Asia/Tokyo', gate: true,
      body: { windowVisible: () => true, latestReturn: () => null, latestOfTypes: () => null, others: () => false },
      ownerActiveSince: () => false, ownerLastActiveAt: () => null, awaiting: () => null, blocked: () => null, ownMessages: () => ({ today: 0, lastAt: null }),
      fetcher: (async () => { throw new Error('NO_JEV_IS_ASKED'); }) as unknown as typeof fetch,
    };
    const self = configuredProactiveMoments({ SHANNON_AUTONOMY_ENABLED: 'true', TYPESAFE_API_KEY: 'test-only' }, parts)!;
    expect((self.moments as unknown as { ports: { self?: boolean; ask?: unknown } }).ports).toMatchObject({ self: true });
    expect((self.moments as unknown as { ports: { ask?: unknown } }).ports.ask).toBeUndefined();
    self.close();
    const jev = configuredProactiveMoments({ SHANNON_AUTONOMY_ENABLED: 'true', SHANNON_PROACTIVE_SELF: 'off', TYPESAFE_API_KEY: 'test-only' }, parts)!;
    expect((jev.moments as unknown as { ports: { self?: boolean; ask?: unknown } }).ports.self).toBeUndefined();
    expect(typeof (jev.moments as unknown as { ports: { ask?: unknown } }).ports.ask).toBe('function');
    jev.close();
  });

  it('with anyone else there, a stream included: perceives nothing, decides nothing, and says nothing', async () => {
    const desk = deskWorld({ self: true, others: () => true });
    await desk.moments.consider(scope, START);
    expect(desk.row('returned:r1')).toBeUndefined();
    expect(desk.moments.take(scope, START)).toBeNull();
    desk.close();
    // Someone comes while she writes: her words stay unsent, and her inner note is never handed to a prompt with others there.
    let noteAsked = 0;
    const w = speakingWorld({ innerNote: () => { noteAsked += 1; return '[心のメモ]\n- 本音: SENTINEL-HONNE'; } });
    await w.moments.consider(scope, w.now());
    w.model.during = kind => { if (kind === 'reach_out') w.setOthers(true); };
    await runUntilIdle(w.loop);
    expect(w.count('SELECT COUNT(*) AS n FROM initiative_messages')).toBe(0);
    expect(w.entries().find(entry => entry.kind === 'action' && entry.tool === REACH_OUT_HELD_TOOL)).toMatchObject({ outcome: 'done' });
    expect(noteAsked).toBe(1);
    w.close();
  });

  it('may stay silent: an empty message is her answer, recorded as such, and nothing is written', async () => {
    const w = speakingWorld();
    w.model.replies.reach_out = { message: '', where: 'voice' };
    await w.moments.consider(scope, w.now());
    expect(await runUntilIdle(w.loop)).toEqual(['stepped', 'cycle-ended']);
    expect(w.model.kinds()).toEqual(['reach_out']);
    expect(w.count('SELECT COUNT(*) AS n FROM initiative_messages')).toBe(0);
    expect(w.entries().find(entry => entry.kind === 'action' && entry.tool === REACH_OUT_HELD_TOOL)).toMatchObject({ outcome: 'done', reasonCode: 'chose_silence' });
    w.close();
  });

  it('speaks in her own words, and leaves it as text when she says so (a body shows it and does not say it aloud)', async () => {
    const w = speakingWorld();
    w.model.replies.reach_out = { message: 'SENTINEL-HER-WORDS', where: 'text' };
    await w.moments.consider(scope, w.now());
    await runUntilIdle(w.loop);
    expect(w.count(`SELECT COUNT(*) AS n FROM initiative_messages WHERE source_item_id LIKE 'reach-out:wonder:%' AND content = 'SENTINEL-HER-WORDS'`)).toBe(1);
    expect(JSON.parse(w.metadata()!)).toMatchObject({ reachOut: { reason: 'wonder', spoken: false } });
    const sources = new SQLiteInitiativeSources(w.path);
    const id = (new DatabaseSync(w.path).prepare('SELECT initiative_id AS id FROM initiative_messages').get() as { id: string }).id;
    const source = sources.sources(scope, [id]).get(id)!;
    expect(source.textOnly).toBe(true);
    expect(initiativeDelivery(source, w.now(), { timeZone: 'Asia/Tokyo', morningHours: { start: 7, end: 10 } })).toBe('text');
    // Aloud (her choice, and the default), the message is her body's as every message of hers was: no flag, not judged.
    expect(initiativeDelivery({ ...source, textOnly: undefined } as never, w.now(), { timeZone: 'Asia/Tokyo', morningHours: { start: 7, end: 10 } })).toBe('unjudged');
    sources.close();
    w.close();
    const aloud = speakingWorld();
    await aloud.moments.consider(scope, aloud.now());
    await runUntilIdle(aloud.loop);
    expect(JSON.parse(aloud.metadata()!).reachOut).toEqual({ reason: 'wonder' });
    aloud.close();
  });

  it('is given her core, her inner note, her own day and their recent talk, and the moment last; one Haiku call with its system cached', async () => {
    const block = momentInnerNoteBlock(note(), START, 'Asia/Tokyo');
    const w = speakingWorld({ innerNote: () => block, ownerContext: '[ライ氏のこと・最近のふたりのこと]\n〈最近のふたりの会話（古い順）〉\n- ライ氏: SENTINEL-TALK' });
    const dayKey = '2026-10-14';
    w.store.activity.append(scope, dayKey, later(START, -60), { kind: 'action', actor: 'shannon', summary: 'SENTINEL-READ 公開ページを一つ読みました。', domain: 'public_read', tool: 'study.read', outcome: 'done', approval: 'not_needed' });
    w.store.activity.append(scope, dayKey, later(START, -50), { kind: 'action', actor: 'shannon', summary: 'SENTINEL-MINECRAFT マイクラにログインしました。', domain: 'conversation', tool: 'minecraft.login', outcome: 'done', approval: 'not_needed' });
    w.store.activity.append(scope, dayKey, later(START, -40), { kind: 'action', actor: 'shannon', summary: 'SENTINEL-TOUCH 触れられて一言', domain: 'conversation', tool: 'body.reaction', outcome: 'done', approval: 'not_needed' });
    w.store.study.create(scope, { kind: 'story', title: 'SENTINEL-STORY 傘のある駅', body: STORY_BODY }, later(START, -30));
    w.service.addPursuit(scope, { kind: 'question', title: 'SENTINEL-MIND 夕方の光', why: '物語に使いたいから', origin: 'self' });
    await w.moments.consider(scope, w.now());
    await runUntilIdle(w.loop);
    const call = w.model.calls[0]!;
    expect(call.model).toBe('claude-haiku-5-5');
    expect(call.cacheSystem).toBe(true);
    expect(call.maximumOutputTokens).toBe(OWN_MOMENT_SPEECH_V1.outputTokens);
    // The stable prefix: her core, then the instructions and the owner-private rule of a message; nothing of this moment.
    expect(call.system).toBe(momentSpeechSystem(ownerPrivateRule('message', true)));
    expect(call.system.startsWith(characterCoreBlock(CHARACTER_CORE))).toBe(true);
    expect(call.system).not.toMatch(/SENTINEL|242分/u);
    // What changes follows it, the moment last.
    for (const sentinel of ['SENTINEL-HONNE', 'SENTINEL-READ', 'SENTINEL-MINECRAFT', 'SENTINEL-STORY', 'SENTINEL-MIND', 'SENTINEL-TALK']) expect(call.prompt).toContain(sentinel);
    expect(call.prompt).not.toContain('SENTINEL-TOUCH');
    expect(call.prompt).toContain('つもり（構え。言うせりふではない）: しばらくはツンとしておく');
    expect(call.prompt).toContain('[ボクの今日]');
    expect(call.prompt.trimEnd().endsWith(momentFactLine({ kind: 'owner_returned', minutes: 242 }))).toBe(true);
    expect(w.count('SELECT COUNT(*) AS n FROM initiative_messages')).toBe(1);
    w.close();
  });

  it('keeps the spam bounds: the same kind of moment within 30 minutes and his talking hold her words (the gate), as before', async () => {
    const w = speakingWorld();
    await w.moments.consider(scope, w.now());
    await runUntilIdle(w.loop);
    w.advance(6 * MINUTE);
    w.set(facts({ at: w.now(), ...returnedAt(w.now(), 'r2', 32) }));
    await w.moments.consider(scope, w.now());
    await runUntilIdle(w.loop);
    expect(w.count('SELECT COUNT(*) AS n FROM initiative_messages')).toBe(1);
    w.advance(40 * MINUTE);
    w.ownerSpeaks();
    w.advance(2 * MINUTE);
    w.set(facts({ at: w.now(), ...returnedAt(w.now(), 'r3', 32) }));
    await w.moments.consider(scope, w.now());
    await runUntilIdle(w.loop);
    expect(w.count('SELECT COUNT(*) AS n FROM initiative_messages')).toBe(1);
    // Owner 2026-10-19: the same kind of moment is taken once a day at most, so the second return never reaches the gate.
    expect(w.holds()).toEqual([]);
    expect(w.count("SELECT COUNT(*) AS n FROM proactive_moments WHERE reason = 'kind_today'")).toBe(2);
    w.close();
  });
});

describe('the cache-friendly prompt', () => {
  it('keeps one byte-identical system across moments, notes, days and times; everything that changes is after it', () => {
    const one = momentSpeechPrompt({ localTime: '10月14日(火) 9:22', momentLine: 'A', innerNote: momentInnerNoteBlock(note(), START, 'Asia/Tokyo'),
      ownDay: ownDayBlock({ activities: [{ at: START, summary: 'x' }], stories: [], notes: [], pursuits: [] }, 'Asia/Tokyo'), ownerContext: 'ctx', privateRule: ownerPrivateRule('message', true) });
    const two = momentSpeechPrompt({ localTime: '10月15日(水) 23:40', momentLine: 'B', innerNote: null,
      ownDay: ownDayBlock({ activities: [], stories: [], notes: [], pursuits: [] }, 'Asia/Tokyo'), ownerContext: 'other', privateRule: ownerPrivateRule('message', true) });
    expect(one.system).toBe(two.system);
    expect(one.system.startsWith(characterCoreBlock(CHARACTER_CORE))).toBe(true);
    // Two fixed variants only: with his context (its rule) and without.
    expect(momentSpeechSystem(null)).toBe(`${characterCoreBlock(CHARACTER_CORE)}\n\n${MOMENT_SPEECH_INSTRUCTIONS}`);
    // The core alone is far above the 512-token cache minimum (about 3,000 characters of Japanese).
    expect(CHARACTER_CORE.text.length).toBeGreaterThan(2_000);
    expect(one.prompt.trimEnd().endsWith('- A')).toBe(true);
    expect(two.prompt).toContain('（今日はまだ、自分の時間に何もしていない）');
  });

  it('costs about $0.001-0.0015 an opportunity at Haiku\'s prices, and stays inside the target of $0.002', () => {
    // The estimate reserved before the call (all input at the one-hour write rate, all output): a conservative upper bound.
    const system = momentSpeechSystem(ownerPrivateRule('message', true));
    const typicalPrompt = 'x'.repeat(1_600);
    const reserved = autonomyModelCostUsd('claude-haiku-5-5', { inputTokens: Math.ceil((system.length + typicalPrompt.length) * 1.5) + 64, outputTokens: OWN_MOMENT_SPEECH_V1.outputTokens }, {})!;
    expect(reserved).toBeLessThan(0.003);
    // A closed call: the prefix written once an hour or read, the tail written by the automatic breakpoint, about 400 output tokens.
    const write = autonomyModelCostUsd('claude-haiku-5-5', { inputTokens: 6_500, outputTokens: 400, cacheCreationInputTokens: 6_500, cachedInputTokens: 0 }, {})!;
    const read = autonomyModelCostUsd('claude-haiku-5-5', { inputTokens: 6_500, outputTokens: 400, cacheCreationInputTokens: 2_500, cachedInputTokens: 4_000 }, {})!;
    expect(write).toBeLessThan(0.002);
    expect(read).toBeLessThan(write);
  });
});

describe('no scripted line', () => {
  it('holds no line to say, no example and no greeting: her words come from the model', () => {
    expect(MOMENT_SPEECH_INSTRUCTIONS).not.toMatch(/「[^」]+」/u);
    const sources = ['ownMomentSpeech.ts', 'autonomyLoopReachOutStep.ts', 'momentSpeechWiring.ts', 'proactiveMomentDesk.ts'].map(name => readFileSync(apiSourceFile(name), 'utf8'));
    for (const source of sources) for (const canned of CANNED) expect(source).not.toContain(canned);
    // A promise's notice is the server's fixed fact sentence (with at most one listed phrase of hers).
    const store = readFileSync(apiSourceFile('initiativeStore.ts'), 'utf8');
    expect(store).toContain('commitmentFactSentence(');
  });
});

describe('her inner note, read in her own time\'s process (read-only, through its forgetting check)', () => {
  function stored(path: string, overrides: Partial<{ sourceIds: string[]; closing: boolean; scopeKey: string }> = {}) {
    const store = new SQLiteInnerNoteStore(path);
    const base = note();
    store.append({ scopeKey: overrides.scopeKey ?? 'owner', dayId: null, dayKey: base.dayKey, dayEndsAt: base.dayEndsAt, text: base.text, hooks: base.hooks,
      triggers: base.triggers, events: [], sourceIds: overrides.sourceIds ?? ['experience:e1'], flags: {}, changeReason: null, summary: null,
      coreVersion: 'v1', coreHash: CHARACTER_CORE.hash, episodeStartedAt: base.episodeStartedAt, usage: null, elapsedMs: 0, createdAt: base.createdAt,
      closing: overrides.closing ?? false });
    store.close();
  }

  it('hands her loop the note as one block for the owner, and nothing when it is closed, forgotten, another scope or switched off', () => {
    const path = join(directory, `note-${databases += 1}.sqlite`);
    const state = new SQLiteShannonStore({ path, now: () => START });
    state.snapshot('owner');
    stored(path);
    const environment = { SHANNON_AUTONOMY_ENABLED: 'true', SHANNON_INNER_NOTE: 'on' };
    const speech = configuredMomentSpeech(environment, { databasePath: path, ownerScope: 'owner', timeZone: 'Asia/Tokyo' })!;
    const block = speech.speech.innerNote('owner', START)!;
    expect(block).toContain('[心のメモ]');
    expect(block).toContain('SENTINEL-HONNE');
    expect(block).toContain('- 意思: まだこのままの気持ちでいるつもり');
    expect(speech.speech.innerNote('someone-else', START)).toBeNull();
    // Past her day, it is not her present.
    expect(speech.speech.innerNote('owner', later(START, 24 * 60))).toBeNull();
    // He has her forget the moment the note came from: it is not read (the API's sweep deletes it).
    state.apply('owner', { type: 'memory-control-upserted', control: { memoryId: 'e1', kind: 'experience', status: 'forgotten', pinned: false, updatedAt: START, changeReason: 'test' } as never });
    expect(speech.speech.innerNote('owner', START)).toBeNull();
    speech.close();
    // Switched off: no port at all; with the inner note off, the port says nothing of a note.
    expect(configuredMomentSpeech({ ...environment, SHANNON_PROACTIVE_SELF: 'off' }, { databasePath: path, ownerScope: 'owner', timeZone: 'Asia/Tokyo' })).toBeNull();
    const without = configuredMomentSpeech({ SHANNON_AUTONOMY_ENABLED: 'true' }, { databasePath: path, ownerScope: 'owner', timeZone: 'Asia/Tokyo' })!;
    expect(without.speech.innerNote('owner', START)).toBeNull();
    without.close();
    state.close();
    // The reader writes nothing: it opens the file read-only.
    expect(readFileSync(apiSourceFile('momentSpeechWiring.ts'), 'utf8')).toMatch(/openDatabase\(options\.databasePath, 'readOnly'\)/u);
  });

  it('gives a sulk whose time ran out only as what she felt a while ago', () => {
    const past = momentInnerNoteBlock(note({ hooks: { ...note().hooks, until: later(START, -1) } }), START, 'Asia/Tokyo');
    expect(past).toContain('[さっきまでの気持ち]');
    expect(past).not.toContain('つもり（構え');
    expect(past).not.toContain('意思');
  });
});

describe('a promise is told on time (SHANNON_PROMISE_ON_TIME)', () => {
  // Said on 2026-10-13 at 21:58 in Tokyo: 「明日9:20に起こして」 → due 2026-10-14T00:20Z (09:20). He wrote at 08:34.
  const SAID = '2026-10-13T12:58:33.359Z';
  const DUE = '2026-10-14T00:20:00.000Z';
  function fixture(options: { onTime: boolean; gate?: boolean }) {
    const path = join(directory, `promise-${databases += 1}.sqlite`);
    let now = SAID;
    const state = new SQLiteShannonStore({ path, now: () => now });
    const threadId = state.createThread('owner', 'いつものトーク');
    state.apply('owner', { type: 'prospective-memory-upserted', memory: extractProspectiveMemories('明日9:20に起こして', SAID)[0]! });
    const withheld = options.gate ? configuredWithheldActions({}, { databasePath: path, createsSchema: true, defer: task => task() })! : null;
    const inbox = options.gate ? configuredMindInbox({}, { databasePath: path })! : null;
    const gate = options.gate ? configuredProactiveGate({}, { databasePath: path, now: () => now, source: 'worker', withheld: withheld!.withheld.sink, emit: inbox!.emit })! : null;
    const world = new SQLiteWorldStore(path, () => now);
    const initiatives = new SQLiteInitiativeStore(path, () => now, gate?.gate ?? null, { promisesOnTime: options.onTime });
    const sources = new SQLiteInitiativeSources(path);
    const close = () => { sources.close(); initiatives.close(); gate?.close(); inbox?.close(); withheld?.close(); world.close(); state.close(); };
    const last = () => state.conversationHistory('owner', threadId).at(-1);
    return { state, threadId, initiatives, sources, close, last, setNow: (value: string) => { now = value; } };
  }

  it('the 2026-10-14 case: told at 09:20 though he wrote at 08:34, where the topic loop had waited until 10:04 and told it at 10:07', async () => {
    const old = fixture({ onTime: false });
    old.state.appendTurn('owner', old.threadId, 'おはよう', 'おはようございます。', '2026-10-13T23:34:14.000Z');
    // Before: the 90-minute conversation cooldown of a topic held the promise too, and the loop rechecked every 15 minutes.
    expect(old.initiatives.runOnce(later(DUE, 2), 'Asia/Tokyo')).toMatchObject({ sent: 0, stopped: 'recent-conversation' });
    expect(old.initiatives.runOnce('2026-10-14T01:07:47.968Z', 'Asia/Tokyo')).toMatchObject({ sent: 1 });
    old.close();

    const f = fixture({ onTime: true });
    f.state.appendTurn('owner', f.threadId, 'おはよう', 'おはようございます。', '2026-10-13T23:34:14.000Z');
    expect(f.initiatives.deliverDuePromises(later(DUE, -1), 'Asia/Tokyo')).toEqual({ due: 0, sent: 0 });
    expect(f.initiatives.deliverDuePromises(DUE, 'Asia/Tokyo', new Map())).toEqual({ due: 1, sent: 1 });
    // No prepared line here (as when the preparation failed): the private-safe fact sentence, content hidden.
    expect(f.last()?.content).toBe('9時20分の約束の時刻です（内容はアプリで確認できます）。');
    // Told once.
    expect(f.initiatives.deliverDuePromises(later(DUE, 1), 'Asia/Tokyo')).toEqual({ due: 0, sent: 0 });
    // The topic loop neither tells a promise nor keeps the day's slot for one: a topic of hers may still come that day.
    expect(f.initiatives.runOnce(later(DUE, 120), 'Asia/Tokyo').stopped).not.toBe('reserved-for-commitment');
    f.close();
  });

  it('is not held because he is talking (the gate still sees and notes it), and keeps the quiet hours', async () => {
    const f = fixture({ onTime: true, gate: true });
    f.state.appendTurn('owner', f.threadId, 'いま話してる', 'はい。', later(DUE, -1));
    f.setNow(DUE);
    expect(f.initiatives.deliverDuePromises(DUE, 'Asia/Tokyo')).toMatchObject({ sent: 1 });
    f.close();
    const night = fixture({ onTime: true });
    night.state.apply('owner', { type: 'prospective-memory-upserted', memory: extractProspectiveMemories('今日の23:30に薬を飲む', '2026-10-14T05:00:00.000Z')[0]! });
    expect(night.initiatives.deliverDuePromises('2026-10-14T14:31:00.000Z', 'Asia/Tokyo')).toEqual({ due: 0, sent: 0 });
    night.close();
  });

  it('is the fact sentence of the moment it is told, with her phrase when she chose one; the fact alone otherwise; logged content-free', async () => {
    const f = fixture({ onTime: true });
    const asked: unknown[] = [];
    const writer: CommitmentLineWriter = { write: async (_scopeKey, facts) => { asked.push(facts); return promisePhraseChoice({ phrase: '起きてー！', position: 'before' }, facts); } };
    const logs: string[] = [];
    const lines = commitmentLinePreparer({ writer, scopeKey: 'owner', timeZone: 'Asia/Tokyo', snapshot: key => f.state.snapshot(key),
      delivered: (key, item) => f.sources.delivered(key, item), others: () => false, log: line => logs.push(line) });
    f.initiatives.deliverDuePromises(DUE, 'Asia/Tokyo', await lines(DUE));
    expect(asked).toEqual([{ title: '明日9:20に起こして', when: '09:20', overdueMinutes: 0, others: false }]);
    expect(f.last()?.content).toBe('起きてー！9時20分の約束：「明日9:20に起こして」');
    expect(logs).toEqual(['Shannon promise line: phrase']);
    f.close();

    const none = fixture({ onTime: true });
    const noneLogs: string[] = [];
    const quiet = commitmentLinePreparer({ writer: { write: async () => null }, scopeKey: 'owner', timeZone: 'Asia/Tokyo', snapshot: key => none.state.snapshot(key),
      delivered: (key, item) => none.sources.delivered(key, item), others: () => false, log: line => noneLogs.push(line) });
    none.initiatives.deliverDuePromises(later(DUE, 47), 'Asia/Tokyo', await quiet(later(DUE, 47)));
    expect(none.last()?.content).toBe('9時20分の約束：「明日9:20に起こして」（47分遅れのお知らせ）');
    expect(noneLogs).toEqual(['Shannon promise line: fact_only:none']);
    none.close();
  });

  it('asks her choice again when it waited, and always states the lateness of the moment it is told', async () => {
    const f = fixture({ onTime: true });
    let n = 0;
    const writer: CommitmentLineWriter = { write: async (_scopeKey, facts) => { n += 1; return promisePhraseChoice({ phrase: 'ライ氏、', position: 'before' }, facts); } };
    const lines = commitmentLinePreparer({ writer, scopeKey: 'owner', timeZone: 'Asia/Tokyo', snapshot: key => f.state.snapshot(key),
      delivered: (key, item) => f.sources.delivered(key, item), others: () => false });
    expect([...(await lines(DUE)).values()]).toEqual(['ライ氏、9時20分の約束：「明日9:20に起こして」']);
    expect([...(await lines(later(DUE, 5))).values()]).toEqual(['ライ氏、9時20分の約束：「明日9:20に起こして」（5分遅れのお知らせ）']);
    expect(n).toBe(1);
    await lines(later(DUE, 11));
    expect(n).toBe(2);
    f.close();
  });

  it('after the night, says so and how late, in the fixed sentence', () => {
    expect(commitmentFactSentence({ title: '薬を飲む', when: '23:30', overdueMinutes: 450, others: false, quietHeld: true }))
      .toBe('夜の11時30分の約束：「薬を飲む」（夜のあいだは控えていたため、7時からのお知らせ・7時間30分遅れ）');
  });

  it('has no free-text path, no placeholder path and no judge for promises left in the code', () => {
    const model = readFileSync(apiSourceFile('commitmentLineModel.ts'), 'utf8');
    expect(model).not.toMatch(/groundedCommitmentLine|judgedPromiseLine|configuredPromiseJudge|JevChoiceClient|LINE_SCHEMA/u);
    expect(model).toContain("schemaName: 'shannon_promise_phrase', schema: promisePhraseSchema");
    const time = readFileSync(apiSourceFile('commitmentLineTime.ts'), 'utf8');
    expect(time).not.toMatch(/commitmentRawTextClean|\{時刻\}|\{約束\}/u);
    expect(readFileSync(apiSourceFile('jevChoice.ts'), 'utf8')).not.toContain('promise_time');
  });
});

describe('a promise never speaks over him (review of b867e66c)', () => {
  const SAID = '2026-10-13T12:58:33.359Z';
  const DUE = '2026-10-14T00:20:00.000Z';
  function told(options: { talkedAt?: string; inCall?: boolean }) {
    const path = join(directory, `quiet-${databases += 1}.sqlite`);
    const state = new SQLiteShannonStore({ path, now: () => DUE });
    const threadId = state.createThread('owner', 'いつものトーク');
    state.apply('owner', { type: 'prospective-memory-upserted', memory: extractProspectiveMemories('明日9:20に起こして', SAID)[0]! });
    if (options.talkedAt) state.appendTurn('owner', threadId, 'いま話してる', 'はい。', options.talkedAt);
    const initiatives = new SQLiteInitiativeStore(path, () => DUE, null, { promisesOnTime: true });
    expect(initiatives.deliverDuePromises(DUE, 'Asia/Tokyo', new Map(), () => options.inCall === true)).toMatchObject({ sent: 1 });
    const sources = new SQLiteInitiativeSources(path);
    const database = new DatabaseSync(path);
    const id = (database.prepare('SELECT initiative_id AS id FROM initiative_messages').get() as { id: string }).id;
    const source = sources.sources('owner', [id]).get(id)!;
    const delivery = initiativeDelivery(source, DUE, { timeZone: 'Asia/Tokyo', morningHours: { start: 7, end: 10 } });
    database.close(); sources.close(); initiatives.close(); state.close();
    return { textOnly: source.textOnly === true, delivery };
  }

  it('is told as text only (the Talk and a bubble, never read aloud) while he is in a call with her or has just talked', () => {
    expect(told({ inCall: true })).toEqual({ textOnly: true, delivery: 'text' });
    expect(told({ talkedAt: later(DUE, -3) })).toEqual({ textOnly: true, delivery: 'text' });
    // Otherwise as before: her body says it.
    expect(told({ talkedAt: later(DUE, -30) })).toEqual({ textOnly: false, delivery: 'unjudged' });
    // The world worker reads his devices' call events for it.
    const worker = readFileSync(apiSourceFile('worldWorker.ts'), 'utf8');
    expect(worker).toContain("deliverDuePromises(at, 'Asia/Tokyo', lines, inCallWithHer)");
    expect(worker).toMatch(/const inCallWithHer = \(scopeKey: string, at: string\) => bodyStore\.latestOfTypes\(scopeKey, \['callStarted', 'callEnded'\]/u);
  });
});

describe('her own time reads the note without its writer (review of b867e66c)', () => {
  it('loads the row module only: no migration, no writer class', () => {
    const wiring = readFileSync(apiSourceFile('momentSpeechWiring.ts'), 'utf8');
    expect(wiring).toContain("from '../mind/emotion/store/innerNoteRows.js'");
    expect(wiring).not.toContain('innerNoteStore.js');
    const rows = readFileSync(apiSourceFile('innerNoteRows.ts'), 'utf8');
    expect(rows.match(/^import[^;]+;$/gmu)?.join('\n')).not.toMatch(/migrations|sqliteOpen|innerNoteStore|INSERT|UPDATE|DELETE/u);
  });
});
