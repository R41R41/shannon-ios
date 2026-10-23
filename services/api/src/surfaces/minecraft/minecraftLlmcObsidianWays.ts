import type { MapView } from './minecraftLlmcPreflightMap.js';
import { NAME, ptText, type P } from './minecraftLlmcWalkRules.js';

/**
 * mb-llmc v2 (実走37: 10 m 先に覆い 1 枚の溶岩 (173,-16,147) があったのに、走査で見えた 85 m 先の自然の黒曜石 (253,-55,154) へ階段で向かい、約 260 秒かかった。
 * 結局その近くの溶岩 (233,-55,200) で作った): the node of the obsidian is shown the distances of both ways side by side, from the live state alone (`body.obsidian`):
 * the nearest lava source and the nearest obsidian, each from the map, the landmarks or the scan's lines, with the distance from her feet and where it
 * was read. Facts only: the measured costs are run 37's (a stair at 0.5–0.9 blocks a second with a diamond pickaxe; the first obsidian 34–46 s after
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
const LIQUID = new Set(['w', '-', 'L', 'l']);
const CONTACTS = 3;
/**
 * mb-llmc-cand 11 (bench s67: the water source was one cell from her and the lava source two, and the answers dug beside the lava, where the water did
 * not reach and the lava came to her feet): the cells of the map that are not liquid themselves and have a water source and a lava source beside them, nearest
 * first, each with the two sources. Opening such a cell lets the water and the lava meet. Facts from the map only: what to do with them is the decision's.
 */
export function contactCells(view: MapView, self: P): string[] {
  const found: Array<{ at: P; meters: number; water: P; lava: P }> = [];
  for (const [y, layer] of view.layers.layers) {
    for (const [key, symbol] of layer) {
      if (LIQUID.has(symbol)) continue;
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
/** `body.obsidian`: the nearest lava and the nearest obsidian beside each other, when the plan's node is the obsidian. Empty otherwise. */
export function obsidianWays(body: Rec, self: P, view: MapView | null): string[] {
  if (!/黒曜石/u.test(String(body.planNow ?? ''))) return [];
  const landmarks = strings(body.landmarks), scan = strings(body.scan);
  const lava = nearest([...view ? inMap(view, self, 'L') : [], ...inLines(landmarks, /^L |溶岩/u, self, '目印'), ...inLines(scan, /溶岩/u, self, '走査')]);
  const obsidian = nearest([...view ? inMap(view, self, 'O') : [], ...inLines(landmarks, /^O |黒曜石/u, self, '目印'), ...inLines(scan, /黒曜石/u, self, '走査')]);
  const contact = view ? contactCells(view, self) : [];
  if (!lava && !obsidian) return [];
  const closer = lava && (!obsidian || lava.meters < obsidian.meters) ? '（溶岩の方が近い）' : '';
  return [`黒曜石 10 個の元: 溶岩の源 ${show(lava, '見えていない')} / 自然の黒曜石 ${show(obsidian, '見えていない')}${closer}。`
    + '階段掘りは 0.5〜0.9 マス/秒（ダイヤのツルハシ）、溶岩に水を注いで 1 個目ができるまで 30〜50 秒、黒曜石の dig は空気中で 1 個約 9 秒（ダイヤのツルハシ・測った値）',
    ...contact.length ? [`水の源と溶岩の源の両方に隣り合うマス（開けると水と溶岩が出会う）: ${contact.join(' / ')}。溶岩の源だけに隣り合う岩を開けると、溶岩が流れ込む`] : []];
}
