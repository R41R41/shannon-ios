import { describe, expect, it } from 'vitest';
import { nightArmsLine } from '../src/surfaces/minecraft/minecraftNightArms.js';

/** The night with nothing to fight with, as a fact (run60, 11/4 01:47). */
const pack = (...names: string[]) => new Map(names.map(name => [name, 1] as [string, number]));
const at = (time: string) => ({ time });

describe('nightArmsLine', () => {
  it('comes within three minutes of the night and through it, with no sword and no axe', () => {
    expect(nightArmsLine(at('12300'), pack('iron_ingot'), 'overworld')).toBe('夜まで 約 1 分: 剣も斧も荷に無い。夜は地上にゾンビ・スケルトンが湧く'.replace('約 1 分', '35 秒'));
    expect(nightArmsLine(at('9500'), pack(), 'overworld')).toContain('夜まで 約 3 分');
    expect(nightArmsLine(at('14000'), pack(), 'overworld')).toContain('夜（朝まで 約 8 分）');
  });
  it('is silent by day, at dawn, with a sword or an axe in the pack, and outside the overworld', () => {
    expect(nightArmsLine(at('6000'), pack(), 'overworld')).toBeNull();
    expect(nightArmsLine(at('23500'), pack(), 'overworld')).toBeNull();
    expect(nightArmsLine(at('14000'), pack('iron_sword'), 'overworld')).toBeNull();
    expect(nightArmsLine(at('14000'), pack('stone_axe'), 'overworld')).toBeNull();
    expect(nightArmsLine(at('14000'), pack('iron_pickaxe', 'shield'), 'overworld')).not.toBeNull();
    expect(nightArmsLine(at('14000'), pack(), 'the_nether')).toBeNull();
    expect(nightArmsLine({}, pack(), 'overworld')).toBeNull();
  });
});

describe('nightBedLine', () => {
  const bed = (...extra: string[]) => new Map([['white_bed', 1], ...extra.map(name => [name, 1] as [string, number])]);
  it('comes within a minute of the night and through it, with a bed in the pack and no enemy within 8 blocks, and names no hand', async () => {
    const { nightBedLine } = await import('../src/surfaces/minecraft/minecraftNightArms.js');
    expect(nightBedLine({ time: '12000' }, bed(), 'overworld')).toContain('寝られるのは夜になってから（あと 27 秒）');
    expect(nightBedLine({ time: '12000' }, bed(), 'overworld')).not.toContain('近くに敵がいる間');
    expect(nightBedLine({ time: '14000' }, bed(), 'overworld')).toContain('夜（朝まで 約 8 分）: ベッドを持っている');
    expect(nightBedLine({ time: '14000', nearbyThreats: [{ name: 'zombie', distance: 30 }] }, bed(), 'overworld')).not.toBeNull();
  });
  it('is silent by day, with no bed, with an enemy within 8 blocks, and outside the overworld', async () => {
    const { nightBedLine } = await import('../src/surfaces/minecraft/minecraftNightArms.js');
    expect(nightBedLine({ time: '6000' }, bed(), 'overworld')).toBeNull();
    expect(nightBedLine({ time: '11000' }, bed(), 'overworld')).toBeNull();
    expect(nightBedLine({ time: '11300' }, bed(), 'overworld')).toBeNull();
    expect(nightBedLine({ time: '14000' }, new Map([['stone', 3]]), 'overworld')).toBeNull();
    expect(nightBedLine({ time: '14000', nearbyThreats: [{ name: 'zombie', distance: 7 }] }, bed(), 'overworld')).toBeNull();
    expect(nightBedLine({ time: '14000' }, bed(), 'the_nether')).toBeNull();
  });
});

describe('swordLine and crowdLine', () => {
  it('names the sword and the iron while the best sword is below iron and iron for one is carried, at any hour', async () => {
    const { swordLine } = await import('../src/surfaces/minecraft/minecraftNightArms.js');
    const pack = (entries: Array<[string, number]>) => new Map(entries);
    expect(swordLine(pack([['stone_sword', 1], ['raw_iron', 8]]), 'overworld')).toBe('剣は stone_sword（鉄の剣は延べ棒 2 個と棒 1 本。持っている鉄: 延べ棒 0 個・生の鉄 8 個（焼くと延べ棒））');
    expect(swordLine(pack([['iron_ingot', 3]]), 'overworld')).toContain('剣は なし');
    expect(swordLine(pack([['wooden_sword', 1], ['stone_sword', 1], ['iron_ingot', 2]]), 'overworld')).toContain('剣は stone_sword');
    expect(swordLine(pack([['iron_sword', 1], ['iron_ingot', 8]]), 'overworld')).toBeNull();
    expect(swordLine(pack([['stone_sword', 1], ['iron_ingot', 1]]), 'overworld')).toBeNull();
    expect(swordLine(pack([['stone_sword', 1], ['iron_ingot', 8]]), 'the_nether')).toBeNull();
  });
  it('counts three or more enemies within 8 blocks and says how many can strike; silent with two or far ones', async () => {
    const { crowdLine } = await import('../src/surfaces/minecraft/minecraftNightArms.js');
    const zombie = (distance: number) => ({ name: 'zombie', distance });
    expect(crowdLine({ nearbyThreats: [zombie(2), zombie(3), zombie(5), { name: 'skeleton', distance: 7 }, zombie(30)] }))
      .toBe('8m 内に敵 4 体（zombie・skeleton）: 開けた所では全員が同時に殴る。幅 1 の通路では前の 1 体ずつになる');
    expect(crowdLine({ nearbyThreats: [zombie(2), zombie(3)] })).toBeNull();
    expect(crowdLine({ nearbyThreats: [zombie(2), zombie(3), zombie(9)] })).toBeNull();
    expect(crowdLine({})).toBeNull();
  });
});
