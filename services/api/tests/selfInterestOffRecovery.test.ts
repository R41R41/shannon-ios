import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { MEMORY_WRITER_V1 } from '../src/mind/memory/memoryWriter.js';
import { memoryWriterOf } from '../src/wiring/memoryOutboxWiring.js';
import { stage5MemoryStoreOptions } from '../src/wiring/stage5MemoryWiring.js';

const worlds: Array<{ close(): void }> = [];
function world() {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-self-interest-off-'));
  const path = join(directory, 'synthetic.sqlite');
  const clock = { at: Date.parse('2026-10-07T19:00:00.000Z') };
  const now = () => new Date(clock.at).toISOString();
  const connections = new Set<SQLiteShannonStore>();
  let generation = 0;
  const open = (enabled: boolean) => {
    const store = new SQLiteShannonStore({ path, now, moodHistory: null, decisionTraces: false,
      ...stage5MemoryStoreOptions({ SHANNON_ADR8_STAGE3: 'on', SHANNON_ADR8_STAGE5: enabled ? 'on' : 'off' }) });
    connections.add(store);
    return { store, outbox: store.memoryOutbox()!, proposals: store.memoryProposals()!,
      writer: memoryWriterOf(store, { now, owner: `restart-${++generation}`, log: () => {} })!,
      close() { store.close(); connections.delete(store); } };
  };
  const result = { path, now, open, advance(milliseconds: number) { clock.at += milliseconds; },
    close() { for (const store of connections) store.close(); rmSync(directory, { recursive: true, force: true }); } };
  worlds.push(result);
  return result;
}
afterEach(() => { for (const current of worlds.splice(0)) current.close(); });

const propose = (current: ReturnType<ReturnType<typeof world>['open']>, opId: string, evidence: string, subjectKey = opId) =>
  current.proposals.propose({ opId, scopeKey: 'owner', kind: 'self.interest.propose', origin: 'sleep', subjectKey,
    payload: { kind: 'add', title: '天文', reason: '会話をきっかけにした', provenance: 'sleep_self' }, episodeIds: [evidence] });
const night = (current: ReturnType<ReturnType<typeof world>['open']>, opId: string) =>
  current.proposals.propose({ opId, scopeKey: 'owner', kind: 'self.interest.night', origin: 'sleep', subjectKey: 'self-interest-night', payload: {} });
const fact = (current: ReturnType<ReturnType<typeof world>['open']>, at: string, opId: string, subjectKey: string, scopeKey = 'owner') =>
  current.proposals.propose({ opId, scopeKey, kind: 'fact.upsert', origin: 'turn', subjectKey,
    payload: { fact: { id: opId, statement: 'ユーザーは星が好き', confidence: 0.9, observedAt: at }, source: 'conversation' } });

describe('Stage5 OFF contains pending self-interest operations without consuming their original intent', () => {
  it('preserves the complete pending proposal and night across OFF and crash-style reopens, then applies each once', async () => {
    const w = world(); const on = w.open(true);
    const evidence = on.store.appendTurn('owner', 'thread', '天文を調べたい。', '覚えました。', w.now()).id;
    propose(on, 'original-proposal', evidence); night(on, 'original-night');
    // An earlier transient write failure must not become a fifth failure merely because the feature is OFF.
    on.outbox.underLock(w.now(), () => on.outbox.retryLater(1, 4, w.now(), 'apply_error'));
    const original = on.outbox.rows(); const cursor = on.outbox.appliedSeq();
    on.close(); const off = w.open(false);
    expect(off.store.selfInterests()).toBeNull();
    const run = vi.spyOn(off.writer, 'runOnce');
    await off.writer.drain(); expect(run).toHaveBeenCalledTimes(1);
    expect(await off.writer.runOnce()).toBe('idle');
    w.advance(2 * 86_400_000);
    for (let attempt = 0; attempt < MEMORY_WRITER_V1.modelFailures + 2; attempt += 1) expect(await off.writer.runOnce()).toBe('idle');
    expect(off.outbox.rows()).toEqual(original);
    expect(off.outbox.appliedSeq()).toBe(cursor);
    off.close(); w.advance(MEMORY_WRITER_V1.leaseMilliseconds + 1);
    const resumed = w.open(true);
    await resumed.writer.drain();
    expect(resumed.outbox.rows().map(row => [row.opId, row.status, row.outcomeCode])).toEqual([
      ['original-proposal', 'applied', 'proposed'], ['original-night', 'applied', 'night_adopted'],
    ]);
    expect(resumed.outbox.row(1)).toMatchObject({ attempts: 4, payloadJson: original[0]!.payloadJson, episodeIdsJson: original[0]!.episodeIdsJson });
    expect(resumed.store.selfInterests()!.snapshot('owner').items).toMatchObject([{ title: '天文', weight: 0.5, revision: 1 }]);
    expect(resumed.store.selfInterests()!.snapshot('owner').changes).toHaveLength(1);
    expect(resumed.outbox.appliedSeq()).toBe(2);
    const accepted = resumed.outbox.rows(); resumed.close(); w.advance(MEMORY_WRITER_V1.leaseMilliseconds + 1);
    const restarted = w.open(true);
    // The original producer's retry and a writer restart do not add another candidate, night change or quota use.
    propose(restarted, 'original-proposal', evidence); night(restarted, 'original-night');
    expect(await restarted.writer.runOnce()).toBe('idle');
    expect(restarted.outbox.rows()).toEqual(accepted);
    expect(restarted.store.selfInterests()!.snapshot('owner').changes).toHaveLength(1);
    expect(restarted.store.selfInterests()!.store.candidates('owner', false)).toHaveLength(1);
  });

  it('leaves a durable owner operation intact while OFF and retains its CAS/idempotency receipt after ON', async () => {
    const w = world(); const on = w.open(true);
    const evidence = on.store.appendTurn('owner', 'thread', '天文を調べたい。', '覚えました。', w.now()).id;
    propose(on, 'first-proposal', evidence); night(on, 'first-night'); await on.writer.drain();
    const item = on.store.selfInterests()!.snapshot('owner').items[0]!;
    // A closed already-persisted owner operation is not a new grant from the rollback switch.
    on.proposals.propose({ opId: 'original-owner-op', scopeKey: 'owner', kind: 'self.interest.owner', origin: 'owner', subjectKey: item.id,
      payload: { operationId: 'original-owner-request', itemId: item.id, expectedRevision: item.revision, action: 'pin' } });
    const original = on.outbox.rows(); const cursor = on.outbox.appliedSeq();
    on.close(); w.advance(MEMORY_WRITER_V1.leaseMilliseconds + 1);
    const off = w.open(false); await off.writer.drain();
    expect(off.outbox.rows()).toEqual(original); expect(off.outbox.appliedSeq()).toBe(cursor);
    off.close(); w.advance(MEMORY_WRITER_V1.leaseMilliseconds + 1);
    const resumed = w.open(true); await resumed.writer.drain();
    expect(resumed.outbox.rows().at(-1)).toMatchObject({ opId: 'original-owner-op', status: 'applied', outcomeCode: 'changed', attempts: 0 });
    expect(resumed.store.selfInterests()!.store.get('owner', item.id)).toMatchObject({ pinned: true, revision: 2 });
    const receipt = resumed.store.selfInterests()!.store.receipt('owner', 'original-owner-request');
    expect(receipt).toMatchObject({ code: 'changed', item: { id: item.id, pinned: true, revision: 2 } });
    resumed.close(); w.advance(MEMORY_WRITER_V1.leaseMilliseconds + 1);
    const restarted = w.open(true); await restarted.writer.drain();
    expect(restarted.store.selfInterests()!.store.receipt('owner', 'original-owner-request')).toEqual(receipt);
    expect(restarted.store.selfInterests()!.snapshot('owner').changes).toHaveLength(2);
  });

  it('excludes deferred subjects before the batch LIMIT without blocking unrelated subjects or other scopes', async () => {
    const w = world(); const on = w.open(true);
    const evidence = on.store.appendTurn('owner', 'thread', '天文を調べたい。', '覚えました。', w.now()).id;
    for (let i = 0; i < MEMORY_WRITER_V1.batch + 8; i += 1) propose(on, `deferred-${i}`, evidence);
    fact(on, w.now(), 'ordered-fact', 'deferred-0');
    fact(on, w.now(), 'independent-fact', 'fact:independent');
    fact(on, w.now(), 'other-scope-fact', 'deferred-0', 'other');
    const original = on.outbox.rows(); on.close();
    const off = w.open(false);
    expect(await off.writer.runOnce()).toBe('worked');
    expect(await off.writer.runOnce()).toBe('idle');
    expect(off.outbox.rows().slice(0, MEMORY_WRITER_V1.batch + 9)).toEqual(original.slice(0, MEMORY_WRITER_V1.batch + 9));
    expect(off.outbox.rows().slice(-2)).toMatchObject([{ opId: 'independent-fact', status: 'applied' }, { opId: 'other-scope-fact', status: 'applied' }]);
    expect(off.store.snapshot('owner').userFacts.map(row => row.id)).toEqual(['independent-fact']);
    expect(off.store.snapshot('other').userFacts.map(row => row.id)).toEqual(['other-scope-fact']);
    expect(off.outbox.appliedSeq()).toBe(0);
    off.close(); w.advance(MEMORY_WRITER_V1.leaseMilliseconds + 1);
    const resumed = w.open(true); await resumed.writer.drain();
    expect(resumed.outbox.rows().every(row => row.status === 'applied')).toBe(true);
    expect(resumed.store.snapshot('owner').userFacts.map(row => row.id).sort()).toEqual(['independent-fact', 'ordered-fact']);
    expect(resumed.outbox.appliedSeq()).toBe(original.at(-1)!.seq);
  });

  it('creates no self schema while OFF and preserves ordinary unavailable-target and unknown-kind refusals', async () => {
    const w = world(); const off = w.open(false);
    const evidence = off.store.appendTurn('owner', 'thread', '天文を調べたい。', '覚えました。', w.now()).id;
    propose(off, 'future-on-proposal', evidence);
    off.proposals.propose({ opId: 'no-replay-port', scopeKey: 'owner', kind: 'replay_summary.update', origin: 'replay_summary', subjectKey: 'replay:thread',
      payload: { threadId: 'thread', experienceId: evidence } });
    off.outbox.underLock(w.now(), () => off.outbox.insert({ opId: 'unknown-kind', scopeKey: 'owner', kind: 'future.unknown', origin: 'turn',
      subjectKey: 'future:unknown', baseRevision: null, payloadJson: '{}', episodeIdsJson: '[]', disclosureJson: null }, w.now()));
    await off.writer.drain();
    expect(off.store.selfInterests()).toBeNull();
    expect(off.outbox.rows()).toMatchObject([
      { opId: 'future-on-proposal', status: 'pending', attempts: 0 },
      { opId: 'no-replay-port', status: 'rejected', outcomeCode: 'disabled' },
      { opId: 'unknown-kind', status: 'rejected', outcomeCode: 'unknown_kind' },
    ]);
    const database = new DatabaseSync(w.path, { readOnly: true });
    try { expect(database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'self_interest_%'").all()).toEqual([]); }
    finally { database.close(); }
    expect(off.outbox.appliedSeq()).toBe(0);
  });

  it('keeps canonical forgetting effective while OFF rather than resurrecting the held source on ON', async () => {
    const w = world(); const on = w.open(true);
    const evidence = on.store.appendTurn('owner', 'thread', '天文を調べたい。', '覚えました。', w.now()).id;
    propose(on, 'forgotten-proposal', evidence); night(on, 'after-forget-night'); on.close();
    const off = w.open(false); await off.writer.drain();
    off.store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: evidence, kind: 'experience',
      status: 'forgotten', pinned: false, updatedAt: w.now(), changeReason: 'owner' } });
    expect(off.outbox.row(1)).toMatchObject({ status: 'superseded', outcomeCode: 'forgotten', payloadJson: '{}', episodeIdsJson: '[]' });
    off.close(); w.advance(MEMORY_WRITER_V1.leaseMilliseconds + 1);
    const resumed = w.open(true); await resumed.writer.drain();
    expect(resumed.outbox.row(1)).toMatchObject({ status: 'superseded', outcomeCode: 'forgotten', payloadJson: '{}' });
    expect(resumed.outbox.row(2)).toMatchObject({ status: 'applied', outcomeCode: 'night_adopted' });
    expect(resumed.store.selfInterests()!.snapshot('owner').items).toEqual([]);
    expect(resumed.store.selfInterests()!.store.candidates('owner', false)).toEqual([]);
  });
});
