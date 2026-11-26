import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { goStop } from '../src/surfaces/minecraft/minecraftLlmcGoGuard.js';

/** 2026-11-13 flow, h-preflight: the form checks of a hand that fails within a second (reach, canPlace, pickaxe wear, full eat, make materials). */
type Item = { name: string; count: number; durability?: { left: number; max: number } };
const item = (name: string, count = 1): Item => ({ name, count });
const pick = (name: string, left: number): Item => ({ name, count: 1, durability: { left, max: 131 } });
/** A frame at (10.5, 10, 10.5): a map with air under the cell (14,10,10) at 2 and more. */
function frame(inventory: Item[], extra: Record<string, unknown> = {}): BodyObservation {
  const rows = ['地図 v1 足=(10,10,10) x=3..17 z=3..17 方式=layers 上=北'];
  for (const dy of [1, 0, -1, -2]) {
    rows.push(`y=${10 + dy}`);
    for (let z = 3; z <= 17; z += 1) rows.push(` ${z} ${Array.from({ length: 15 }, (_, i) => dy === 0 && z === 10 && i + 3 === 10 ? '@' : dy === 0 || dy === 1 ? '.' : (i + 3 === 14 ? '.' : '#')).join(' ')}`);
  }
  return { schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', facts: {}, state: { world: { position: { x: 10.5, y: 10, z: 10.5 }, localMap: rows.join('\n'), health: 20, food: 12,
    inventory, nearbyThreats: [], nearbyEntities: [], ...extra } } } as unknown as BodyObservation;
}
const act = (...hands: unknown[]) => ({ hands });

describe('far dig, use, furnace put, chest (G8)', () => {
  it('stops a dig 8 m away with no go or walk before it, and says the go to write', () => {
    const stop = goStop(act({ do: 'dig', at: [{ x: 18, y: 10, z: 10 }] }), frame([]));
    expect(stop).toMatchObject({ hand: 1, kind: 'dig', code: 'reach_far' });
    expect(stop?.line).toBe('(18,10,10) は 5m 超（8.0m）。先に go 18,10,10 range=2 を同じ act に置く');
    expect(goStop(act({ do: 'chest', op: 'look', at: [{ x: 10, y: 10, z: 16 }] }), frame([]))?.code).toBe('reach_far');
    expect(goStop(act({ do: 'furnace', op: 'put', at: [{ x: 10, y: 10, z: 16 }] }), frame([]))?.code).toBe('reach_far');
  });
  it('lets a near dig, a dig after a go, and a furnace take go', () => {
    expect(goStop(act({ do: 'dig', at: [{ x: 12, y: 10, z: 10 }] }), frame([]))).toBeNull();
    expect(goStop(act({ do: 'go', to: { x: 17, y: 10, z: 10 } }, { do: 'dig', at: [{ x: 18, y: 10, z: 10 }] }), frame([]))).toBeNull();
    expect(goStop(act({ do: 'walk', to: { x: 14, y: 10, z: 10 } }, { do: 'dig', at: [{ x: 18, y: 10, z: 10 }] }), frame([]))).toBeNull();
    expect(goStop(act({ do: 'furnace', op: 'take', at: [{ x: 10, y: 10, z: 16 }] }), frame([]))).toBeNull();
  });
  it('lets a far furnace put or chest that names canDig go: the body digs its way to it (the iron node says to write it so)', () => {
    expect(goStop(act({ do: 'furnace', op: 'put', item: 'raw_iron', count: 8, at: [{ x: 10, y: 10, z: 16 }], canDig: ['stone', 'dirt'], maxDig: 20 }), frame([]))).toBeNull();
    expect(goStop(act({ do: 'chest', op: 'look', at: [{ x: 10, y: 10, z: 16 }], canDig: ['stone'] }), frame([]))).toBeNull();
  });
});

describe('go into the air without canPlace (G9)', () => {
  const air = { do: 'go', to: { x: 14, y: 10, z: 10 }, canDig: ['stone'] };
  it('stops when the pack holds 10 or more blocks to lay', () => {
    const stop = goStop(act(air), frame([item('cobblestone', 50)]));
    expect(stop).toMatchObject({ code: 'place_missing' });
    expect(stop?.line).toBe('荷の cobblestone×50 を canPlace に足す（maxPlace は持つ数−32 まで＝18）');
  });
  it('goes with canPlace, with fewer than 10 blocks, or to a cell with floor', () => {
    expect(goStop(act({ ...air, canPlace: ['cobblestone'] }), frame([item('cobblestone', 50)]))).toBeNull();
    expect(goStop(act(air), frame([item('cobblestone', 9)]))).toBeNull();
    expect(goStop(act({ do: 'go', to: { x: 12, y: 10, z: 10 } }), frame([item('cobblestone', 50)]))).toBeNull();
  });
});

const diamond = (left: number): Item => ({ name: 'diamond_pickaxe', count: 1, durability: { left, max: 1561 } });
describe('a pickaxe that cannot last, by the kind the blocks need (11/27)', () => {
  const dig = (canDig: string[], maxDig = 45) => act({ do: 'go', to: { x: 12, y: 10, z: 10 }, canDig, maxDig });
  const stones = pick('stone_pickaxe', 131);
  it('lets a go that digs stone or dirt go on a stone pickaxe in the pack while the diamond one is short', () => {
    expect(goStop(dig(['stone', 'dirt']), frame([diamond(10), { ...stones, count: 4 }]))).toBeNull();
    expect(goStop(dig(['stone', 'dirt']), frame([diamond(10), stones]))).toBeNull();
  });
  it('stops a go that digs iron ore or obsidian when only stone pickaxes are in the pack, and says the pack', () => {
    const iron = goStop(dig(['stone', 'iron_ore'], 60), frame([pick('stone_pickaxe', 10), pick('wooden_pickaxe', 59)]));
    expect(iron?.code).toBe('pickaxe_wear');
    expect(iron?.line).toContain('荷のツルハシ: 石×1（10/131）、木×1（59/131）');
    const obsidian = goStop(dig(['stone', 'obsidian'], 60), frame([stones, diamond(5)]));
    expect(obsidian?.code).toBe('pickaxe_wear');
    expect(obsidian?.line).toContain('ダイヤのツルハシ');
    expect(goStop(dig(['stone', 'obsidian'], 60), frame([stones]))?.line).toContain('荷にその階級が無い');
    expect(goStop(dig(['stone', 'iron_ore'], 60), frame([stones, diamond(1000)]))?.code).toBe('go_blocks');
  });
  it('does not stop a go that digs stone with only the short diamond pickaxe (the facts say what it is kept for), and a mine of iron ore with a stone pickaxe goes', () => {
    expect(goStop(dig(['stone', 'dirt']), frame([diamond(10)]))).toBeNull();
    expect(goStop(act({ do: 'mine', block: 'iron_ore', count: 5 }), frame([diamond(10), stones]))).toBeNull();
    expect(goStop(act({ do: 'mine', block: 'iron_ore', count: 5 }), frame([diamond(10)]))).toBeNull();
  });
  it('does not look at a go under 30 blocks of digging, and goes with enough diamond left', () => {
    expect(goStop(dig(['stone'], 29), frame([diamond(10)]))).toBeNull();
    expect(goStop(dig(['stone'], 45), frame([diamond(100)]))).toBeNull();
  });
});

describe('a pickaxe that cannot last (G5)', () => {
  const dive = { do: 'vertical', dir: 'down', shape: 'stairs', toward: 'north', toY: -30, maxDig: 60, canDig: ['stone'] };
  it('stops a stairs of 40 steps (about 80 blocks needed) with a stone pickaxe at 30 left and no spare', () => {
    const stop = goStop(act({ ...dive, maxDig: 40 }), frame([pick('stone_pickaxe', 30)]));
    expect(stop?.code).toBe('pickaxe_wear');
    expect(stop?.line).toBe('荷のツルハシ: 石×1（30/131）。この下りの掘りは石の階級以上で足りる（見込み 80 回）が、その階級の残りは合わせて 30。先に予備を作る: 石のツルハシ（丸石 3・棒 2、作業台の近く）を同じ act の前に');
    expect(goStop(act({ do: 'mine', block: 'iron_ore', count: 10 }), frame([pick('stone_pickaxe', 30)]))?.line).toContain('見込み 40 回');
    expect(goStop(act({ do: 'go', to: { x: 12, y: 10, z: 10 }, canDig: ['stone'], maxDig: 80 }), frame([pick('stone_pickaxe', 30)]))?.line).toContain('見込み 40 回');
  });
  it('goes with a spare, with enough left, or after a make of a pickaxe in the same act', () => {
    expect(goStop(act({ ...dive, maxDig: 40 }), frame([pick('stone_pickaxe', 30), pick('stone_pickaxe', 131)]))).toBeNull();
    expect(goStop(act({ ...dive, maxDig: 40 }), frame([pick('stone_pickaxe', 100)]))).toBeNull();
    expect(goStop(act({ do: 'make', item: 'stone_pickaxe' }, { ...dive, maxDig: 40 }), frame([pick('stone_pickaxe', 30), item('cobblestone', 5), item('stick', 4)]))).toBeNull();
  });
});

describe('an eat at 20/20 (N6)', () => {
  it('stops with the fact, and goes when the bar is below 20, after a hand that uses it up, or for a golden apple', () => {
    expect(goStop(act({ do: 'eat', item: 'bread' }), frame([item('bread')], { food: 20 }))?.line).toContain('満腹（20/20）。eat は今は効かない');
    expect(goStop(act({ do: 'eat', item: 'bread' }), frame([item('bread')], { food: 19 }))).toBeNull();
    expect(goStop(act({ do: 'vertical', dir: 'down', shape: 'shaft', toY: 0 }, { do: 'eat', item: 'bread' }), frame([item('bread')], { food: 20 }))).toBeNull();
    expect(goStop(act({ do: 'eat', item: 'golden_apple' }), frame([item('golden_apple')], { food: 20 }))).toBeNull();
  });
});

describe('a make without materials (F3)', () => {
  it('says what is missing and where it comes from', () => {
    const stop = goStop(act({ do: 'make', item: 'stone_pickaxe' }), frame([item('oak_planks', 8), item('cobblestone', 1)]));
    expect(stop).toMatchObject({ code: 'make_short' });
    expect(stop?.line).toContain('cobblestone×2（石を dig か mine で掘る）');
  });
  it('goes when the pack has them, or an earlier hand of the act brings them', () => {
    expect(goStop(act({ do: 'make', item: 'stone_pickaxe' }), frame([item('oak_planks', 8), item('cobblestone', 3)]))).toBeNull();
    expect(goStop(act({ do: 'dig', at: [{ x: 11, y: 10, z: 10 }] }, { do: 'make', item: 'stone_pickaxe' }), frame([item('oak_planks', 8)]))).toBeNull();
    expect(goStop(act({ do: 'make', item: 'unknown_thing' }), frame([]))).toBeNull();
  });
  it('counts cobbled deepslate and blackstone as cobblestone (below y=0 the pack has mostly cobbled deepslate)', () => {
    expect(goStop(act({ do: 'make', item: 'furnace' }), frame([item('cobbled_deepslate', 40)]))).toBeNull();
    expect(goStop(act({ do: 'make', item: 'stone_pickaxe' }), frame([item('oak_planks', 8), item('cobbled_deepslate', 2), item('blackstone', 1)]))).toBeNull();
    expect(goStop(act({ do: 'make', item: 'furnace' }), frame([item('cobbled_deepslate', 7)]))?.code).toBe('make_short');
  });
});

describe('a go straight up higher than the blocks it may lay', () => {
  const up = (y: number, extra: Record<string, unknown> = {}) => act({ do: 'go', to: { x: 10, y, z: 10 }, canDig: ['stone'], canPlace: ['cobblestone'], ...extra });
  it('says what the height needs when maxPlace is below the levels (a climb lays one block a level)', () => {
    const stop = goStop(up(54, { maxPlace: 30 }), frame([item('cobblestone', 90)]));
    expect(stop).toMatchObject({ hand: 1, kind: 'go', code: 'place_missing' });
    expect(stop?.line).toContain('真上 44 段');
    expect(stop?.line).toContain('maxPlace=48 以上');
  });
  it('counts the default of 24 when no maxPlace is written', () => {
    expect(goStop(up(40), frame([item('cobblestone', 90)]))?.line).toContain('maxPlace 24（既定）');
    expect(goStop(up(30), frame([item('cobblestone', 90)]))).toBeNull();
  });
  it('lets a maxPlace that covers the levels, and a place far to the side (a slope is walked, not climbed)', () => {
    expect(goStop(up(54, { maxPlace: 50 }), frame([item('cobblestone', 90)]))).toBeNull();
    expect(goStop(act({ do: 'go', to: { x: 60, y: 54, z: 10 }, canDig: ['stone'], canPlace: ['cobblestone'], maxPlace: 24 }), frame([item('cobblestone', 90)]))).toBeNull();
  });
});
