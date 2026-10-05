import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { predictOutcome, resolveShannonEmotionState } from '@shannon/cognition';
import { configuredAwakeClock } from '../src/autonomyAwakeClock.js';
import { PredictionShadow } from '../src/predictionShadow.js';
import { foldOutcomes } from '../src/predictionShadowFold.js';
import { SQLitePredictionStore, ensurePredictionSchema, type PredictionOutcomeDraft } from '../src/predictionStore.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';

/**
 * The prediction shadow's housekeeping (Syzygy ADR-0006 stage 1): it never folds while it holds the write lock, it
 * keeps reply feelings no longer than the mood history, it reconciles forgetting once a day, and it hears the awake
 * clock of the activity loop's process.
 */
const scope = 'owner';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-prediction-maintenance-'));
  directories.push(directory);
  return join(directory, 'shannon.sqlite');
}

const derived = { expectation: null, uncertainty: null, error: null, learningRate: null, cause: null };
const touchRow = (index: number): PredictionOutcomeDraft => ({
  domain: 'touch', key: `pet.head.${index % 2 ? 'owner' : 'others'}`, outcome: ((index * 7) % 10) / 10 - 0.4, context: 'windows', features: {},
  sourceKind: 'touch', sourceId: `burst-${Math.floor(index / 10)}`, observedAt: new Date(Date.parse('2026-10-05T00:00:00.000Z') + index * 30_000).toISOString(),
});

/** Records, for every read of all rows (the start of a fold from scratch), whether a write transaction was open. */
function watchFullReads(): Array<{ inTransaction: boolean }> {
  const reads: Array<{ inTransaction: boolean }> = [];
  const original = SQLitePredictionStore.prototype.rows;
  vi.spyOn(SQLitePredictionStore.prototype, 'rows').mockImplementation(function (this: SQLitePredictionStore, scopeKey: string, afterSeq = 0) {
    if (afterSeq === 0) reads.push({ inTransaction: (this as unknown as { database: DatabaseSync }).database.isTransaction });
    return original.call(this, scopeKey, afterSeq);
  });
  return reads;
}

describe('the write lock', () => {
  it('is never held while a cold table is folded: the fold runs first, the lock only for the rows that arrived and the insert', () => {
    const path = databasePath();
    const database = new DatabaseSync(path);
    ensurePredictionSchema(database);
    const store = new SQLitePredictionStore(database, { createSchema: false });
    for (let index = 0; index < 2_000; index += 1) store.insert(scope, touchRow(index), derived);
    const reads = watchFullReads();
    const shadow = new PredictionShadow({ database, createsSchema: true, log: () => {} });
    const state = new SQLiteShannonStore({ path, now: () => '2026-10-05T23:00:00.000Z', moodHistory: null, predictionShadow: false }).snapshot(scope);
    shadow.stateWritten(scope, state, '2026-10-05T23:00:00.000Z', { type: 'expressive-emotion-updated', emotion: resolveShannonEmotionState({ provisionalPrimary: 'happy', provisionalIntensity: 0.6, transcript: '', now: '2026-10-05T23:00:00.000Z', target: 'ライ氏' }) });
    shadow.forget(scope, ['burst-3']);
    shadow.recompute(scope);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(read => !read.inTransaction)).toBe(true);
    expect(store.shape(scope).count).toBe(2_000 - 10 + 1);
    database.close();
  });

  it('lets go and folds again outside when another process deleted rows between its fold and its lock', () => {
    const path = databasePath();
    const first = new DatabaseSync(path);
    const second = new DatabaseSync(path);
    ensurePredictionSchema(first);
    const store = new SQLitePredictionStore(first, { createSchema: false });
    for (let index = 0; index < 200; index += 1) store.insert(scope, touchRow(index), derived);
    const ours = new PredictionShadow({ database: first, createsSchema: false, log: () => {} });
    const theirs = new PredictionShadow({ database: second, createsSchema: false, log: () => {} });
    ours.mind(scope);
    theirs.mind(scope);
    const reads = watchFullReads();
    // Just before our lock, the other process forgets a burst.
    const exec = first.exec.bind(first);
    let interfered = false;
    vi.spyOn(first, 'exec').mockImplementation((sql: string) => {
      if (sql === 'BEGIN IMMEDIATE' && !interfered) { interfered = true; theirs.forget(scope, ['burst-0']); }
      exec(sql);
    });
    ours.awake(scope, '2026-10-06T00:00:00.000Z');
    expect(interfered).toBe(true);
    // Ours folded again from scratch, outside the lock (theirs too, for its recompute).
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads.every(read => !read.inTransaction)).toBe(true);
    const rows = store.rows(scope);
    expect(rows).toHaveLength(200 - 10 + 1);
    expect(rows.at(-1)!.domain).toBe('awake');
    // What we hold is what a fold of the table gives.
    expect(JSON.stringify(ours.mind(scope).dynamics)).toBe(JSON.stringify(foldOutcomes(rows).mind.dynamics));
    first.close();
    second.close();
  });
  it('folds the table under the lock on its third try when deletions keep arriving during a recompute, never using a stale fold', () => {
    const path = databasePath();
    const first = new DatabaseSync(path);
    const second = new DatabaseSync(path);
    ensurePredictionSchema(first);
    const store = new SQLitePredictionStore(first, { createSchema: false });
    for (let index = 0; index < 200; index += 1) store.insert(scope, touchRow(index), derived);
    const ours = new PredictionShadow({ database: first, createsSchema: false, log: () => {} });
    const theirs = new PredictionShadow({ database: second, createsSchema: false, log: () => {} });
    ours.mind(scope);
    theirs.mind(scope);
    // Our forget takes the lock once to delete, then the recompute takes it again per try: before each of those three
    // tries, the other process forgets another burst.
    const exec = first.exec.bind(first);
    let begins = 0;
    vi.spyOn(first, 'exec').mockImplementation((sql: string) => {
      if (sql === 'BEGIN IMMEDIATE') {
        begins += 1;
        if (begins >= 2 && begins <= 4) theirs.forget(scope, [`burst-${begins}`]);
      }
      exec(sql);
    });
    expect(ours.forget(scope, ['burst-0'])).toBe(10);
    expect(begins).toBe(4);
    vi.restoreAllMocks();
    const rows = store.rows(scope);
    expect(rows).toHaveLength(200 - 4 * 10);
    const fresh = foldOutcomes(rows);
    // The cached mind is a fold of the table as it ended, and so is every stored derived value.
    expect(JSON.stringify(ours.mind(scope).dynamics)).toBe(JSON.stringify(fresh.mind.dynamics));
    expect(predictOutcome(ours.mind(scope).model, { domain: 'touch', key: 'pet.head.owner', at: Date.parse('2026-10-06T00:00:00.000Z') }))
      .toEqual(predictOutcome(fresh.mind.model, { domain: 'touch', key: 'pet.head.owner', at: Date.parse('2026-10-06T00:00:00.000Z') }));
    rows.forEach((row, index) => expect(row.expectation, `${row.seq}`).toBeCloseTo(fresh.folded[index]!.expectation!, 5));
    first.close();
    second.close();
  });
});

describe('retention and forgetting', () => {
  it('keeps reply feelings as long as the mood history, and reconciles forgetting once a day also for what it missed', () => {
    const path = databasePath();
    const clock = { at: '2026-10-05T00:00:00.000Z' };
    const on = new SQLiteShannonStore({ path, now: () => clock.at, moodHistory: null, predictionShadow: true, predictionShadowDefer: task => task() });
    const shadow = on.predictionShadow()!;
    (shadow as unknown as { log: (line: string) => void }).log = () => {};
    on.apply(scope, { type: 'expressive-emotion-updated', emotion: resolveShannonEmotionState({ provisionalPrimary: 'happy', provisionalIntensity: 0.6, transcript: '', now: clock.at, target: 'ライ氏' }) });
    shadow.touch(scope, { burstId: 'burst-x', kind: 'pet', region: 'head', audience: 'owner', count: 1 }, on.snapshot(scope), clock.at);
    const database = new DatabaseSync(path);
    const count = (where: string) => (database.prepare(`SELECT COUNT(*) AS n FROM shannon_prediction_outcomes WHERE ${where}`).get() as { n: number }).n;
    expect(count(`domain = 'reply_feeling'`)).toBe(1);
    expect(count(`source_id = 'burst-x'`)).toBe(1);
    // The owner has her forget the touch while this process's shadow does not hear it (a lost task, or the switch off elsewhere).
    const off = new SQLiteShannonStore({ path, now: () => clock.at, moodHistory: null, predictionShadow: false });
    clock.at = '2026-10-05T00:05:00.000Z';
    off.apply(scope, { type: 'memory-control-upserted', control: { memoryId: 'burst-x', kind: 'experience', status: 'forgotten', pinned: false, updatedAt: clock.at, changeReason: 'user' } });
    expect(count(`source_id = 'burst-x'`)).toBe(1);
    // The next owner day, the first write reconciles it.
    clock.at = new Date(Date.parse('2026-10-05T00:00:00.000Z') + DAY).toISOString();
    on.apply(scope, { type: 'awake-observed' });
    expect(count(`source_id = 'burst-x'`)).toBe(0);
    expect(count(`domain = 'reply_feeling'`)).toBe(1);
    // After the mood history's 14 days the reply feeling goes too.
    clock.at = new Date(Date.parse('2026-10-05T00:00:00.000Z') + 15 * DAY).toISOString();
    on.apply(scope, { type: 'awake-observed' });
    expect(count(`domain = 'reply_feeling'`)).toBe(0);
    database.close();
    on.close();
    off.close();
  });
});

describe('the awake clock of her own activity', () => {
  it('tells the shadow the instant it advanced, and the shadow keeps one awake instant a minute', () => {
    const path = databasePath();
    const clock = { at: '2026-10-05T00:00:00.000Z' };
    const api = new SQLiteShannonStore({ path, now: () => clock.at, moodHistory: null, predictionShadow: true, predictionShadowDefer: task => task() });
    api.apply(scope, { type: 'awake-observed' });
    const seen: string[] = [];
    const awakeClock = configuredAwakeClock(path, { now: () => clock.at, awake: (scopeKey, at) => { seen.push(`${scopeKey}@${at}`); } });
    clock.at = '2026-10-05T00:03:00.000Z';
    awakeClock.observe(scope);
    expect(seen).toEqual(['owner@2026-10-05T00:03:00.000Z']);
    // Within its minute the clock writes nothing, and tells nothing.
    clock.at = '2026-10-05T00:03:30.000Z';
    awakeClock.observe(scope);
    expect(seen).toHaveLength(1);
    awakeClock.close();
    const database = new DatabaseSync(path);
    const shadow = new PredictionShadow({ database, createsSchema: false, log: () => {} });
    const awakeRows = () => new SQLitePredictionStore(database, { createSchema: false }).rows(scope).filter(row => row.domain === 'awake').length;
    const before = awakeRows();
    shadow.awake(scope, '2026-10-05T00:03:00.000Z');
    shadow.awake(scope, '2026-10-05T00:03:30.000Z');
    expect(awakeRows()).toBe(before + 1);
    database.close();
    api.close();
  });
});
