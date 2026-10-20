import { describe, expect, it } from 'vitest';
import type { LiveMoment } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { bodyInDanger, createMomentDetector, dayTick, dimensionOfWorld, isNightTick, mapDiamondCount, mapLavaDistance, mapStructures } from '../src/surfaces/minecraft/minecraftMoments.js';

const T0 = Date.parse('2026-10-20T10:00:00.000Z');
let sequence = 0;
const frame = (world: Record<string, unknown> = {}, facts: Record<string, string | number | boolean | null> = {}, connected = true): BodyObservation => ({
  schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: new Date(T0).toISOString(), receivedAt: new Date(T0).toISOString(), connected,
  state: { world: { dimension: 'overworld', health: 20, food: 20, time: '1000', inventory: [], ...world } },
  facts: { alive: true, dimension: 'overworld', ...facts },
});
const kinds = (moments: readonly LiveMoment[]) => moments.map(moment => moment.kind);
const stack = (name: string, count = 1) => ({ name, count });
const MAP = '構造物: 村: 171m 東 (287,85,13)／荒廃したポータル: 40m 北 (1,2,3)（黒曜石あり）\n鉱石: 鉄 5か所（10m 東 (1,2,3)）／ダイヤ 2か所（30m 南 (4,5,6)）\n溶岩の溜まり 1か所: 20m 西';

describe('the map and the clock', () => {
  it('reads the structures, the diamond count, the dimension and the day tick from the frame', () => {
    expect([...mapStructures(MAP)]).toEqual([['村', 171], ['荒廃したポータル', 40]]);
    expect(mapStructures(undefined).size).toBe(0);
    expect(mapDiamondCount(MAP)).toBe(2);
    expect(mapDiamondCount('鉱石: 鉄 5か所')).toBe(0);
    expect(dimensionOfWorld({ dimension: 'minecraft:the_nether' }, {})).toBe('the_nether');
    expect(dimensionOfWorld({}, { dimension: 'the_end' })).toBe('the_end');
    expect(dimensionOfWorld({ dimension: 'overworld' }, {})).toBe('overworld');
    expect(dimensionOfWorld({}, {})).toBeNull();
    expect(dayTick({ time: '24500' })).toBe(500);
    expect(dayTick({ time: 'x' })).toBeNull();
    expect([isNightTick(12_999), isNightTick(13_000), isNightTick(22_999), isNightTick(23_000)]).toEqual([false, true, true, false]);
  });
  it('knows danger: low health, or a hostile at her', () => {
    expect(bodyInDanger(frame({ health: 8 }))).toBe(true);
    expect(bodyInDanger(frame({ health: 9 }))).toBe(false);
    expect(bodyInDanger(frame({ nearbyThreats: [{ name: 'zombie', distance: 4, canReachMe: true }] }))).toBe(true);
    expect(bodyInDanger(frame({ nearbyThreats: [{ name: 'zombie', distance: 4, canReachMe: false }] }))).toBe(false);
    expect(bodyInDanger(frame({ health: 4 }, { alive: false }))).toBe(false);
  });
});

describe('createMomentDetector', () => {
  it('only remembers the first frame (what she already carried is not news)', () => {
    const detector = createMomentDetector();
    expect(detector.observe(frame({ inventory: [stack('diamond', 3)], mapSummary: MAP }), T0)).toEqual([]);
    expect(detector.observe(frame({ inventory: [stack('diamond', 3)], mapSummary: MAP }), T0 + 500)).toEqual([]);
  });

  it('notices a diamond carried, and a diamond ore the map newly knows, each once', () => {
    const detector = createMomentDetector();
    detector.observe(frame({ mapSummary: '鉱石: 鉄 1か所' }), T0);
    const ore = detector.observe(frame({ mapSummary: MAP }), T0 + 500);
    expect(ore.filter(moment => moment.kind === 'diamond_found').map(moment => moment.facts)).toEqual([{ count: 2, carried: false }]);
    expect(detector.observe(frame({ mapSummary: MAP }), T0 + 1000)).toEqual([]);
    const carried = detector.observe(frame({ mapSummary: MAP, inventory: [stack('diamond', 2)] }), T0 + 1500);
    expect(carried.map(moment => moment.facts)).toEqual([{ count: 2, carried: true }]);
    expect(detector.observe(frame({ mapSummary: MAP, inventory: [stack('diamond', 2)] }), T0 + 2000)).toEqual([]);
    expect(kinds(detector.observe(frame({ mapSummary: MAP, inventory: [stack('diamond', 3)] }), T0 + 2500))).toEqual(['diamond_found']);
  });

  it('notices the full set of armour once, and a new tier of pickaxe once', () => {
    const detector = createMomentDetector();
    detector.observe(frame({ inventory: [stack('iron_helmet'), stack('iron_chestplate'), stack('iron_leggings')] }), T0);
    const armour = detector.observe(frame({ inventory: [stack('iron_helmet'), stack('iron_chestplate'), stack('iron_leggings'), stack('iron_boots'), stack('iron_pickaxe')] }), T0 + 500);
    expect(kinds(armour).sort()).toEqual(['armor_complete', 'tool_made']);
    expect(armour.find(moment => moment.kind === 'tool_made')?.facts).toEqual({ item: 'iron_pickaxe' });
    detector.observe(frame({ inventory: [] }), T0 + 1000);
    expect(detector.observe(frame({ inventory: [stack('iron_helmet'), stack('iron_chestplate'), stack('iron_leggings'), stack('iron_boots'), stack('iron_pickaxe')] }), T0 + 1500)).toEqual([]);
    expect(kinds(detector.observe(frame({ inventory: [stack('diamond_pickaxe')] }), T0 + 2000))).toEqual(['tool_made']);
  });

  it('counts the armour she wears (the pack lists no worn piece)', () => {
    const detector = createMomentDetector();
    detector.observe(frame({ inventory: [] }), T0);
    const worn = detector.observe(frame({ worn: '頭: iron_helmet(残り200)、胴: iron_chestplate(残り300)、脚: iron_leggings(残り200)、足: iron_boots(残り150)' }), T0 + 500);
    expect(kinds(worn)).toEqual(['armor_complete']);
  });

  it('notices the first blaze rod, pearl, eye, flint and steel, ten obsidian and a bed, each once', () => {
    const detector = createMomentDetector();
    detector.observe(frame({ inventory: [stack('obsidian', 4)] }), T0);
    expect(detector.observe(frame({ inventory: [stack('obsidian', 9)] }), T0 + 500)).toEqual([]);
    const got = detector.observe(frame({ inventory: [stack('obsidian', 10), stack('blaze_rod', 2), stack('ender_pearl'), stack('white_bed')] }), T0 + 1000);
    expect(got.map(moment => moment.facts.item).sort()).toEqual(['bed', 'blaze_rod', 'ender_pearl', 'obsidian']);
    expect(detector.observe(frame({ inventory: [stack('obsidian', 20), stack('blaze_rod', 5), stack('ender_pearl', 3), stack('white_bed')] }), T0 + 1500)).toEqual([]);
  });

  it('notices a near death once and again only after her health came back', () => {
    const detector = createMomentDetector();
    detector.observe(frame({ health: 20 }), T0);
    const near = detector.observe(frame({ health: 5, nearbyThreats: [{ name: 'zombie', distance: 2, canReachMe: true }] }), T0 + 500);
    expect(near.map(moment => [moment.kind, moment.facts])).toEqual([['near_death', { health: 5, from: 'zombie' }]]);
    expect(detector.observe(frame({ health: 3 }), T0 + 1000)).toEqual([]);
    detector.observe(frame({ health: 14 }), T0 + 1500);
    expect(kinds(detector.observe(frame({ health: 6 }), T0 + 2000))).toEqual(['near_death']);
  });

  it('notices hunger, and a death', () => {
    const detector = createMomentDetector();
    detector.observe(frame({ food: 12 }), T0);
    expect(detector.observe(frame({ food: 6 }), T0 + 500).map(moment => moment.facts)).toEqual([{ food: 6 }]);
    expect(detector.observe(frame({ food: 5 }), T0 + 1000)).toEqual([]);
    const died = detector.observe(frame({ health: 0, deaths: [{ cause: 'minecraft:lava' }] }, { alive: false }), T0 + 1500);
    expect(died.map(moment => [moment.kind, moment.facts])).toEqual([['died', { cause: 'minecraft:lava' }]]);
    expect(detector.observe(frame({ health: 0 }, { alive: false }), T0 + 2000)).toEqual([]);
  });

  it('notices the night falling, the morning coming at the game\'s pace, and a night slept through', () => {
    const detector = createMomentDetector();
    detector.observe(frame({ time: '12990' }), T0);
    expect(kinds(detector.observe(frame({ time: '13010' }), T0 + 1000))).toEqual(['night_fell']);
    detector.observe(frame({ time: '22980' }), T0 + 2000);
    expect(kinds(detector.observe(frame({ time: '23020' }), T0 + 4000))).toEqual(['morning']);
    detector.observe(frame({ time: '13010' }), T0 + 5000);
    detector.observe(frame({ time: '14000' }), T0 + 6000);
    // The clock jumped from the dead of night to dawn within seconds: a bed.
    expect(kinds(detector.observe(frame({ time: '23500' }), T0 + 12_000))).toEqual(['slept']);
  });

  it('notices going to another dimension, and says nothing of the map it then reads for the first time', () => {
    const detector = createMomentDetector();
    detector.observe(frame({ mapSummary: '構造物: 村: 10m 東' }), T0);
    const entered = detector.observe(frame({ dimension: 'the_nether', mapSummary: '構造物: ネザー要塞: 90m 北 (1,2,3)' }, { dimension: 'the_nether' }), T0 + 500);
    expect(entered.map(moment => [moment.kind, moment.facts])).toEqual([['dimension_entered', { dimension: 'the_nether' }]]);
    const found = detector.observe(frame({ dimension: 'the_nether', mapSummary: '構造物: ネザー要塞: 90m 北 (1,2,3)／砦の遺跡: 150m 東 (4,5,6)' }, { dimension: 'the_nether' }), T0 + 1000);
    expect(found.map(moment => [moment.kind, moment.facts])).toEqual([['structure_found', { name: '砦の遺跡', distance: 150 }]]);
  });

  it('notices a new structure once, and only the ones worth a word', () => {
    const detector = createMomentDetector();
    detector.observe(frame({ mapSummary: '鉱石: 鉄 1か所' }), T0);
    const found = detector.observe(frame({ mapSummary: '構造物: 村: 171m 東 (1,2,3)／ネザーポータル: 3m 北 (1,2,3)' }), T0 + 500);
    expect(found.map(moment => moment.facts)).toEqual([{ name: '村', distance: 171 }]);
    expect(detector.observe(frame({ mapSummary: '構造物: 村: 100m 東 (1,2,3)' }), T0 + 1000)).toEqual([]);
  });

  it('notices a lava escape by the reflex counter, and the blaze coming near once', () => {
    const detector = createMomentDetector();
    detector.observe(frame({ dimension: 'the_nether', reflexes: { recent: [], counts: { lava: 0 } } }, { dimension: 'the_nether' }), T0);
    expect(kinds(detector.observe(frame({ dimension: 'the_nether', reflexes: { recent: [], counts: { lava: 1 } } }, { dimension: 'the_nether' }), T0 + 500))).toEqual(['lava_escape']);
    const near = { dimension: 'the_nether', nearbyThreats: [{ name: 'blaze', distance: 20, canReachMe: true }] };
    expect(kinds(detector.observe(frame(near, { dimension: 'the_nether' }), T0 + 1000))).toEqual(['blaze_seen']);
    expect(detector.observe(frame(near, { dimension: 'the_nether' }), T0 + 1500)).toEqual([]);
  });

  it('notices lava close by on the map once, and again only after she went away from it', () => {
    const detector = createMomentDetector();
    const lava = (metres: number) => frame({ mapSummary: `溶岩の溜まり 2か所: ${metres}m 西 (1,-55,3) 地下×31、90m 東 (2,60,3) 地表` });
    detector.observe(lava(40), T0);
    expect(detector.observe(lava(10), T0 + 500)).toEqual([]);
    expect(detector.observe(lava(5), T0 + 1000).map(moment => [moment.kind, moment.facts])).toEqual([['lava_near', { distance: 5 }]]);
    expect(detector.observe(lava(3), T0 + 1500)).toEqual([]);
    expect(detector.observe(lava(10), T0 + 2000)).toEqual([]);
    detector.observe(lava(30), T0 + 2500);
    expect(kinds(detector.observe(lava(4), T0 + 3000))).toEqual(['lava_near']);
    // Beside lava from the first frame is not news.
    const start = createMomentDetector();
    start.observe(lava(2), T0);
    expect(start.observe(lava(2), T0 + 500)).toEqual([]);
    expect(mapLavaDistance('鉱石: 鉄 1か所')).toBeNull();
  });

  it('notices the dragon and the crystals in the End', () => {
    const detector = createMomentDetector();
    const end = (entities: Array<Record<string, unknown>>) => frame({ dimension: 'the_end', nearbyEntities: entities }, { dimension: 'the_end' });
    const crystals = (count: number) => Array.from({ length: count }, (_, index) => ({ name: 'end_crystal', distance: 30 + index, position: { x: index, y: 80, z: 0 } }));
    detector.observe(end(crystals(10)), T0);
    expect(detector.observe(end([...crystals(10), { name: 'ender_dragon', distance: 60 }]), T0 + 500).map(moment => moment.facts)).toEqual([{ stage: 'seen' }]);
    expect(detector.observe(end(crystals(9)), T0 + 1000).map(moment => moment.facts)).toEqual([{ stage: 'crystals', crystals: 9 }]);
    expect(detector.observe(end(crystals(9)), T0 + 1500)).toEqual([]);
  });

  it('forgets the frame before on reset, and says nothing while the body is not connected', () => {
    const detector = createMomentDetector();
    detector.observe(frame({ inventory: [] }), T0);
    detector.reset();
    expect(detector.observe(frame({ inventory: [stack('diamond')] }), T0 + 500)).toEqual([]);
    expect(detector.observe(frame({ inventory: [stack('diamond', 2)] }, {}, false), T0 + 1000)).toEqual([]);
  });

  it('gives every moment a key that is the same for the same moment', () => {
    const detector = createMomentDetector();
    detector.observe(frame({}), T0);
    const first = detector.observe(frame({ inventory: [stack('iron_pickaxe')] }), T0 + 500);
    expect(first[0]?.key).toBe('tool:iron_pickaxe');
    expect(first[0]?.at).toBe(T0 + 500);
  });
});
