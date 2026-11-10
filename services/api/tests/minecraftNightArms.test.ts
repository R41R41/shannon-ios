import { describe, expect, it } from 'vitest';
import { nightArmsLine } from '../src/surfaces/minecraft/minecraftNightArms.js';

/** The night with nothing to fight with, as a fact (run60, 11/4 01:47). */
const pack = (...names: string[]) => new Map(names.map(name => [name, 1] as [string, number]));
const at = (time: string) => ({ time });

describe('nightArmsLine', () => {
  it('comes within three minutes of the night and through it, with no sword and no axe', () => {
    expect(nightArmsLine(at('12300'), pack('iron_ingot'), 'overworld'))
      .toBe('夜まで 35 秒: 剣も斧も荷に無い。鉄 1 個は鉄のツルハシ（鉄 3）が先（ダイヤと黒曜石は鉄のツルハシでしか掘れない。剣・盾に使うとツルハシが次の鉄まで遅れる）。夜は地上にゾンビ・スケルトンが湧く');
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
  it('says a stone sword is not the iron one once iron for a sword is in the pack (the audit of 11/4: a stone sword put the warning out)', () => {
    const iron = new Map([['stone_sword', 1], ['iron_ingot', 5]]);
    expect(nightArmsLine(at('14000'), new Map([...iron, ['shield', 1]]), 'overworld'))
      .toBe('夜（朝まで 約 8 分）: 荷の剣・斧は stone_sword だけ（鉄の剣は無い。鉄の剣は鉄 2 個で作れる。鉄のツルハシの 3 個を除いて鉄は 2 個）。夜は地上にゾンビ・スケルトンが湧く');
    expect(nightArmsLine(at('14000'), new Map([...iron, ['iron_sword', 1], ['shield', 1]]), 'overworld')).toBeNull();
    expect(nightArmsLine(at('14000'), new Map([['stone_sword', 1], ['iron_pickaxe', 1]]), 'overworld')).toContain('鉄は 0 個');
    expect(nightArmsLine(at('14000'), new Map([['stone_sword', 1], ['iron_ingot', 1], ['shield', 1]]), 'overworld')).toBeNull();
    expect(nightArmsLine(at('14000'), new Map([['stone_sword', 1], ['iron_pickaxe', 1], ['iron_ingot', 1], ['shield', 1]]), 'overworld')).toContain('鉄は 1 個');
  });
  it('says no shield once iron is in the pack (the audit of 11/4, order 1: the sword and the shield right after the iron)', () => {
    expect(nightArmsLine(at('14000'), new Map([['iron_sword', 1], ['iron_pickaxe', 1], ['iron_ingot', 3]]), 'overworld'))
      .toBe('夜（朝まで 約 8 分）: 盾が無い（盾は板 6 と鉄 1 で作れる。鉄は 3 個）。夜は地上にゾンビ・スケルトンが湧く');
    // end1109o10: the first 3 iron are the pickaxe's; the shield gets the 4th.
    expect(nightArmsLine(at('14000'), new Map([['stone_sword', 1], ['iron_ingot', 1]]), 'overworld')).not.toContain('盾が無い');
    expect(nightArmsLine(at('14000'), new Map([['iron_sword', 1], ['iron_ingot', 4]]), 'overworld')).toContain('盾が無い（盾は板 6 と鉄 1 で作れる。鉄のツルハシの 3 個を除いて鉄は 1 個）');
    expect(nightArmsLine(at('14000'), new Map([['stone_sword', 1]]), 'overworld')).toBeNull();
    expect(nightArmsLine({ timeOfDay: 14_000 }, new Map([['iron_sword', 1], ['iron_pickaxe', 1]]), 'overworld')).toContain('鉄は 0 個');
  });
  it('treats underground as dark at any hour (a cave is dark in the morning)', () => {
    expect(nightArmsLine(at('6000'), pack(), 'overworld', true)).toBe('地下は昼でも暗く、ゾンビ・スケルトンが湧く: 剣も斧も荷に無い');
    expect(nightArmsLine({}, new Map([['stone_axe', 1], ['iron_ingot', 5]]), 'overworld', true)).toContain('stone_axe だけ');
    expect(nightArmsLine({}, new Map([['stone_axe', 1], ['iron_ingot', 3]]), 'overworld', true)).toContain('鉄 3 個は鉄のツルハシ');
    expect(nightArmsLine(at('6000'), pack('iron_sword'), 'overworld', true)).toBeNull();
    expect(nightArmsLine(at('6000'), pack(), 'overworld', false)).toBeNull();
    expect(nightArmsLine(at('6000'), pack(), 'the_nether', true)).toBeNull();
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
    expect(nightBedLine({ time: '12000', nearbyThreats: [{ name: 'zombie', distance: 7 }] }, bed(), 'overworld')).toBeNull();
    // At night with an enemy within 8 blocks: the refusal is said (the audit of 11/4, chapter 3).
    expect(nightBedLine({ time: '14000', nearbyThreats: [{ name: 'zombie', distance: 7 }] }, bed(), 'overworld'))
      .toContain('8m 内に敵がいる間は寝られない（壁の向こうでも断られる）');
    expect(nightBedLine({ time: '14000' }, bed(), 'the_nether')).toBeNull();
  });
  it('K10: while the plan\'s now is a pearl node and the pearls are under 10, the bed\'s lines say a night slept through has no endermen', async () => {
    const { nightBedLine, dayBedLine } = await import('../src/surfaces/minecraft/minecraftNightArms.js');
    const { createEndgame } = await import('../src/surfaces/minecraft/minecraftEndgame.js');
    const word = 'パールを地上のエンダーマンで集めるなら、その夜は寝ない（地上のエンダーマンは夜に出て、寝ると夜が飛ぶ）';
    const few = new Map([['white_bed', 1], ['blaze_rod', 7], ['ender_pearl', 3]]);
    for (const time of ['12000', '14000']) {
      expect(nightBedLine({ time }, few, 'overworld', true)).toContain(word);
      expect(nightBedLine({ time }, few, 'overworld')).not.toContain('パールを地上の');
    }
    expect(dayBedLine({ timeOfDay: 1000 }, few, 'overworld', true)).toContain(word);
    expect(dayBedLine({ timeOfDay: 1000 }, few, 'overworld')).not.toContain('パールを地上の');
    // With 10 or more pearls and eyes the stronghold is next (no going back for more): the bed's line is as it was.
    const enough = new Map([['white_bed', 1], ['ender_pearl', 4], ['ender_eye', 6]]);
    expect(nightBedLine({ time: '14000' }, enough, 'overworld', true)).not.toContain('パールを地上の');
    expect(dayBedLine({ timeOfDay: 1000 }, enough, 'overworld', true)).not.toContain('パールを地上の');
    // The wire: the endgame's lines take the plan's now from the caller.
    const frame = { connected: true, state: { world: { dimension: 'overworld', time: '14000', position: { x: 0, y: 64, z: 0 }, health: 20, food: 20,
      inventory: [{ name: 'white_bed', count: 1 }, { name: 'blaze_rod', count: 7 }] } }, facts: {}, bodyId: 'b', sequence: 1, stateAt: new Date(0).toISOString() } as never;
    expect(createEndgame(null).lines(frame, true, true).lines.join('\n')).toContain(word);
    expect(createEndgame(null).lines(frame, true).lines.join('\n')).toContain('寝れば夜が飛び、朝になる');
    expect(createEndgame(null).lines(frame, true).lines.join('\n')).not.toContain('パールを地上の');
  });
});

describe('crying obsidian is not obsidian', () => {
  it('is left out of the count of obsidian (the gate, the End fight)', async () => {
    const { carried } = await import('../src/surfaces/minecraft/minecraftConditions.js');
    expect(carried(new Map([['obsidian', 3], ['crying_obsidian', 5]]), 'obsidian')).toBe(3);
    expect(carried(new Map([['crying_obsidian', 5]]), 'obsidian')).toBe(0);
  });
});
