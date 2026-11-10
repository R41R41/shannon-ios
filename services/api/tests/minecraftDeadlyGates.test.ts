import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { blazeLack, deadlyGateHold } from '../src/surfaces/minecraft/minecraftLlmcDeadlyGates.js';
import { heldOfFrame } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { preparationShortage, readinessOf } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { END_GATHER_MS, firstEntryLack, forgetEndGather } from '../src/surfaces/minecraft/minecraftEndGather.js';

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
  it('asks 60 food points whatever the rods, and says what the rods still to come eat (G04, 11/10: the head leaves for the fortress with 100)', () => {
    const ready = (rods: Array<[string, number]>, beef: number) => blazeLack(readinessOf(frame([['shield', 1], ['cooked_beef', beef], ...rods]))!);
    // A cooked beef is 20.8 points: the gate asks 60 whatever the rods, 3 beef. What a trip for food should bring is said, not asked.
    expect(ready([], 2)).toContain('ロッド 0/7。入るのに 60 点。残りのロッドを取り切るまでに約 150 点食べるので、取りに出るなら一度でそこまで');
    expect(ready([], 3)).toBeNull();
    expect(ready([['blaze_rod', 4]], 2)).toContain('ロッド 4/7。入るのに 60 点。残りのロッドを取り切るまでに約 64 点');
    expect(ready([['blaze_rod', 4]], 3)).toBeNull();
    expect(ready([['blaze_rod', 6]], 2)).toContain('ロッド 6/7。入るのに 60 点。焼く・狩る・拾う');
    expect(ready([['blaze_rod', 6]], 2)).toContain('持ち物の食料');
    expect(ready([['blaze_rod', 6]], 3)).toBeNull();
    expect(ready([['blaze_rod', 2], ['blaze_powder', 6]], 3)).toBeNull();
    expect(blazeLack(readinessOf(frame(READY, { health: 19.66666603088379 }))!)).toContain('体力 19.7/20（満腹度 20 なので食べずに見えない所で wait 約 2 秒で戻る）');
    expect(blazeLack(readinessOf(frame(READY, { health: 15, food: 18 }))!)).toContain('wait 約 20 秒');
    expect(blazeLack(readinessOf(frame(READY, { health: 15, food: 12 }))!)).toContain('体力 15/20（食べて回復を待つ）');
  });
  it('says to make a shield where she stands when the materials are carried (end1108h18: both shields broke, 14 minutes on other work)', () => {
    const carrying = blazeLack(readinessOf(frame([['cooked_beef', 20], ['iron_ingot', 2], ['oak_planks', 16]]))!)!;
    expect(carrying).toContain('盾 0/1（鉄 2・板 16 を持っている。今その場で make shield');
    expect(blazeLack(readinessOf(frame([['cooked_beef', 20], ['iron_ingot', 1], ['oak_planks', 4]]))!)).toContain('盾 0/1（板 6 と鉄 1 で作業台で作る');
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
    const kit: Array<[string, number]> = [['obsidian', 64], ['water_bucket', 1], ['white_bed', 8], ['cooked_beef', 16]];
    expect(deadlyGateHold(walkIn, overworld(kit))).toBeNull();
    expect(deadlyGateHold(walkIn, overworld(kit.filter(([name]) => name !== 'water_bucket')))?.line).toContain('水入りバケツ');
    expect(deadlyGateHold({ hands: [{ do: 'walk', to: { x: 1, y: 70, z: 0 } }] }, overworld([]))).toBeNull();
  });
  it('the dragon is killed with beds: fewer than 8 beds, or fewer than 8 obsidian for the fight beside the blocks to stand on, holds the walk', () => {
    const kit: Array<[string, number]> = [['cobblestone', 64], ['obsidian', 8], ['water_bucket', 1], ['white_bed', 8], ['cooked_beef', 16]];
    expect(deadlyGateHold(walkIn, overworld(kit))).toBeNull();
    const fewBeds = deadlyGateHold(walkIn, overworld(kit.map(([name, n]) => [name, name === 'white_bed' ? 7 : n] as [string, number])));
    expect(fewBeds?.line).toContain('ベッド（目標 10） 7/8');
    const fewObsidian = deadlyGateHold(walkIn, overworld(kit.map(([name, n]) => [name, name === 'obsidian' ? 7 : n] as [string, number])));
    expect(fewObsidian?.line).toContain('黒曜石（エンドの戦い用');
    expect(fewObsidian?.line).toContain('7/8');
  });
  it('lets the fallback in once the gathering of beds has had ten minutes, with an iron sword; the bow and arrows are aims (the review of 11/5, item 8; thru-1110 11/9)', () => {
    forgetEndGather();
    let clock = 0;
    const now = () => clock;
    const fallback: Array<[string, number]> = [['cobblestone', 64], ['water_bucket', 1], ['white_bed', 6], ['cooked_beef', 12], ['bow', 1], ['arrow', 30],
      ['iron_sword', 1]];
    const facts = readinessOf(overworld(fallback))!;
    expect(firstEntryLack(facts, 't', now)).toContain('残り約 10 分');
    clock = END_GATHER_MS - 60_000;
    expect(firstEntryLack(facts, 't', now)).toContain('残り約 1 分');
    clock = END_GATHER_MS;
    expect(firstEntryLack(facts, 't', now)).toBeNull();
    // thru-1110 (11/9): no bow and no arrows do not hold it for ever.
    expect(firstEntryLack(readinessOf(overworld(fallback.filter(([name]) => name !== 'bow' && name !== 'arrow')))!, 't', now)).toBeNull();
    // Without the fallback's kit the clock lets nothing in, and the line says so.
    const bare = readinessOf(overworld(fallback.filter(([name]) => name !== 'iron_sword')))!;
    expect(firstEntryLack(bare, 't', now)).toContain('予備の手（止まり木の竜を剣・あれば弓でクリスタル）の必須もそろっていない');
    // Through the gate: the walk is held, with the clock in its words.
    forgetEndGather();
    expect(deadlyGateHold(walkIn, overworld(fallback), 'g')?.line).toContain('最初に止めてから 10 分まで');
  });
  it("reads the gate's clock at the End check and, ten minutes past the gate's first hold, asks the fallback's kit there too (ChatGPT's review of 11/10, Q2; E1)", () => {
    forgetEndGather();
    const kit: Array<[string, number]> = [['cobblestone', 64], ['water_bucket', 1], ['white_bed', 6], ['cooked_beef', 12], ['bow', 1], ['arrow', 30],
      ['iron_sword', 1], ['ender_eye', 12]];
    const check = (items: Array<[string, number]>, now: number) => {
      const facts = readinessOf(overworld(items))!;
      return preparationShortage({ dimension: facts.dimension, counts: facts.counts, food: facts.food, nowKinds: ['end'], world: facts.world, taskId: 'q2', now });
    };
    expect(check(kit, 0)).toContain('ベッド');
    // The check does not start the clock: ten minutes on, with no hold at the gate yet, the beds and the food of the beds' way are still asked.
    expect(check(kit, END_GATHER_MS)).toContain('ベッド');
    expect(check(kit, END_GATHER_MS)).not.toContain('予備の手');
    // The gate's first hold starts it; ten minutes after that the fallback goes in, and the check says the same.
    expect(firstEntryLack(readinessOf(overworld(kit))!, 'q2', () => END_GATHER_MS)).toContain('残り約 10 分');
    expect(firstEntryLack(readinessOf(overworld(kit))!, 'q2', () => 2 * END_GATHER_MS)).toBeNull();
    const after = check(kit, 2 * END_GATHER_MS);
    expect(after ?? '').not.toContain('ベッド');
    expect(after ?? '').not.toContain('黒曜石（エンドの戦い用');
    const noSword = check(kit.filter(([name]) => name !== 'iron_sword'), 2 * END_GATHER_MS);
    expect(noSword).toContain('予備の手');
    expect(noSword).toContain('剣');
    // Without a task there is no clock: the beds stay asked.
    const facts = readinessOf(overworld(kit))!;
    expect(preparationShortage({ dimension: facts.dimension, counts: facts.counts, food: facts.food, nowKinds: ['end'], world: facts.world }))
      .toContain('ベッド');
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
  it('lets a return for the drops of a Nether death through with none worn (G01, the review of 11/10: the golden boots lie with the drops)', () => {
    const lastDeath = '3分前 the_nether (89,67,40)「Shannon was slain by Blaze」 落とした物: golden_boots×1。消えるまで最長約5分（近くにいる間だけ減る）→拾いに戻れる';
    expect(deadlyGateHold(portalHand, frame([], { dimension: 'overworld', lastDeath }))).toBeNull();
    expect(deadlyGateHold(portalHand, frame([], { dimension: 'overworld', lastDeath: lastDeath.replace('was slain by Blaze', 'tried to swim in lava') })))
      .toMatchObject({ hand: 1, kind: 'portal' });
    expect(deadlyGateHold(portalHand, frame([], { dimension: 'overworld', lastDeath: lastDeath.replace(/落とした物.*$/u, '何も落としていない') })))
      .toMatchObject({ hand: 1, kind: 'portal' });
  });
  it('in the Nether holds the travel of the search, only when the means are in the pack', () => {
    const work = { hands: [{ do: 'eat', item: 'cooked_beef' }, { do: 'go', to: { x: 60, y: 70, z: 60 } }] };
    expect(deadlyGateHold(work, nether([['gold_ingot', 4]]))).toMatchObject({ hand: 2, kind: 'gold' });
    expect(deadlyGateHold(work, nether([['golden_helmet', 1]]))!.line).toContain('equip で着る');
    expect(deadlyGateHold(work, nether([['gold_ingot', 1]]))).toBeNull();
    expect(deadlyGateHold(work, nether([['gold_ingot', 4]], '足: golden_boots(残り65/65)'))).toBeNull();
    expect(deadlyGateHold({ hands: [{ do: 'make', item: 'golden_boots' }, { do: 'equip', item: 'golden_boots' }] }, nether([['gold_ingot', 4]]))).toBeNull();
  });
  it('lets a way back and a short hop through at full health, holds the far search (the end of the move decides)', () => {
    const well = (world: Record<string, unknown> = {}) => frame([['gold_ingot', 4]], { dimension: 'the_nether', health: 20, ...world });
    const far = { hands: [{ do: 'go', to: { x: 60, y: 70, z: 60 } }] };
    expect(deadlyGateHold(far, well())).toMatchObject({ hand: 1, kind: 'gold' });
    expect(deadlyGateHold({ hands: [{ do: 'go', to: { x: 6, y: 70, z: 6 } }] }, well())).toBeNull();
    const portal = { mapLandmarks: ['P ネザーポータル (60,70,62) 拠点'] };
    expect(deadlyGateHold(far, well(portal))).toBeNull();
    expect(deadlyGateHold(far, well({ mapLandmarks: ['[overworld] P ネザーポータル (60,70,62) 拠点'] }))).toMatchObject({ kind: 'gold' });
    expect(deadlyGateHold(far, well({ rememberedPlaces: { nether_portal: '90m 南 (60,70,62) ↔overworld(1,2,3)' } }))).toBeNull();
    const goals = (...cells: Array<[number, number]>) => ({ hands: [{ do: 'go', goals: cells.map(([x, z]) => ({ x, y: 70, z })) }] });
    expect(deadlyGateHold(goals([61, 60], [80, 80]), well(portal))).toBeNull();
    expect(deadlyGateHold(goals([90, 90], [80, 80]), well(portal))).toMatchObject({ kind: 'gold' });
  });
  it('lets a retreat, cover, food from a chest and the boots through at 5 health (review of 11/4); holds a move only while well and alone', () => {
    const hurt = () => frame([['gold_ingot', 4], ['bread', 2]], { dimension: 'the_nether', health: 5, food: 12 });
    const chestTake = { do: 'chest', op: 'take', at: [{ x: 2, y: 70, z: 2 }], items: [{ item: 'bread', count: 2 }] };
    for (const hand of [{ do: 'go', to: { x: 60, y: 70, z: 60 } }, { do: 'place', at: [{ x: 1, y: 70, z: 1 }], block: 'cobblestone' }, chestTake,
      { do: 'make', item: 'golden_boots' }]) expect(deadlyGateHold({ hands: [hand] }, hurt()), String(hand.do)).toBeNull();
    const trip = { hands: [{ do: 'go', to: { x: 60, y: 70, z: 60 } }] };
    expect(deadlyGateHold(trip, frame([['gold_ingot', 4]], { dimension: 'the_nether', health: 12 }))).toMatchObject({ hand: 1, kind: 'gold' });
    const piglin = { dimension: 'the_nether', health: 12, nearbyThreats: [{ name: 'piglin', distance: 6 }] };
    expect(deadlyGateHold(trip, frame([['gold_ingot', 4]], piglin))).toBeNull();
    const cover = { hands: [{ do: 'place', at: [{ x: 1, y: 70, z: 1 }], block: 'cobblestone' }] };
    expect(deadlyGateHold(cover, frame([['gold_ingot', 4]], { dimension: 'the_nether', health: 20 }))).toBeNull();
  });
});

describe('the blaze fight once the rods are in (S5, 11/5)', () => {
  it('holds a fight or an attack on a blaze while the pack holds seven rods (powder and eyes counted), and says to leave', () => {
    const fightBlaze = { hands: [{ do: 'fight', target: 'blaze', seconds: 20 }] };
    const held = deadlyGateHold(fightBlaze, frame([['blaze_rod', 7], ['shield', 1], ['cooked_beef', 20]]));
    expect(held).toMatchObject({ hand: 1, kind: 'rods' });
    expect(held!.line).toContain('ブレイズロッドは足りている（ロッド換算 7/7');
    expect(held!.line).toContain('湧き場から離れて帰りのゲートか次の節へ');
    expect(deadlyGateHold(fightBlaze, frame([['blaze_rod', 3], ['blaze_powder', 6], ['ender_eye', 2], ['shield', 1], ['cooked_beef', 20]]))?.kind).toBe('rods');
    // Fewer than seven: the blaze gate as before (or nothing when ready).
    expect(deadlyGateHold(fightBlaze, frame([['blaze_rod', 6], ['shield', 1], ['cooked_beef', 20], ['iron_sword', 1]]))).toBeNull();
    // A shot with the bow is held as well (S2, 11/5).
    expect(deadlyGateHold({ hands: [{ do: 'shoot', target: 'blaze', item: 'bow' }] }, frame([['blaze_rod', 7]]))?.kind).toBe('rods');
    // Other foes are not held.
    expect(deadlyGateHold({ hands: [{ do: 'fight', target: 'wither_skeleton' }] }, frame([['blaze_rod', 7]]))).toBeNull();
  });
});
