import { afterEach, describe, expect, it } from 'vitest';
import { memoryWorld, MEMORY_AT } from './support/memoryWorld.js';
import { MEMORY_WRITER_V1 } from '../src/mind/memory/memoryWriter.js';

/**
 * Syzygy ADR-0008 stage 3, step F5: the one memory writer survives a crash between its model call and its compare-and-set, and
 * a restart replays from `applied_seq` without a second call or a second write. Also: a lost compare-and-set is tried three
 * times, five model failures fail a row, a refused proposal is kept text-free, the cursor always moves, and the owner's command
 * is synchronous.
 */
const worlds: Array<ReturnType<typeof memoryWorld>> = [];
const world = (options?: Parameters<typeof memoryWorld>[0]) => { const created = memoryWorld(options); worlds.push(created); return created; };
afterEach(() => { for (const created of worlds.splice(0)) created.close(); });

const MINUTE = 60_000;
const fact = (id: string, statement: string, sourceExperienceId?: string) => ({ id, statement, confidence: 0.9, observedAt: MEMORY_AT,
  evidence: statement, ...(sourceExperienceId ? { sourceExperienceId } : {}), disclosure: { audience: { kind: 'owner' as const }, sensitivity: 'ordinary' as const } });

describe('the memory writer after a crash', () => {
  it('replays from applied_seq after a crash between the model call and the compare-and-set: one model call, one write', async () => {
    const w = world();
    const last = w.thread(15);
    expect(await w.summarizer.refreshForTurn('owner', last)).toBe('proposed');
    expect(w.store.replaySummary('owner', 'thread')).toBeUndefined();
    const [row] = w.rows();
    expect(row).toMatchObject({ kind: 'replay_summary.update', status: 'pending', origin: 'replay_summary' });

    const crashing = w.writer({ owner: 'writer-before-crash', beforeLock: () => { throw new Error('CRASH'); } });
    await expect(crashing.runOnce()).rejects.toThrow('CRASH');
    expect(w.calls).toHaveLength(1);
    expect(w.store.replaySummary('owner', 'thread')).toBeUndefined();
    expect(w.outbox.row(row!.seq)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(w.outbox.appliedSeq()).toBe(0);

    // The restarted process: a new lease holder once the old lease ran out. The answer comes from memory_writer_calls.
    w.advance(MEMORY_WRITER_V1.leaseMilliseconds + MINUTE);
    const restarted = w.writer({ owner: 'writer-after-restart' });
    expect(await restarted.runOnce()).toBe('worked');
    expect(w.calls).toHaveLength(1);
    expect(w.store.replaySummary('owner', 'thread')?.summary).toBe('要約1');
    expect(w.outbox.row(row!.seq)).toMatchObject({ status: 'applied', outcomeCode: 'updated' });
    expect(w.outbox.appliedSeq()).toBe(row!.seq);

    // The same proposal again (a retried job): stored once, written once.
    await w.summarizer.refreshForTurn('owner', last);
    expect(w.rows()).toHaveLength(1);
    expect(await restarted.runOnce()).toBe('idle');
    expect(w.calls).toHaveLength(1);
  });

  it('holds the lease: a second writer waits while the first holds it', async () => {
    const w = world();
    w.ports.proposals.propose({ opId: 'f-1', scopeKey: 'owner', kind: 'fact.upsert', origin: 'turn', subjectKey: 'fact:f-1', payload: { fact: fact('user-fact-a', 'ユーザーは犬が好き'), source: 'conversation' } });
    const first = w.writer({ owner: 'one' });
    const second = w.writer({ owner: 'two' });
    expect(await first.runOnce()).toBe('worked');
    w.ports.proposals.propose({ opId: 'f-2', scopeKey: 'owner', kind: 'fact.upsert', origin: 'turn', subjectKey: 'fact:f-2', payload: { fact: fact('user-fact-b', 'ユーザーは猫も好き'), source: 'conversation' } });
    expect(await second.runOnce()).toBe('leased_elsewhere');
    w.advance(MEMORY_WRITER_V1.leaseMilliseconds + 1);
    expect(await second.runOnce()).toBe('worked');
    expect(w.store.snapshot('owner').userFacts.map(item => item.id).sort()).toEqual(['user-fact-a', 'user-fact-b']);
  });
});

describe('the memory writer, row by row', () => {
  it('tries a lost compare-and-set again from a new snapshot, and supersedes the row after three', async () => {
    const w = world();
    let changes = 0;
    const interfering = (times: number) => w.writer({ beforeLock: () => {
      if (changes >= times) return;
      changes += 1;
      w.store.apply('owner', { type: 'user-fact-upserted', fact: fact('user-fact-a', `ユーザーは犬が好き${changes}`), source: 'conversation' });
    } });
    w.ports.proposals.propose({ opId: 'once', scopeKey: 'owner', kind: 'fact.upsert', origin: 'turn', subjectKey: 'fact:user-fact-a',
      payload: { fact: fact('user-fact-a', 'ユーザーは犬が大好き'), source: 'conversation' } });
    await interfering(1).runOnce();
    expect(w.rows()[0]).toMatchObject({ status: 'applied' });
    expect(w.store.snapshot('owner').userFacts.find(item => item.id === 'user-fact-a')?.statement).toBe('ユーザーは犬が大好き');

    changes = 0;
    w.ports.proposals.propose({ opId: 'thrice', scopeKey: 'owner', kind: 'fact.upsert', origin: 'turn', subjectKey: 'fact:user-fact-a',
      payload: { fact: fact('user-fact-a', 'ユーザーは犬が苦手'), source: 'conversation' } });
    await interfering(3).runOnce();
    expect(w.rows()[1]).toMatchObject({ status: 'superseded', outcomeCode: 'cas_lost' });
    expect(w.store.snapshot('owner').userFacts.find(item => item.id === 'user-fact-a')?.statement).toBe('ユーザーは犬が好き3');
    expect(w.outbox.appliedSeq()).toBe(w.rows()[1]!.seq);
  });

  it('counts a model failure, lets other subjects go on, fails the row after five, and always moves the cursor', async () => {
    const w = world({ summary: () => null });
    const last = w.thread(15);
    await w.summarizer.refreshForTurn('owner', last);
    w.ports.proposals.propose({ opId: 'later', scopeKey: 'owner', kind: 'fact.upsert', origin: 'turn', subjectKey: 'fact:user-fact-a',
      payload: { fact: fact('user-fact-a', 'ユーザーは犬が好き'), source: 'conversation' } });
    const writer = w.writer();
    await writer.runOnce();
    const [summary, later] = w.rows();
    expect(summary).toMatchObject({ status: 'pending', attempts: 1, outcomeCode: 'model_empty' });
    expect(later).toMatchObject({ status: 'applied' });
    // The cursor waits before the pending row; the applied row after it is not read again.
    expect(w.outbox.appliedSeq()).toBe(summary!.seq - 1);
    for (let attempt = 2; attempt <= MEMORY_WRITER_V1.modelFailures; attempt += 1) {
      expect(await writer.runOnce()).toBe('idle'); // not due yet
      w.advance(attempt * MEMORY_WRITER_V1.retryMilliseconds);
      await writer.runOnce();
    }
    expect(w.outbox.row(summary!.seq)).toMatchObject({ status: 'failed', attempts: MEMORY_WRITER_V1.modelFailures });
    expect(w.outbox.appliedSeq()).toBe(later!.seq);
    expect(w.calls).toHaveLength(MEMORY_WRITER_V1.modelFailures);
  });

  it('keeps a refused proposal as rejected without its text, and the writer passes over it', async () => {
    const w = world();
    w.ports.proposals.propose({ opId: 'secret', scopeKey: 'owner', kind: 'fact.upsert', origin: 'turn', subjectKey: 'fact:x',
      payload: { fact: fact('user-fact-x', 'ユーザーのパスワード: hunter2-secret'), source: 'conversation' } });
    expect(w.rows()[0]).toMatchObject({ status: 'rejected', outcomeCode: 'secret', payloadJson: '{}' });
    expect(await w.writer().runOnce()).toBe('idle');
    expect(w.outbox.appliedSeq()).toBe(w.rows()[0]!.seq);
    expect(w.store.snapshot('owner').userFacts).toHaveLength(0);
  });

  it('runs the owner command synchronously through the same write, stored as applied', () => {
    const w = world();
    const people = w.store.peopleMemoryOnConnection()!;
    const mina = people.createPerson('owner', { displayName: 'ミナ', howKnown: 'テスト' }, MEMORY_AT);
    expect(w.ports.commands.run({ opId: 'rename-1', scopeKey: 'owner', kind: 'person.link', subjectKey: `person:${mina.id}`,
      payload: { action: 'rename', personId: mina.id, displayName: 'ミナミ' } })).toEqual({ applied: true, code: 'renamed' });
    expect(people.person('owner', mina.id)).toMatchObject({ displayName: 'ミナミ', aliases: ['ミナ'] });
    expect(w.rows()[0]).toMatchObject({ status: 'applied', origin: 'owner', kind: 'person.link' });
  });

  it('measures the waits for the write lock', async () => {
    const w = world();
    w.ports.proposals.propose({ opId: 'f-1', scopeKey: 'owner', kind: 'fact.upsert', origin: 'turn', subjectKey: 'fact:f-1', payload: { fact: fact('user-fact-a', 'ユーザーは犬が好き'), source: 'conversation' } });
    await w.writer().runOnce();
    expect(w.outbox.meter!.summary().writes).toBeGreaterThanOrEqual(4);
  });
});
