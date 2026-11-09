import type { ItemCounts } from './minecraftItems.js';
import { countMatching } from './minecraftItems.js';

/**
 * The hands to the ore the opening needs next, from where she stands (end1109o09, o10). o10: three nights with no bed she waited in a
 * hole (about 8, 9 and 12 minutes) while the night line said only 「鉄鉱石へ stairs で下りて掘る（鉄の場所は scan の行）」 with no iron on
 * the map; the seal was the one hand written, and she sealed and waited. The way to the ore is said as hands: the nearest iron the map
 * shows, else the stair down to the ore's height and one row dug sideways (iron is most common about y=16, diamonds about y=-58).
 *
 * end1109o12: every hand written here must be one the act takes as it is. The stair had no way (`toward`) and 21 kinds to dig (the act takes
 * 12), so each try was refused and she sealed and waited two nights; with no table, planks or log the descent is held by the table hold, so
 * the wood comes first in the words.
 */
/** The stair's dig list for each ore, at most 12 kinds (the act's limit). */
export const STAIR_DIG: Readonly<Record<'iron' | 'diamond', string>> = {
  iron: 'stone,deepslate,andesite,diorite,granite,tuff,dirt,gravel,coal_ore,iron_ore,deepslate_iron_ore,copper_ore',
  diamond: 'stone,deepslate,andesite,diorite,granite,tuff,dirt,gravel,iron_ore,deepslate_iron_ore,diamond_ore,deepslate_diamond_ore',
};
/** The stair goes north and the row goes on north from its foot (the body turns by itself where the north is blocked). */
const STAIR_WAY = 'north';
/** Planks that make a table (minecraftLlmcReadiness TABLE_PLANKS; not imported, that module imports this one). */
const TABLE_PLANKS = 4;
const DESCENT = 10;
/** The rock a `go` may dig on its way (the go guard holds ores, which are the `mine`/`dig` hands; o11 had eight go hands held for the ores in its list). */
export const WAY_DIG = 'stone,andesite,diorite,granite,tuff,deepslate,cobbled_deepslate,dirt,gravel';
const IRON_ROW = /鉄鉱石\[(?:deepslate_)?iron_ore\] \((-?\d+),(-?\d+),(-?\d+)\)/u;
export const IRON_ORE_Y = 16;
export const DIAMOND_ORE_Y = -58;

interface Cell { x: number; y: number; z: number }
const cellOf = (world: Record<string, unknown>): Cell | null => {
  const at = world.position && typeof world.position === 'object' ? world.position as Record<string, unknown> : null;
  const [x, y, z] = [at?.x, at?.y, at?.z].map(value => typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : null);
  return x === null || y === null || z === null ? null : { x, y, z };
};

/** The nearest iron ore the map shows, or null. */
export function nearestIronMark(world: Record<string, unknown>): Cell | null {
  const feet = cellOf(world);
  const marks = (Array.isArray(world.mapLandmarks) ? world.mapLandmarks : []).flatMap(line => {
    const m = typeof line === 'string' ? IRON_ROW.exec(line) : null;
    return m ? [{ x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }] : [];
  });
  if (!feet) return marks[0] ?? null;
  return marks.sort((a, b) => Math.hypot(a.x - feet.x, a.y - feet.y, a.z - feet.z) - Math.hypot(b.x - feet.x, b.y - feet.y, b.z - feet.z))[0] ?? null;
}

/**
 * The hands from the feet to the ore: `iron` goes to the nearest iron on the map when there is one; otherwise (and for `diamond`) the stair
 * down to the ore's height when she is above it, then one row of 30 dug sideways. Null without a position.
 */
export function oreRouteHands(world: Record<string, unknown>, ore: 'iron' | 'diamond', counts?: ItemCounts, night = false): string | null {
  const feet = cellOf(world);
  if (!feet) return null;
  const mark = ore === 'iron' ? nearestIronMark(world) : null;
  const deep = (to: number) => feet.y - to >= DESCENT;
  // The table hold stops a descent of 10 or more with no table, fewer than 4 planks and no log (minecraftLlmcTableHold): the wood first.
  const bare = !!counts && countMatching(counts, /^crafting_table$/u) === 0 && countMatching(counts, /_planks$/u) < TABLE_PLANKS
    && countMatching(counts, /_(?:log|stem|wood|hyphae)$/u) === 0;
  const wood = (to: number) => bare && deep(to)
    ? `先に原木 2 本を取って持つ（作業台・板 4・原木のどれも無いと 10 段以上下りる手は止められる。下では木が見つかりにくい）。それから ` : '';
  const y = ore === 'iron' ? IRON_ORE_Y : DIAMOND_ORE_Y;
  // A mark not 10 below (or any, with wood) is gone to as it is; a deeper one with no wood waits for the wood by day.
  if (mark) {
    const toMark = `「go ${mark.x},${mark.y},${mark.z} range=1 dig=${WAY_DIG} maxDig=40」で地図の鉄鉱石 (${mark.x},${mark.y},${mark.z}) へ掘り進み「mine iron_ore ${mark.x},${mark.y},${mark.z} count=3」`;
    if (!(bare && deep(mark.y))) return toMark;
    if (!night) return `${wood(mark.y)}${toMark}`;
  }
  // end1109o13: by night the wood is surface work, and 「先に原木」 was her reason to wait in the enclosure (two nights). By night with no wood the
  // row is dug at the height she stands (no descent the table hold stops); iron comes high in a mountain too.
  if (night && bare && deep(y)) {
    return `今の高さで横へ 1 列掘り進む「go ${feet.x},${feet.y},${feet.z - 30} dig=${WAY_DIG} maxDig=60」（作業台・板 4・原木が無いので 10 段以上は下りない。`
      + `掘った壁に見えた鉱石は mine で掘る。鉄は山の中の高い所にも出る。原木は朝に取り、それから y=${y} へ下りる）`;
  }
  const descend = feet.y > y + 8;
  const row = descend ? y : feet.y;
  // A stair goes one block across for each block down: the row starts where the stair ends and goes on the same way.
  const foot = feet.z - (descend ? feet.y - y : 0);
  const down = descend ? `「vertical down stairs ${STAIR_WAY} y=${y} dig=${STAIR_DIG[ore]} liquid=stop」で y=${y} へ下り、` : '';
  return `${wood(row)}${down}横へ 1 列掘り進む「go ${feet.x},${row},${foot - 30} dig=${WAY_DIG} maxDig=60」（${ore === 'iron' ? '鉄は y=16' : 'ダイヤは y=-58'} 前後に最も多い。掘った壁に見えた鉱石は mine で掘る。y=0 より下は deepslate_ の付く名前）`;
}

/**
 * end1109o10: at y=55 in a sealed hole in the rock (the surface about y=70) the night line said 「夜に地上で待てば」 and she answered
 * 「夜の地上は敵が多い」 and waited; the y<45 test of `undergroundInOverworld` did not hold. Roofed in rock: the map is the layers kind and
 * its top layer (feet +2) is rock in at least 80 of each 100 cells it shows.
 */
export function roofedInRock(world: Record<string, unknown>): boolean {
  const lines = (typeof world.map === 'string' ? world.map : '').split('\n');
  if (!/方式=layers/u.test(lines[0] ?? '')) return false;
  const start = lines.findIndex(line => /^y=-?\d+（足 \+2）/u.test(line));
  if (start < 0) return false;
  let rock = 0, all = 0;
  for (const line of lines.slice(start + 1)) {
    if (/^y=/u.test(line)) break;
    const row = /^\s*-?\d+ (.+)$/u.exec(line);
    if (!row) continue;
    for (const cell of row[1]!.split(' ')) { if (!cell) continue; all += 1; if (cell === '#') rock += 1; }
  }
  return all >= 25 && rock / all >= 0.8;
}
