import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { whereCheckLine, ARRIVED_METERS } from '../src/surfaces/minecraft/minecraftLlmcWhereCheck.js';
import { planNowOf } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { nearbyLines, nearbyResourcesOf } from '../src/surfaces/minecraft/minecraftLlmcNearby.js';
import { ironSearchLine, nearIronHands } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { createFoodTrend, minecraftLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';

/**
 * The place a node names is said at the node: far from it, as what was read when the plan was written; at it, against the body's count of the plants round her.
 * The morning's replay: she stood 12 m from a field's coordinate that was bare cobblestone, the node line still said 「畑・作物 (x,y,z)」 and the sentence that says to mend
 * the `where` was in the stage's knowledge.
 */
const observation = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: '2026-01-01T00:08:00Z',
  receivedAt: 't', connected: true, state: { world } as never, facts: {} as never });
const node = { id: 'p1.1', title: '小麦3を集める', state: 'continue', where: '畑・作物 (-115,70,-149)', doneWhen: 'have:wheat>=3' } as { id: string; title: string; state: 'continue'; where: string; doneWhen: string };
const lava = { purpose: 'lava', kind: 'lava', count: 0, range: 96, sites: [] };
const world = (x: number, z: number, resources: unknown[]) => ({ position: { x, y: 71, z }, dimension: 'overworld', nearbyResources: resources });

describe('whereCheckLine: the node\'s place against her feet and the body\'s count', () => {
  it('far from the place: it is a reading from when the plan was written, to be looked at again on arriving', () => {
    const line = whereCheckLine(node, observation(world(-50, -115, [lava])))!;
    expect(line).toContain('(-115,70,-149)');
    expect(line).toContain('足元から水平 73m');
    expect(line).toContain('計画を書いた時に読んだ物');
    expect(line).toContain('着いたら今の観測で 畑・作物 を確かめる');
  });
  it('at the place with no plant in the count (the morning\'s case): says it is not there and how to mend the where', () => {
    const line = whereCheckLine(node, observation(world(-105, -157, [lava, { purpose: 'wood', kind: 'oak_log', count: 3, range: 64, sites: [{ x: -90, y: 70, z: -160 }] }])))!;
    expect(ARRIVED_METERS).toBeGreaterThanOrEqual(13);
    expect(line).toContain('に着いている');
    expect(line).toContain('畑・作物 は載っていない');
    expect(line).toContain('plan_update の set で where を直す');
    expect(line).toContain('同じ座標をもう確かめに行かない');
  });
  it('at the place with the crop elsewhere: gives its nearest place and its distance from the where', () => {
    const line = whereCheckLine(node, observation(world(-105, -157, [lava, { purpose: 'plant', kind: 'wheat', count: 4, range: 48,
      sites: [{ x: -80, y: 70, z: -170, note: '育ち中 2/7' }] }])))!;
    expect(line).toContain('そこに 畑・作物 は見えない');
    expect(line).toContain('wheat (-80,70,-170)');
    expect(line).toContain('where から 41m');
  });
  it('says nothing when the crop is where the node says, for a body whose count was not read, outside the overworld, and for a node with no thing or no place', () => {
    const here = { purpose: 'plant', kind: 'wheat', count: 2, range: 48, sites: [{ x: -114, y: 70, z: -150, note: '育った' }] };
    expect(whereCheckLine(node, observation(world(-105, -157, [lava, here])))).toBeNull();
    expect(whereCheckLine(node, observation(world(-105, -157, [])))).toBeNull();
    expect(whereCheckLine(node, observation({ ...world(-105, -157, [lava]), dimension: 'the_nether' }))).toBeNull();
    expect(whereCheckLine({ ...node, where: '' } as never, observation(world(-105, -157, [lava])))).toBeNull();
    expect(whereCheckLine({ ...node, where: '走査の最寄り（畑）' } as never, observation(world(-105, -157, [lava])))).toBeNull();
    expect(whereCheckLine({ id: 'p2', title: '作業台を作る', state: 'continue', where: '(-100,70,-150)' } as never, observation(world(-50, -115, [lava])))).toBeNull();
    expect(whereCheckLine({ ...node, state: 'done' } as never, observation(world(-105, -157, [lava])))).toBeNull();
  });
  it('an ore far away gets the same note; at it nothing is said (the count cannot tell a buried ore)', () => {
    const iron = { id: 'p1.4', title: '鉄インゴット9個', state: 'continue', where: '鉄鉱石 (-131,28,-140)' } as never;
    expect(whereCheckLine(iron, observation(world(-50, -115, [lava])))).toContain('鉄鉱石 を確かめる');
    expect(whereCheckLine(iron, observation(world(-130, -139, [lava])))).toBeNull();
  });
  it('is part of the plan\'s now (the line the decision reads before the map)', () => {
    const tree = { schema: 'plan-tree/1', revision: 1, current: 'p1.1', nodes: [{ id: 'p1.1', parentId: null, order: 0, title: '小麦3を集める', state: 'continue', where: '畑・作物 (-115,70,-149)',
      doneWhen: 'have:wheat>=3' }], promises: [] } as never;
    const now = planNowOf(tree, null, observation(world(-105, -157, [lava])))!;
    expect(now).toContain('[p1.1] 小麦3を集める');
    expect(now).toContain('畑・作物 は載っていない');
  });
});

describe('a crop that is not grown says what a dig does to it, at the row the dig\'s target is read from', () => {
  const raw = (note: string) => [{ purpose: 'plant', kind: 'wheat', count: 3, range: 48, sites: [{ x: -114, y: 70, z: -150, note }] }];
  const feet = { x: -105, y: 71, z: -157 };
  it('a young crop: the stage, that a dig gives the seed back, and the ways on', () => {
    const line = nearbyLines(nearbyResourcesOf(raw('育ち中 2/7')), feet)[0]!;
    expect(line).toContain('育ち中 2/7');
    expect(line).toContain('dig すると種に戻る');
    expect(line).toContain('骨粉を use');
  });
  it('a grown crop says nothing of it', () => {
    expect(nearbyLines(nearbyResourcesOf(raw('育った')), feet)[0]).not.toContain('種に戻る');
  });
  describe('in the decision own input (quiet): a young crop has no place to aim a hand at, and the growth is said to be counted again', () => {
    it('leaves the cell out of the young crop row, keeps the way (west/north/up and metres), and says no go, look or dig is needed to see its growth', () => {
      const line = nearbyLines(nearbyResourcesOf(raw('育ち中 1/7')), { x: -113, y: 69, z: -149 }, '', true)[0]!;
      expect(line).toContain('wheat 48m 内に 3個。最寄り 西1・北1・上1 2m（育ち中 1/7）');
      expect(line).not.toContain('(-114,70,-150)');
      expect(line).toContain('育ちを確かめるのに go・look・dig は要らない');
      expect(line).toContain('「育った」と出たら座標つきで出る');
    });
    it('keeps the cell of a grown crop and gives a young one after it only as metres', () => {
      const mixed = [{ purpose: 'plant', kind: 'wheat', count: 3, range: 48, sites: [{ x: -114, y: 70, z: -150, note: '育った' }, { x: -113, y: 70, z: -150, note: '育ち中 3/7' }] }];
      const line = nearbyLines(nearbyResourcesOf(mixed), { x: -116, y: 69, z: -151 }, '小麦', true)[0]!;
      expect(line).toContain('最寄り (-114,70,-150)');
      expect(line).toContain('（育った） / 3m（育ち中 3/7）');
      expect(line).not.toContain('(-113,70,-150)');
    });
    it('says nothing different of a row with no young crop, and the row not quiet keeps the cell and the bone meal words', () => {
      expect(nearbyLines(nearbyResourcesOf(raw('育った')), feet, '', true)[0]).toBe(nearbyLines(nearbyResourcesOf(raw('育った')), feet)[0]);
      const loud = nearbyLines(nearbyResourcesOf(raw('育ち中 1/7')), feet)[0]!;
      expect(loud).toContain('(-114,70,-150)');
      expect(loud).toContain('骨粉を use');
    });
    it('the live nearby is quiet unless she holds bone meal (using it needs the cell)', () => {
      const liveFor = (inventory: string[]): string => JSON.stringify(minecraftLlmcLive({ elapsedMinutes: 1, trend: createFoodTrend(() => 0), events: [],
        observation: observation({ position: { x: -113, y: 69, z: -149 }, dimension: 'overworld', inventory, nearbyResources: raw('育ち中 1/7') }) }).nearby);
      expect(liveFor(['coal×4'])).not.toContain('(-114,70,-150)');
      expect(liveFor(['coal×4'])).toContain('手を向ける物ではない');
      expect(liveFor(['coal×4', 'bone_meal×3'])).toContain('(-114,70,-150)');
      expect(liveFor(['coal×4', 'bone_meal×3'])).not.toContain('手を向ける物ではない');
    });
  });
});

describe('iron: the nearest ore\'s hands are in the input as they can be sent, and a still ore is believed', () => {
  const T0 = Date.parse('2026-01-01T00:00:00Z');
  const row = '鉄鉱石 ×33907 最寄り (-73,61,-119) 東12m・下10 ｜空気に面した最寄り (-91,30,-140) 北23m・下41';
  const scan = { trigger: 'login', at: new Date(T0).toISOString(), center: { x: -113, y: 67, z: -152 }, text: '鉄', rows: [row] };
  const pack = new Map([['stone_pickaxe', 1]]);
  const now = { id: 'p1.4', title: '鉄を掘る', doneWhen: 'have:iron_ingot>=9' } as never;
  it('a far ore: go first (mine gives a cell up after a few seconds), digging only rock, with a bound; then mine', () => {
    const hands = nearIronHands(row, { x: -50, y: 72, z: -115 });
    expect(hands).toContain('go -73,61,-119 range=2 dig=stone,dirt,gravel');
    expect(hands).toMatch(/maxDig=\d+ seconds=\d+/u);
    expect(hands).toContain('mine iron_ore -73,61,-119 count=3');
    expect(hands).toContain('go が先');
  });
  it('a near ore: mine alone; below y=0 the deepslate name', () => {
    expect(nearIronHands(row, { x: -70, y: 62, z: -120 })).toContain('mine だけで届く');
    expect(nearIronHands(row.replace('(-73,61,-119)', '(-73,-12,-119)'), { x: -70, y: -10, z: -120 })).toContain('mine deepslate_iron_ore -73,-12,-119 count=3');
    expect(nearIronHands('鉄鉱石 ×3', null)).toBe('');
  });
  it('the iron line carries the hands and the form of mine (so its contract is not read first), and has no "unconfirmed" mark', () => {
    const line = ironSearchLine({ position: { x: -50, y: 72, z: -115 }, mapLandmarks: [], scan }, pack, 'overworld', now, T0 + 3 * 60_000)!;
    expect(line).toContain('鉄鉱石の当て（走査 3 分前');
    expect(line).not.toContain('今は未確認');
    expect(line).not.toContain('先に probe で確かめなくてよい');
    expect(line).toContain('契約（skill_read）を読まずにそのまま出せる: 「mine iron_ore X,Y,Z count=3」');
    expect(line).toContain('岩に埋まっていても岩・土を掘って届く');
    expect(line).toContain('go -73,61,-119');
  });
  it('iron the map shows near her is mined where it is: the scan\'s nearest is the nearest to its base, so its hands are not said (the form of mine is)', () => {
    const seen = ironSearchLine({ position: { x: -50, y: 72, z: -115 }, mapLandmarks: ['i 鉄鉱石[iron_ore] (-52,70,-118) 西2・南3・下2 ×1 見えている'], scan }, pack, 'overworld', now, T0 + 3 * 60_000)!;
    expect(seen).toContain('鉄鉱石の当て（走査 3 分前');
    expect(seen).not.toContain('この鉄の手');
    expect(seen).toContain('契約（skill_read）を読まずにそのまま出せる');
  });
  it('a row past the still limit is not said as a lead (the time is passed, so the old row is not "there")', () => {
    const line = ironSearchLine({ position: { x: -50, y: 72, z: -115 }, mapLandmarks: [], scan }, pack, 'overworld', now, T0 + 100 * 60_000) ?? '';
    expect(line).not.toContain('鉄鉱石の当て');
  });
});

describe('iron wanted through the buckets of a cake: the iron line and its ledger are in front of her though the node is not about iron', () => {
  const T0 = Date.parse('2026-01-01T00:00:00Z');
  const row = '鉄鉱石 ×33031 最寄り (-129,66,-151) 北 12m・下 5 埋まり・17マス掘り歩き｜空気に面した最寄り (-131,28,-140) 西 6m・下 43';
  const scan = { trigger: 'login', at: new Date(T0).toISOString(), center: { x: -125, y: 71, z: -140 }, text: '鉄', rows: [row] };
  const cake = { id: 'p1.5', title: 'ケーキを工作台で作る', doneWhen: 'have:cake>=1', target: { item: 'cake', count: 1 } } as never;
  const world = { position: { x: -125, y: 71, z: -140 }, mapLandmarks: [], scan };
  const pack = (extra: Record<string, number> = {}) => new Map<string, number>([['stone_pickaxe', 1], ['raw_iron', 2], ...Object.entries(extra)]);
  it('3 buckets lacking and 2 raw iron: the ledger (7 raw iron to dig and smelt), the scan row, the hand of the near ore and the form of mine', () => {
    const line = ironSearchLine(world, pack(), 'overworld', cake, T0 + 60_000)!;
    expect(line).toContain('鉄の勘定: インゴット 9 要る（今 インゴット 0・生の鉄 2');
    expect(line).toContain('あと生の鉄 7 を掘って焼く');
    expect(line).toContain('make は材料不足で止まる');
    expect(line).toContain('mine iron_ore -129,66,-151 count=3');
    expect(line).toContain('契約（skill_read）を読まずにそのまま出せる');
  });
  it('a milk bucket held counts as a bucket made: 2 lacking is 6 ingots; the buckets all held, the line is not said', () => {
    expect(ironSearchLine(world, pack({ milk_bucket: 1 }), 'overworld', cake, T0 + 60_000)).toContain('インゴット 6 要る');
    expect(ironSearchLine(world, pack({ milk_bucket: 3 }), 'overworld', cake, T0 + 60_000)).toBeNull();
  });
  it('enough ingots and raw iron for them: say to smelt, not to dig; a node with no iron in it and no cake says nothing', () => {
    const smelt = ironSearchLine(world, pack({ raw_iron: 9 }), 'overworld', { id: 'p1.4.1.1', title: '鉄', doneWhen: 'have:iron_ingot>=9' } as never, T0 + 60_000)!;
    expect(smelt).toContain('生の鉄は足りている。炉で焼く');
    expect(ironSearchLine(world, pack(), 'overworld', { id: 'p1.1', title: '木を集める', doneWhen: 'have:log>=4' } as never, T0 + 60_000)).toBeNull();
  });
});
