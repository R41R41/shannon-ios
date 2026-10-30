import type { MapView } from './minecraftLlmcPreflightMap.js';
import { isHard, NAME, ptText, type P } from './minecraftLlmcWalkRules.js';
import { factsIn, hasKind, nowAndNextKinds } from './minecraftPlanFacts.js';
import type { PlanKind } from '@shannon/mind';

/**
 * mb-llmc v2 (実走37: 10 m 先に覆い 1 枚の溶岩 (173,-16,147) があったのに、走査で見えた 85 m 先の自然の黒曜石 (253,-55,154) へ階段で向かい、約 260 秒かかった。
 * 結局その近くの溶岩 (233,-55,200) で作った): the node of the obsidian is shown the distances of both ways side by side, from the live state
 * alone (`body.obsidian`):
 * the nearest lava source and the nearest obsidian, each from the map, the landmarks or the scan's lines, with
 * the distance from her
 * feet and where it
 * was read. Facts only: the measured costs are run 37's (a stair at 0.5–0.9 blocks a second with a diamond
 * pickaxe; the first obsidian 34–46 s after
 * she stood at the lava; a dig of obsidian about 9 s with a diamond pickaxe in the air).
 */
type Rec = Record<string, unknown>;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const POINT = /\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/u;
interface Found { at: P; meters: number; from: string }

const distance = (a: P, b: P): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const pointOf = (text: string): P | null => {
  const m = POINT.exec(text);
  return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null;
};
/** The cells of the map with the symbol, nearest first (the whole map: 15 wide). */
function inMap(view: MapView, self: P, symbol: string): Found[] {
  const out: Found[] = [];
  for (const [y, layer] of view.layers.layers) {
    for (const [key, sym] of layer) {
      if (sym !== symbol) continue;
      const [x, z] = key.split(',').map(Number) as [number, number];
      out.push({ at: { x, y, z }, meters: distance(self, { x, y, z }), from: '地図' });
    }
  }
  return out;
}
/** The lines that name the thing (a landmark `L 溶岩源 (…)`, a scan row `溶岩の溜まり … (…)`) with a place. */
function inLines(lines: readonly string[], word: RegExp, self: P, from: string): Found[] {
  return lines.flatMap(line => {
    const at = word.test(line) ? pointOf(line) : null;
    return at ? [{ at, meters: distance(self, at), from }] : [];
  });
}
const nearest = (items: Found[]): Found | null => items.sort((a, b) => a.meters - b.meters)[0] ?? null;
const show = (item: Found | null, none: string): string => item ? `${ptText(item.at)} まで ${Math.round(item.meters)}m（${item.from}）` : none;

const SIDES: ReadonlyArray<readonly [number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const CONTACTS = 3;
/**
 * mb-llmc-cand 11 (bench s67: the water source was one cell from her and the lava source two, and the answers
 * dug beside the lava, where the water did
 * not reach and the lava came to her feet): the cells of the map that are not liquid themselves and have a water
 * source and a lava source beside them, nearest
 * first, each with the two sources. Opening such a cell lets the water and the lava meet. Facts from the map
 * only: what to do with them is the decision's.
 */
export function contactCells(view: MapView, self: P): string[] {
  const found: Array<{ at: P; meters: number; water: P; lava: P }> = [];
  for (const [y, layer] of view.layers.layers) {
    for (const [key, symbol] of layer) {
      if (!isHard(symbol)) continue;
      const [x, z] = key.split(',').map(Number) as [number, number];
      const beside = (wanted: string): P | null => {
        const side = SIDES.find(([dx, dy, dz]) => view.symbol(x + dx, y + dy, z + dz) === wanted);
        return side ? { x: x + side[0], y: y + side[1], z: z + side[2] } : null;
      };
      const water = beside('w'), lava = beside('L');
      if (water && lava) found.push({ at: { x, y, z }, meters: distance(self, { x, y, z }), water, lava });
    }
  }
  const name = (at: P): string => NAME[view.symbol(at.x, at.y, at.z) ?? ''] ?? '?';
  return found.sort((a, b) => a.meters - b.meters).slice(0, CONTACTS).map(item => `${ptText(item.at)} 目から ${item.meters.toFixed(1)}m（${name(item.at)}）`
    + `・隣の水の源 ${ptText(item.water)}・溶岩の源 ${ptText(item.lava)}`);
}
/** Enough sources for the ten obsidian of a gate. */
export const POOL_SOURCES = 10;
/**
 * Run 38 (2026-10-24: from +1,090 s she went to single lava sources one after another and reached a pool of 64
 * sources at +1,310 s, about 220 s):
 * the map's lava sources joined into pools (side by side, the six faces), each with its nearest cell and how many sources it has.
 */
export function lavaPools(view: MapView, self: P): Array<Found & { sources: number }> {
  const cells = new Map<string, P>();
  for (const [y, layer] of view.layers.layers) {
    for (const [key, symbol] of layer) {
      if (symbol !== 'L') continue;
      const [x, z] = key.split(',').map(Number) as [number, number];
      cells.set(`${x},${y},${z}`, { x, y, z });
    }
  }
  const seen = new Set<string>(), pools: Array<Found & { sources: number }> = [];
  for (const [key, start] of cells) {
    if (seen.has(key)) continue;
    seen.add(key);
    const queue = [start];
    let near: P = start, sources = 0;
    while (queue.length) {
      const at = queue.pop()!;
      sources += 1;
      if (distance(self, at) < distance(self, near)) near = at;
      for (const [dx, dy, dz] of SIDES) {
        const next = `${at.x + dx},${at.y + dy},${at.z + dz}`;
        if (cells.has(next) && !seen.has(next)) {
          seen.add(next);
          queue.push(cells.get(next)!);
        }
      }
    }
    pools.push({ at: near, meters: distance(self, near), from: '地図', sources });
  }
  return pools.sort((a, b) => a.meters - b.meters);
}
/** The scan's and the landmarks' lava rows with a count of sources (「溶岩の溜まり 3 つ以上（最寄り 西 4m・源 28） (x,y,z)」, 「L 溶岩源
 * (x,y,z) … 溜まりの源 4」). */
function countedPools(lines: readonly string[], self: P, from: string): Array<Found & { sources: number }> {
  return lines.flatMap(line => {
    const at = /溶岩/u.test(line) ? pointOf(line) : null, count = /源\s*(\d+)/u.exec(line);
    return at && count ? [{ at, meters: distance(self, at), from, sources: Number(count[1]) }] : [];
  });
}
/** The words of the pools: the nearest of ten sources or more, and how small the nearest source's pool is when it
 * is under ten. */
function poolsLine(pools: Array<Found & { sources: number }>, lava: Found | null): string {
  const big = pools.filter(pool => pool.sources >= POOL_SOURCES).sort((a, b) => a.meters - b.meters)[0];
  const near = lava ? pools.find(pool => pool.at.x === lava.at.x && pool.at.y === lava.at.y && pool.at.z === lava.at.z) : undefined;
  const small = near && near.sources < POOL_SOURCES ? `（いちばん近い源の溜まりは源 ${near.sources}: 黒曜石も ${near.sources} 個まで）` : '';
  return `。源が ${POOL_SOURCES} 以上の溜まり ${big ? `${show(big, '')}・源 ${big.sources}` : '見えていない'}${small}`;
}
/** The kinds of node whose distances to lava and to obsidian are shown: the obsidian and the portal (chapter 7). */
const OBSIDIAN_KINDS: ReadonlySet<PlanKind> = new Set<PlanKind>(['obsidian', 'portal']);
/** `body.obsidian`: the nearest lava and the nearest obsidian beside each other, when the current node or the
 * next is of the kind obsidian or portal. Empty otherwise. */
export function obsidianWays(body: Rec, self: P, view: MapView | null): string[] {
  if (!hasKind(nowAndNextKinds(factsIn(body)), OBSIDIAN_KINDS)) return [];
  const landmarks = strings(body.landmarks), scan = strings(body.scan);
  const lava = nearest([...view ? inMap(view, self, 'L') : [], ...inLines(landmarks, /^L |溶岩/u, self, '目印'), ...inLines(scan, /溶岩/u, self, '走査')]);
  const obsidian = nearest([...view ? inMap(view, self, 'O') : [], ...inLines(landmarks, /^O |黒曜石/u, self, '目印'), ...inLines(scan, /黒曜石/u, self, '走査')]);
  const contact = view ? contactCells(view, self) : [];
  if (!lava && !obsidian) return [];
  const closer = lava && (!obsidian || lava.meters < obsidian.meters) ? '（溶岩の方が近い）' : '';
  const pools = [...view ? lavaPools(view, self) : [], ...countedPools(landmarks, self, '目印'), ...countedPools(scan, self, '走査')];
  const poolWords = poolsLine(pools, lava);
  return [`黒曜石 10 個の元: 溶岩の源 ${show(lava, '見えていない')} / 自然の黒曜石 ${show(obsidian, '見えていない')}${closer}${poolWords}。`
    + '階段掘りは 0.5〜0.9 マス/秒（ダイヤのツルハシ）、溶岩に水を注いで 1 個目ができるまで 30〜50 秒、黒曜石の dig は空気中で 1 個約 9 秒（ダイヤのツルハシ・測った値）',
    ...contact.length ? [`水の源と溶岩の源の両方に隣り合うマス（開けると水と溶岩が出会う）: ${contact.join(' / ')}。溶岩の源だけに隣り合う岩を開けると、溶岩が流れ込む`] : []];
}
