import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { blazeLack, deadlyGateHold } from '../src/surfaces/minecraft/minecraftLlmcDeadlyGates.js';
import { heldOfFrame } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { readinessOf } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';

/**
 * The deadly gates in `gateHold`'s form (the coordinator's list for 11/4, item 2): a hand that goes into the blaze spawner or the End is held
 * while what the place needs is missing; the line says what is missing and what going on costs, and leaves the gathering to the decision.
 */
const pack = (items: ReadonlyArray<readonly [string, number]>) => items.map(([name, count]) => ({ name, count }));
const frame = (items: ReadonlyArray<readonly [string, number]>, world: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1,
  stateAt: 't', receivedAt: 't', connected: true, facts: {},
  state: { world: { dimension: 'the_nether', position: { x: 0, y: 70, z: 0 }, health: 20, food: 20, inventory: pack(items), worn: '', ...world } as never } });

const READY: Array<[string, number]> = [['shield', 1], ['cooked_beef', 20], ['iron_sword', 1]];
const fight = { hands: [{ do: 'wait', seconds: 1 }, { do: 'fight', target: 'blaze', seconds: 20 }] };

describe('the blaze spawner', () => {
  it('names what is missing: health, hunger, the food carried and the shields', () => {
    const lack = blazeLack(readinessOf(frame([['cooked_beef', 2]], { health: 14, food: 12 }))!)!;
    for (const word of ['体力 14/20', '満腹度 12/18', '持ち物の食料', '盾 0/1', '未達の必須（ブレイズの湧き場に入る前に必ず）', '欠けたまま進むと']) expect(lack, word).toContain(word);
    expect(blazeLack(readinessOf(frame(READY))!)).toBeNull();
  });
  it('holds the hand that begins the fight when none is near, and says that the way of gathering is the decision\'s', () => {
    const held = deadlyGateHold(fight, frame([['cooked_beef', 20]]));
    expect(held).toMatchObject({ hand: 2, kind: 'fight' });
    expect(held!.line).toContain('ブレイズの湧き場へ入る手は送らない');
    expect(held!.line).toContain('盾 0/1');
    expect(held!.line).toContain('どう取るかは自分で決める');
    expect(held!.line).toContain('先にパールなど他の段の節へ今の節を移して進めてよい');
    expect(heldOfFrame(fight, frame([['cooked_beef', 20]]), 'dg')).toMatchObject({ hand: 2, code: 'gate_required' });
  });
  it('holds a fight on a blaze given by its id, and a go that ends beside a spawner from far away', () => {
    const live = { threats: ['#41 blaze 30.0m (5,70,5)'] };
    expect(deadlyGateHold({ hands: [{ do: 'fight', target: '#41' }] }, frame([], live))).toMatchObject({ hand: 1 });
    const map = ['地図 v1 足=(0,70,0) x=-20..20 z=-20..20 方式=cube', 'y=70 x=-20..20 z=-20..20', ...Array.from({ length: 41 }, (_, i) => `${i - 20} ${Array.from({ length: 41 }, (_, j) => (i === 40 && j === 30 ? 'S' : '.')).join(' ')}`)].join('\n');
    const far = frame([], { localMap: map });
    expect(deadlyGateHold({ hands: [{ do: 'go', to: { x: 10, y: 70, z: 20 } }] }, far)).toMatchObject({ hand: 1, kind: 'fight' });
    expect(deadlyGateHold({ hands: [{ do: 'go', to: { x: -10, y: 70, z: -10 } }] }, far)).toBeNull();
  });
  it('holds nothing when the needs are met, a blaze is already near (the fight is on), or the hand is not the fight', () => {
    expect(deadlyGateHold(fight, frame(READY))).toBeNull();
    expect(deadlyGateHold(fight, frame([['shield', 1]], { threats: ['#41 blaze 9.5m (3,72,4)'] }))).toBeNull();
    expect(deadlyGateHold({ hands: [{ do: 'fight', target: 'zombie' }, { do: 'eat' }] }, frame([]))).toBeNull();
    expect(deadlyGateHold(fight, null)).toBeNull();
  });
});

describe('the End', () => {
  const MAP = ['地図 v1 足=(0,70,0) x=-2..2 z=-2..2 方式=cube', 'y=70 x=-2..2 z=-2..2', '-2 . . . . .', '-1 . . . . .', '0 . . . . e', '1 . . . . .', '2 . . . . .'].join('\n');
  const walkIn = { hands: [{ do: 'walk', to: { x: 2, y: 70, z: 0 }, range: 0 }] };
  const overworld = (items: Array<[string, number]>) => frame(items, { dimension: 'overworld', localMap: MAP });
  it('holds the walk into the portal while blocks, the water bucket, beds or food are missing, and names them', () => {
    const held = deadlyGateHold(walkIn, overworld([['cobblestone', 10]]));
    expect(held).toMatchObject({ hand: 1, kind: 'walk' });
    for (const word of ['エンドへ入る手は送らない', '積める物（丸石・黒曜石など） 10/64', '水入りバケツ', 'ベッド', '食料', '欠けたまま進むと']) expect(held!.line, word).toContain(word);
  });
  it('counts obsidian as a block, and lets the walk go when everything is carried', () => {
    const kit: Array<[string, number]> = [['obsidian', 64], ['water_bucket', 1], ['white_bed', 4], ['cooked_beef', 12]];
    expect(deadlyGateHold(walkIn, overworld(kit))).toBeNull();
    expect(deadlyGateHold(walkIn, overworld(kit.filter(([name]) => name !== 'water_bucket')))?.line).toContain('水入りバケツ');
    expect(deadlyGateHold({ hands: [{ do: 'walk', to: { x: 1, y: 70, z: 0 } }] }, overworld([]))).toBeNull();
  });
});

describe('work with almost no health', () => {
  const mine = { hands: [{ do: 'eat', item: 'cooked_beef' }, { do: 'mine', block: 'iron_ore', count: 3 }] };
  const overworld = (health: number, world: Record<string, unknown> = {}) => frame([['cooked_beef', 4]], { dimension: 'overworld', health, food: 12, ...world });
  it('holds the work hand under 8 health, with an enemy near or not, and says how health comes back', () => {
    for (const world of [{}, { threats: ['#9 skeleton 1.0m (1,2,3)'] }]) {
      const held = deadlyGateHold(mine, overworld(5.7, world));
      expect(held).toMatchObject({ hand: 2, kind: 'work' });
      expect(held!.line).toContain('体力が 8 を切っている間は掘る・作る・拾うなどの作業の手を送らない');
      expect(held!.line).toContain('戦う・逃げる・食べる・遮蔽に入る手は出せる');
    }
    expect(heldOfFrame(mine, overworld(5.7), 'lh')).toMatchObject({ hand: 2, code: 'gate_required' });
  });
  it('lets the food through: made, cooked, taken from a furnace or a chest (health could never come back otherwise)', () => {
    const hungry = overworld(5, { food: 12 });
    for (const hand of [{ do: 'make', item: 'bread', count: 3 }, { do: 'craft', item: 'cooked_beef' }, { do: 'furnace', op: 'take', at: [{ x: 1, y: 2, z: 3 }] },
      { do: 'chest', op: 'take', items: [{ item: 'cooked_porkchop', count: 4 }], at: [{ x: 1, y: 2, z: 3 }] },
      { do: 'smelt', items: [{ item: 'beef', count: 4 }], fuel: 'coal' }, { do: 'chest', op: 'look', at: [{ x: 1, y: 2, z: 3 }] }]) {
      expect(deadlyGateHold({ hands: [hand] }, hungry), String(hand.do)).toBeNull();
    }
    for (const hand of [{ do: 'make', item: 'iron_pickaxe' }, { do: 'chest', op: 'take', items: [{ item: 'iron_ingot', count: 4 }], at: [{ x: 1, y: 2, z: 3 }] },
      { do: 'chest', op: 'takeAll', at: [{ x: 1, y: 2, z: 3 }] }, { do: 'smelt', items: [{ item: 'raw_iron', count: 4 }], fuel: 'coal' }]) {
      expect(deadlyGateHold({ hands: [hand] }, hungry), `${hand.do} ${JSON.stringify(hand)}`).toMatchObject({ kind: 'work' });
    }
  });
  it('lets go the hands of defence, and everything at 8 or more', () => {
    expect(deadlyGateHold(mine, overworld(8))).toBeNull();
    for (const hand of [{ do: 'fight', target: 'zombie' }, { do: 'attack', target: '#9' }, { do: 'eat', item: 'cooked_beef' }, { do: 'go', to: { x: 1, y: 2, z: 3 } },
      { do: 'equip', item: 'shield' }, { do: 'place', block: 'cobblestone', at: [{ x: 1, y: 2, z: 3 }] }, { do: 'wait', seconds: 5 }]) {
      expect(deadlyGateHold({ hands: [hand] }, overworld(5.7, { threats: ['#9 skeleton 1.0m (1,2,3)'] })), String(hand.do)).toBeNull();
    }
  });
});

describe('the golden piece against the piglins (run59, 14:15: dead in the Nether to a piglin with none worn)', () => {
  const portalHand = { hands: [{ do: 'portal', enter: true }] };
  const overworld = (items: Array<[string, number]>, worn = '') => frame(items, { dimension: 'overworld', worn });
  const nether = (items: Array<[string, number]>, worn = '') => frame(items, { dimension: 'the_nether', worn });
  it('holds the hand that enters the Nether while no golden piece is worn, and says what is in the pack toward it', () => {
    const held = deadlyGateHold(portalHand, overworld([['gold_ingot', 1], ['raw_gold', 2]]));
    expect(held).toMatchObject({ hand: 1, kind: 'portal' });
    expect(held!.line).toContain('金の防具を 1 つ着ていない（ピグリンが襲う）');
    expect(held!.line).toContain('金の延べ棒 1 個・生の金 2 個');
    expect(deadlyGateHold(portalHand, overworld([['golden_boots', 1]]))!.line).toContain('持っている golden_boots を equip で着る');
    expect(deadlyGateHold(portalHand, overworld([['golden_boots', 1]], '足: golden_boots(残り65/65)')))?.toBeNull();
    expect(deadlyGateHold({ hands: [{ do: 'eat', item: 'cooked_beef' }] }, overworld([]))).toBeNull();
  });
  it('in the Nether holds what is not the putting on, making, eating or defence, only when the means are in the pack', () => {
    const work = { hands: [{ do: 'eat', item: 'cooked_beef' }, { do: 'go', to: { x: 5, y: 70, z: 5 } }] };
    expect(deadlyGateHold(work, nether([['gold_ingot', 4]]))).toMatchObject({ hand: 2, kind: 'gold' });
    expect(deadlyGateHold(work, nether([['golden_helmet', 1]]))!.line).toContain('equip で着る');
    expect(deadlyGateHold(work, nether([['gold_ingot', 1]]))).toBeNull();
    expect(deadlyGateHold(work, nether([['gold_ingot', 4]], '足: golden_boots(残り65/65)'))).toBeNull();
    expect(deadlyGateHold({ hands: [{ do: 'make', item: 'golden_boots' }, { do: 'equip', item: 'golden_boots' }] }, nether([['gold_ingot', 4]]))).toBeNull();
  });
});
