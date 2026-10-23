import type { MapView } from './minecraftLlmcPreflightMap.js';
import { ptText, type P } from './minecraftLlmcWalkRules.js';

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

/** `body.obsidian`: the nearest lava and the nearest obsidian beside each other, when the plan's node is the obsidian. Empty otherwise. */
export function obsidianWays(body: Rec, self: P, view: MapView | null): string[] {
  if (!/黒曜石/u.test(String(body.planNow ?? ''))) return [];
  const landmarks = strings(body.landmarks), scan = strings(body.scan);
  const lava = nearest([...view ? inMap(view, self, 'L') : [], ...inLines(landmarks, /^L |溶岩/u, self, '目印'), ...inLines(scan, /溶岩/u, self, '走査')]);
  const obsidian = nearest([...view ? inMap(view, self, 'O') : [], ...inLines(landmarks, /^O |黒曜石/u, self, '目印'), ...inLines(scan, /黒曜石/u, self, '走査')]);
  if (!lava && !obsidian) return [];
  const closer = lava && (!obsidian || lava.meters < obsidian.meters) ? '（溶岩の方が近い）' : '';
  return [`黒曜石 10 個の元: 溶岩の源 ${show(lava, '見えていない')} / 自然の黒曜石 ${show(obsidian, '見えていない')}${closer}。`
    + '階段掘りは 0.5〜0.9 マス/秒（ダイヤのツルハシ）、溶岩に水を注いで 1 個目ができるまで 30〜50 秒、黒曜石の dig は空気中で 1 個約 9 秒（実走37）'];
}
