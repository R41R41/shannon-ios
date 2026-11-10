import { describe, expect, it } from 'vitest';
import { urgentLimitStop } from '../src/surfaces/minecraft/minecraftLlmcHandGuards.js';
import { actCalls, callTags, craftedOrderedTool, eatsFood, minesIronOre } from '../src/surfaces/minecraft/minecraftAdoptionTags.js';

describe('task 85663847 (11/10 16:24): the urgent limit is the act\'s own, and an eat is never held', () => {
  const fights = [{ do: 'fight' }, { do: 'fight' }, { do: 'fight' }];
  it('does not count the queued items ahead', () => {
    expect(urgentLimitStop({ hands: [...fights, { do: 'eat' }] }, true, 3)).toBeNull();
    expect(urgentLimitStop({ hands: [...fights, { do: 'place' }, { do: 'place' }, { do: 'place' }, { do: 'place' }] }, true, 3)).toMatchObject({ hand: 7, kind: 'place' });
  });
  it('lets an eat through and does not count it; holds the fourth other hand', () => {
    expect(urgentLimitStop({ hands: [{ do: 'place' }, { do: 'place' }, { do: 'place' }, { do: 'eat' }] }, true)).toBeNull();
    expect(urgentLimitStop({ hands: [{ do: 'eat' }, { do: 'place' }, { do: 'place' }, { do: 'place' }, { do: 'go' }] }, true)).toMatchObject({ hand: 5, kind: 'go' });
    expect(urgentLimitStop({ hands: [...fights, { do: 'go' }] }, false)).toBeNull();
  });
});

describe('task 85663847: the early-game tags read the hands of mc_act', () => {
  it('maps short and expanded hands to the calls the tags read', () => {
    const calls = actCalls('mc_act', { hands: ['eat bread', 'craft stone_pickaxe 1', 'make white_bed', 'mine iron_ore 3', { do: 'sleep' }, 'look 1,2,3'] });
    expect(calls.map(call => call.name)).toEqual(['mc.eat-food', 'mc.craft-one', 'mc.craft-one', 'mc.mine-block', 'mc.sleep-in-bed']);
    expect(eatsFood(calls[0]!.name)).toBe(true);
    expect(craftedOrderedTool(calls[1]!.name, calls[1]!.input)).toBe('stone_pickaxe');
    expect(callTags(calls[2]!.name, calls[2]!.input)).toContain('bed_made');
    expect(minesIronOre(calls[3]!.name, calls[3]!.input)).toBe(true);
    expect(callTags(calls[4]!.name, calls[4]!.input)).toContain('bed_used');
    expect(actCalls('mc.observe', {})).toEqual([{ name: 'mc.observe', input: {} }]);
  });
});
