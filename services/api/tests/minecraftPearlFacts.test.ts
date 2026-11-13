import { describe, expect, it } from 'vitest';
import { seenMarks } from '../src/surfaces/minecraft/minecraftSeenMarks.js';
import { pearlLine, pearlSearchLines } from '../src/surfaces/minecraft/minecraftPearlFacts.js';

/** The pearls still to find, as numbers beside the choices (the pearl forest scenes: 18 gold and 2 endermen in 10 minutes, and no trade set against the wait). */
const pack = (items: Record<string, number>) => new Map(Object.entries(items));

describe('the pearl line', () => {
  it('says how many are missing and what the gold carried gives, eyes counted as pearls', () => {
    expect(pearlLine(pack({ ender_pearl: 3, gold_ingot: 18, blaze_rod: 7 }), 'the_nether'))
      .toBe('パール 3/14（あと 11 個）: エンダーマン 1 体で平均 0.5 個（あと 約 22 体）。'
        + 'ピグリンとの交換は金の延べ棒 15.6 個（金塊 約 140 個・ネザー金鉱石 約 35 個）で平均 1 個、持っている金の延べ棒 18 個では平均 約 1.2 個');
    expect(pearlLine(pack({ ender_pearl: 3, ender_eye: 4, blaze_powder: 2 }), 'the_nether')).toContain('パール 7/14（あと 7 個）');
  });
  it('sets the endermen beside the trade when no gold is carried (h28: the gold line alone sent Haiku digging gold ore)', () => {
    const line = pearlLine(pack({ blaze_rod: 7 }), 'the_nether')!;
    expect(line).toContain('パール 0/14（あと 14 個）: エンダーマン 1 体で平均 0.5 個（あと 約 28 体）');
    expect(line).toContain('ネザー金鉱石 約 35 個');
  });
  it('says nothing outside the Nether, with the pearls found, or before rods and pearls begin', () => {
    expect(pearlLine(pack({ ender_pearl: 3, gold_ingot: 18 }), 'overworld')).toBeNull();
    expect(pearlLine(pack({ ender_pearl: 14 }), 'the_nether')).toBeNull();
    expect(pearlLine(pack({ gold_ingot: 18 }), 'the_nether')).toBeNull();
  });
});

describe('the search for a warped forest (run 9: 0 scans after the rods, then the way back for pearls)', () => {
  const none = { scans: 0, goes: 0 };
  it('names the forest as unseen, the search so far, the way back and what to do first, only with 7 rods and pearls missing in the Nether', () => {
    const world = { biomesSeen: 'nether_wastes（ここ）・crimson_forest 西 120m', rememberedPlaces: { nether_portal: '240m 南 (1,2,3)' } };
    const lines = pearlSearchLines(world, pack({ blaze_rod: 7 }), 'the_nether', { scans: 1, goes: 2 }).join(' ');
    expect(lines).toContain('歪んだ森: 未見。探した回数（走査→go の組） 2（走査 1 回）。ゲートまで 240m（歩いて 約 200 秒）。');
    expect(lines).toContain('通ったバイオーム: nether_wastes（ここ）・crimson_forest 西 120m');
    expect(lines).toContain('mc_probe kind=scan → 見えていない向きへ 90m の go → 走査');
    expect(lines).toContain('黒曜石 12 はピグリンとの交換でも出る');
    expect(pearlSearchLines(world, pack({ blaze_rod: 6 }), 'the_nether', none)).toEqual([]);
    expect(pearlSearchLines(world, pack({ blaze_rod: 7 }), 'overworld', none)).toEqual([]);
    expect(pearlSearchLines(world, pack({ blaze_rod: 7, ender_eye: 14 }), 'the_nether', none)).toEqual([]);
  });
  it('leaves the search at 12 eyes, counts 2 powder as a rod, and closes a search that finds nothing after 3 pairs', () => {
    const world = { biomesSeen: 'nether_wastes（ここ）' };
    expect(pearlSearchLines(world, pack({ blaze_rod: 7, ender_eye: 12 }), 'the_nether', none)).toEqual([]);
    expect(pearlSearchLines(world, pack({ blaze_powder: 13 }), 'the_nether', none)).toEqual([]);
    const out = pearlSearchLines(world, pack({ blaze_rod: 7 }), 'the_nether', { scans: 3, goes: 3 }).join(' ');
    expect(out).toContain('探しても出ない');
    expect(out).toContain('skip と理由で閉じ');
    expect(pearlSearchLines({ biomesSeen: 'warped_forest 東 150m' }, pack({ blaze_rod: 7 }), 'the_nether', none).join(' ')).toContain('skip と理由で閉じ');
  });
  it('points at a forest the body reported instead of another scan, and the forest closes the plan node by see:warped_forest', () => {
    const world = { biomesSeen: 'nether_wastes（ここ）・warped_forest 東 150m' };
    const lines = pearlSearchLines(world, pack({ blaze_powder: 14 }), 'the_nether', none).join(' ');
    expect(lines).toContain('歪んだ森: warped_forest 東 150m');
    expect(lines).toContain('fight target=enderman');
    expect(lines).not.toContain('次の手: mc_probe kind=scan');
    expect(lines).not.toContain('歪んだ森の控え');
    const placed = pearlSearchLines({ ...world, rememberedPlaces: { warped_forest: '150m 東 (9,9,9)' } }, pack({ blaze_powder: 14 }), 'the_nether', none).join(' ');
    expect(placed).toContain('歪んだ森の控え: y は目安');
    expect(placed).toContain('scan の幹');
    expect(seenMarks(world).has('warped_forest')).toBe(true);
    expect(seenMarks({ biomesSeen: 'nether_wastes（ここ）・warped_forest 未見' }).has('warped_forest')).toBe(false);
    expect(seenMarks({ rememberedPlaces: { warped_forest: '150m 東 (9,9,9)' } }).has('warped_forest')).toBe(true);
  });
});

describe('the plan after the Nether gate puts the search before the hunt and the way back after the eyes', () => {
  it('has 歪んだ森を探す first under the pearl node, closed by see:warped_forest, and the way back waits for pearls and eyes', async () => {
    const { seedPlan } = await import('../src/surfaces/minecraft/minecraftFirstPlan.js');
    const { parseDoneWhen } = await import('../src/surfaces/minecraft/minecraftPlanDone.js');
    const nodes = seedPlan('エンドラを討伐して', 'the_nether')!.nodes;
    const search = nodes.findIndex(node => node.title.startsWith('歪んだ森を探す'));
    const hunt = nodes.findIndex(node => node.title.startsWith('歪んだ森のエンダーマン'));
    const back = nodes.findIndex(node => node.title === 'オーバーワールドへ戻る');
    expect(search).toBeGreaterThan(-1);
    expect(search).toBeLessThan(hunt);
    expect(hunt).toBeLessThan(back);
    expect(parseDoneWhen(nodes[search]!.doneWhen!)).toEqual([[{ kind: 'see', what: 'warped_forest' }]]);
    expect(nodes[back]!.note).toContain('パールとアイがそろってから');
  });
});
