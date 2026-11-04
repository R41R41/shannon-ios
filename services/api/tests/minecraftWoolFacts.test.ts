import { describe, expect, it } from 'vitest';
import { createWoolWatch, woolLine } from '../src/surfaces/minecraft/minecraftWoolFacts.js';

/** Sheep, wool and shears as facts (the whole-run audit of 11/4, order 9: wool was only ever taken by killing, one a sheep). */
const sheep = (...entries: Array<[number, number]>) => ({ nearbyEntities: entries.map(([id, distance]) => ({ name: 'sheep', id, distance })) });

describe('the wool line', () => {
  it('says what a sheep gives shorn and killed, the shears and the iron for them, the wool by colour and the beds', () => {
    const line = woolLine(sheep([7, 12.34], [8, 3.2]), new Map([['white_wool', 2], ['red_wool', 1], ['white_bed', 3], ['iron_ingot', 4]]), 'overworld', null)!;
    expect(line.startsWith('羊 #8 3.2m ほか 1 頭・ベッド 3/10・羊毛 white×2・red×1: ')).toBe(true);
    for (const word of ['ハサミで刈ると 1 頭 1〜3 個', '殺すと 1 個', 'ハサミ 無し（鉄 2 で作れる。鉄は 4 個）', 'use item=shears target=#id', '未確認', 'pickup']) {
      expect(line, word).toContain(word);
    }
    expect(woolLine(sheep([7, 5]), new Map([['shears', 1]]), 'overworld', null)).toContain('ハサミ 有り');
  });
  it('is silent with ten beds, with no sheep within 24 m, and outside the overworld', () => {
    expect(woolLine(sheep([7, 5]), new Map([['white_bed', 10]]), 'overworld', null)).toBeNull();
    expect(woolLine(sheep([7, 30]), new Map(), 'overworld', null)).toBeNull();
    expect(woolLine(sheep([7, 5]), new Map(), 'the_nether', null)).toBeNull();
  });
  it('says the wool the last decision added, so a shearing is seen to have worked', () => {
    const watch = createWoolWatch();
    expect(watch.line(sheep([7, 5]), new Map([['white_wool', 1]]), 'overworld')).not.toContain('前の判断から');
    expect(watch.line(sheep([7, 5]), new Map([['white_wool', 3]]), 'overworld')).toContain('羊毛 white×3（前の判断から +2）');
    expect(watch.line(sheep([7, 5]), new Map([['white_wool', 3]]), 'overworld')).not.toContain('前の判断から');
  });
});
