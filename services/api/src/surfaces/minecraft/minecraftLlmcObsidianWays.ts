import type { MapView } from './minecraftLlmcPreflightMap.js';
import { lavaSitesIn, type LavaSite } from './minecraftLlmcNearby.js';
import { GATE_OBSIDIAN, OBSIDIAN_AT_FIRST_LAVA } from './minecraftLlmcPrepRules.js';
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
/**
 * The pool worth going to: ten sources or more, the gate's (the strategy's 「10 個には源が 10 以上ある溜まり」). end1109t04b (thru, 11/9):
 * with this at 22 (`OBSIDIAN_AT_FIRST_LAVA`, the gate's and the fight's) the node of the first lava stayed open about 70 minutes without
 * reaching 10 (the run's records were cleared; the pull to a far pool of 22 is the head's reading, not observed). The plan's 22 is unchanged:
 * the rest is taken at the same pool when it has them, or at the next lava.
 */
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
/** The pools shown from the body's `nearby` lava line. */
const POOLS_SHOWN = 3;

/** The obsidian in the pack, from the body's inventory lines (`obsidian×18`, a line a stack). */
export function heldObsidian(inventory: unknown): number {
  return strings(inventory).reduce((sum, line) => sum + Number(/^(?:minecraft:)?obsidian×(\d+)/u.exec(line)?.[1] ?? 0), 0);
}
/** The obsidian cells the map shows (the whole map: 15 wide). */
export const mapObsidian = (view: MapView | null): number => {
  let count = 0;
  for (const [, layer] of view?.layers.layers ?? []) for (const [, symbol] of layer) if (symbol === 'O') count += 1;
  return count;
};
/**
 * Run 8 (11/13: the strong model's replan decided 「水入りバケツが無く黒曜石を作れない」 and made a node to fetch water, 252 s, while obsidian stood
 * in the world): the head of the obsidian line, the count in the pack beside the gate's least and the aim, and the obsidian in view. Facts only.
 */
export function obsidianTally(held: number, visible: number, nearest: string | null): string {
  const seen = visible > 0 || nearest ? `見えている自然の黒曜石 ${visible > 0 ? `地図に ${visible} マス` : ''}${visible > 0 && nearest ? '・' : ''}${nearest ? `最寄り ${nearest}` : ''}`
    : '自然の黒曜石 見えていない';
  return `黒曜石: 持ち物 ${held}／ゲートの最低 ${GATE_OBSIDIAN}／目標 ${OBSIDIAN_AT_FIRST_LAVA}（ゲート ${GATE_OBSIDIAN}＋竜戦 12）。${seen}`;
}
/** A pool from her feet: the place, how far across and how far up or down, the sources and the cover (the body's note). */
function poolWords(feet: P, site: LavaSite): string {
  const across = Math.round(Math.hypot(site.x - feet.x, site.z - feet.z)), dy = site.y - feet.y;
  const height = dy === 0 ? '同じ高さ' : `${dy > 0 ? '上' : '下'} ${Math.abs(dy)}`;
  const facts = [`水平 ${across}m`, height, ...site.sources !== null ? [`源 ${site.sources}`] : [], ...site.covered !== null ? [`覆い${site.covered ? '○' : '×'}`] : []];
  return `${ptText(site)} ${facts.join('・')}`;
}
/**
 * Run 8 (11/13: pools at y=20 (7 m), y=-19 (about 40 m) and y=-45 (about 36 m) were loaded, and the head was told only the nearest source, y=-55, 27
 * below across a hollow 21 deep, and dug down to it, 191 s to the lava): the lava part. The body's pools near her (`nearby`, nearest three, each
 * with how far across and up or down from her feet now, its sources and whether stone covers it) when it sends them; when it says none within its
 * range, that and where else to look; with no lava line (an older body), the nearest source and the pool of ten as before.
 */
function lavaWords(body: Rec, self: P, view: MapView | null, landmarks: string[], scan: string[]): { words: string; meters: number | null } {
  const nearby = lavaSitesIn(strings(body.nearby));
  if (nearby?.sites.length) {
    const sites = nearby.sites.slice(0, POOLS_SHOWN);
    return { words: `溶岩の溜まり（近い順・今の足から）: ${sites.map(site => poolWords(self, site)).join(' / ')}`, meters: distance(self, sites[0]!) };
  }
  const lava = nearest([...view ? inMap(view, self, 'L') : [], ...inLines(landmarks, /^L |溶岩/u, self, '目印'), ...inLines(scan, /溶岩/u, self, '走査')]);
  if (nearby && !lava) {
    return { words: `溶岩の溜まり ${nearby.range}m 内に見えない（洞窟・地表の近くも mc_probe kind=scan で読み直す。それでも無ければ低い y を当てて掘る）`, meters: null };
  }
  const pools = [...view ? lavaPools(view, self) : [], ...countedPools(landmarks, self, '目印'), ...countedPools(scan, self, '走査')];
  return { words: `溶岩の源 ${show(lava, '見えていない')}${poolsLine(pools, lava)}`, meters: lava?.meters ?? null };
}
/** `body.obsidian`: what she holds and sees of obsidian, and the lava near, when the current node or the next is of the kind obsidian or portal.
 * Empty otherwise, and when neither lava nor obsidian is known. */
export function obsidianWays(body: Rec, self: P, view: MapView | null): string[] {
  if (!hasKind(nowAndNextKinds(factsIn(body)), OBSIDIAN_KINDS)) return [];
  const landmarks = strings(body.landmarks), scan = strings(body.scan);
  const obsidian = nearest([...view ? inMap(view, self, 'O') : [], ...inLines(landmarks, /^O |黒曜石/u, self, '目印'), ...inLines(scan, /黒曜石/u, self, '走査')]);
  const contact = view ? contactCells(view, self) : [];
  const lava = lavaWords(body, self, view, landmarks, scan);
  if (lava.meters === null && !obsidian && !lavaSitesIn(strings(body.nearby))) return [];
  const closer = lava.meters !== null && (!obsidian || lava.meters < obsidian.meters) ? '（溶岩の方が近い）' : '';
  return [`${obsidianTally(heldObsidian(body.inventory), mapObsidian(view), obsidian ? show(obsidian, '') : null)}。${lava.words}${closer}。`
    + '階段掘りは 0.5〜0.9 マス/秒（ダイヤのツルハシ）、溶岩に水を注いで 1 個目ができるまで 30〜50 秒、黒曜石の dig は空気中で 1 個約 9 秒（ダイヤのツルハシ・測った値）',
    ...contact.length ? [`水の源と溶岩の源の両方に隣り合うマス（開けると水と溶岩が出会う）: ${contact.join(' / ')}。溶岩の源だけに隣り合う岩を開けると、溶岩が流れ込む`] : []];
}
