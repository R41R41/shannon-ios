import { describe, expect, it } from 'vitest';
import { preparationShortage } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';

/** The End's check counts the eyes the frames still need once the frames are in view (S5's section of 11/5), not twelve in hand. */
const counts = (items: Array<[string, number]>) => new Map(items);
const KIT: Array<[string, number]> = [['white_bed', 10], ['obsidian', 12], ['bow', 1], ['arrow', 30], ['iron_sword', 1], ['cobblestone', 64],
  ['water_bucket', 1]];
const frames = (note: string) => ({ mapLandmarks: [`Q エンドポータルの枠 (703,26,-1899) 北3m ${note}`] });

describe('the eyes of the End check', () => {
  it('asks twelve with no frames in view, and the empty frames once they are', () => {
    const base = { dimension: 'overworld', food: 330, nowKinds: ['stronghold' as const] };
    expect(preparationShortage({ ...base, counts: counts([...KIT, ['ender_eye', 4]]) })).toContain('エンダーアイ（12 が目安。落ちたアイは拾う） 4/10');
    const some = preparationShortage({ ...base, counts: counts([...KIT, ['ender_eye', 4]]), world: frames('×12 アイ入り 9') });
    expect(some).toBeNull();
    const short = preparationShortage({ ...base, counts: counts([...KIT, ['ender_eye', 1]]), world: frames('×12 アイ入り 9') });
    expect(short).toContain('エンダーアイ（空いた枠の分） 1/3');
  });
});
