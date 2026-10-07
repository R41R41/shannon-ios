import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { identify } from '@shannon/mind';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { SQLiteTrustLedger } from '../src/mind/memory/store/trustLedgerStore.js';
import { PeopleMemory } from '../src/mind/memory/peopleMemory.js';
import { peopleMigrationReport } from '../src/mind/memory/store/peopleMigrationReport.js';
import { identityOf, identityPeople, type IdentityChooser, type PersonFactJudge } from '../src/mind/memory/memoryPorts.js';
import { platformImpressionLines } from '../src/mind/recall/impressionRecall.js';
import { peopleFactsStoreOptions } from '../src/wiring/peopleFactsWiring.js';
import { peopleFactsWorld, PEOPLE_AT } from './support/peopleFactsWorld.js';
import { databaseDigests } from './support/stage3Scenarios.js';

/**
 * Syzygy ADR-0008 stage 3, step F6: people facts with the time they were true, luna's contradiction and duplicate step (with its
 * daily cap and the rule), identity tiers that only suggest (the owner pinned, a short name never fuzzy), the turns' speakers,
 * two-clock decay behind its switch with the dry-run the owner sees first, the inert trust ledger, and an additive migration.
 */
const worlds: Array<{ close(): void }> = [];
const world = (options?: Parameters<typeof peopleFactsWorld>[0]) => { const created = peopleFactsWorld(options); worlds.push(created); return created; };
afterEach(() => { for (const created of worlds.splice(0)) created.close(); });

const MINA = '900000000000000002';

describe('mem.contradiction', () => {
  it('closes the fact a later one contradicts (invalid from when the new one holds, expired now), never deletes it, and recall leaves it out', async () => {
    const w = world();
    w.say(MINA, 'ミナ', '私は猫が好き');
    await w.writer.drain();
    w.say(MINA, 'ミナ', '私は猫が嫌い');
    await w.writer.drain();
    const [older, newer] = w.factRows();
    expect(older).toMatchObject({ text: 'ミナさんは猫が好き', invalid_at: newer!.valid_at, expired_at: w.now(), fact_revision: 1 });
    expect(newer).toMatchObject({ text: 'ミナさんは猫が苦手', invalid_at: null, expired_at: null });
    const lines = w.context([MINA]).join('\n');
    expect(lines).toContain('ミナさんは猫が苦手');
    expect(lines).not.toContain('ミナさんは猫が好き');
    // People memory's recall leaves it out as well; the row itself is still there.
    const recalled = new PeopleMemory(w.peopleStore, w.store, w.ports).visibleItems('owner', w.store.snapshot('owner')).map(item => item.text);
    expect(recalled).toContain('ミナさんは猫が苦手');
    expect(recalled).not.toContain('ミナさんは猫が好き');
    expect(w.peopleStore.items('owner').map(item => item.text)).toContain('ミナさんは猫が好き');
    expect(w.store.memoryOutbox()!.rows().filter(row => row.kind === 'person.fact').map(row => row.outcomeCode)).toEqual(['written', 'written_closing']);
  });
});

describe('mem.duplicate', () => {
  it('a fact said again is not written twice: the row it repeats gains the episode', async () => {
    const w = world();
    w.say(MINA, 'ミナ', '私は猫が好き');
    w.say(MINA, 'ミナ', '私は猫が好き');
    await w.writer.drain();
    const rows = w.factRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.episode_ids_json!)).toHaveLength(2);
    expect(rows[0]!.fact_revision).toBe(1);
    expect(w.store.memoryOutbox()!.rows().filter(row => row.kind === 'person.fact').map(row => row.outcomeCode)).toEqual(['written', 'duplicate']);
  });
});

describe('the contradiction step', () => {
  it('asks luna once per op over the person\'s current facts, through the writer\'s cache, and follows what it found', async () => {
    const asked: Parameters<PersonFactJudge['judge']>[1][] = [];
    const judge: PersonFactJudge = { judge: async (_scopeKey, input) => {
      asked.push(input);
      return { judgements: input.newFacts.map(item => ({ key: item.key, duplicates: [], contradicts: input.facts.filter(fact => fact.text.includes('東京')).map(fact => fact.key) })) };
    } };
    const w = world({ judge });
    w.say(MINA, 'ミナ', '私は東京に住んでいる');
    await w.writer.drain();
    w.say(MINA, 'ミナ', '私は大阪に住んでいる');
    await w.writer.drain();
    // The first fact had nothing to compare with: no call. The second: one call, over the one current fact.
    expect(asked).toHaveLength(1);
    expect(asked[0]!.facts.map(fact => fact.text)).toEqual(['ミナさんは東京に住んでいる']);
    const [tokyo, osaka] = w.factRows();
    expect(tokyo!.expired_at).not.toBeNull();
    expect(osaka!.expired_at).toBeNull();
  });

  it('uses the rule once the day\'s forty calls are spent, and while luna is not there', async () => {
    let calls = 0;
    const judge: PersonFactJudge = { judge: async (_scopeKey, input) => { calls += 1; return { judgements: input.newFacts.map(item => ({ key: item.key, duplicates: [], contradicts: [] })) }; } };
    const w = world({ judge });
    // Forty calls of the judge already made today.
    const database = new DatabaseSync(w.path);
    for (let index = 0; index < 40; index += 1) database.prepare(`INSERT INTO memory_writer_calls (call_key, op_seq, kind, answer_json, created_at) VALUES (?, 0, 'person.fact', '{}', ?)`).run(`k${index}`, w.now());
    database.close();
    w.say(MINA, 'ミナ', '私は猫が好き');
    await w.writer.drain();
    w.say(MINA, 'ミナ', '私は猫が嫌い');
    await w.writer.drain();
    expect(calls).toBe(0);
    expect(w.factRows()[0]!.expired_at).not.toBeNull(); // the rule saw 好き／嫌い
  });
});

describe('identity tiers only suggest', () => {
  it('tier 3: a near-identical new account is suggested to the owner (never merged), and settled when he merges', async () => {
    const w = world();
    w.say('900000000000000010', 'MaximilianSchwarzenegger', 'こんにちは');
    await w.writer.drain();
    w.say('900000000000000011', 'MaximilianSchwarzeneggerr', 'こんばんは');
    await w.writer.drain();
    const people = w.peopleStore.listPeople('owner');
    expect(people).toHaveLength(2);
    const [candidate] = w.readers!.candidates('owner');
    expect(candidate).toMatchObject({ tier: 3 });
    expect(new Set([candidate!.personId, candidate!.candidatePersonId])).toEqual(new Set(people.map(person => person.id)));
    // The owner merges (his command, synchronous through the same write); the suggestion is closed.
    expect(w.ports.commands.run({ opId: 'merge-1', scopeKey: 'owner', kind: 'person.link', subjectKey: `person:${candidate!.candidatePersonId}`,
      payload: { action: 'merge', personId: candidate!.personId, intoPersonId: candidate!.candidatePersonId } }).applied).toBe(true);
    expect(w.readers!.candidates('owner')).toEqual([]);
    expect(w.peopleStore.listPeople('owner')).toHaveLength(1);
  });

  it('tier 4: Jev\'s probability is followed only in the band, in the background, to suggest', async () => {
    const asked: Array<{ name: string; menu: readonly { key: string; names: readonly string[] }[] }> = [];
    const chooser: IdentityChooser = { probabilities: async (_scopeKey, input) => { asked.push(input); return { p1: 0.95, new_person: 0.02 }; } };
    const w = world({ chooser });
    w.say('900000000000000020', 'ミナミ', 'こんにちは');
    await w.writer.drain();
    w.say('900000000000000021', 'ミナ', 'やあ');
    await w.writer.drain();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ name: 'ミナ', menu: [{ key: 'p1', names: ['ミナミ'] }] });
    expect(w.readers!.candidates('owner')).toMatchObject([{ tier: 4 }]);
  });

  it('id.short-name: a short Latin name is never matched fuzzily', async () => {
    const w = world({ chooser: { probabilities: async () => ({ p1: 0.99, new_person: 0 }) } });
    w.say('900000000000000030', 'Mia', 'hi');
    const mi = w.say('900000000000000031', 'Mi', 'hey');
    await w.writer.drain();
    expect(w.readers!.candidates('owner')).toEqual([]);
    expect(identityOf('Mi', identityPeople(w.peopleStore, 'owner', [mi.personId!]))).toMatchObject({ tier: 2, why: 'too_short' });
  });

  it('id.owner-pinned: the owner is matched only by his pins, never by a name at any tier', () => {
    const people = [{ personId: 'owner-row', names: ['ライ'], links: [], isOwner: true }, { personId: 'p-1', names: ['Raymond'], links: [], isOwner: false }];
    expect(identify({ name: 'ライ' }, people, () => 0.99)).not.toMatchObject({ personId: 'owner-row' });
    expect(identify({ name: 'ライ', ownerPinned: true }, people)).toEqual({ tier: 0, verdict: 'owner' });
    // In people memory the owner is no person row at all: a guest named like him is someone else.
    const w = world();
    w.say('900000000000000040', 'ライ', 'はじめまして');
    expect(identityPeople(w.peopleStore, 'owner').every(person => !person.isOwner)).toBe(true);
  });

  it('keeps who wrote each stored message (turn_speakers): tier 1, verified by the platform account', () => {
    const w = world();
    const result = w.say(MINA, 'ミナ', 'こんにちは');
    expect(w.store.personFacts()!.speaker('owner', result.itemId)).toMatchObject({ speakerKind: 'person', personId: result.personId, tier: 1, verified: true });
  });
});

describe('decay.two-clock', () => {
  function seededImpressions(path: string) {
    const store = new SQLiteShannonStore({ path, now: () => PEOPLE_AT, moodHistory: null });
    const people = new SQLitePeopleMemoryStore(path);
    const mina = people.createPerson('owner', { displayName: 'ミナ', howKnown: 'テスト' }, PEOPLE_AT);
    const day = (offset: number) => new Date(Date.parse(PEOPLE_AT) - offset * 86_400_000).toISOString();
    const row = (id: string, status: 'active' | 'candidate' | 'retired', evidence: Array<{ id: string; at: string; stance: 'support' | 'contra' }>) => ({
      id, personKey: mina.id, kind: 'speech_habit' as const, pattern: `口癖${id}`, keyTerms: ['口癖'], herFeeling: '', feelingTag: '' as const, feelingHistory: [],
      supportCount: evidence.filter(item => item.stance === 'support').length, contraCount: 0, contraStreak: 0, supportDays: 1, lastSupportDay: '2026-10-07',
      firstSeenAt: evidence[0]!.at, lastSeenAt: evidence.at(-1)!.at, evidence, status, disclosure: {}, createdAt: evidence[0]!.at, updatedAt: evidence.at(-1)!.at,
    });
    store.impressionStore().saveImpressions('owner', [
      // In use today, but its support is old: the two clocks would no longer use it.
      row('old', 'active', [{ id: 't1', at: day(120), stance: 'support' }, { id: 't2', at: day(110), stance: 'support' }, { id: 't3', at: day(100), stance: 'support' }]),
      // Not in use today (a candidate), but supported four times this week (net about 1.9): the two clocks would use it.
      row('fresh', 'candidate', [0, 1, 2, 3].map(offset => ({ id: `f${offset}`, at: day(offset), stance: 'support' as const }))),
      // The owner's own: exempt, never listed.
      { ...row('owners', 'active', [{ id: 'o1', at: day(200), stance: 'support' }]), personKey: 'owner' },
    ], []);
    people.close();
    store.close();
    return mina;
  }

  it('the dry-run lists, per person, what would change, and changes nothing (also through the script)', () => {
    const w = world();
    const path = `${w.directory}/decay.sqlite`;
    const mina = seededImpressions(path);
    const before = databaseDigests(path);
    const database = new DatabaseSync(path, { readOnly: true });
    const report = peopleMigrationReport(database, 'owner', PEOPLE_AT);
    database.close();
    expect(report.decay).toEqual([{ personKey: mina.id, displayName: 'ミナ', transitions: [
      expect.objectContaining({ id: 'fresh', current: 'faded', after: 'usable' }),
      expect.objectContaining({ id: 'old', current: 'active', after: 'unconfirmed' }),
    ] }]);
    expect(report.temporal).toMatchObject({ columns: false, impressionsToBackfill: 3 });
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const printed = execFileSync('scripts/shannon-people-migration.sh', ['--dry-run', '--database', path, '--scope', 'owner'], { cwd: root, encoding: 'utf8' });
    expect(printed).toContain('nothing was changed');
    expect(printed).toContain('口癖old : active -> unconfirmed');
    expect(() => execFileSync('scripts/shannon-people-migration.sh', ['--database', path], { cwd: root, stdio: 'pipe' })).toThrow();
    expect(databaseDigests(path)).toEqual(before);
  });

  it('is off by default; on, impressions of others are used by the two clocks, the owner\'s by today\'s rule', () => {
    const w = world();
    const path = `${w.directory}/decay.sqlite`;
    const mina = seededImpressions(path);
    const store = new SQLiteShannonStore({ path, now: () => PEOPLE_AT, moodHistory: null });
    const lines = (environment: Record<string, string>) => platformImpressionLines(store, store.snapshot('owner'), 'owner',
      { personIds: [mina.id], present: { kind: 'people', personIds: [mina.id] }, at: PEOPLE_AT }, { ...environment, SHANNON_IMPRESSIONS_VOICE_LINES: '4' }).join('\n');
    expect(peopleFactsStoreOptions({})).not.toHaveProperty('evidenceDecay');
    expect(lines({})).toContain('口癖old');
    expect(lines({})).not.toContain('口癖fresh');
    const decayed = lines({ SHANNON_EVIDENCE_DECAY: 'on' });
    expect(decayed).toContain('口癖fresh');
    expect(decayed).not.toContain('口癖old');
    store.close();
  });
});

describe('trust.inert', () => {
  it('records closed kinds only, with trust_after null while its parameters are unset; no table while it is switched off', () => {
    const w = world();
    const ledger = w.store.trustLedger()!;
    expect(ledger).toBeInstanceOf(SQLiteTrustLedger);
    expect(ledger.record('owner', 'promise_kept', 'thread', PEOPLE_AT)).toBeNull();
    expect(ledger.trust('owner')).toBeNull();
    expect(() => ledger.record('owner', 'flattered' as 'promise_kept', 'thread', PEOPLE_AT)).toThrow('TRUST_KIND');
    const off = world({ environment: { SHANNON_TRUST_LEDGER: 'off', SHANNON_TEMPORAL_FACTS: 'off', SHANNON_IDENTITY_TIERS: 'off' } });
    expect(off.store.trustLedger()).toBeNull();
    expect(off.store.personFacts()).toBeNull();
    const database = new DatabaseSync(off.path, { readOnly: true });
    const tables = (database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(row => row.name);
    const columns = (database.prepare('PRAGMA table_info(person_memory_items)').all() as Array<{ name: string }>).map(row => row.name);
    database.close();
    expect(tables).not.toEqual(expect.arrayContaining(['shannon_trust_ledger']));
    expect(tables).not.toContain('person_identity_candidates');
    expect(tables).not.toContain('turn_speakers');
    expect(columns).not.toContain('valid_at');
  });
});

describe('the additive migration', () => {
  it('adds the columns and backfills rows written before, changing no text', () => {
    const w = world({ environment: { SHANNON_TEMPORAL_FACTS: 'off', SHANNON_IDENTITY_TIERS: 'off' } });
    const before = new SQLitePeopleMemoryStore(w.path);
    const person = before.createPerson('owner', { displayName: 'ミナ', howKnown: 'テスト' }, PEOPLE_AT);
    before.saveCall('owner', { callId: 'call-1', status: 'remembered', personIds: [person.id], createdPersonIds: [], startedAt: PEOPLE_AT, updatedAt: PEOPLE_AT });
    before.replaceCallItems('owner', 'call-1', [{ id: 'fact-1', kind: 'fact', personId: person.id, text: 'ミナさんは猫が好き', observedAt: PEOPLE_AT, disclosure: {} }]);
    before.close();
    const store = new SQLiteShannonStore({ path: w.path, now: () => PEOPLE_AT, moodHistory: null, peopleFacts: { temporal: true, identity: false } });
    const facts = store.personFacts()!.facts('owner', person.id);
    expect(facts).toMatchObject([{ id: 'fact-1', text: 'ミナさんは猫が好き', validAt: PEOPLE_AT, invalidAt: null, expiredAt: null, episodeIds: [], revision: 0 }]);
    store.close();
  });
});
