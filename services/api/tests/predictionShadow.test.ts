import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHANNON_AFFECT_STEP, predictOutcome, resolveShannonEmotionState, type CompanionStateEvent, type ShannonEmotionKind, type ShannonTouchKind } from '@shannon/cognition';
import type { ReachOutFacts } from '../src/autonomyLoopObservations.js';
import { observeStep } from '../src/autonomyLoopObserve.js';
import type { StepDependencies } from '../src/autonomyLoopSteps.js';
import { SHANNON_CORE_PATHS } from '../src/autonomyCore.js';
import { SQLiteBodyReactionStore } from '../src/bodyReactionStore.js';
import { BodyTouches } from '../src/bodyTouch.js';
import { PredictionShadow, decidedFeelingOutcome, predictionShadowEnabled } from '../src/predictionShadow.js';
import { foldOutcomes, readMind } from '../src/predictionShadowFold.js';
import { PREDICTION_SOURCE_ID, PREDICTION_SYMBOL, SQLitePredictionStore, ensurePredictionSchema } from '../src/predictionStore.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';

/**
 * Stage 1 of Syzygy ADR-0006 (影): the taps change nothing, the record holds no words, forgetting recomputes, and the
 * one-day trajectories of the current and the new dynamics are compared (reported in the test output).
 */
const scope = 'owner';
const MINUTE = 60_000;
const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function world(options: { shadow: boolean; start?: string }) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-prediction-shadow-'));
  directories.push(directory);
  const clock = { at: options.start ?? '2026-10-05T23:00:00.000Z' };
  const now = () => clock.at;
  const lines: string[] = [];
  const path = join(directory, 'shannon.sqlite');
  // At once, so that a test reads what a tap wrote; the default defers to the next turn of the event loop (see below).
  const store = new SQLiteShannonStore({ path, now, predictionShadow: options.shadow, predictionShadowDefer: task => task(), moodHistory: null });
  const shadow = store.predictionShadow();
  // Every line the shadow writes, also from the store's own tap.
  if (shadow) (shadow as unknown as { log: (line: string) => void }).log = line => { lines.push(line); };
  const touches = new BodyTouches({ store: new SQLiteBodyReactionStore(join(directory, 'body.sqlite')), stateStore: store, experiences: null, enabled: true, now, prediction: shadow });
  let touchId = 0;
  const advance = (milliseconds: number) => { clock.at = new Date(Date.parse(clock.at) + milliseconds).toISOString(); };
  const touch = (kind: ShannonTouchKind, region?: 'head' | 'face' | 'side' | 'hand' | 'body') =>
    touches.observe(scope, { id: `touch-${touchId += 1}`, type: kind, audience: 'owner', occurredAt: clock.at, ...(region ? { region } : {}), surface: 'windows' });
  const feel = (primary: ShannonEmotionKind, intensity: number) => store.apply(scope, {
    type: 'expressive-emotion-updated',
    emotion: resolveShannonEmotionState({ provisionalPrimary: primary, provisionalIntensity: intensity, transcript: '', reply: 'ボクはそう思います。', now: clock.at, target: 'ライ氏' }),
  });
  const apply = (event: CompanionStateEvent) => store.apply(scope, event);
  return { store, shadow, touches, touch, feel, apply, advance, clock, lines, path };
}

/** One day: waking, talk with feelings, a sitting of touches, a hurt, her own activity, and the evening. */
function day(w: ReturnType<typeof world>): unknown[] {
  const states: unknown[] = [];
  const keep = (value: unknown) => { states.push(JSON.parse(JSON.stringify(value))); };
  keep(w.apply({ type: 'awake-observed' }));
  for (const [kind, strength] of [['happy', 0.6], ['curiosity', 0.25], ['happy', 0.6], ['pride', 0.9]] as const) {
    w.advance(4 * MINUTE); keep(w.feel(kind, strength));
  }
  w.advance(3 * 60 * MINUTE);
  for (let index = 0; index < 6; index += 1) { w.advance(40_000); keep(w.touch('pet', 'head')?.snapshot); }
  for (let index = 0; index < 4; index += 1) { w.advance(20_000); keep(w.touch('poke', 'face')?.snapshot); }
  w.advance(2 * 60 * MINUTE);
  keep(w.feel('hurt', 0.9));
  for (let index = 0; index < 6; index += 1) { w.advance(10 * MINUTE); keep(w.apply({ type: 'awake-observed' })); }
  w.advance(5 * 60 * MINUTE);
  keep(w.feel('happy', 0.6));
  w.advance(30_000); keep(w.touch('holdHand', 'hand')?.snapshot);
  w.advance(10 * MINUTE); keep(w.apply({ type: 'awake-observed' }));
  return states;
}

const facts = (overrides: Partial<ReachOutFacts> = {}): ReachOutFacts => ({
  id: 'initiative-1', reason: 'wonder', sentAt: '2026-10-05T12:00:00.000Z', waitedSeconds: 180, replied: true, repliedAfterSeconds: 95,
  delivery: 'shown_spoken', windowVisible: true, owner: 'unknown', others: false, ...overrides,
});

describe('the prediction shadow changes nothing', () => {
  it('leaves every state of a day exactly as it is without the shadow', () => {
    const on = world({ shadow: true });
    const off = world({ shadow: false });
    expect(on.shadow).not.toBeNull();
    expect(off.shadow).toBeNull();
    expect(day(on)).toEqual(day(off));
    expect(on.store.snapshot(scope)).toEqual(off.store.snapshot(scope));
    expect(on.shadow!.comparisons(scope).length).toBeGreaterThan(5);
  });

  it('is on unless SHANNON_PREDICTION_SHADOW switches it off, and then creates nothing', () => {
    expect(predictionShadowEnabled({})).toBe(true);
    for (const value of ['off', 'OFF', ' false ', '0', 'disabled', 'no', 'none']) expect(predictionShadowEnabled({ SHANNON_PREDICTION_SHADOW: value })).toBe(false);
    vi.stubEnv('SHANNON_PREDICTION_SHADOW', 'off');
    const directory = mkdtempSync(join(tmpdir(), 'shannon-prediction-off-'));
    directories.push(directory);
    const store = new SQLiteShannonStore({ path: join(directory, 'shannon.sqlite'), now: () => '2026-10-05T00:00:00.000Z', moodHistory: null });
    expect(store.predictionShadow()).toBeNull();
    store.close();
    const database = new DatabaseSync(join(directory, 'shannon.sqlite'));
    expect(database.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'shannon_prediction%'`).all()).toEqual([]);
    database.close();
  });

  it('runs after the caller by default, so that no reply, touch or worker waits for it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-prediction-later-'));
    directories.push(directory);
    const path = join(directory, 'shannon.sqlite');
    const store = new SQLiteShannonStore({ path, now: () => '2026-10-05T00:00:00.000Z', moodHistory: null, predictionShadow: true });
    store.apply(scope, { type: 'awake-observed' });
    expect(store.predictionShadow()!.comparisons(scope)).toEqual([]);
    await new Promise(resolve => { setImmediate(resolve); });
    expect(store.predictionShadow()!.comparisons(scope)).toHaveLength(1);
    // Closed before its turn (a shutdown): skipped quietly.
    const error = vi.spyOn(console, 'error');
    store.apply(scope, { type: 'awake-observed' });
    store.close();
    await new Promise(resolve => { setImmediate(resolve); });
    expect(error).not.toHaveBeenCalled();
  });

  it('is listed among the core paths of emotion', () => {
    for (const path of ['packages/cognition/src/prediction.ts', 'packages/cognition/src/predictionDomains.ts', 'packages/cognition/src/affectDynamics.ts',
      'services/api/src/predictionStore.ts', 'services/api/src/predictionShadow.ts', 'services/api/src/predictionShadowFold.ts', 'services/api/src/predictionShadowReadings.ts']) expect(SHANNON_CORE_PATHS.emotion).toContain(path);
  });
});

describe('the record holds no words', () => {
  it('stores symbols, identifiers, instants and numbers only, and logs nothing else', () => {
    const w = world({ shadow: true });
    day(w);
    w.shadow!.reachOut(scope, facts(), w.clock.at);
    const database = new DatabaseSync(w.path);
    const text: string[] = [];
    for (const table of ['shannon_prediction_outcomes', 'shannon_prediction_shadow']) {
      for (const row of database.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>) {
        for (const [column, value] of Object.entries(row)) {
          if (typeof value !== 'string') { expect(value === null || typeof value === 'number' || typeof value === 'bigint', column).toBe(true); continue; }
          text.push(value);
          if (column === 'scope_key') continue;
          if (column === 'observed_at' || column === 'recorded_at') expect(new Date(value).toISOString()).toBe(value);
          else if (column === 'features_json') expect(value).toMatch(/^\{("[a-z]+":-?\d+(\.\d+)?,?)*\}$/u);
          else if (column === 'source_id') expect(value).toMatch(PREDICTION_SOURCE_ID);
          else if (column === 'context' && value === '') continue;
          else expect(value, column).toMatch(PREDICTION_SYMBOL);
        }
      }
    }
    database.close();
    const everything = [...text, ...w.lines].join('\n');
    // Nothing of a cause, a reply or a target: no Japanese at all.
    expect(everything).not.toMatch(/[぀-ヿ一-鿿]/u);
    for (const line of w.lines) expect(line).toMatch(/^Shannon prediction shadow: [A-Za-z0-9_.:=+|\- ]+$/u);
    expect(w.lines.some(line => line.includes('tap=touch key=pet.head.owner'))).toBe(true);
  });

  it('refuses a word where a symbol belongs', () => {
    const database = new DatabaseSync(':memory:');
    const store = new SQLitePredictionStore(database, { createSchema: true });
    const draft = { domain: 'touch', key: '頭', outcome: 0.5, context: '', features: {}, sourceKind: 'touch', sourceId: null, observedAt: '2026-10-05T00:00:00.000Z' };
    const derived = { expectation: null, uncertainty: null, error: null, learningRate: null, cause: null };
    expect(() => store.insert(scope, draft, derived)).toThrow('PREDICTION_SYMBOL_INVALID');
    expect(() => store.insert(scope, { ...draft, key: 'pet', sourceId: 'なでた' }, derived)).toThrow('PREDICTION_SOURCE_INVALID');
    expect(() => store.insert(scope, { ...draft, key: 'pet', features: { '親しさ': 1 } }, derived)).toThrow('PREDICTION_FEATURE_INVALID');
    database.close();
  });
});

describe('forgetting', () => {
  it('deletes the rows of a forgotten touch and recomputes the rest exactly as if they had never been', () => {
    const w = world({ shadow: true });
    w.apply({ type: 'awake-observed' });
    w.advance(MINUTE);
    const first = w.touch('pet', 'head')!;
    w.advance(30_000); w.touch('pet', 'head');
    w.advance(3 * 60 * MINUTE);
    w.feel('happy', 0.6);
    w.advance(MINUTE);
    const second = w.touch('poke', 'face')!;
    w.advance(30_000); w.touch('poke', 'face');
    expect(first.burst.id).not.toBe(second.burst.id);
    const database = new DatabaseSync(w.path);
    const count = () => (database.prepare(`SELECT COUNT(*) AS n FROM shannon_prediction_outcomes WHERE source_id = ?`).get(first.burst.id) as { n: number }).n;
    expect(count()).toBe(2);
    w.advance(MINUTE);
    const forgottenAt = w.clock.at;
    w.apply({ type: 'memory-control-upserted', control: { memoryId: first.burst.id, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: w.clock.at, changeReason: 'user' } });
    expect(count()).toBe(0);
    expect(w.lines.some(line => /forgot sources=1 rows=2 recomputed=\d+ changed=\d+/u.test(line))).toBe(true);
    // A fresh fold of what is left gives the stored derived values and the same mind.
    const store = new SQLitePredictionStore(database, { createSchema: false });
    const rows = store.rows(scope);
    const fresh = foldOutcomes(rows);
    rows.forEach((row, index) => {
      const folded = fresh.folded[index]!;
      for (const name of ['expectation', 'uncertainty', 'error', 'learningRate'] as const) {
        expect(row[name] === null ? null : Number(row[name]!.toFixed(5)), `${row.seq} ${name}`).toEqual(folded[name] === null ? null : Number(folded[name]!.toFixed(5)));
      }
    });
    const live = w.shadow!.mind(scope);
    expect(predictOutcome(live.model, { domain: 'touch', key: 'poke.face.owner', at: Date.parse(w.clock.at) }))
      .toEqual(predictOutcome(fresh.mind.model, { domain: 'touch', key: 'poke.face.owner', at: Date.parse(w.clock.at) }));
    expect(predictOutcome(live.model, { domain: 'touch', key: 'pet.head.owner', at: Date.parse(w.clock.at) }).count).toBe(0);
    expect(readMind(live, w.clock.at)).toEqual(readMind(fresh.mind, w.clock.at));
    // Comparisons made with the forgotten rows are gone with them; the one written with the forgetting is made without them.
    const firstAt = new Date(Date.parse(first.burst.startedAt)).toISOString();
    const comparisons = w.shadow!.comparisons(scope);
    expect(comparisons.some(item => item.at >= firstAt && item.at < forgottenAt)).toBe(false);
    expect(comparisons.some(item => item.at < firstAt)).toBe(true);
    database.close();
  });

  it('gives the same mind from a store that only ever received the remaining rows', () => {
    const w = world({ shadow: true });
    day(w);
    const database = new DatabaseSync(w.path);
    const store = new SQLitePredictionStore(database, { createSchema: false });
    const victim = store.rows(scope).find(row => row.sourceKind === 'touch')!.sourceId!;
    w.shadow!.forget(scope, [victim]);
    const remaining = store.rows(scope);
    const other = new DatabaseSync(':memory:');
    ensurePredictionSchema(other);
    const replay = new PredictionShadow({ database: other, createsSchema: true, log: () => {} });
    const replayStore = new SQLitePredictionStore(other, { createSchema: false });
    const derived = { expectation: null, uncertainty: null, error: null, learningRate: null, cause: null };
    for (const row of remaining) replayStore.insert(scope, row, derived);
    expect(replay.recompute(scope).rows).toBe(remaining.length);
    expect(replayStore.rows(scope).map(({ seq: _seq, ...row }) => row)).toEqual(remaining.map(({ seq: _seq, ...row }) => row));
    expect(readMind(replay.mind(scope), w.clock.at)).toEqual(readMind(w.shadow!.mind(scope), w.clock.at));
    database.close();
    other.close();
  });
});

describe('the taps', () => {
  it('learns from what followed a message of hers, and keeps an away or hidden report out of whether he answers', () => {
    const database = new DatabaseSync(':memory:');
    const lines: string[] = [];
    const shadow = new PredictionShadow({ database, createsSchema: true, log: line => { lines.push(line); } });
    shadow.reachOut(scope, facts(), '2026-10-05T12:03:00.000Z');
    shadow.reachOut(scope, facts({ id: 'initiative-2', delivery: 'away', replied: false }), '2026-10-05T13:03:00.000Z');
    shadow.reachOut(scope, facts({ id: 'initiative-3', delivery: 'unknown', replied: false, unwatched: true }), '2026-10-05T14:03:00.000Z');
    const rows = new SQLitePredictionStore(database, { createSchema: false }).rows(scope).map(row => [row.domain, row.key, row.outcome, row.sourceId]);
    expect(rows).toEqual([
      ['owner_present', 'evening', 1, 'initiative-1'],
      ['reply', 'wonder.evening.body', 1, 'initiative-1'],
      ['reply_time', 'wonder.evening.body', 95, 'initiative-1'],
      ['owner_present', 'evening', 0, 'initiative-2'],
    ]);
    expect(lines).toHaveLength(4);
    database.close();
  });

  it('is handed every observed message by the loop, after the observation, and a failing tap never stops a step', () => {
    const seen: string[] = [];
    const observations: string[] = [];
    const dependencies = {
      store: { loop: { observations: { add: () => { observations.push('added'); } } } },
      config: { maximumReachOutFollowUpsPerDay: 1 }, loop: { pacing: 'cycles' },
      prediction: { reachOut: (_scope: string, item: ReachOutFacts) => { seen.push(`${observations.length}:${item.id}`); } },
    } as unknown as StepDependencies;
    const cycle = { id: 'cycle', kind: 'activity', scopeKey: scope } as never;
    const row = { ordinal: 1, step: { kind: 'reach_out' } } as never;
    observeStep(dependencies, cycle, row, { outcome: 'done', observed: facts() }, [{ kind: 'think' }], '2026-10-05T12:03:00.000Z');
    observeStep(dependencies, cycle, { ordinal: 2, step: { kind: 'note' } } as never, { outcome: 'done' }, [{ kind: 'think' }], '2026-10-05T12:04:00.000Z');
    expect(seen).toEqual(['1:initiative-1']);
    const failing = { ...dependencies, prediction: { reachOut: () => { throw new Error('boom'); } } } as StepDependencies;
    expect(() => observeStep(failing, cycle, row, { outcome: 'done', observed: facts() }, [{ kind: 'think' }], '2026-10-05T12:05:00.000Z')).not.toThrow();
  });

  it('reads a reply\'s decided feeling as sign × strength, and leaves out a touch\'s feeling and a feeling that only goes on', () => {
    const at = '2026-10-05T00:00:00.000Z';
    const make = (primary: ShannonEmotionKind, intensity: number) => resolveShannonEmotionState({ provisionalPrimary: primary, provisionalIntensity: intensity, transcript: '', now: at, target: 'ライ氏' });
    expect(decidedFeelingOutcome(make('hurt', 0.9))).toBeCloseTo(-0.9, 12);
    expect(decidedFeelingOutcome(make('happy', 0.6))).toBeCloseTo(0.6, 12);
    expect(decidedFeelingOutcome(make('neutral', 0.5))).toBeNull();
    expect(decidedFeelingOutcome({ ...make('happy', 0.6), continued: true })).toBeNull();
    expect(decidedFeelingOutcome({ ...make('happy', 0.6), cause: 'ライ氏に頭をなでてもらった' })).toBeNull();
  });
});

describe('the comparison record', () => {
  it('says which step the new dynamics took, and writes one comparison for one touch event', async () => {
    const w = world({ shadow: true });
    w.touch('pet', 'head');
    const comparisons = w.shadow!.comparisons(scope);
    expect(comparisons.map(item => item.tap)).toEqual(['touch']);
    expect(comparisons.every(item => item.dynamics === SHANNON_AFFECT_STEP)).toBe(true);
    w.apply({ type: 'touch-appraised', outcome: { error: 0.4, unexpected: 0.5 } });
    expect(w.shadow!.comparisons(scope)).toHaveLength(1);
  });
});

describe('the current and the new dynamics over one day', () => {
  it('gives the same trajectory every time a scripted day runs: the noise is seeded by what and when, never by a random burst id', () => {
    const first = world({ shadow: true });
    const second = world({ shadow: true });
    day(first);
    day(second);
    const strip = (items: ReturnType<NonNullable<typeof first.shadow>['comparisons']>) => items.map(item => ({ ...item }));
    expect(strip(second.shadow!.comparisons(scope))).toEqual(strip(first.shadow!.comparisons(scope)));
  });

  it('reports how far the two trajectories differ', () => {
    const w = world({ shadow: true });
    day(w);
    const comparisons = w.shadow!.comparisons(scope);
    expect(new Set(comparisons.map(item => item.tap))).toEqual(new Set(['mood', 'reply_feeling', 'touch']));
    const delta = (pick: (item: (typeof comparisons)[number]) => number) => {
      const values = comparisons.map(pick).map(Math.abs);
      return { mean: values.reduce((sum, value) => sum + value, 0) / values.length, max: Math.max(...values) };
    };
    const valence = delta(item => item.next.valence - item.old.valence);
    const arousal = delta(item => item.next.arousal - item.old.arousal);
    const present = delta(item => item.next.present - item.old.present);
    const rows = comparisons.map(item => `${item.at.slice(11, 16)} ${item.tap.padEnd(13)} old v=${item.old.valence.toFixed(2).padStart(5)} a=${item.old.arousal.toFixed(2)} p=${item.old.present.toFixed(2).padStart(5)}`
      + ` | new v=${item.next.valence.toFixed(2).padStart(5)} a=${item.next.arousal.toFixed(2)} p=${item.next.present.toFixed(2).padStart(5)} m=${item.next.mood.toFixed(2).padStart(5)} awake=${Math.round(item.next.awakeMs / 60_000)}m epi=${Math.round(item.next.boundaryMs / 60_000)}m`);
    console.log([
      'ADR-0006 stage 1: one day, current (old) and new dynamics (UTC times)', ...rows, 'Log lines:', ...w.lines,
      `|Δvalence| mean ${valence.mean.toFixed(3)} max ${valence.max.toFixed(3)}; |Δarousal| mean ${arousal.mean.toFixed(3)} max ${arousal.max.toFixed(3)}; |Δpresent| mean ${present.mean.toFixed(3)} max ${present.max.toFixed(3)}`,
    ].join('\n'));
    for (const item of comparisons) {
      for (const value of [item.old.valence, item.next.valence, item.old.present, item.next.present]) expect(Math.abs(value)).toBeLessThanOrEqual(1);
    }
    // The repeated pat is felt less each time in the new dynamics (habituation), where the table steps it up.
    const pats = w.lines.filter(line => line.includes('key=pet.head.owner')).map(line => Math.abs(Number(/ i=([+-][\d.]+)/u.exec(line)![1])));
    expect(pats).toHaveLength(6);
    expect(pats.at(-1)!).toBeLessThan(pats[0]!);
  });
});
