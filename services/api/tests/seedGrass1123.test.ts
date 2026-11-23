import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { grassLines, nearbyWithGrass } from '../src/surfaces/minecraft/minecraftLlmcNearby.js';
import { MATERIAL_ACQUISITION_LINES } from '../src/surfaces/minecraft/minecraftRequestKnowledge.js';
import { MAP_LEGEND_V2_EN } from '../src/contracts/minecraftMapLegendV2.js';

/**
 * 2026-11-23 (run a666362e, the seeds for a cake's wheat): the decisions d0005, d0017, d0019 and d0024 of that run, as the head's live state had them
 * (`fixtures/seedGrass1123/lives.json`: the plan's now, the pack, the map and the `nearby` rows as written). The map's `,` cells are the grass; the row
 * `grassLines` adds says them at the y of their own layer, so the cells for `dig at=` can be copied (the model had aimed at the grass blocks, at the
 * layer above and below, and at the air).
 */
type Live = { planNow: string; inventory: string[]; nearby: string[]; map: string };
const lives = JSON.parse(readFileSync(new URL('./fixtures/seedGrass1123/lives.json', import.meta.url), 'utf8')) as Record<string, Live>;
// The lives carry the map as the model read it (`normalizeMap`: 「y=64（足の高さ）」 and a `^` row); the body's text, which `world.localMap` is, has 「y=64」 alone.
const rawOf = (map: string): string => map.replace(/^(y=-?\d+)（[^）]*）$/gmu, '$1');
const HEADER = /足=\((-?\d+),(-?\d+),(-?\d+)\)/u;

function worldOf(live: Live, extra: Record<string, unknown> = {}): { world: Record<string, unknown>; feet: { x: number; y: number; z: number } } {
  const at = HEADER.exec(live.map)!;
  const feet = { x: Number(at[1]), y: Number(at[2]), z: Number(at[3]) };
  // The cane row of the recorded `nearby` as the body's resources (the places it names).
  const caneRow = live.nearby.find(row => row.includes('sugar_cane'));
  const sites = [...(caneRow ?? '').matchAll(/\((-?\d+),(-?\d+),(-?\d+)\)/gu)].map(m => ({ x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }));
  const nearbyResources = caneRow ? [{ purpose: 'plant', kind: 'sugar_cane', count: sites.length, range: 96, sites }] : [];
  return { world: { position: feet, inventory: live.inventory, localMap: rawOf(live.map), nearbyResources, ...extra }, feet };
}
const cells = (row: string): number[][] => [...row.matchAll(/\((-?\d+),(-?\d+),(-?\d+)\)/gu)].map(m => [Number(m[1]), Number(m[2]), Number(m[3])]);

describe('the grass row for the seeds', () => {
  it('d0005: the nearest grass cells at their layer y, none of the grass blocks the model dug', () => {
    const live = lives.d0005!, { world, feet } = worldOf(live);
    const [row] = grassLines(world, feet, live.planNow);
    expect(row).toContain('草（種を取る用）');
    const listed = cells(row!);
    expect(listed).toHaveLength(10);
    // feet (-110,64,-94): the nearest `,` is the grass on the grass block east of her, at y=65 (the model's first hand dug the `:` of y=64 below it: grass blocks;
    // the cell it hit later, with the one seed of the run, is this one).
    expect(listed[0]).toEqual([-108, 65, -94]);
    expect(row).toContain('(-108,65,-94) 東2・上1 2m');
    const map = lives.d0005!.map;
    const layerOf = (y: number) => map.slice(map.indexOf(`y=${y}`)).split('\n').slice(2, 13);
    for (const [x, y, z] of listed) {
      const rows = layerOf(y!), line = rows.find(item => item.startsWith(`${z} `))!;
      expect(line.split(' ')[1 + (x! + 115)], `(${x},${y},${z})`).toBe(',');
    }
  });

  it('d0017, d0019 and d0024: the cells are the map\'s `,` of the layer they are in, the cane\'s column is left out', () => {
    for (const id of ['d0017', 'd0019', 'd0024']) {
      const live = lives[id]!, { world, feet } = worldOf(live);
      const [row] = grassLines(world, feet, live.planNow);
      expect(row, id).toContain('地図の「,」');
      const listed = cells(row!);
      expect(listed.length, id).toBeGreaterThan(5);
      // never the same column twice (a tall grass or a cane is two `,` cells one over the other), never the cane's.
      expect(new Set(listed.map(([x, , z]) => `${x},${z}`)).size, id).toBe(listed.length);
      expect(listed.some(([x, , z]) => x === -126 && z === -62), id).toBe(false);
    }
    // d0024: she stands at y=63 with the grass in the layer of her own height: the cells say y=63 (the model wrote y=64 for them).
    const live = lives.d0024!, { world, feet } = worldOf(live);
    expect(cells(grassLines(world, feet, live.planNow)[0]!).slice(0, 5).every(([, y]) => y === 63)).toBe(true);
  });

  it('is said only while the plan is about the seeds, under 3 seeds are held and no wheat stands near', () => {
    const live = lives.d0017!, { world, feet } = worldOf(live);
    expect(grassLines(world, feet, live.planNow)).toHaveLength(1);
    expect(grassLines(world, feet, '夜まで 3 分。ベッドを作る')).toEqual([]);
    expect(grassLines({ ...world, inventory: ['wheat_seeds×3'] }, feet, live.planNow)).toEqual([]);
    expect(grassLines({ ...world, inventory: ['wheat_seeds×2'] }, feet, live.planNow)).toHaveLength(1);
    const planted = [{ purpose: 'plant', kind: 'wheat', count: 3, range: 96, sites: [{ x: -120, y: 63, z: -68, note: '育ち中 1/7' }] }];
    expect(grassLines({ ...world, nearbyResources: planted }, feet, live.planNow)).toEqual([]);
    expect(grassLines(world, null, live.planNow)).toEqual([]);
    expect(grassLines({ ...world, localMap: undefined }, feet, live.planNow)).toEqual([]);
  });

  it('says there is none when the layers show no `,`, and walks her on', () => {
    const live = lives.d0005!, { world, feet } = worldOf(live);
    const bare = { ...world, localMap: String(world.localMap).replace(/^(-?\d+) (.*)$/gmu, (_all, z: string, row: string) => `${z} ${row.replaceAll(',', '.')}`) };
    const [row] = grassLines(bare, feet, live.planNow);
    expect(row!).toContain('「,」のマスが無い');
    expect(row!).toContain('歩いてから');
  });

  it('puts the row first in `nearby` and leaves the other rows as they were', () => {
    const live = lives.d0005!, { world, feet } = worldOf(live);
    const { nearby } = nearbyWithGrass(live.nearby, world, feet, live.planNow) as { nearby: string[] };
    expect(nearby).toHaveLength(live.nearby.length + 1);
    expect(nearby.slice(1)).toEqual(live.nearby);
    expect(nearby[0]).toContain('草（種を取る用）');
    expect(nearbyWithGrass([], world, feet, '鉄を掘る')).toEqual({});
    expect(nearbyWithGrass(live.nearby, world, feet, '鉄を掘る')).toEqual({ nearby: live.nearby });
  });
});

describe('the words for the grass', () => {
  const knowledge = MATERIAL_ACQUISITION_LINES.join('\n');
  it('the request knowledge says: the `,` only, its layer y as it is, the `:` gives no seeds, many cells at once', () => {
    expect(knowledge).toContain('「:」は地面そのもの');
    expect(knowledge).toContain('「草（種を取る用）」の行');
    expect(knowledge).toContain('見出し y=N をそのまま書く');
    expect(knowledge).toContain('「,」を 10 マスほど選んで 1 手で壊す');
    expect(knowledge).not.toContain('草のマスは地面ブロックの 1 つ上（y が 1 つ違うと');
  });
  it('the legend the instructions carry tells the grass block from the grass', () => {
    const legend = MAP_LEGEND_V2_EN.join('\n');
    expect(legend).toContain(', grass plants and flowers, snow (passable)');
    expect(legend).toContain(': dirt, grass blocks, snow, clay');
  });
});
