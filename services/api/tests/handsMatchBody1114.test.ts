import { describe, expect, it } from 'vitest';
import type { ActHand } from '../src/contracts/minecraftActContract.js';
import { handProblem } from '../src/contracts/minecraftActHandRules.js';
import { handToLine, lineToHand, SHORT_ACT_DESCRIPTION } from '../src/contracts/minecraftActShortContract.js';

/** The head's hand checks against the body's (utils/actHandRules, fightSecondsMax): enderman fights to 150 s, furnace/chest/make take canDig and maxDig. */
const cell = { x: 1, y: 64, z: 3 };
const hand = (fields: Record<string, unknown>) => fields as unknown as ActHand;

describe('fight seconds: enderman 150, every other target 60 (the body fightSecondsMax)', () => {
  it('lets the kind enderman run to 150 s', () => {
    expect(handProblem(hand({ do: 'fight', target: 'enderman', seconds: 150 }))).toBeNull();
    expect(handProblem(hand({ do: 'fight', target: 'minecraft:Enderman', seconds: 120 }))).toBeNull();
    expect(handProblem(hand({ do: 'fight', target: 'enderman', seconds: 151 }))).toBe('seconds は 5〜150');
  });
  it('keeps 60 for other kinds and for an id', () => {
    expect(handProblem(hand({ do: 'fight', target: 'zombie', seconds: 61 }))).toBe('seconds は 5〜60');
    expect(handProblem(hand({ do: 'fight', target: '#6480', seconds: 120 }))).toBe('seconds は 5〜60');
    expect(handProblem(hand({ do: 'fight', target: 'zombie', seconds: 60 }))).toBeNull();
  });
});

describe('furnace, chest and make take canDig and maxDig', () => {
  it('accepts them', () => {
    expect(handProblem(hand({ do: 'furnace', at: [cell], op: 'take', canDig: ['stone', 'dirt'], maxDig: 20 }))).toBeNull();
    expect(handProblem(hand({ do: 'chest', at: [cell], op: 'look', canDig: ['dirt'] }))).toBeNull();
    expect(handProblem(hand({ do: 'make', item: 'stick', count: 4, canDig: ['stone'], maxDig: 200 }))).toBeNull();
  });
  it('refuses a wrong shape the way the body does', () => {
    expect(handProblem(hand({ do: 'make', item: 'stick', maxDig: 5 }))).toContain('canDig と一緒');
    expect(handProblem(hand({ do: 'make', item: 'stick', canDig: ['stone'], maxDig: 201 }))).toBe('maxDig は 0〜200 の整数');
    expect(handProblem(hand({ do: 'chest', at: [cell], op: 'look', canDig: [] }))).toContain('1〜12');
    expect(handProblem(hand({ do: 'furnace', at: [cell], op: 'take', canDig: ['Stone!'] }))).toContain('canDig');
    expect(handProblem(hand({ do: 'furnace', at: [cell], op: 'take', canDig: Array.from({ length: 13 }, (_, i) => `b${i}`) }))).toContain('1〜12');
  });
  it('still refuses a field the kind does not take', () => {
    expect(handProblem(hand({ do: 'make', item: 'stick', canPlace: ['stone'] }))).toContain('canPlace は使えない');
  });
  it('writes and reads them in a short line, and teaches them', () => {
    for (const h of [
      hand({ do: 'make', item: 'stick', count: 4, canDig: ['stone'], maxDig: 12 }),
      hand({ do: 'furnace', at: [cell], op: 'take', canDig: ['dirt', 'stone'], maxDig: 9 }),
      hand({ do: 'furnace', at: [cell], op: 'put', item: 'iron_ore', count: 8, fuel: 'coal', canDig: ['dirt'] }),
      hand({ do: 'chest', at: [cell], op: 'take', items: [{ item: 'coal', count: 4 }], canDig: ['dirt'], maxDig: 3 }),
    ]) {
      const back = lineToHand(handToLine(h));
      expect('error' in back).toBe(false);
      expect(back).toEqual(h);
    }
    expect(SHORT_ACT_DESCRIPTION).toContain('かまどまで掘って近づく');
  });
});
