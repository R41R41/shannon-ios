import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SkillMemory } from '../src/mind/memory/skillMemory.js';
import { SKILL_SLEEP_LIMITS, ShannonSkillConsolidator } from '../src/mind/sleep/skillConsolidation.js';
import type { SkillSleepModel } from '../src/mind/sleep/skillSleepModel.js';

/** Review M4: the skill sleep's models, bounded per call, per night and to the latest night. */
const AT = '2026-10-07T20:00:00.000Z';
const hours = (count: number) => new Date(Date.parse(AT) + count * 3_600_000).toISOString();

function world(spent: { usd: number }) {
  const skills = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
  skills.createPattern('owner', { kind: 'strategy', title: '三つ挙げる', body: '三つ挙げるとよい。' }, [], { carries: () => false }, hours(-1));
  let calls = 0;
  // A proposer that keeps opening pages: every round is a call.
  const proposer: SkillSleepModel = { model: 'scripted', json: async () => { calls += 1; spent.usd += 0; return { action: 'none' }; } };
  const consolidator = (at: string) => new ShannonSkillConsolidator(skills, { knowledge: () => [], experiences: () => [], choices: () => [], visible: () => () => true, check: () => ({ carries: () => false }) },
    { maintainer: null, proposer }, { backgroundLlmCostUsd: () => spent.usd }, { backgroundBudgetUsd: 1, now: () => at, log: () => {} });
  return { calls: () => calls, consolidator };
}

describe('the skill sleep\'s limits (M4)', () => {
  it('makes at most three proposer calls a night across batches, none past the budget, and none on an old window', async () => {
    const spent = { usd: 0 };
    const w = world(spent);
    const sleeper = w.consolidator(AT);
    for (let batch = 0; batch < 5; batch += 1) await sleeper.consolidate('owner', hours(-8), AT);
    expect(w.calls()).toBe(SKILL_SLEEP_LIMITS.proposerCallsPerNight);
    const over = world({ usd: 5 });
    await over.consolidator(AT).consolidate('owner', hours(-8), AT);
    expect(over.calls()).toBe(0);
    const old = world({ usd: 0 });
    await old.consolidator(AT).consolidate('owner', hours(-80), hours(-72));
    expect(old.calls()).toBe(0);
  });
});
