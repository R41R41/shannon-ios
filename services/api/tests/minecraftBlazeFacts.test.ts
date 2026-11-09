import { describe, expect, it } from 'vitest';
import { blazesInSpawnerBox, createBlazeWatch, footingLine, retreatLine, strikeLine, watchLine } from '../src/surfaces/minecraft/minecraftBlazeFacts.js';

/** The blaze camp as causes and numbers: six around the spawner hold the spawn, so waiting adds no kill; the lab saw them gone after 150 s farther than 32 blocks. */
const blazes = (count: number, distance = 8) => ({ nearbyThreats: Array.from({ length: count }, (_, index) => ({ id: index, name: 'blaze', distance })) });
const counts = (rods: number) => new Map([['blaze_rod', rods]]);
const NETHER = 'the_nether';

describe('watchLine', () => {
  it('gives the cause and the lab numbers when six or more are left, and names no hand', () => {
    const line = watchLine(6, 6 * 60_000, 4, 4)!;
    expect(line).toContain('湧き場の近くで 6 分 0 秒: 撃破 4 体・棒 4/7');
    expect(line).toContain('スポナーは止まっている（周りに 6 体いると新しく湧かない）。ここで待っても撃破は増えない');
    expect(line).toContain('32 マスより遠くで 150 秒待つと生き残りが消え、湧きが戻る（ラボ実測: 戻った時 0〜3 体）');
  });
  it('says the rate after two minutes, and after five minutes with no kill the number around (not the cause of six)', () => {
    expect(watchLine(3, 60_000, 0, 2)).toBeNull();
    expect(watchLine(3, 3 * 60_000, 1, 2)).toBe('湧き場の近くで 3 分 0 秒: 撃破 1 体・棒 2/7');
    const quiet = watchLine(3, 5 * 60_000, 0, 2)!;
    expect(quiet).toContain('撃破 0 体');
    expect(quiet).toContain('いま周りに 3 体（6 体いると新しく湧かない）');
    expect(quiet).not.toContain('ここで待っても');
  });
  it('is silent once seven rods are carried', () => {
    expect(watchLine(6, 6 * 60_000, 4, 7)).toBeNull();
    expect(watchLine(6, 6 * 60_000, 4, 7, 32)).toBeNull();
  });
  it('says the sword with the h16 numbers from the first frame while a bow and arrows are carried, and keeps the arrows for the End (owner 11/8)', () => {
    const first = watchLine(3, 10_000, 0, 0, 32)!;
    expect(first).toContain('ブレイズは剣で倒す: 体力 14 以上の時に、見えている 8m 内の 1 体へ attack target=#id');
    expect(first).toContain('追って斬った 2 回は 3 秒以内に倒し傷 0、動かず待つ hold は約 25 回で 1 体');
    expect(first).toContain('矢 32 本はエンド用に残す');
    expect(first).not.toContain('shoot');
    const later = watchLine(3, 3 * 60_000, 1, 2, 20)!;
    expect(later.startsWith('湧き場の近くで 3 分 0 秒: 撃破 1 体・棒 2/7。')).toBe(true);
    expect(later).toContain('矢 20 本はエンド用');
  });
});

describe('the arrows kept in the watch', () => {
  it('needs both a bow and arrows in the pack', () => {
    const pack = (items: Array<[string, number]>) => new Map(items);
    expect(createBlazeWatch(null).line(blazes(2), pack([['bow', 1], ['arrow', 32]]), NETHER, 0)).toContain('矢 32 本はエンド用');
    expect(createBlazeWatch(null).line(blazes(2), pack([['arrow', 32]]), NETHER, 0)).toBeNull();
    expect(createBlazeWatch(null).line(blazes(2), pack([['bow', 1]]), NETHER, 0)).toBeNull();
  });
});

describe('the spawner\'s 16 m (end1108h12: the walks out of the fireballs went 24 m off, and she waited 3 minutes for nothing)', () => {
  const SPAWNER = 'S スポナー (146,75,74) 西24m・上1 blaze';
  const at = (x: number, count = 2) => ({ ...blazes(count), position: { x, y: 74, z: 74 }, mapLandmarks: [SPAWNER, 'F ネザー要塞 (150,70,70) 東4m'] });
  it('says the distance from 12 m, and that farther than 16 m nothing spawns', () => {
    const watch = createBlazeWatch(null);
    expect(watch.line(at(156), counts(0), NETHER, 0)).toBeNull();
    expect(watch.line(at(160), counts(0), NETHER, 1_000)).toBe('ブレイズのスポナー (146,75,74) まで 14m（16m を超えると新しく湧かない）');
    const far = watch.line(at(170), counts(1), NETHER, 3 * 60_000)!;
    expect(far.startsWith('湧き場の近くで 3 分 0 秒: 撃破 0 体・棒 1/7。ブレイズのスポナー (146,75,74) まで 24m: 16m より遠いと新しく湧かない')).toBe(true);
    expect(far).toContain('湧き場から 3m 以内の野営マスへ戻る');
  });
  it('says the far line with no blaze near while the watch holds, and nothing once seven rods are carried or with no blaze spawner marked', () => {
    const watch = createBlazeWatch(null);
    watch.line(at(150), counts(0), NETHER, 0);
    expect(watch.line(at(170, 0), counts(0), NETHER, 60_000)).toContain('まで 24m: 16m より遠い');
    expect(watch.line(at(170), counts(7), NETHER, 70_000)).toBeNull();
    expect(createBlazeWatch(null).line({ ...at(170), mapLandmarks: ['S スポナー (146,75,74) 西24m zombie'] }, counts(0), NETHER, 0)).toBeNull();
  });
  it('keeps the far line after three quiet minutes on the same Nether visit, and drops it once she leaves (end1108h15: 7 minutes at 20 m, 0 kills)', () => {
    const watch = createBlazeWatch(null);
    expect(watch.line(at(170, 0), counts(0), NETHER, 0)).toBeNull();   // never near blazes yet on this visit: no line on the way in
    watch.line(at(150), counts(0), NETHER, 1_000);
    const quiet = watch.line(at(170, 0), counts(3), NETHER, 10 * 60_000)!;
    expect(quiet).toContain('まで 24m: 16m より遠い');
    expect(watch.checkpoint().minecraftBlazeWatch.since).toBeNull();
    expect(createBlazeWatch(watch.checkpoint().minecraftBlazeWatch).line(at(170, 0), counts(3), NETHER, 11 * 60_000)).toContain('16m より遠い');
    watch.line(at(170, 0), counts(3), 'overworld', 12 * 60_000);
    expect(watch.line(at(170, 0), counts(3), NETHER, 13 * 60_000)).toBeNull();
  });
  it('says the spawn box with or without a blaze near (end1108h13: a wait at 2 m, blazes at 0.5 m, 18.9 → 9.4 in 10 s)', () => {
    const watch = createBlazeWatch(null);
    const inside = watch.line(at(148), counts(0), NETHER, 0)!;
    expect(inside).toContain('ブレイズのスポナー (146,75,74) まで 2m: 湧く範囲（横 4 マス・上下 1）の中なので、体のすぐ隣に湧く');
    expect(inside).toContain('ここで hold・wait で待たない');
    expect(watch.line(at(150, 0), counts(0), NETHER, 30_000)).toContain('湧く範囲');
    expect(watch.line({ ...at(148, 0), position: { x: 148, y: 80, z: 74 } }, counts(0), NETHER, 40_000)).toBeNull();
  });
});

describe('createBlazeWatch', () => {
  it('starts when blazes come near in the Nether, counts a kill once, and keeps through the checkpoint', () => {
    const watch = createBlazeWatch(null);
    expect(watch.line(blazes(2), counts(2), NETHER, 0)).toBeNull();
    const result = JSON.stringify({ v: 1, done: 1, of: 1, lines: [{ i: 1, do: 'fight', status: 'done', code: 'target_killed', line: 'blaze を倒した', goal: 'done', end: 'finished' }] });
    watch.note('r1', result, 60_000);
    watch.note('r1', result, 61_000);
    const line = watch.line(blazes(2), counts(2), NETHER, 3 * 60_000)!;
    expect(line).toBe('湧き場の近くで 3 分 0 秒: 撃破 1 体・棒 2/7');
    const again = createBlazeWatch(watch.checkpoint().minecraftBlazeWatch);
    expect(again.line(blazes(2), counts(2), NETHER, 3 * 60_000 + 1_000)).toContain('撃破 1 体');
  });
  it('ends when she leaves the Nether or no blaze was near for three minutes, and ignores far ones', () => {
    const watch = createBlazeWatch(null);
    watch.line(blazes(6), counts(0), NETHER, 0);
    expect(watch.line(blazes(0), counts(0), NETHER, 4 * 60_000)).toBeNull();
    expect(watch.line(blazes(3), counts(0), NETHER, 10 * 60_000)).toBeNull();
    watch.line(blazes(3), counts(0), 'overworld', 11 * 60_000);
    expect(watch.checkpoint().minecraftBlazeWatch.since).toBeNull();
    expect(createBlazeWatch(null).line(blazes(6, 80), counts(0), NETHER, 0)).toBeNull();
  });
});

describe('the way out below 14 (end1108h20: she ate and struck back at 11.3 where two blazes saw her, and died 48 s later)', () => {
  it('says to go to the hideout before eating or striking, first in the line', () => {
    const line = createBlazeWatch(null).line({ ...blazes(2), health: 11.3 }, counts(1), NETHER, 0)!;
    expect(line.startsWith('体力 11.3（14 未満）でブレイズ 2 体の近く')).toBe(true);
    expect(line).toContain('隠れ場所へ go で退く');
    expect(line).toContain('体力 18 以上で野営マスへ戻る');
    expect(line).toContain('hands が go 1 つだけで、act の accept に blaze を入れる');
  });
  it('says nothing at 14 or above, with no blaze near, with seven rods, or with no health known', () => {
    expect(retreatLine(14, 2)).toBeNull();
    expect(retreatLine(9, 0)).toBeNull();
    expect(retreatLine(undefined, 2)).toBeNull();
    expect(retreatLine(9, 1)).toContain('体力 9（14 未満）');
    expect(createBlazeWatch(null).line({ ...blazes(2), health: 9 }, counts(7), NETHER, 0)).toBeNull();
  });
});

describe('the spawner box (end1108h23: blazes counted to 32 m said the spawner was held)', () => {
  const SPAWNER = 'S スポナー (140,77,75) 東2m blaze';
  const world = (cells: Array<[number, number, number]>) => ({ position: { x: 136, y: 76, z: 74 }, mapLandmarks: [SPAWNER],
    nearbyThreats: cells.map(([x, y, z], id) => ({ id, name: 'blaze', distance: 8, position: { x, y, z } })) });
  it('counts only the blazes in the box 4 around the spawner block', () => {
    expect(blazesInSpawnerBox(world([[142, 78, 76], [137, 74, 73], [150, 77, 75], [140, 90, 75]]))).toBe(2);
    expect(blazesInSpawnerBox({ ...world([[142, 78, 76]]), mapLandmarks: [] })).toBeNull();
  });
  it('six far off do not hold it; six in the box do, and the line names the sword, not the 32 m walk', () => {
    const far = Array.from({ length: 6 }, (_, i) => [150 + i, 77, 75] as [number, number, number]);
    const line = createBlazeWatch(null).line(world(far), counts(2), NETHER, 0);
    expect(line ?? '').not.toContain('スポナーは止まっている');
    const near = Array.from({ length: 6 }, (_, i) => [138 + i * 0.5, 77, 75] as [number, number, number]);
    const held = createBlazeWatch(null).line(world(near), counts(2), NETHER, 0)!;
    expect(held).toContain('湧き場の周り 4 マスにブレイズ 6 体: スポナーは止まっている');
    expect(held).toContain('attack target=#id で斬ると');
    expect(held).not.toContain('32 マス');
  });
  it('the sword fact no longer sends her to wait behind a wall', () => {
    const first = watchLine(3, 10_000, 0, 0, 32)!;
    expect(first).not.toContain('見えないと寄ってくる');
    expect(first).toContain('壁の陰で attack hold して寄るのを待つのは効かない');
  });
});

describe('the distance said as numbers (end1109f03 replay: told the 8 m rule, she read 14.5 m as 待つ and attacked 1 of 8)', () => {
  const spawner = { mapLandmarks: ['S スポナー (0,64,0) 西14m blaze'] };
  const seen = (id: number, distance: number, dy = 0) => ({ id, name: 'blaze', distance, dy, lineOfSight: true });
  it('names the attack on the nearest seen blaze at sword height within 8 m', () => {
    const line = strikeLine({ position: { x: 20, y: 64, z: 0 }, health: 20, nearbyThreats: [seen(5, 12), seen(7, 6.2, 1)] })!;
    expect(line).toContain('見えている #7 は 6.2m');
    expect(line).toContain('今 attack target=#7');
  });
  it('sends her to 6 m of the spawner when none seen is within 8 m and health is 18 or more', () => {
    const line = strikeLine({ ...spawner, position: { x: 14, y: 64, z: 0 }, health: 20, nearbyThreats: [seen(1593, 14.5), { id: 2, name: 'blaze', distance: 5, lineOfSight: false }] })!;
    expect(line).toContain('一番近い見える #1593 は 14.5m、8m 内は 0 体 → 待っても寄って来ない');
    expect(line).toContain('go 0,64,0 range=3');
  });
  it('says to mend first below 18, and that blazes far up are out of reach', () => {
    expect(strikeLine({ ...spawner, position: { x: 14, y: 64, z: 0 }, health: 15, nearbyThreats: [seen(1, 14)] })).toContain('見えない所で食べて 18 以上');
    expect(strikeLine({ position: { x: 0, y: 64, z: 0 }, nearbyThreats: [seen(3, 6, 6)] })).toContain('届かないので attack を出さず');
  });
  it('skips an id the attack came back 届かない on, and says the sign of the height (review 11/9 07:40)', () => {
    const line = strikeLine({ position: { x: 20, y: 64, z: 0 }, health: 20, nearbyThreats: [seen(5, 6.5), seen(7, 6.2, 1)] }, new Set([7]))!;
    expect(line).toContain('今 attack target=#5');
    expect(line).not.toContain('target=#7');
    const only = strikeLine({ position: { x: 20, y: 64, z: 0 }, health: 20, nearbyThreats: [seen(7, 6.2, 1)] }, new Set([7]))!;
    expect(only).toContain('#7 は attack が「届かない」と返した相手');
    expect(only).not.toContain('target=#7');
    expect(strikeLine({ position: { x: 0, y: 64, z: 0 }, nearbyThreats: [seen(3, 6, -6)] })).toContain('#3 は下 6m');
  });
  it('keeps the id from the body 届かない line across a checkpoint', () => {
    const watch = createBlazeWatch({ v: 1, since: 0, lastNear: 0, kills: [], camped: true });
    watch.note('q1', JSON.stringify({ v: 1, done: 0, of: 1, lines: [{ i: 1, do: 'attack', status: 'stopped', code: 'cannot_reach', line: 'blaze（id 7） に届かない（6.2m、5秒近づけない）。3回振って 0回当たった' }] }), 1000);
    expect(createBlazeWatch(watch.checkpoint().minecraftBlazeWatch).checkpoint().minecraftBlazeWatch.unreached).toEqual([7]);
  });
  it('sends her out from behind the walls when every blaze is hidden (end1109f06), and says nothing with none at all', () => {
    const hid = (id: number) => ({ id, name: 'blaze', distance: 6, lineOfSight: false });
    const far = strikeLine({ ...spawner, position: { x: 9, y: 58, z: 6 }, health: 20, nearbyThreats: [hid(1), hid(2)] })!;
    expect(far).toContain('壁の向こうに 2 体');
    expect(far).toContain('go 0,64,0 range=3');
    expect(far).toContain('accept に blaze');
    const under = strikeLine({ ...spawner, position: { x: 3, y: 59, z: 0 }, health: 20, nearbyThreats: [hid(1)] })!;
    expect(under).toContain('壁の陰: 野営マス');
    expect(strikeLine({ position: { x: 0, y: 64, z: 0 }, nearbyThreats: [] })).toBeNull();
    const unfound = strikeLine({ position: { x: 0, y: 64, z: 0 }, health: 20, nearbyThreats: [hid(1)] })!;
    expect(unfound).toContain('湧き場はまだ見つかっていない');
    expect(unfound).toContain('mc_probe kind=camp');
  });
  it('names the fence the 届かない attack named, with dig and attack in one act (end1109f07), while she stands near it', () => {
    const watch = createBlazeWatch({ v: 1, since: 0, lastNear: 0, kills: [], camped: true });
    watch.note('q1', JSON.stringify({ v: 1, done: 0, of: 1, lines: [{ i: 1, do: 'attack', status: 'stopped', code: 'cannot_reach',
      line: 'blaze（id 905） に届かない（7.5m）。間に nether_brick_fence (4,65,2)：掘るか回り込めば近づける' }] }), 1000);
    const wall = createBlazeWatch(watch.checkpoint().minecraftBlazeWatch).checkpoint().minecraftBlazeWatch.wall;
    expect(wall).toEqual({ name: 'nether_brick_fence', x: 4, y: 65, z: 2 });
    const line = strikeLine({ ...spawner, position: { x: 5, y: 64, z: 4 }, health: 20, nearbyThreats: [seen(905, 7.6, 1), seen(906, 9)] }, new Set([905]), wall)!;
    expect(line).toContain('"dig 4,65,2 collect=false", "attack target=#906"');
    expect(line).toContain('accept に blaze');
    expect(line).not.toContain('8m 内に入ったらすぐ attack');
    const reach = strikeLine({ ...spawner, position: { x: 9, y: 64, z: 4 }, health: 20, nearbyThreats: [seen(906, 9)] }, new Set(), wall)!;
    expect(reach).toContain('"go 4,65,2 range=3", "dig 4,65,2 collect=false"');   // end1109f09: dig does not walk past 5 m
    expect(line).not.toContain('"go 4,65,2');
    expect(strikeLine({ ...spawner, position: { x: 30, y: 64, z: 4 }, health: 20, nearbyThreats: [seen(906, 9)] }, new Set(), wall)).not.toContain('dig 4,65,2');
    expect(strikeLine({ ...spawner, position: { x: 5, y: 64, z: 4 }, health: 12, nearbyThreats: [seen(906, 9)] }, new Set(), wall)).toContain('見えない所で食べて 18 以上');
  });
  it('keeps her off the open floor in sight of three blazes or more (end1109f07), but still names a blaze at sword height', () => {
    const high = strikeLine({ ...spawner, position: { x: 7, y: 64, z: 0 }, health: 20, nearbyThreats: [seen(1, 7.5, 4), seen(2, 8, 4), seen(3, 13, -1)] })!;
    expect(high).toContain('見えている射手が 3 体: 覆いの無い床へ出ない');
    expect(high).not.toContain('湧き場の部屋の床で剣の高さ');
    const far = strikeLine({ ...spawner, position: { x: 14, y: 64, z: 0 }, health: 20, nearbyThreats: [seen(1, 10), seen(2, 11), seen(3, 12)] })!;
    expect(far).toContain('射手が 3 体');
    expect(far).not.toContain('go 0,64,0 range=3');
    expect(strikeLine({ position: { x: 0, y: 64, z: 0 }, health: 20, nearbyThreats: [seen(1, 6, 1), seen(2, 9), seen(3, 10)] })).toContain('今 attack target=#1');
  });
  it('sends her back to cover, not to the attack, with three blazes or more seen within 8 m (end1109f16)', () => {
    const line = strikeLine({ position: { x: 0, y: 64, z: 0 }, health: 20, nearbyThreats: [seen(1, 1.6, 1), seen(2, 2.1), seen(3, 4)] })!;
    expect(line).toContain('8m 内に見える射手が 3 体（最寄りの見える #1 は 1.6m）→ ここで斬り合わない');
    expect(line).not.toContain('今 attack target=#1');
    expect(strikeLine({ position: { x: 0, y: 64, z: 0 }, health: 20, nearbyThreats: [seen(1, 2, 1), seen(2, 6)] })).toContain('今 attack target=#1');
  });
  it('counts the blazes behind the bricks too, and keeps her out of the camp cell beside a crowd (end1109f17)', () => {
    const hid = (id: number, distance: number) => ({ id, name: 'blaze', distance, lineOfSight: false });
    const mixed = strikeLine({ position: { x: 0, y: 64, z: 0 }, health: 20, nearbyThreats: [seen(1258, 1.6), hid(649, 2.4), seen(474, 2.6)] })!;
    expect(mixed).toContain('8m 内にブレイズが 3 体（見える 2・壁の向こう 1）');
    expect(mixed).toContain('dependsOn: []');
    expect(mixed).not.toContain('今 attack');
    const behind = strikeLine({ ...spawner, position: { x: 3, y: 59, z: 0 }, health: 20, nearbyThreats: [hid(1, 4.3), hid(2, 4.5), hid(3, 5.1), hid(4, 5.1)] })!;
    expect(behind).toContain('8m 内の 4 体はどれも壁の向こう → 野営マスへ入らず');
    expect(behind).not.toContain('野営マス（mc_probe');
  });
  it('lets her strike from her cover when one or two are seen past 3 m and the rest are behind the walls (end1109f25)', () => {
    const hid = (id: number, distance: number) => ({ id, name: 'blaze', distance, lineOfSight: false });
    const threats = [seen(764, 5.9), hid(1, 4.2), hid(2, 4.6), hid(3, 6.9), hid(4, 7)];
    const line = strikeLine({ position: { x: 0, y: 64, z: 0 }, health: 20, nearbyThreats: threats })!;
    expect(line).toContain('8m 内にブレイズが 5 体（見える 1・壁の向こう 4）');
    expect(line).toContain('今の陰が「見えるのが 1〜2 体の所」');
    expect(line).toContain('attack target=#764');
    expect(line).not.toContain('ここで斬り合わない');
    const dug = strikeLine({ position: { x: 0, y: 64, z: 0 }, health: 20, nearbyThreats: threats }, new Set(), { name: 'netherrack', x: 2, y: 64, z: 0 } as any)!;
    expect(dug).toContain('hands: ["dig 2,64,0 collect=false", "attack target=#764"]');
  });
});

describe('footingLine', () => {
  it('says the count and mine netherrack 64 below 48 blocks in the Nether, and the dig when none are left (end1109f05, end1109f14)', () => {
    const low = footingLine(new Map([['minecraft:netherrack', 10], ['cobblestone', 3]]), NETHER)!;
    expect(low).toContain('積める物 13 個');
    expect(low).toContain('mine netherrack <見えているネザーラックのマス> count=64');
    expect(low).toContain('要塞へ入る前のネザーラックの陸で足す');
    expect(footingLine(new Map([['netherrack', 40]]), NETHER)).toContain('積める物 40 個');
    expect(low).not.toContain('0 個で足場の先');
    expect(footingLine(new Map([['nether_bricks', 0]]), NETHER)).toContain('0 個で足場の先から動けない時は');
  });
  it('is silent with enough blocks, outside the Nether, or with the seven rods', () => {
    expect(footingLine(new Map([['cobblestone', 50]]), NETHER)).toBeNull();
    expect(footingLine(new Map(), 'overworld')).toBeNull();
    expect(footingLine(new Map([['blaze_rod', 7]]), NETHER)).toBeNull();
  });
});
