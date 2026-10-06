import { describe, expect, it } from 'vitest';
import { REWARD_FORMULA, ROOT_VALUE, choiceFamily, growthScore, predictionSkill, rewardOf, serveRule, serveScore, settle, worldScore, type LinkedPrediction } from '../src/index.js';

const linked = (overrides: Partial<LinkedPrediction> = {}): LinkedPrediction => ({
  domain: 'reply', status: 'matched', expectation: 0.5, uncertainty: 0.0833, noise: 0.25, prior: 0.5, outcome: 1, lower: 0, upper: 1, ...overrides,
});

describe('the reward of a choice', () => {
  it('weighs her three instincts equally and subtracts no cost (owner answer 2, override 2)', () => {
    expect(REWARD_FORMULA).toMatchObject({ id: 'r1', cost: 0 });
    expect(Object.values(REWARD_FORMULA.weights)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(rewardOf({ world: 0.3, serve: 1, growth: 0.5 })).toBeCloseTo(0.6, 12);
    expect(rewardOf({ world: 1, serve: 1, growth: 1 })).toBe(1);
    expect(rewardOf({ world: 0, serve: -1, growth: -1 })).toBeCloseTo(-2 / 3, 12);
  });

  it('counts as world understanding how much the outcomes reduced her prediction error, at most 1', () => {
    expect(worldScore([])).toBe(0);
    expect(worldScore([linked({ outcome: null, status: 'open' })])).toBe(0);
    const gain = 0.0833 / (0.0833 + 0.25);
    expect(worldScore([linked()])).toBeCloseTo(gain * 0.5, 12);
    // An outcome she expected teaches nothing.
    expect(worldScore([linked({ expectation: 1 })])).toBe(0);
    expect(worldScore(Array.from({ length: 20 }, () => linked({ uncertainty: 10, expectation: 0 })))).toBe(1);
  });

  it('counts as growth the step\'s success and the skill of its predictions over the domain prior', () => {
    expect(growthScore(1, [])).toBe(1);
    expect(growthScore(0, [])).toBe(0);
    expect(predictionSkill({ expectation: 0.9, prior: 0.5, outcome: 1 })).toBeCloseTo(1 - 0.01 / 0.25, 12);
    expect(predictionSkill({ expectation: 0.1, prior: 0.5, outcome: 1 })).toBe(-1);
    expect(predictionSkill({ expectation: 0.4, prior: 1, outcome: 1 })).toBe(0);
    expect(growthScore(1, [linked({ expectation: 0.9 })])).toBeCloseTo(0.5 + 0.5 * 0.96, 12);
  });

  it('finds what the owner did with it, void when it could not be his answer, pending until it is known', () => {
    expect([serveRule('reach_out.wonder'), serveRule('call.share'), serveRule('show'), serveRule('draft'), serveRule('revise'), serveRule('tool.study.search'), serveRule('follow_up')])
      .toEqual(['message', 'call', 'show', 'inherit', 'inherit', 'none', 'none']);
    expect(serveScore('message', [linked()])).toBe(1);
    expect(serveScore('message', [linked({ outcome: 0 })])).toBe(0);
    expect(serveScore('message', [linked({ status: 'void', outcome: null })])).toBeNull();
    expect(serveScore('message', [])).toBeNull();
    expect(serveScore('message', [linked({ status: 'open', outcome: null })])).toBe('pending');
    expect(serveScore('call', [linked({ domain: 'call_answer', outcome: 0 })])).toBe(0);
    const reacted = (status: string, outcome: number | null) => linked({ domain: 'story_reacted', status, outcome });
    const reaction = (status: string, outcome: number | null) => linked({ domain: 'story_reaction', status, outcome });
    expect(serveScore('show', [reacted('open', null), reaction('open', null)])).toBe('pending');
    expect(serveScore('show', [reacted('matched', 1), reaction('matched', 0.5)])).toBe(0.5);
    // No reaction in 14 days: S = 0 (owner override 5).
    expect(serveScore('show', [reacted('expired', 0), reaction('expired', null)])).toBe(0);
    expect(serveScore('show', [])).toBeNull();
    expect(serveScore('inherit', [])).toBe('pending');
    expect(serveScore('none', [])).toBe(0);
  });

  it('settles δ against the value held at choice time, with u from that value\'s spread', () => {
    const settled = settle({ world: 0, serve: 1, growth: 1 }, ROOT_VALUE);
    expect(settled.reward).toBeCloseTo(2 / 3, 12);
    expect(settled.delta).toBeCloseTo(2 / 3, 12);
    expect(settled.unexpected).toBeGreaterThan(0.5);
    expect(settle({ world: 0, serve: 0, growth: 0 }, { mean: 0, variance: 0.01, noise: 0.01 }).unexpected).toBe(0);
    expect(choiceFamily('tool.study.search')).toBe('tool');
    expect(choiceFamily('draft')).toBe('draft');
  });
});
