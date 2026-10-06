import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { CompanionStateSnapshot } from '@shannon/cognition';
import { recomputeLedger, sameDerived } from '@shannon/learning';
import type { ReachOutFacts } from '../src/mind/action/ownTime/store/autonomyLoopObservations.js';
import { TouchPredictions } from '../src/mind/prediction/bodyTouchPrediction.js';
import { PredictionLedger, calibrationLine, predictionLedgerEnabled } from '../src/mind/learning/predictionLedger.js';
import { configuredPredictionLedger } from '../src/wiring/cognitionLedgerWiring.js';
import { ledgerPredictionTap, storyReacted, touchLedger } from '../src/wiring/cognitionLedgerTaps.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { loopHarness, scope } from './autonomyLoopHarness.js';

/**
 * The prediction ledger (Syzygy ADR-0008 stage 1, `docs/cognition-ledger-contract.md`): predictions opened with an id before
 * their outcome and settled against it, the open/match/void/expire wiring, recomputing after forgetting, closed symbols only.
 */
const directory = mkdtempSync(join(tmpdir(), 'shannon-prediction-ledger-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const DAY = 24 * 60 * 60_000;
const START = Date.parse('2026-10-07T03:00:00.000Z');
const at = (minutes: number) => new Date(START + minutes * 60_000).toISOString();
let files = 0;

function ledgerHarness(options: { createsSchema?: boolean; path?: string } = {}) {
  const path = options.path ?? join(directory, `ledger-${files += 1}.sqlite`);
  const database = new DatabaseSync(path);
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  const queue: Array<() => void> = [];
  const lines: string[] = [];
  const ledger = new PredictionLedger({ database, createsSchema: options.createsSchema ?? true, defer: task => { queue.push(task); }, log: line => lines.push(line) });
  const flush = () => { while (queue.length) queue.shift()!(); };
  return { path, database, ledger, flush, queue, lines };
}

function facts(overrides: Partial<ReachOutFacts> = {}): ReachOutFacts {
  return { id: 'message-1', reason: 'wonder', sentAt: at(0), waitedSeconds: 90, replied: true, repliedAfterSeconds: 40, delivery: 'shown', windowVisible: true, owner: 'unknown', others: false, ...overrides };
}

describe('opening and settling a prediction', () => {
  it('opens after the caller with what the ledger expected then, and settles once', () => {
    const { ledger, flush, queue } = ledgerHarness();
    const id = ledger.open('owner', { domain: 'reply', key: 'wonder.afternoon', context: 'alone', sourceKind: 'reach_out', sourceId: 'message-1' }, at(0));
    expect(queue).toHaveLength(1);
    expect(ledger.rows('owner')).toEqual([]);
    flush();
    const [opened] = ledger.rows('owner');
    expect(opened).toMatchObject({ predictionId: id, domain: 'reply', status: 'open', expectation: 0.5, prior: 0.5, basisSeq: 0, outcome: null, expiresAt: new Date(START + DAY).toISOString() });
    expect(opened!.intervalLow).toBeLessThan(0.5);
    ledger.settle('owner', id, 1, at(3));
    ledger.settle('owner', id, 0, at(4));
    flush();
    expect(ledger.rows('owner')[0]).toMatchObject({ status: 'matched', outcome: 1, outcomeSeq: 1, settledAt: at(3) });
  });

  it('learns from what was settled: the next prediction of the key leans toward its outcomes', () => {
    const { ledger, flush } = ledgerHarness();
    for (let index = 0; index < 6; index += 1) {
      const id = ledger.open('owner', { domain: 'reading_used', key: 'public', context: '', sourceKind: 'reading', sourceId: `reading-${index}` }, at(index * 10));
      ledger.settle('owner', id, 1, at(index * 10 + 5));
    }
    ledger.open('owner', { domain: 'reading_used', key: 'public', context: '', sourceKind: 'reading', sourceId: 'reading-last' }, at(100));
    flush();
    const last = ledger.rows('owner').at(-1)!;
    expect(last.basisSeq).toBe(6);
    expect(last.expectation).toBeGreaterThan(0.8);
    expect(last.expectation).toBeGreaterThan(last.prior - 1e-9);
    // Every stored value is what a fold of the rows gives.
    expect(ledger.recompute('owner')).toEqual({ rows: 7, changed: 0 });
  });

  it('is restart-safe: a new connection folds the table cold and expects the same', () => {
    const first = ledgerHarness();
    for (let index = 0; index < 4; index += 1) {
      const id = first.ledger.open('owner', { domain: 'call_answer', key: 'share.evening', context: 'alone', sourceKind: 'call', sourceId: `call-${index}` }, at(index));
      first.ledger.settle('owner', id, index % 2, at(index + 1));
    }
    first.flush();
    const second = ledgerHarness({ path: first.path });
    first.ledger.open('owner', { domain: 'call_answer', key: 'share.evening', context: 'alone', sourceKind: 'call', sourceId: 'call-a' }, at(10));
    second.ledger.open('owner', { domain: 'call_answer', key: 'share.evening', context: 'alone', sourceKind: 'call', sourceId: 'call-b' }, at(10));
    first.flush();
    second.flush();
    const [a, b] = first.ledger.rows('owner').slice(-2);
    expect(sameDerived(a!, b!)).toBe(true);
    second.database.close();
  });

  it('writes nothing from a process that does not create the table until the API has, and creates nothing with the switch off', () => {
    const loop = ledgerHarness({ createsSchema: false });
    loop.ledger.open('owner', { domain: 'reply', key: 'wonder.night', context: 'alone', sourceKind: 'reach_out', sourceId: 'm' }, at(0));
    loop.flush();
    expect(loop.database.prepare("SELECT name FROM sqlite_master WHERE name = 'shannon_predictions'").get()).toBeUndefined();
    expect(predictionLedgerEnabled({})).toBe(true);
    expect(predictionLedgerEnabled({ SHANNON_PREDICTION_LEDGER: 'off' })).toBe(false);
    expect(predictionLedgerEnabled({ SHANNON_PREDICTION_SHADOW: 'off' })).toBe(false);
    expect(predictionLedgerEnabled({ SHANNON_ADR8_STAGE1: 'none' })).toBe(false);
    expect(configuredPredictionLedger({ SHANNON_PREDICTION_LEDGER: 'off' }, loop.path)).toBeNull();
    const path = join(directory, 'off.sqlite');
    const store = new SQLiteShannonStore({ path, now: () => at(0), predictionLedger: false });
    expect(store.predictionLedger()).toBeNull();
    store.close();
    const database = new DatabaseSync(path);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name IN ('shannon_predictions', 'shannon_prediction_ledger_seq')").all()).toEqual([]);
    database.close();
  });

  it('refuses words: a key, a context or an id that is not a closed value is never written', () => {
    const { ledger, flush } = ledgerHarness();
    const failed = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ledger.open('owner', { domain: 'reply', key: 'ねえ聞いて', context: 'alone', sourceKind: 'reach_out', sourceId: 'm1' }, at(0));
    ledger.open('owner', { domain: 'reply', key: 'wonder.night', context: 'two words', sourceKind: 'reach_out', sourceId: 'm2' }, at(0));
    ledger.open('owner', { domain: 'reply', key: 'wonder.night', context: '', sourceKind: 'reach_out', sourceId: 'not an id' }, at(0));
    flush();
    expect(ledger.rows('owner')).toEqual([]);
    expect(failed).toHaveBeenCalledTimes(3);
    failed.mockRestore();
  });
});

describe('where predictions are opened and settled', () => {
  it('settles a message by what followed: answered, not answered, or void when he could not have seen it', () => {
    const { ledger, flush } = ledgerHarness();
    const shadow = { reachOut: vi.fn() };
    const tap = ledgerPredictionTap(ledger, shadow);
    const cases: Array<[string, Partial<ReachOutFacts>, string, number | null]> = [
      ['m-replied', { replied: true }, 'matched', 1], ['m-silent', { replied: false }, 'matched', 0],
      ['m-away', { delivery: 'away', replied: false }, 'void', null], ['m-hidden', { delivery: 'hidden' }, 'void', null],
      ['m-unwatched', { unwatched: true, replied: false }, 'void', null],
    ];
    for (const [id, overrides] of cases) {
      tap.sent('owner', { id, reason: 'wonder', others: id === 'm-silent' }, at(0));
      tap.reachOut('owner', facts({ id, ...overrides }), at(3));
    }
    flush();
    expect(shadow.reachOut).toHaveBeenCalledTimes(cases.length);
    const rows = ledger.rows('owner');
    for (const [id, , status, outcome] of cases) expect(rows.find(row => row.sourceId === id), id).toMatchObject({ domain: 'reply', status, outcome });
    expect(rows.find(row => row.sourceId === 'm-silent')).toMatchObject({ key: 'wonder.afternoon', context: 'others' });
  });

  it('settles a call by what became of it, a story by the owner\'s reaction, and a reading by her note', () => {
    const { ledger, flush } = ledgerHarness();
    const tap = ledgerPredictionTap(ledger, { reachOut: () => undefined });
    for (const [id, call] of [['c-answered', 'answered'], ['c-declined', 'declined'], ['c-failed', 'failed']] as const) {
      tap.called('owner', { id, reason: 'share', others: false }, at(0));
      tap.reachOut('owner', facts({ id, call, replied: call === 'answered' }), at(1));
    }
    tap.called('owner', { id: 'c-unwatched', reason: 'share', others: false }, at(0));
    tap.reachOut('owner', facts({ id: 'c-unwatched', unwatched: true }), at(1));
    tap.shown('owner', { id: 'piece-1', revised: false }, at(0));
    tap.shown('owner', { id: 'piece-2', revised: true }, at(0));
    storyReacted(ledger, 'owner', 'piece-1', 'more', at(60));
    tap.read('owner', { id: 'reading-1', source: 'notion' }, at(0));
    tap.read('owner', { id: 'reading-2', source: 'public' }, at(0));
    tap.noted('owner', 'reading-1', at(5));
    flush();
    const row = (sourceId: string, domain: string) => ledger.rows('owner').find(item => item.sourceId === sourceId && item.domain === domain);
    expect(row('c-answered', 'call_answer')).toMatchObject({ status: 'matched', outcome: 1 });
    expect(row('c-declined', 'call_answer')).toMatchObject({ status: 'matched', outcome: 0 });
    expect(row('c-failed', 'call_answer')).toMatchObject({ status: 'void', outcome: null });
    expect(row('c-unwatched', 'call_answer')).toMatchObject({ status: 'void' });
    // A call opens no message prediction: nothing about `reply` was written for it.
    expect(row('c-answered', 'reply')).toBeUndefined();
    expect(row('piece-1', 'story_reacted')).toMatchObject({ status: 'matched', outcome: 1, key: 'first' });
    expect(row('piece-1', 'story_reaction')).toMatchObject({ status: 'matched', outcome: 0.5 });
    expect(row('piece-2', 'story_reacted')).toMatchObject({ status: 'open', key: 'revised', expiresAt: new Date(START + 14 * DAY).toISOString() });
    expect(row('reading-1', 'reading_used')).toMatchObject({ status: 'matched', outcome: 1, key: 'notion' });
    expect(row('reading-2', 'reading_used')).toMatchObject({ status: 'open', key: 'public' });
  });

  it('predicts a touch\'s stance when it arrives, matches it with her stance, and voids a carried one', () => {
    const { ledger, flush } = ledgerHarness();
    const record = { predict: () => null, recent: () => null, learnLater: () => undefined, stanceCompared: () => undefined };
    const predictions = new TouchPredictions(record, touchLedger(ledger));
    const touch = { id: 't1', type: 'pet', gesture: 'stroke', part: 'head', audience: 'owner', surface: 'windows', occurredAt: at(0) } as never;
    const given = predictions.expect('owner', touch, at(0), 'burst-1');
    const carried = predictions.expect('owner', touch, at(1), 'burst-2');
    const unanswered = predictions.expect('owner', touch, at(2), 'burst-3');
    expect(predictions.expect('owner', touch, at(3)).ledgerId).toBeUndefined();
    predictions.learn('owner', given, 'burst-1', 1, at(0), {} as CompanionStateSnapshot, () => true);
    predictions.voided('owner', carried, at(1));
    flush();
    const row = (id: string) => ledger.rows('owner').find(item => item.predictionId === id)!;
    expect(row(given.ledgerId!)).toMatchObject({ domain: 'body_stance', key: 'stroke.head.owner', context: 'windows', sourceKind: 'touch', sourceId: 'burst-1', status: 'matched', outcome: 1 });
    expect(row(carried.ledgerId!)).toMatchObject({ status: 'void' });
    expect(row(unanswered.ledgerId!)).toMatchObject({ status: 'open' });
  });
});

describe('privacy', () => {
  it('hands the ledger the reaction\'s enum only, never the owner\'s comment, and stores closed values only', () => {
    const reacted: unknown[][] = [];
    const harness = loopHarness({ storyReacted: (...args) => { reacted.push(args); } });
    const piece = harness.store.study.create(scope, { kind: 'story', title: '傘のある駅', body: '本文'.repeat(60), changeNote: '最初の稿です。' }, at(0));
    if (typeof piece === 'string') throw new Error(piece);
    // A reaction that is refused (the story is not readable yet) tells nothing.
    harness.service.study.react(scope, piece.id, 'more', 'まだ読めない');
    expect(reacted).toEqual([]);
    harness.store.study.markReady(scope, piece.id, at(1));
    harness.service.study.react(scope, piece.id, 'unclear', 'ここは秘密のコメントです');
    expect(reacted).toEqual([[scope, piece.id, 'unclear', expect.any(String)]]);
    expect(JSON.stringify(reacted)).not.toContain('秘密');
    harness.store.close();
    const { ledger, flush, database } = ledgerHarness();
    const tap = ledgerPredictionTap(ledger, { reachOut: () => undefined });
    tap.sent('owner', { id: 'message-9', reason: 'share', others: true }, at(0));
    tap.reachOut('owner', facts({ id: 'message-9' }), at(1));
    tap.shown('owner', { id: piece.id, revised: false }, at(0));
    storyReacted(ledger, 'owner', piece.id, 'like', at(2));
    flush();
    const closed = /^(?:[A-Za-z][A-Za-z0-9_.:-]{0,95}|[A-Za-z0-9][A-Za-z0-9_:-]{0,119}|\d{4}-\d{2}-\d{2}T[\d:.]+Z|)$/u;
    const rows = database.prepare('SELECT * FROM shannon_predictions').all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(3);
    for (const row of rows) for (const [column, value] of Object.entries(row)) {
      if (typeof value === 'string') expect(value, column).toMatch(closed);
      else expect(value === null || typeof value === 'number', column).toBe(true);
    }
  });
});

describe('the daily maintenance', () => {
  it('expires what ran out (a story without a reaction counts as none, a reading unused), prunes after 90 days, and logs the calibration', () => {
    const { ledger, flush, lines } = ledgerHarness();
    const tap = ledgerPredictionTap(ledger, { reachOut: () => undefined });
    tap.shown('owner', { id: 'piece-1', revised: false }, at(0));
    tap.read('owner', { id: 'reading-1', source: 'public' }, at(0));
    tap.sent('owner', { id: 'm-lost', reason: 'share', others: false }, at(0));
    flush();
    expect(ledger.maintain('owner', new Date(START + 2 * DAY).toISOString())).toEqual({ expired: 1, pruned: 0 });
    expect(ledger.maintain('owner', new Date(START + 15 * DAY).toISOString())).toEqual({ expired: 3, pruned: 0 });
    const row = (sourceId: string, domain: string) => ledger.rows('owner').find(item => item.sourceId === sourceId && item.domain === domain);
    expect(row('m-lost', 'reply')).toMatchObject({ status: 'expired', outcome: null, outcomeSeq: null });
    // The reading ran out first (7 days), the story after 14: they took their places in that order.
    expect(row('piece-1', 'story_reacted')).toMatchObject({ status: 'expired', outcome: 0, outcomeSeq: 2 });
    expect(row('piece-1', 'story_reaction')).toMatchObject({ status: 'expired', outcome: null });
    expect(row('reading-1', 'reading_used')).toMatchObject({ status: 'expired', outcome: 0, outcomeSeq: 1 });
    expect(lines.at(-1)).toMatch(/^Shannon prediction ledger: day=\d{4}-\d{2}-\d{2} open=0 matched=0 expired=4 void=0 reading_used:n=1,brier=0\.250,kappa=0\.000 story_reacted:n=1,brier=0\.250,kappa=0\.000$/u);
    expect(ledger.maintain('owner', new Date(START + 91 * DAY).toISOString())).toEqual({ expired: 0, pruned: 4 });
    expect(ledger.rows('owner')).toEqual([]);
    expect(calibrationLine('2026-10-07', { open: 1 }, { domains: [], overall: { n: 0, brier: null, skill: null } })).toBe('Shannon prediction ledger: day=2026-10-07 open=1');
  });

  it('forgets the rows of a touch the owner had her forget, and recomputes the rest to what a fold of what remains gives', () => {
    const path = join(directory, 'forget.sqlite');
    const store = new SQLiteShannonStore({ path, now: () => at(0), predictionLedger: true, cognitionDefer: task => task(), predictionShadowDefer: task => task() });
    const ledger = store.predictionLedger()!;
    const port = touchLedger(ledger);
    for (let index = 0; index < 8; index += 1) {
      const id = port.open('owner', { key: 'poke.cheek.owner', context: 'windows', burstId: `burst-${index}` }, at(index * 10))!;
      port.settle('owner', id, index === 2 ? -1 : 0.5, at(index * 10 + 1));
    }
    const before = ledger.rows('owner');
    store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: 'burst-2', kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at(100), changeReason: 'user' } } as never);
    const after = ledger.rows('owner');
    expect(after.map(row => row.sourceId)).toEqual(before.map(row => row.sourceId).filter(id => id !== 'burst-2'));
    const { derived } = recomputeLedger(after);
    for (const row of after) expect(sameDerived(row, derived.get(row.predictionId)!), row.sourceId).toBe(true);
    // The ones opened after the forgotten outcome were folded from it, so they changed.
    expect(after.filter(row => !sameDerived(row, before.find(item => item.predictionId === row.predictionId)!)).length).toBeGreaterThan(0);
    store.close();
  });
});
