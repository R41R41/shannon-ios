import { describe, expect, it } from 'vitest';
import type { PlanPromise } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { actSpends, breakingWords, freeOutside, promiseLines } from '../src/surfaces/minecraft/minecraftLlmcPromises.js';

/** A-8: the ledger line says what is free beyond the open promises; an act that would spend the promised is told once (nothing refused). */
const AT = '2026-10-29T00:00:00.000Z';
const promise = (id: number, item: string, count: number, use: string, state: PlanPromise['state'] = 'open'): PlanPromise =>
  ({ id, rev: 1, item, count, use, state, ledger: [{ id: 'plan:1', at: AT, kind: 'made', count, have: 0 }] });
const frame = (items: Record<string, number>, food = 20): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:w', sequence: 1, stateAt: AT, receivedAt: AT, connected: true,
  state: { world: { dimension: 'overworld', food, health: 20, position: { x: 0, y: 64, z: 0 }, inventory: Object.entries(items).map(([name, count]) => `${name}×${count}`) } },
  facts: { dimension: 'overworld', alive: true } } as unknown as BodyObservation);

describe('A-8 1: the line says what is free beyond the open promises', () => {
  it('今 7 with an open promise of 4 is 3 free; never below 0; the promises of one item are added', () => {
    const open = [promise(1, 'planks', 4, '地下の作業台')];
    expect(promiseLines(open, { observation: frame({ spruce_planks: 7 }) })[0]).toBe('約束 #1 地下の作業台用の板 4: 今 7（約束の外で使えるのは 3）');
    expect(promiseLines(open, { observation: frame({ spruce_planks: 2 }) })[0]).toContain('今 2（約束の外で使えるのは 0）');
    expect(freeOutside([...open, promise(2, 'planks', 4, 'はしご')], 'planks', 7)).toBe(0);
    expect(freeOutside([...open, promise(3, 'planks', 4, 'はしご', 'closed')], 'planks', 7)).toBe(3);
  });
});

describe('A-8 2: an act that would break a promise is told once, and not refused', () => {
  const open = [promise(1, 'planks', 4, '地下の作業台')];
  it('a smelt with 6 planks as fuel of 7: 板 6 を使い、残り 1', () => {
    const hands = [{ do: 'smelt', items: [{ item: 'raw_iron', count: 6 }], fuel: 'spruce_planks', fuelCount: 6 }];
    expect(breakingWords(open, hands, frame({ spruce_planks: 7, raw_iron: 6 }))).toEqual(['この act は約束 #1（地下の作業台用の板 4）を割る見込み（板 6 を使い、残り 1）']);
  });
  it('says nothing when the act spends only what is free, or what no promise holds', () => {
    expect(breakingWords(open, [{ do: 'smelt', fuel: 'spruce_planks', fuelCount: 3 }], frame({ spruce_planks: 7 }))).toEqual([]);
    expect(breakingWords(open, [{ do: 'smelt', fuel: 'coal', fuelCount: 6 }], frame({ spruce_planks: 7, coal: 6 }))).toEqual([]);
    expect(breakingWords([], [{ do: 'smelt', fuel: 'spruce_planks', fuelCount: 6 }], frame({ spruce_planks: 7 }))).toEqual([]);
  });
  it('counts what the hands name: a smelt, a drop, a chest put, the cells of a place, the n of a pillar, and (A-10) the planks of a make of sticks', () => {
    expect(actSpends([{ do: 'drop', items: [{ item: 'cobblestone', count: 3 }] }, { do: 'chest', op: 'put', items: [{ item: 'oak_planks', count: 2 }] },
      { do: 'place', block: 'cobblestone', at: [{}, {}] }, { do: 'pillarUp', block: 'dirt', n: 4 }, { do: 'make', item: 'stick', count: 4 }]))
      .toEqual([{ item: 'cobblestone', count: 3 }, { item: 'oak_planks', count: 2 }, { item: 'cobblestone', count: 2 }, { item: 'dirt', count: 4 }, { item: 'planks', count: 2 }]);
  });
});

describe('A-9: the pack\'s lines carry the shares of the open promises', () => {
  it('writes where a promise is and how much is outside it; adds up the stacks of a kind a promise names; leaves the rest and the held-by-instead ones', async () => {
    const { shareStacks } = await import('../src/surfaces/minecraft/minecraftLlmcPromises.js');
    const open = [promise(1, 'planks', 4, '地下の作業台')];
    expect(shareStacks(['spruce_planks×7', 'dirt×35'], open)).toEqual(['spruce_planks×7（約束 #1 地下の作業台に 4・外 3）', 'dirt×35']);
    // two kinds of planks: the first line carries the total
    expect(shareStacks(['spruce_planks×4', 'oak_planks×3', 'oak_planks×2'], open)).toEqual(['spruce_planks×4（板の合計 9: 約束 #1 地下の作業台に 4・外 5）', 'oak_planks×5']);
    // two promises of one item, an exact one beside a kind
    expect(shareStacks(['spruce_planks×7'], [...open, promise(2, 'spruce_planks', 2, 'はしご')])).toEqual(['spruce_planks×7（約束 #1 地下の作業台に 4・外 3）（約束 #2 はしごに 2・外 5）']);
    expect(shareStacks(['spruce_planks×7'], [promise(1, 'planks', 4, '作業台', 'kept_by_instead')])).toEqual(['spruce_planks×7']);
    expect(shareStacks(['spruce_planks×7'], undefined)).toEqual(['spruce_planks×7']);
    expect(shareStacks(['bread×3'], [promise(4, 'food', 20, '地下で食べる分')])).toEqual(['bread×3']);
  });
});
