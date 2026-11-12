import { PORTAL, type MapView } from './minecraftLlmcPreflightMap.js';
import { lavaRightUnder } from './minecraftLlmcLiquid.js';
import { lavaSitesIn, type LavaSite } from './minecraftLlmcNearby.js';
import { OBSIDIAN_AT_FIRST_LAVA } from './minecraftLlmcPrepRules.js';
import { isHard, NAME, ptText, type P } from './minecraftLlmcWalkRules.js';
import { factsIn, hasKind, nowAndNextKinds } from './minecraftPlanFacts.js';
import { firstMark } from './minecraftSeenMarks.js';
import { OMIT } from './minecraftLlmcLiveEnemies.js';
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
 * with the goal at 22 the node of the first lava stayed open about 70 minutes without
 * reaching 10 (the run's records were cleared; the pull to a far pool of 22 is the head's reading, not observed). Since run 8 (11/13) the goal
 * (`OBSIDIAN_AT_FIRST_LAVA`) is the gate's 10 only; the End fight's 12 is taken by the departure check's own node.
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

/**
 * The obsidian in the pack, from the body's inventory lines (`obsidian×18`, a line a stack); null when no line names it and the lines were cut
 * (`ほかN件（長いため略）`: the live state shrinks the pack first, and a stack of obsidian in the cut part would read as none).
 */
export function heldObsidian(inventory: unknown): number | null {
  const lines = strings(inventory);
  const counts = lines.flatMap(line => { const found = /^(?:minecraft:)?obsidian×(\d+)/u.exec(line); return found ? [Number(found[1])] : []; });
  if (!counts.length && lines.some(line => OMIT.test(line))) return null;
  return counts.reduce((sum, count) => sum + count, 0);
}
const VERTICAL: ReadonlyArray<readonly [number, number, number]> = [[0, 1, 0], [0, -1, 0]];
/** The diagonals of an upright plane (a frame's bottom and top cells touch its sides only by a corner: the frame has none). */
const UPRIGHT_DIAGONALS: ReadonlyArray<readonly [number, number, number]> = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [0, 1, 1], [0, 1, -1], [0, -1, 1], [0, -1, -1]];
/**
 * Whether an obsidian cell of the map stands in a frame's shape: a lit gate's (it touches a portal cell, `p`: `PORTAL` as read), or an upright one, built or ruined
 * (it has obsidian right over or under it, or touches such a cell by an upright corner). The obsidian a lava pool leaves lies flat; a gate
 * stands. Review of the run-8 fixes (11/13): with her frame of 10 built, the line read 「持ち物 8／ゲートの最低 10・見えている自然の黒曜石 10 マス」
 * and could send her back to the obsidian, or to dig her own frame.
 */
export function frameCell(view: MapView, at: P): boolean {
  const obsidian = (x: number, y: number, z: number) => view.symbol(x, y, z) === 'O';
  const stacked = (x: number, y: number, z: number) => obsidian(x, y, z) && VERTICAL.some(([dx, dy, dz]) => obsidian(x + dx, y + dy, z + dz));
  return SIDES.some(([dx, dy, dz]) => view.symbol(at.x + dx, at.y + dy, at.z + dz) === PORTAL) || stacked(at.x, at.y, at.z)
    || UPRIGHT_DIAGONALS.some(([dx, dy, dz]) => stacked(at.x + dx, at.y + dy, at.z + dz));
}
/** How near a ruined portal's crying obsidian (the scan's row) an O of the map may be crying obsidian too (the map marks both O). */
const RUIN_METERS = 12;
/** The ruined portals the scan lines name (「壊れたポータル（泣く黒曜石） ×N 最寄り (x,y,z) …」). */
export const ruinsIn = (lines: readonly string[]): P[] => lines.flatMap(line => {
  const at = /壊れたポータル/u.test(line) ? pointOf(line) : null;
  return at ? [at] : [];
});
/**
 * The obsidian of the map that may go to the gate: not in a frame's shape (`frameCell`) and not near a ruined portal (crying obsidian is O too).
 * `overLava`: how many of the cells have lava right under them (the body digs those only after water is poured on top: a water bucket is needed).
 */
export interface MapObsidian { cells: P[]; frame: number; ruined: number; overLava: number }
export function naturalObsidian(view: MapView | null, ruins: readonly P[] = []): MapObsidian {
  const out: MapObsidian = { cells: [], frame: 0, ruined: 0, overLava: 0 };
  if (!view) return out;
  for (const [y, layer] of view.layers.layers) {
    for (const [key, symbol] of layer) {
      if (symbol !== 'O') continue;
      const [x, z] = key.split(',').map(Number) as [number, number], at = { x, y, z };
      if (frameCell(view, at)) out.frame += 1;
      else if (ruins.some(ruin => distance(ruin, at) <= RUIN_METERS)) out.ruined += 1;
      else {
        out.cells.push(at);
        if (lavaRightUnder(view, at)) out.overLava += 1;
      }
    }
  }
  return out;
}
/** The count of the natural obsidian cells the map shows (`naturalObsidian`). */
export const mapObsidian = (view: MapView | null, ruins: readonly P[] = []): number => naturalObsidian(view, ruins).cells.length;
/** A lit gate near her: the nearest portal cell of the map (`p`), else the landmarks' ネザーポータル. */
export function litGate(view: MapView | null, self: P, landmarks: readonly string[]): { at: P; meters: number } | null {
  const cell = view ? nearest(inMap(view, self, PORTAL)) : null;
  if (cell) return { at: cell.at, meters: cell.meters };
  const mark = firstMark({ mapLandmarks: [...landmarks] }, 'nether_portal');
  return mark ? { at: { x: mark.x, y: mark.y, z: mark.z }, meters: distance(self, mark) } : null;
}
/** The obsidian line once the gate is lit: nothing to count or fetch for it, and its frame not to be dug. */
export const litGateLine = (gate: { at: P; meters: number }): string =>
  `黒曜石: ゲートは点いている（ネザーポータル ${ptText(gate.at)} まで ${Math.round(gate.meters)}m）。ゲートの黒曜石はもう要らない。枠の O は数えない・掘らない（掘るとゲートが消える）`;
/**
 * Run 8 (11/13: the strong model's replan decided 「水入りバケツが無く黒曜石を作れない」 and made a node to fetch water, 252 s, while obsidian stood
 * in the world): the head of the obsidian line, the count in the pack beside the gate's least and the aim, and the obsidian in view (the frames
 * and the cells near a ruined portal not counted, and said so). Facts only. `held` null: the pack's lines were cut.
 */
export function obsidianTally(held: number | null, visible: number, nearest: string | null, left: { frame?: number; ruined?: number; overLava?: number } = {}): string {
  // The body digs an O with lava right under it only with a water bucket (poured on top first); without one it is not dug.
  const overLava = visible > 0 && left.overLava ? `（うち真下が溶岩 ${left.overLava}: 水入りバケツが要る）` : '';
  const seen = visible > 0 || nearest ? `見えている自然の黒曜石 ${visible > 0 ? `地図に ${visible} マス${overLava}` : ''}${visible > 0 && nearest ? '・' : ''}${nearest ? `最寄り ${nearest}` : ''}`
    : '自然の黒曜石 見えていない';
  const notes = [...left.frame ? [`枠の形の O ${left.frame} マス（組んだ枠・壊れたポータル）は数えない`] : [],
    ...left.ruined ? [`壊れたポータルの近くの O ${left.ruined} マスは泣く黒曜石が混ざるので数えない（泣く黒曜石はゲートに使えない）`] : []];
  return `黒曜石: 持ち物 ${held ?? '不明（持ち物の行が略された）'}／ゲートの分 ${OBSIDIAN_AT_FIRST_LAVA}（これで足りる。竜戦の 12 は出発の点検で別に取る）。${seen}`
    + `${notes.length ? `（${notes.join('。')}）` : ''}`;
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
  // Review of the run-8 fixes (11/13): the portal's node stays open until the Nether, so a lit gate's frame read as obsidian lacking.
  const gate = litGate(view, self, landmarks);
  if (gate) return [litGateLine(gate)];
  const ruins = ruinsIn(scan), natural = naturalObsidian(view, ruins);
  // The map's frames and ruins are left out; a landmark or scan row on a left-out cell of the map, or of crying obsidian, too.
  const kept = (found: Found) => !view || view.symbol(found.at.x, found.at.y, found.at.z) !== 'O'
    || natural.cells.some(cell => cell.x === found.at.x && cell.y === found.at.y && cell.z === found.at.z);
  const obsidian = nearest([...natural.cells.map(at => ({ at, meters: distance(self, at), from: '地図' })),
    ...inLines(landmarks.filter(line => !/泣く/u.test(line)), /^O |黒曜石/u, self, '目印').filter(kept),
    ...inLines(scan.filter(line => !/泣く|壊れたポータル/u.test(line)), /黒曜石/u, self, '走査').filter(kept)]);
  const contact = view ? contactCells(view, self) : [];
  const lava = lavaWords(body, self, view, landmarks, scan);
  if (lava.meters === null && !obsidian && !lavaSitesIn(strings(body.nearby))) return [];
  const closer = lava.meters !== null && (!obsidian || lava.meters < obsidian.meters) ? '（溶岩の方が近い）' : '';
  return [`${obsidianTally(heldObsidian(body.inventory), natural.cells.length, obsidian ? show(obsidian, '') : null, natural)}。${lava.words}${closer}。`
    + '階段掘りは 0.5〜0.9 マス/秒（ダイヤのツルハシ）、溶岩に水を注いで 1 個目ができるまで 30〜50 秒、黒曜石の dig は空気中で 1 個約 9 秒（ダイヤのツルハシ・測った値）',
    ...contact.length ? [`水の源と溶岩の源の両方に隣り合うマス（開けると水と溶岩が出会う）: ${contact.join(' / ')}。溶岩の源だけに隣り合う岩を開けると、溶岩が流れ込む`] : []];
}
