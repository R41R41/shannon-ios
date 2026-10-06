import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SHANNON_AFFECT_DYNAMICS, stationaryBand } from '@shannon/cognition';
import { choiceMoodStep, rewardMoodCap, rewardMoodDecision } from '@shannon/learning';
import type { ReachOutFacts } from '../src/mind/action/ownTime/store/autonomyLoopObservations.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { ledgerPredictionTap } from '../src/wiring/cognitionLedgerTaps.js';
import { startRewardMood } from '../src/wiring/cognitionLedgerWiring.js';

/**
 * The reward system's exit to her mood (Syzygy ADR-0008 stage 1, step 7b; owner override 1): every settled choice of hers that
 * may move mood moves it once, in the API process, by the stage-2 bounded step; stale, expired and void ones never; the
 * hourly rate safeguard holds; switched off, her state is what it was.
 */
const directory = mkdtempSync(join(tmpdir(), 'shannon-reward-mood-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const START = Date.parse('2026-10-07T03:00:00.000Z');
const at = (minutes: number) => new Date(START + minutes * 60_000).toISOString();
let files = 0;

function world(path = join(directory, `mood-${files += 1}.sqlite`), clock = { at: at(0) }) {
  const store = new SQLiteShannonStore({ path, now: () => clock.at, predictionLedger: true, choiceLedger: true, cognitionDefer: task => task(), predictionShadowDefer: task => task() });
  const tap = ledgerPredictionTap(store.predictionLedger()!, { reachOut: () => undefined }, { ledger: store.choiceLedger()!, presence: () => 'alone' });
  let steps = 0;
  const message = (minute: number, replied: boolean) => {
    const id = `m-${steps += 1}`;
    const when = at(minute);
    tap.chose('owner', { stepId: id, kind: 'reach_out', reason: 'wonder' }, when);
    tap.sent('owner', { id, reason: 'wonder', others: false }, when);
    const facts: ReachOutFacts = { id, reason: 'wonder', sentAt: when, waitedSeconds: 60, replied, ...(replied ? { repliedAfterSeconds: 30 } : {}), delivery: 'shown', windowVisible: true, owner: 'returned', others: false };
    tap.reachOut('owner', facts, when);
    tap.reported('owner', { stepId: id, outcome: 'done', costYen: 1 }, when);
  };
  /** Three settled messages and a nightly version: later messages read V from a cell that learned from three (the warm-up). */
  const warm = () => {
    for (let index = 0; index < 3; index += 1) message(index, true);
    store.valueVersions()!.nightly('owner', at(3));
  };
  const mood = (environment: Record<string, string> = {}) => startRewardMood(environment, { choices: store.choiceLedger(), shadow: store.predictionShadow(), state: store }, () => clock.at, { intervalMs: 3_600_000, log: () => undefined });
  return { path, clock, store, message, mood, warm };
}

const stateHash = (store: SQLiteShannonStore) => createHash('sha256').update(JSON.stringify(store.snapshot('owner').emotion)).digest('hex');

describe('the reward mood', () => {
  it('uses the stage-2 step and caps an hour at the stationary band', () => {
    expect(rewardMoodCap()).toBe(stationaryBand());
    expect(SHANNON_AFFECT_DYNAMICS).toMatchObject({ eventForgetting: 0.61, errorWeight: 1 });
    expect(SHANNON_AFFECT_DYNAMICS.expectationWeight).toBeCloseTo(0.4375, 12);
    const choice = { status: 'settled', settleCode: 'reply', settledAt: at(0), delta: 0.5, expected: 0, unexpected: 0.4, expectedLevel: 'presence', expectedN: 3 };
    expect(rewardMoodDecision({ choice, now: START, boundaryMs: 600_000, recentSteps: 0, step: 0.1 })).toEqual({ code: 'applied', share: 1 });
    expect(rewardMoodDecision({ choice, now: START + 700_000, boundaryMs: 600_000, recentSteps: 0, step: 0.1 })).toEqual({ code: 'stale', share: 0 });
    expect(rewardMoodDecision({ choice: { ...choice, settleCode: 'story_expired' }, now: START, boundaryMs: 600_000, recentSteps: 0, step: 0.1 })).toEqual({ code: 'ineligible', share: 0 });
    const capped = rewardMoodDecision({ choice, now: START, boundaryMs: 600_000, recentSteps: 0.1, step: 0.1 });
    expect(capped.code).toBe('applied_capped');
    expect(capped.share * 0.1).toBeCloseTo(stationaryBand() - 0.1, 12);
    expect(rewardMoodDecision({ choice, now: START, boundaryMs: 600_000, recentSteps: stationaryBand(), step: 0.01 })).toEqual({ code: 'rate_capped', share: 0 });
    // Warm-up: V from the root, a family, or a cell that learned from fewer than three is not yet hers to feel against.
    for (const [expectedLevel, expectedN] of [['root', 0], ['family', 9], ['choice', 2]] as const) {
      expect(rewardMoodDecision({ choice: { ...choice, expectedLevel, expectedN }, now: START, boundaryMs: 600_000, recentSteps: 0, step: 0.1 })).toEqual({ code: 'warmup', share: 0 });
    }
    expect(choiceMoodStep({ valence: 0, arousal: 0.3, openness: 0.35 }, { error: 0, expectation: 0, unexpected: 0 })).toBeCloseTo(0, 12);
  });

  it('moves her mood once per settled choice, also with two API connections pumping', () => {
    const first = world();
    const second = world(first.path, first.clock);
    first.warm();
    first.clock.at = at(5);
    first.message(5, true);
    const before = first.store.snapshot('owner').emotion.valence;
    const a = first.mood();
    const b = second.mood();
    const counts = [a.mood!.pump(), b.mood!.pump(), a.mood!.pump()];
    expect(counts.reduce((sum, item) => sum + item.applied + item.applied_capped, 0)).toBe(1);
    expect(counts.reduce((sum, item) => sum + item.warmup, 0)).toBe(3);
    const choice = first.store.choiceLedger()!.rows('owner').at(-1)!;
    expect(choice.moodCode).toMatch(/^applied/u);
    expect(choice.moodStep).toBeGreaterThan(0);
    expect(first.store.snapshot('owner').emotion.valence).toBeGreaterThan(before);
    a.stop(); b.stop(); second.store.close(); first.store.close();
  });

  it('moves her for nothing before the table knows the choice: a day of ordinary successes leaves her as she was', () => {
    const cold = world();
    const before = stateHash(cold.store);
    for (let index = 0; index < 12; index += 1) cold.message(index * 20, true);
    cold.clock.at = at(240);
    expect(cold.mood().mood!.pump()).toMatchObject({ applied: 0, applied_capped: 0, warmup: 12 });
    expect(stateHash(cold.store)).toBe(before);
    cold.store.close();
  });

  it('never moves her for a stale outcome, and stays inside the hourly safeguard however many choices settle', () => {
    const late = world();
    late.warm();
    late.message(5, true);
    late.clock.at = at(24 * 60);
    const before = stateHash(late.store);
    expect(late.mood().mood!.pump()).toMatchObject({ applied: 0, stale: 1, warmup: 3 });
    expect(stateHash(late.store)).toBe(before);
    late.store.close();

    const burst = world();
    burst.warm();
    for (let index = 0; index < 20; index += 1) burst.message(5 + index / 2, index % 4 !== 0);
    burst.clock.at = at(15);
    const counts = burst.mood().mood!.pump();
    const choices = burst.store.choiceLedger()!.rows('owner');
    const applied = choices.filter(row => row.moodCode?.startsWith('applied'));
    expect(counts.applied + counts.applied_capped + counts.rate_capped).toBe(20);
    expect(counts.warmup).toBe(3);
    expect(counts.rate_capped).toBeGreaterThan(0);
    expect(applied.reduce((sum, row) => sum + (row.moodStep ?? 0), 0)).toBeLessThanOrEqual(stationaryBand() + 1e-9);
    // Capped choices are settled and learned from all the same.
    expect(choices.every(row => row.status === 'settled' && row.reward !== null)).toBe(true);
    burst.store.close();
  });

  it('leaves her state exactly as it was with the switch off', () => {
    const on = world();
    const off = world();
    for (const item of [on, off]) { item.warm(); item.message(5, true); }
    expect(off.mood({ SHANNON_REWARD_MOOD: 'off' }).mood).toBeNull();
    expect(off.mood({ SHANNON_CHOICE_LEDGER: 'off' }).mood).toBeNull();
    const untouched = world();
    untouched.warm();
    untouched.message(5, true);
    expect(stateHash(off.store)).toBe(stateHash(untouched.store));
    on.mood().mood!.pump();
    expect(stateHash(on.store)).not.toBe(stateHash(untouched.store));
    for (const item of [on, off, untouched]) item.store.close();
  });
});
