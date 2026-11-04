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
