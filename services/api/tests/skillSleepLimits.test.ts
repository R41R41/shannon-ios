import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { configuredSkillBudgetUsd } from '../src/infra/models/llmUsage.js';
import { SkillMemory } from '../src/mind/memory/skillMemory.js';
import { SKILL_SLEEP_LIMITS, ShannonSkillConsolidator, skillSleepNight } from '../src/mind/sleep/skillConsolidation.js';
import type { SkillSleepModel } from '../src/mind/sleep/skillSleepModel.js';
import { skillSleepSpend } from '../src/wiring/skillMemoryWiring.js';

/** Review M4: the skill sleep's models, on their own budget, bounded per call, per night (in the database) and to the latest night. */
const AT = '2026-10-07T12:00:00.000Z';
const hours = (count: number) => new Date(Date.parse(AT) + count * 3_600_000).toISOString();
const directory = mkdtempSync(join(tmpdir(), 'shannon-skill-sleep-limits-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let files = 0;

function world(path = join(directory, `limits-${files += 1}.sqlite`)) {
  const skills = new SkillMemory({ database: new DatabaseSync(path), createsSchema: true, defer: task => task(), log: () => {} });
  skills.createPattern('owner', { kind: 'strategy', title: '三つ挙げる', body: '三つ挙げるとよい。' }, [], { carries: () => false }, hours(-1));
  let calls = 0;
  const spend = skillSleepSpend(skills);
  // A proposer that costs 0.4 USD a call and proposes nothing.
  const proposer: SkillSleepModel = { model: 'scripted', json: async scopeKey => {
    calls += 1;
    spend.recordLlmUsage({ scopeKey, lane: 'memory_background', model: 'scripted', inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0.4, occurredAt: AT });
    return { action: 'none' };
  } };
  const consolidator = (at: string, budget = 5) => new ShannonSkillConsolidator(skills,
    { knowledge: () => [], experiences: () => [], choices: () => [], visible: () => () => true, check: () => ({ carries: () => false }) },
    { maintainer: null, proposer }, { skillBudgetUsd: budget, now: () => at, log: () => {} });
  return { calls: () => calls, consolidator, skills, path };
}

describe('the skill sleep\'s limits (M4)', () => {
  it('has its own budget (5 USD a month unless set) and never touches the shared background lane', () => {
    expect(configuredSkillBudgetUsd({})).toBe(5);
    expect(configuredSkillBudgetUsd({ SHANNON_SKILL_MONTHLY_BUDGET_USD: '2.5' })).toBe(2.5);
    expect(skillSleepSpend(world().skills).backgroundLlmCostUsd('2026-10')).toBe(0);
  });

  it('makes at most three proposer calls a night across batches and restarts, none past its budget, and none on an old window', async () => {
    const w = world();
    for (let batch = 0; batch < 3; batch += 1) await w.consolidator(AT).consolidate('owner', hours(-8), AT);
    // A restart (a new process, the same database) does not reset the night's count.
    const again = world(w.path);
    await again.consolidator(AT).consolidate('owner', hours(-8), AT);
    expect(w.calls() + again.calls()).toBe(SKILL_SLEEP_LIMITS.proposerCallsPerNight);
    expect(w.skills.sleepUsage.calls('owner', 'proposer', skillSleepNight(AT))).toBe(3);
    expect(w.skills.sleepUsage.monthCostUsd('2026-10')).toBeCloseTo(1.2, 6);
    // Past the skill budget, no call; the shared background budget is not consulted at all.
    const poor = world();
    await poor.consolidator(AT, 0.3).consolidate('owner', hours(-8), AT);
    await poor.consolidator(hours(24), 0.3).consolidate('owner', hours(16), hours(24));
    expect(poor.calls()).toBe(1);
    const old = world();
    await old.consolidator(AT).consolidate('owner', hours(-80), hours(-72));
    expect(old.calls()).toBe(0);
  });
});
