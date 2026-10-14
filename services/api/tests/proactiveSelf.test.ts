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
import {
  COMMITMENT_LINE_INSTRUCTIONS, COMMITMENT_TIME_RULE, commitmentLineInstructionsWithCore, commitmentRequest, groundedCommitmentLine, namesPromise,
  type CommitmentFacts, type CommitmentLineWriter,
} from '../src/mind/action/respond/commitmentLine.js';
import { canonicalTimePhrases } from '../src/mind/action/respond/commitmentLineTime.js';
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
    expect(w.holds()).toEqual([{ tool: 'owner.reach_out', reason: 'intent_repeat' }, { tool: 'owner.reach_out', reason: 'owner_active' }]);
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
    // The only fixed text for a promise stays its neutral factual line, used when her line could not be written or trusted.
    const store = readFileSync(apiSourceFile('initiativeStore.ts'), 'utf8');
    expect(store).toContain('neutralCommitmentLine(');
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
    expect(f.last()?.content).toBe('約束：「明日9:20に起こして」');
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

  it('is in her words when they state the promise, written at the moment it is due; the neutral line only when the model fails', async () => {
    class Writer implements CommitmentLineWriter {
      readonly asked: CommitmentFacts[] = [];
      constructor(private readonly line: string | null) {}
      async write(_scopeKey: string, facts: CommitmentFacts) { this.asked.push(facts); return this.line === null ? null : groundedCommitmentLine(this.line, facts); }
    }
    const f = fixture({ onTime: true });
    const writer = new Writer('ライ氏、9時20分ですよ！起こしてって言ってたの、ちゃんと覚えてますからね。');
    const logs: string[] = [];
    const lines = commitmentLinePreparer({ writer, scopeKey: 'owner', timeZone: 'Asia/Tokyo', snapshot: key => f.state.snapshot(key),
      delivered: (key, item) => f.sources.delivered(key, item), others: () => false, log: line => logs.push(line) });
    const prepared = await lines(DUE);
    expect(writer.asked).toEqual([{ title: '明日9:20に起こして', when: '09:20', overdueMinutes: 0, others: false, dueOn: { month: 10, day: 14, weekday: '水', today: true } }]);
    f.initiatives.deliverDuePromises(DUE, 'Asia/Tokyo', prepared);
    expect(f.last()?.content).toBe('ライ氏、9時20分ですよ！起こしてって言ってたの、ちゃんと覚えてますからね。');
    expect(logs).toEqual(['Shannon promise line: hers']);
    f.close();

    const failed = fixture({ onTime: true });
    const failedLogs: string[] = [];
    const none = commitmentLinePreparer({ writer: new Writer(null), scopeKey: 'owner', timeZone: 'Asia/Tokyo', snapshot: key => failed.state.snapshot(key),
      delivered: (key, item) => failed.sources.delivered(key, item), others: () => false, log: line => failedLogs.push(line) });
    failed.initiatives.deliverDuePromises(DUE, 'Asia/Tokyo', await none(DUE));
    expect(failed.last()?.content).toBe('約束：「明日9:20に起こして」（09:20）');
    expect(failedLogs).toEqual(['Shannon promise line: neutral:unwritten_or_untrusted']);
    failed.close();
  });

  it('writes the line again when it waited: its facts say how late it is', async () => {
    const f = fixture({ onTime: true });
    let n = 0;
    const writer: CommitmentLineWriter = { write: async () => `ライ氏、起こしての約束の時間です${'！'.repeat(n += 1)}` };
    const lines = commitmentLinePreparer({ writer, scopeKey: 'owner', timeZone: 'Asia/Tokyo', snapshot: key => f.state.snapshot(key),
      delivered: (key, item) => f.sources.delivered(key, item), others: () => false });
    await lines(DUE);
    await lines(later(DUE, 5));
    expect(n).toBe(1);
    await lines(later(DUE, 11));
    expect(n).toBe(2);
    f.close();
  });

  it('accepts her own wording of the promise and of its time, and still refuses a number or a promise that is not there', () => {
    const facts: CommitmentFacts = { title: '明日9:20に起こして', when: '09:20', overdueMinutes: 0, others: false };
    expect(groundedCommitmentLine('9時20分！起こしてって言ってたやつですよ、ライ氏。', facts)).not.toBeNull();
    expect(namesPromise('ライ氏、明日プレゼンの練習、今日やりますよ', '明日プレゼンの練習しよう')).toBe(true);
    expect(groundedCommitmentLine('ライ氏、10時の約束ですよ。', facts)).toBeNull();
    expect(groundedCommitmentLine('ライ氏、そろそろ時間ですよ。', facts)).toBeNull();
    // With anyone else there it still names nothing.
    expect(groundedCommitmentLine('9:20に起こしての約束ですよ', { ...facts, others: true })).toBeNull();
    expect(groundedCommitmentLine('ライ氏、約束の時間ですよ。', { ...facts, others: true })).not.toBeNull();
  });

  it('is written with her core first (the prefix of her moment speech); switched off, the bytes of before', () => {
    expect(commitmentLineInstructionsWithCore(false).startsWith(characterCoreBlock(CHARACTER_CORE))).toBe(true);
    expect(commitmentLineInstructionsWithCore(false).endsWith(`${COMMITMENT_LINE_INSTRUCTIONS}\n${COMMITMENT_TIME_RULE}`)).toBe(true);
    const model = readFileSync(apiSourceFile('commitmentLineModel.ts'), 'utf8');
    expect(model).toMatch(/switchOn\(environment, 'SHANNON_PROMISE_ON_TIME'\) \? \{ \.\.\.COMMITMENT, instructions: \(\) => commitmentLineInstructionsWithCore\(\) \} : COMMITMENT/u);
  });
});

describe('a promise\'s time: an allowlist, never a parser (reviews of b867e66c and 508b6288)', () => {
  const morning: CommitmentFacts = { title: '起こして', when: '09:20', overdueMinutes: 0, others: false, dueOn: { month: 10, day: 14, weekday: '水', today: true } };
  const evening: CommitmentFacts = { ...morning, when: '21:20' };
  const said = (line: string, facts: CommitmentFacts = morning) => groundedCommitmentLine(line, facts) !== null;

  it('tells her the canonical words for the time, and accepts them and their exact equivalents', () => {
    expect(canonicalTimePhrases(morning)).toEqual(['9時20分']);
    expect(canonicalTimePhrases(evening)).toEqual(['夜の9時20分', '21時20分']);
    expect(canonicalTimePhrases({ when: '今日' })).toEqual([]);
    expect(JSON.parse(commitmentRequest(morning))).toMatchObject({ say_time_as: ['9時20分'] });
    for (const line of ['9時20分ですよ、起こしての時間！', '9:20、起こしてって言ってたやつ', '09:20になりました。起こしてですよ', '九時二十分！起こしてって言ったでしょ',
      '今日の9時20分、起こしての約束ですよ', '水曜の朝9時20分、起こしてですよ', '10月14日の9時20分、起こしての時間', '午前9時20分、起こしての時間です', '起こしての時間ですよ']) {
      expect(said(line), line).toBe(true);
    }
    expect(said('ライ氏、「明日9:20に起こして」の時間ですよ', { ...morning, title: '明日9:20に起こして' })).toBe(true);
    expect(said('9時半！起こしての時間ですよ', { ...morning, when: '09:30' })).toBe(true);
    for (const line of ['夜の9時20分、起こしての時間', '夜9時20分、起こしての時間', '21:20、起こしての時間', '21時20分、起こしての時間', '午後9時20分、起こしての時間']) {
      expect(said(line, evening), line).toBe(true);
    }
    expect(said('9時20分の起こして、47分過ぎちゃった', { ...morning, overdueMinutes: 47 })).toBe(true);
  });

  it('refuses every false accept the reviews found, and anything else that names a time, a day or a date', () => {
    const wrong: Array<[string, CommitmentFacts]> = [
      // b867e66c
      ['20時だよ、起こして', morning], ['20時9分、起こして', morning], ['明日の9時20分、起こして', morning], ['午後9時20分、起こして', morning],
      ['21時20分、起こして', morning], ['夜の9時20分、起こして', morning], ['火曜の9時20分、起こして', morning], ['10月15日の9時20分、起こして', morning],
      ['9時、起こして', morning], ['9時20分、起こして。1時間後にまた', morning], ['9時20分、起こして。30分過ぎてます', morning], ['20だよ、起こして', morning],
      ['午前9時20分、起こしての時間', evening], ['朝の9時20分、起こしての時間', evening],
      // 508b6288
      ['今夜は9時20分だね、起こして', morning], ['夜は9時20分、起こして', morning], ['9:20pm、起こして', morning], ['PM9:20、起こして', morning],
      ['9:20am、起こして', evening], ['0時20分、起こして', { ...morning, when: '12:20' }], ['深夜12時20分、起こして', { ...morning, when: '12:20' }],
      ['真夜中の起こして', morning], ['翌日の9時20分、起こして', morning], ['明々後日も起こして', morning], ['tomorrow 9:20、起こして', morning],
      ['9時20分前だよ、起こして', morning], ['20分後に起こすね', { ...morning, overdueMinutes: 20 }],
      // the bare 12-hour form of an evening time is no longer allowed
      ['9時20分ですよ、起こしての時間', evening],
      // other days, durations, parts of the day, kanji numbers, English
      ['昨日の起こして', morning], ['今朝の起こして', morning], ['夕方の起こして', morning], ['十時間後に起こして', morning], ['九時二十五分、起こして', morning],
      ['十九時二十分、起こして', morning], ['19:20、起こして', morning], ['11時20分、起こして', { ...morning, when: '01:20' }], ['2時間たった、起こして', morning],
      ['tonight、起こして', morning], ['monday、起こして', morning], ['来週も起こして', morning], ['今日の起こして', { ...morning, dueOn: { ...morning.dueOn!, today: false } }],
      ['9時20分ごろ、起こして', morning], ['9時20分過ぎ、起こして', morning], ['9時20分くらい、起こして', morning], ['正午に起こして', morning],
      ['１０時、起こして', morning], ['9時20分の起こして、30分過ぎちゃった', { ...morning, overdueMinutes: 47 }], ['9時に起こしての約束ですよ', { ...morning, when: '今日', overdueMinutes: null }],
    ];
    for (const [line, facts] of wrong) expect(said(line, facts), `${line} (${facts.when})`).toBe(false);
  });

  it('accepts no random time phrase that differs from the fact (fuzz)', () => {
    let seed = 20261014;
    const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const periods = ['', '午前', '午後', '朝', '夜', '夕方', '昼', '深夜', '今夜', '朝の', '夜の', '昨夜', '翌朝', '今朝', '深夜の', '明日の', 'pm', 'am', '真夜中の'];
    const suffixes = ['', 'am', 'pm', ' pm', '前', '後', 'ごろ', '過ぎ', '頃', 'くらい', '間'];
    let tried = 0;
    for (const facts of [morning, evening, { ...morning, when: '12:20' }, { ...morning, when: '00:20' }, { ...morning, when: '09:30' }]) {
      const [hour, minute] = facts.when!.split(':').map(Number) as [number, number];
      for (let index = 0; index < 1_000; index += 1) {
        const h = random(25);
        const m = random(60);
        const period = periods[random(periods.length)]!;
        const suffix = suffixes[random(suffixes.length)]!;
        const form = random(4);
        const time = form === 0 ? `${h}時${m}分` : form === 1 ? `${h}:${String(m).padStart(2, '0')}` : form === 2 ? `${h}時` : `${h}時半`;
        const meant = form === 2 ? 0 : form === 3 ? 30 : m;
        // The one reading that is the fact: its own hour in 24h with no half-of-day word, or its 12-hour hour with a true one.
        const pm = ['午後', '夜', '夕方', '夜の'].includes(period) || (period === '昼' && h === 12);
        const am = ['午前', '朝', '朝の'].includes(period);
        const hour24 = period === '' ? h : pm ? (h === 12 ? 12 : h + 12) : am ? h : -1;
        const sameInstant = hour24 === hour && meant === minute && suffix === '' && !(period === '昼' && hour !== 12);
        if (sameInstant) continue;
        tried += 1;
        const line = `${period}${time}${suffix}、起こしての時間ですよ`;
        expect(said(line, facts), `${line} for ${facts.when}`).toBe(false);
      }
    }
    expect(tried).toBeGreaterThan(4_500);
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

