import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PeopleMemory } from '../src/mind/memory/peopleMemory.js';
import { dispatchPeopleMemoryRequest, peopleMemoryOverview } from '../src/infra/http/apiPeopleMemoryRoutes.js';
import { configuredOwnerContext } from '../src/wiring/autonomyOwnerContextWiring.js';
import type { PersonFactJudge } from '../src/mind/memory/memoryPorts.js';
import { MEMORY_AT, memoryWorld } from './support/memoryWorld.js';
import { peopleFactsWorld } from './support/peopleFactsWorld.js';

/**
 * The memory writer after the stage 3 review (Syzygy ADR-0008): what the outbox keeps (H2), what the judge is shown (H3), the
 * owner's controls checked before any model is asked, staleness, the owner's commands after the rows about their people, the
 * batch without head-of-line blocking (M7), and contention that is not a model failure (L4).
 */
const MINA = '900000000000000002';
const AKI = '900000000000000003';
const worlds: Array<{ close(): void }> = [];
const people = (options?: Parameters<typeof peopleFactsWorld>[0]) => { const created = peopleFactsWorld(options); worlds.push(created); return created; };
const memory = () => { const created = memoryWorld(); worlds.push(created); return created; };
afterEach(() => { for (const created of worlds.splice(0)) created.close(); });

const fact = (id: string, observedAt: string, statement = 'ユーザーは星が好き') => ({
  id, statement, confidence: 0.9, observedAt, evidence: '星が好き', disclosure: { audience: { kind: 'owner' as const }, sensitivity: 'ordinary' as const },
});
const tables = (path: string) => {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return JSON.stringify([database.prepare('SELECT * FROM memory_outbox').all(), database.prepare('SELECT * FROM memory_writer_calls').all()]);
  } finally { database.close(); }
};

describe('what the outbox keeps (review H2)', () => {
  it('keeps nothing of a call the owner discarded, in either table', async () => {
    const judge: PersonFactJudge = { judge: async (_scopeKey, input) => ({ judgements: input.newFacts.map(item => ({ key: item.key, duplicates: [], contradicts: [] })) }) };
    const w = people({ judge });
    w.say(MINA, 'ミナ', '私は猫が好き');
    await w.writer.drain();
    w.say(MINA, 'ミナ', '私は犬が好き');
    await w.writer.drain();
    expect(tables(w.path)).toContain('猫');
    const callId = (JSON.parse(w.store.memoryOutbox()!.rows().find(row => row.kind === 'person.fact')!.payloadJson) as { callId: string }).callId;
    w.peopleStore.discardCall('owner', callId, w.now());
    // What was said in it is gone from both tables (the person herself is still remembered, from elsewhere: her name stays in people).
    expect(tables(w.path)).not.toMatch(/猫|犬/u);
    expect(w.store.memoryOutbox()!.rows().filter(row => row.kind !== 'person.link').every(row => row.payloadJson === '{}')).toBe(true);
    expect(JSON.parse(tables(w.path))[1]).toEqual([]);
  });

  it('takes a pending row of a forgotten turn out, and empties a final row\'s payload after a day', async () => {
    const w = memory();
    w.ports.proposals.propose({ opId: 'turn-x:fact', scopeKey: 'owner', kind: 'fact.upsert', origin: 'turn', subjectKey: 'fact:f-1',
      payload: { fact: fact('f-1', MEMORY_AT), source: 'conversation' }, episodeIds: ['turn-x'] });
    w.store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: 'turn-x', kind: 'experience', status: 'forgotten', pinned: false, updatedAt: w.now(), changeReason: 'ユーザーが忘れるよう指定' } });
    expect(w.rows()).toMatchObject([{ status: 'superseded', outcomeCode: 'forgotten', payloadJson: '{}', episodeIdsJson: '[]' }]);
    w.ports.proposals.propose({ opId: 'turn-y:fact', scopeKey: 'owner', kind: 'fact.upsert', origin: 'turn', subjectKey: 'fact:f-2',
      payload: { fact: fact('f-2', MEMORY_AT), source: 'conversation' }, episodeIds: ['turn-y'] });
    const writer = w.writer();
    await writer.runOnce();
    expect(w.rows()[1]).toMatchObject({ status: 'applied' });
    expect(w.rows()[1]!.payloadJson).toContain('星');
    w.advance(25 * 60 * 60_000);
    expect(await writer.runOnce()).toBe('idle');
    expect(w.rows()[1]).toMatchObject({ status: 'applied', payloadJson: '{}', episodeIdsJson: '[]', disclosureJson: null });
  });
});

describe('the owner\'s controls before any model (review: privacy) and the judge\'s input (review H3)', () => {
  it('asks the judge nothing about a forgotten fact row, and never closes it', async () => {
    const asked: Array<Parameters<PersonFactJudge['judge']>[1]> = [];
    const judge: PersonFactJudge = { judge: async (_scopeKey, input) => { asked.push(input); return { judgements: input.newFacts.map(item => ({ key: item.key, duplicates: [], contradicts: input.facts.map(entry => entry.key) })) }; } };
    const w = people({ judge });
    w.say(MINA, 'ミナ', '私は猫が好き');
    await w.writer.drain();
    const [first] = w.factRows();
    new PeopleMemory(w.peopleStore, w.store, w.ports).forgetItem('owner', first!.item_id, w.now());
    w.say(MINA, 'ミナ', '私は猫が嫌い');
    await w.writer.drain();
    expect(asked).toEqual([]);
    expect(w.factRows().find(row => row.item_id === first!.item_id)).toMatchObject({ invalid_at: null, expired_at: null });
  });

  it('asks no model for a person forgotten while the row waited', async () => {
    const judge = { judge: vi.fn(async () => ({ judgements: [] })) } satisfies PersonFactJudge;
    const w = people({ judge });
    w.say(MINA, 'ミナ', '私は猫が好き');
    await w.writer.drain();
    w.say(MINA, 'ミナ', '私は猫が嫌い');
    // Forgotten behind the outbox's back (as another process might): the writer's own check stops it before the judge.
    const database = new DatabaseSync(w.path);
    database.prepare(`UPDATE people SET forgotten_at = ? WHERE scope_key = 'owner'`).run(w.now());
    database.close();
    await w.writer.drain();
    expect(judge.judge).not.toHaveBeenCalled();
    expect(w.store.memoryOutbox()!.rows().filter(row => row.kind === 'person.fact').map(row => row.outcomeCode)).toEqual(['written', 'forgotten']);
  });

  it('does not let an older proposal overwrite a newer statement (staleness, review M2)', async () => {
    const w = memory();
    const later = new Date(Date.parse(MEMORY_AT) + 60_000).toISOString();
    w.ports.proposals.propose({ opId: 'a', scopeKey: 'owner', kind: 'fact.upsert', origin: 'turn', subjectKey: 'fact:f-1', payload: { fact: fact('f-1', later, 'ユーザーは月が好き'), source: 'conversation' } });
    w.ports.proposals.propose({ opId: 'b', scopeKey: 'owner', kind: 'fact.upsert', origin: 'sleep', subjectKey: 'fact:f-1', payload: { fact: fact('f-1', MEMORY_AT), source: 'sleep' } });
    await w.writer().drain();
    expect(w.rows().map(row => row.outcomeCode)).toEqual(['written', 'stale']);
    expect(w.store.snapshot('owner').userFacts.find(item => item.id === 'f-1')?.statement).toBe('ユーザーは月が好き');
  });
});

describe('the owner\'s commands after the rows about their people (review)', () => {
  it('a merge queued behind a pending fact of the person merged away: the fact ends on the person merged into', async () => {
    const w = people();
    w.say(AKI, 'アキ', 'こんにちは');
    w.say(MINA, 'ミナ', 'よろしく');
    await w.writer.drain();
    const [aki, mina] = [AKI, MINA].map(user => w.peopleStore.listPeople('owner').find(person => person.aliases.concat(person.displayName).some(name => name === (user === AKI ? 'アキ' : 'ミナ')))!);
    w.say(MINA, 'ミナ', '私は猫が好き');
    const memoryOfPeople = new PeopleMemory(w.peopleStore, w.store, w.ports);
    expect(memoryOfPeople.merge('owner', aki!.id, mina!.id, w.now())).toBe(true);
    expect(w.store.memoryOutbox()!.rows().at(-1)).toMatchObject({ kind: 'person.link', status: 'pending' });
    await w.writer.drain();
    const item = w.peopleStore.items('owner').find(entry => entry.text.includes('猫'));
    expect(item?.personId).toBe(aki!.id);
    expect(w.peopleStore.person('owner', mina!.id)).toBeNull();
    expect(w.store.memoryOutbox()!.rows().at(-1)).toMatchObject({ kind: 'person.link', status: 'applied', outcomeCode: 'merged' });
  });
});

describe('the batch (review M7) and contention (review L4)', () => {
  it('leaves a subject waiting for its retry out of the batch whole, so the others take its places', () => {
    const w = memory();
    for (const [id, subject] of [['a1', 'fact:a'], ['a2', 'fact:a'], ['b1', 'fact:b']] as const) {
      w.ports.proposals.propose({ opId: id, scopeKey: 'owner', kind: 'fact.upsert', origin: 'turn', subjectKey: subject, payload: { fact: fact(subject.slice(5), MEMORY_AT), source: 'conversation' } });
    }
    const first = w.rows()[0]!;
    w.outbox.underLock(w.now(), () => w.outbox.retryLater(first.seq, 1, new Date(Date.parse(w.now()) + 60_000).toISOString(), 'model_x'));
    expect(w.outbox.pending(32, w.now()).map(row => row.opId)).toEqual(['b1']);
    expect(w.outbox.pending(32, new Date(Date.parse(w.now()) + 61_000).toISOString()).map(row => row.opId)).toEqual(['a1', 'a2', 'b1']);
  });

  it('does not count a busy database as a failure of the row', async () => {
    const w = memory();
    w.ports.proposals.propose({ opId: 'a', scopeKey: 'owner', kind: 'fact.upsert', origin: 'turn', subjectKey: 'fact:a', payload: { fact: fact('a', MEMORY_AT), source: 'conversation' } });
    const writer = w.writer();
    const apply = vi.spyOn(w.store, 'apply').mockImplementationOnce(() => { throw Object.assign(new Error('database is locked'), { errcode: 5 }); });
    await writer.runOnce();
    expect(w.rows()[0]).toMatchObject({ status: 'pending', attempts: 0 });
    apply.mockRestore();
    await writer.runOnce();
    expect(w.rows()[0]).toMatchObject({ status: 'applied', attempts: 0 });
  });
});

describe('closed facts for the owner and her own time (review M4, M5)', () => {
  it('shows the owner which facts the rules closed, and reopens one at once', async () => {
    const w = people();
    w.say(MINA, 'ミナ', '私は猫が好き');
    await w.writer.drain();
    w.say(MINA, 'ミナ', '私は猫が嫌い');
    await w.writer.drain();
    const [older] = w.factRows();
    const memoryOfPeople = new PeopleMemory(w.peopleStore, w.store, w.ports);
    const itemOf = () => peopleMemoryOverview(memoryOfPeople, w.store, 'owner').people.flatMap(person => person.items).find(item => item.id === older!.item_id);
    expect(itemOf()).toMatchObject({ closed: true });
    const response = await dispatchPeopleMemoryRequest({ method: 'POST', path: '/v1/people/memory/action', body: { scopeKey: 'owner', action: 'reopen-fact', itemId: older!.item_id } },
      { people: memoryOfPeople, stateStore: w.store, now: w.now });
    expect(response?.status).toBe(200);
    expect(itemOf()).not.toHaveProperty('closed');
    expect(w.factRows().find(row => row.item_id === older!.item_id)).toMatchObject({ invalid_at: null, expired_at: null });
  });

  it('leaves a closed fact out of what her own time reads of the owner\'s people, as a conversation does', async () => {
    const w = people();
    w.say(MINA, 'ミナ', '私は猫が好き');
    await w.writer.drain();
    w.say(MINA, 'ミナ', '私は猫が嫌い');
    await w.writer.drain();
    const opened = configuredOwnerContext(w.path, { now: w.now, characters: 2_400, timeZone: 'Asia/Tokyo', temporalFacts: true });
    const plain = configuredOwnerContext(w.path, { now: w.now, characters: 2_400, timeZone: 'Asia/Tokyo' });
    try {
      const read = (context: typeof opened) => context.context.forThinking?.('owner', w.now(), '猫')?.section ?? '';
      // The closed fact (her row 「ミナさんは猫が好き」) is left out with temporal facts on; without the reader it was not.
      expect(read(opened)).not.toContain('ミナさんは猫が好き');
      expect(read(opened)).toContain('ミナさんは猫が苦手');
      expect(read(plain)).toContain('ミナさんは猫が好き');
    } finally { opened.close(); plain.close(); }
  });
});

