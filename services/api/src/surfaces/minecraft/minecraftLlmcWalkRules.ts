import { HARM, NOT_FLOOR, SOLID, STANDS, type Cell, type MapView } from './minecraftLlmcPreflightMap.js';

/**
 * mb-llmc v2 (Syzygy ADR-0014 D0 "不明は不明のまま"): the walk's rules on a map, as facts for the live state's `around` and `route`
 * (`minecraftLlmcAround.ts`, `minecraftLlmcRoute.ts`). The same rules as the act preflight and the body's `probe path`
 * (`minecraftLlmcPreflightRoute.ts`, the body's `primitives/walk.ts` and `utils/walkRules.ts`): a step on the level, a step up of one with
 * the cell over the head clear, a drop of one to three with the cells of the fall clear, a diagonal only when one of its two corner
 * columns is open at feet and head. No digging and no laying a block unless a rule here is asked to count the cells it would dig.
 * Facts only: nothing here decides a hand.
 */
export type P = Cell;
export const keyOf = (p: P) => `${p.x},${p.y},${p.z}`;
export const ptText = (p: P) => `(${p.x},${p.y},${p.z})`;

/** The map symbols in the words of the live state (`記号 名前`). */
export const NAME: Readonly<Record<string, string>> = Object.freeze({
  '#': '石の類', ':': '土の類', s: '砂・砂利', I: '氷', n: 'ネザーラック', N: 'ネザーレンガ', u: 'ソウルサンド', O: '黒曜石', E: 'エンドストーン',
  G: 'グロウストーン', i: '鉄鉱石', c: '石炭鉱石', d: 'ダイヤ鉱石', g: '金鉱石', r: 'レッドストーン鉱石', o: '鉱石', X: '岩盤', W: '原木',
  H: '干し草', S: 'スポナー', F: 'かまど', T: '作業台', C: 'チェスト', B: 'ベッド', $: '固いブロック', L: '溶岩', l: '流れる溶岩', f: '火',
  x: 'クモの巣', M: 'マグマブロック', w: '水', '-': '流れる水', '.': '空気', '*': '空気', '@': '空気(自分の足)', '!': '空気(敵の足)',
  m: '空気(動物の足)', ',': '草花', h: 'はしご・つた', t: '松明', '=': 'レール', D: '扉', P: '板', '+': '柵・ガラス', '%': '葉', k: '作物',
  p: 'ネザーポータル', Q: 'エンドポータル枠', R: 'エンドポータル枠', e: 'エンドポータル', '?': '未ロード',
});
export const nameOf = (symbol: string | undefined): string => symbol === undefined ? '地図の外' : `${symbol} ${NAME[symbol] ?? '不明'}`;
/** Hard (not walked through, not filled): a wall of any shape. */
export const isHard = (symbol: string | undefined) => symbol !== undefined && SOLID.has(symbol);
/** Hurts to enter: lava, fire, cobweb, magma. */
export const isHarm = (symbol: string | undefined) => symbol !== undefined && HARM.has(symbol);
/** Open: neither hard nor harmful (a door, a leaf, a plant count as open, as the preflight takes them). */
export const isOpen = (symbol: string | undefined) => symbol !== undefined && !SOLID.has(symbol) && !HARM.has(symbol);
/** Known not to be a floor: air, water, lava, fire, a web. */
export const noFloor = (symbol: string | undefined) => symbol !== undefined && NOT_FLOOR.has(symbol);

export interface Step { kind: 'level' | 'up' | 'down'; drop: number; to: P; dig: P[]; bad: string | null }

/** One step to the column (tx, tz) of the given kind: the cells it would dig, and why it cannot be made at all (even digging), or null. */
export function stepOption(view: MapView, from: P, tx: number, tz: number, kind: Step['kind'], drop = 0): Step {
  const s = view.symbol;
  const dig: P[] = [];
  let bad: string | null = null;
  const need = (cell: P): void => {
    const symbol = s(cell.x, cell.y, cell.z);
    if (symbol === undefined) bad ??= `${ptText(cell)} は地図の外`;
    else if (isHarm(symbol)) bad ??= `${ptText(cell)} が${NAME[symbol]}`;
    else if (symbol === 'X') bad ??= `${ptText(cell)} が岩盤（掘れない）`;
    else if (isHard(symbol)) dig.push(cell);
  };
  const floorAt = (cell: P): void => {
    const symbol = s(cell.x, cell.y, cell.z);
    if (symbol === undefined) bad ??= `床 ${ptText(cell)} は地図の外`;
    else if (noFloor(symbol)) bad ??= `床 ${ptText(cell)} が${NAME[symbol]}（床が無い）`;
  };
  const y = from.y;
  if (kind === 'level') {
    need({ x: tx, y, z: tz });
    need({ x: tx, y: y + 1, z: tz });
    const feet = s(tx, y, tz);
    if (!(feet !== undefined && STANDS.has(feet))) floorAt({ x: tx, y: y - 1, z: tz });
    return { kind, drop: 0, to: { x: tx, y, z: tz }, dig, bad };
  }
  if (kind === 'up') {
    const step = s(tx, y, tz);
    if (!(step !== undefined && isHard(step))) bad = `隣 ${ptText({ x: tx, y, z: tz })} が固くない（上りではない）`;
    need({ x: from.x, y: y + 2, z: from.z });
    need({ x: tx, y: y + 1, z: tz });
    need({ x: tx, y: y + 2, z: tz });
    return { kind, drop: 0, to: { x: tx, y: y + 1, z: tz }, dig, bad };
  }
  return downStep(view, from, tx, tz, drop, { need, floorAt, bad: () => bad, mark: (why: string) => { bad ??= why; }, dig });
}

interface DownParts { need(cell: P): void; floorAt(cell: P): void; bad(): string | null; mark(why: string): void; dig: P[] }
/** A drop of `drop`: the same-height neighbour's feet and head are passed, the cells of the fall are open, the landing has a floor. */
function downStep(view: MapView, from: P, tx: number, tz: number, drop: number, parts: DownParts): Step {
  const s = view.symbol, y = from.y;
  const to = { x: tx, y: y - drop, z: tz };
  parts.need({ x: tx, y, z: tz });
  parts.need({ x: tx, y: y + 1, z: tz });
  for (let level = 1; level < drop; level += 1) {
    const symbol = s(tx, y - level, tz);
    if (symbol === undefined) parts.mark(`${ptText({ x: tx, y: y - level, z: tz })} は地図の外`);
    else if (!isOpen(symbol)) parts.mark(`落ちる途中の ${ptText({ x: tx, y: y - level, z: tz })} が${NAME[symbol] ?? symbol}`);
  }
  const land = s(tx, y - drop, tz);
  if (land === undefined) parts.mark(`着く所 ${ptText(to)} は地図の外`);
  else if (!isOpen(land)) parts.mark(`着く所 ${ptText(to)} が${NAME[land] ?? land}`);
  const headLand = s(tx, y - drop + 1, tz);
  if (headLand !== undefined && !isOpen(headLand)) parts.mark(`着く所の頭 ${ptText({ x: tx, y: y - drop + 1, z: tz })} が${NAME[headLand] ?? headLand}`);
  if (!(land !== undefined && STANDS.has(land))) parts.floorAt({ x: tx, y: y - drop - 1, z: tz });
  return { kind: 'down', drop, to, dig: parts.dig, bad: parts.bad() };
}

/** The step candidates to one column: on the level, up one, down one to three. */
export function stepOptions(view: MapView, from: P, tx: number, tz: number): Step[] {
  return [stepOption(view, from, tx, tz, 'level'), stepOption(view, from, tx, tz, 'up'),
    ...[1, 2, 3].map(drop => stepOption(view, from, tx, tz, 'down', drop))];
}
const ORDER: Record<Step['kind'], number> = { level: 0, up: 1, down: 2 };
/** The candidate with the fewest cells to dig (then level, up, down by the shorter drop), or null when none can be made. */
export function bestStep(options: readonly Step[]): Step | null {
  const ok = options.filter(item => !item.bad);
  ok.sort((a, b) => a.dig.length - b.dig.length || ORDER[a.kind] - ORDER[b.kind] || a.drop - b.drop);
  return ok[0] ?? null;
}
/** A diagonal's corners: one of the two columns beside the way is open at feet and head without digging. */
export function cornerOk(view: MapView, from: P, dx: number, dz: number): boolean {
  const column = (x: number, z: number) => isOpen(view.symbol(x, from.y, z)) && isOpen(view.symbol(x, from.y + 1, z));
  return column(from.x + dx, from.z) || column(from.x, from.z + dz);
}

/** How far a floorless cell falls, from the map: the air under it down to the first floor, or "n 以上" where the map ends. */
export function fallOf(view: MapView, x: number, y: number, z: number): { n: number; below: string | undefined; open: boolean } {
  let n = 0;
  for (let level = y; ; level -= 1) {
    const symbol = view.symbol(x, level, z);
    if (symbol === undefined) return { n, below: undefined, open: true };
    if (!noFloor(symbol)) return { n, below: symbol, open: false };
    n += 1;
  }
}
/** The fall in the words of the live state: `落差 n、下は …`, or `落差 n 以上（地図は y=… まで）` where the map ends. */
export function fallText(view: MapView, x: number, y: number, z: number): string {
  const fall = fallOf(view, x, y, z);
  if (fall.open) return `落差 ${fall.n} 以上（地図は y=${y - fall.n + 1} まで。それより下は地図に無い）`;
  return `落差 ${fall.n}、下は ${nameOf(fall.below)}`;
}

export const DIRS: ReadonlyArray<{ name: string; dx: number; dz: number }> = [
  { name: '北', dx: 0, dz: -1 }, { name: '南', dx: 0, dz: 1 }, { name: '東', dx: 1, dz: 0 }, { name: '西', dx: -1, dz: 0 },
  { name: '北東', dx: 1, dz: -1 }, { name: '北西', dx: -1, dz: -1 }, { name: '南東', dx: 1, dz: 1 }, { name: '南西', dx: -1, dz: 1 },
];
