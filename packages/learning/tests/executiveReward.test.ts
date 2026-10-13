import { describe, expect, it } from 'vitest';
import { EXECUTIVE_REWARD_WEIGHTS, activityOfCapability, capabilityOfChoice, executiveReward, foldedValueCells, ownerReactionPart, type ValueCell } from '../src/index.js';

describe('reward r2 (ADR-0009 stage 2, owner answer 4)', () => {
  it('weighs completion .35, owner .35, prediction .2, self .1', () => {
    expect(EXECUTIVE_REWARD_WEIGHTS).toEqual({ completion: 0.35, owner: 0.35, prediction: 0.2, self: 0.1 });
    expect(executiveReward({ completion: 1, owner: 1, prediction: 1, self: 1 })!.reward).toBeCloseTo(1);
    expect(executiveReward({ completion: 1, owner: 0, prediction: 0, self: 0 })!.reward).toBeCloseTo(0.35);
    expect(executiveReward({ completion: 0, owner: ownerReactionPart('more'), prediction: -1, self: 0.5 })!.reward).toBeCloseTo(0.175 - 0.2 + 0.05);
  });

  it('scales the weights of the parts that apply, clamps each part, and is unsettled with none', () => {
    const only = executiveReward({ completion: 2, owner: null, prediction: null, self: null })!;
    expect(only.reward).toBe(1);
    expect(only.weights).toEqual({ completion: 1 });
    expect(executiveReward({ completion: 0.5, owner: null, prediction: null, self: 1 })!.reward).toBeCloseTo((0.35 * 0.5 + 0.1) / 0.45);
    expect(executiveReward({ completion: null, owner: null, prediction: null, self: Number.NaN })).toBeNull();
  });
});

describe('capability aliases of the value table (cap1)', () => {
  it('folds the old choices into capabilities', () => {
    expect(['draft', 'revise', 'reach_out.share', 'call.saw', 'read', 'notion', 'note', 'jot', 'copy', 'look', 'show'].map(capabilityOfChoice)).toEqual([
      'create.story', 'create.story', 'notify.text.share', 'notify.call.saw', 'research.read', 'research.read', 'create.note', 'create.note', 'create.note',
      'look.room', 'show.piece',
    ]);
    expect(capabilityOfChoice('ready')).toBeNull();
    expect(capabilityOfChoice('tool.web.search')).toBeNull();
    expect(capabilityOfChoice('reach_out.other')).toBeNull();
    expect(capabilityOfChoice('create.story')).toBe('create.story');
    expect(activityOfCapability('notify.text.share')).toBe('notify.text');
  });

  it('pools cells weighted by their counts', () => {
    const cell = (choice: string, n: number, mean: number): ValueCell => ({
      level: 'choice', choice, context: '', n, mean, uncertainty: 0.04, noise: 0.1, volatility: 0, lastAt: n, world: 0, serve: mean, growth: 0, costYen: 2,
    });
    const folded = foldedValueCells([cell('draft', 3, 1), cell('revise', 1, 0), cell('ready', 5, 0), { ...cell('x', 9, 9), level: 'root', choice: '' }]);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ choice: 'create.story', n: 4, mean: 0.75, lastAt: 3 });
    expect(foldedValueCells([cell('reach_out.share', 1, 1), cell('reach_out.saw', 1, 0)], activityOfCapability)[0]).toMatchObject({ choice: 'notify.text', n: 2, mean: 0.5 });
  });
});
