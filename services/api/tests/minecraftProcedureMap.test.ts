import { describe, expect, it } from 'vitest';
import { caveEntrances, lavaPlaces, orePlaces, structures } from '../src/surfaces/minecraft/minecraftProcedureMap.js';
import type { MinecraftProcedureFacts } from '../src/surfaces/minecraft/minecraftProcedureFacts.js';

/** mb-arch: the body's map read in its own words (mb-map a117c6f, places.ts mapSummary; the lab's lines of 2026-10-20). */
const MAP = [
  '構造物: 村: 6m 北 (272,70,224)、310m 南 (256,72,1376)（鍛冶屋の箱 (277,73,1393) 中身: iron_ingot×4: 鉄・黒曜石が入ることがある）／'
    + '荒廃したポータル: 40m 東 (256,-56,192)（黒曜石14個・箱 (255,-46,196): 火打石と打ち金・黒曜石が入ることがある）、90m 西 (100,64,0)（黒曜石8個）／'
    + 'イグルー: 300m 南 (1552,70,-2880)（箱 (1553,65,-2876): 地下室（床の下の梯子））',
  '鉱石: 鉄 12か所（20m 北 (1,40,-20)、30m 東 (30,35,0)、44m 西 (-44,20,3) ほか9）／ダイヤ 2か所（150m 東 (150,-58,3)、250m 西 (-250,-59,0)）',
  '溶岩の溜まり 3か所: 40m 南 (0,-58,40) 地下、60m 北 (0,70,-60) 地表 ほか1（水バケツで黒曜石にできる: use-item-on-block water_bucket count=10）',
  '洞窟の入口 73か所（地表から歩いて地下へ下りられる。鉄・ダイヤへの近道）: 28m 南 (262,65,250) → 底 (279,48,258)、46m 西 (227,59,221) → 底 (233,30,227) ほか71',
].join('\n');
const facts = { map: MAP } as MinecraftProcedureFacts;

describe('the body map in its own words (mb-arch)', () => {
  it('reads each kind\'s places from its own part, not a neighbour\'s', () => {
    expect(orePlaces(facts, 'ダイヤ').map(place => place.at)).toEqual([{ x: 150, y: -58, z: 3 }, { x: -250, y: -59, z: 0 }]);
    expect(orePlaces(facts, '鉄')).toHaveLength(3);
    expect(lavaPlaces(facts).map(place => place.distance)).toEqual([40, 60]);
    expect(caveEntrances(facts)).toEqual([{ distance: 28, mouth: { x: 262, y: 65, z: 250 }, bottom: { x: 279, y: 48, z: 258 } },
      { distance: 46, mouth: { x: 227, y: 59, z: 221 }, bottom: { x: 233, y: 30, z: 227 } }]);
  });

  it('keeps each structure\'s words in brackets for its chest and its frame', () => {
    const villages = structures(facts, '村');
    expect(villages.map(place => place.distance)).toEqual([6, 310]);
    expect(villages[1]!.extra).toContain('鍛冶屋の箱 (277,73,1393)');
    const portals = structures(facts, '荒廃したポータル');
    expect(portals[0]!.extra).toContain('黒曜石14個・箱 (255,-46,196)');
    expect(portals[1]).toMatchObject({ distance: 90, extra: '（黒曜石8個）' });
    expect(structures(facts, 'イグルー')[0]!.at).toEqual({ x: 1552, y: 70, z: -2880 });
  });
});