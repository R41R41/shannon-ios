import { HARM, NOT_FLOOR, readLayers, SOLID, STANDS, mapView, type Layers, type MapView } from '../../src/surfaces/minecraft/minecraftLlmcPreflightMap.js';

/**
 * 書き直した live（10/23、決まりは rewriteRules.md）の部品: 地図から作る事実。手は決めない・足さない（事実だけ）。
 * 歩きの決まりは体の walk と同じ（掘らず置かず、段差は上り 1・下り 3 まで、斜めは角のどちらかの列が空いている時だけ）。
 * 地図は preflight の読み（`minecraftLlmcPreflightMap.ts` の readLayers/mapView）をそのまま使う。
 */
export type P = { x: number; y: number; z: number };
export const keyOf = (p: P) => `${p.x},${p.y},${p.z}`;
export const ptText = (p: P) => `(${p.x},${p.y},${p.z})`;

export const NAME: Record<string, string> = {
  '#': '石の類', ':': '土の類', s: '砂・砂利', I: '氷', n: 'ネザーラック', N: 'ネザーレンガ', u: 'ソウルサンド', O: '黒曜石', E: 'エンドストーン', G: 'グロウストーン',
  i: '鉄鉱石', c: '石炭鉱石', d: 'ダイヤ鉱石', g: '金鉱石', r: 'レッドストーン鉱石', o: '鉱石', X: '岩盤', W: '原木', H: '干し草', S: 'スポナー', F: 'かまど',
  T: '作業台', C: 'チェスト', B: 'ベッド', $: '固いブロック', L: '溶岩', l: '流れる溶岩', f: '火', x: 'クモの巣', M: 'マグマブロック', w: '水', '-': '流れる水',
  '.': '空気', '*': '空気', '@': '空気(自分の足)', '!': '空気(敵の足)', m: '空気(動物の足)', ',': '草花', h: 'はしご・つた', t: '松明', '=': 'レール', D: '扉', P: '板',
  '+': '柵・ガラス', '%': '葉', k: '作物', p: 'ネザーポータル', Q: 'エンドポータル枠', R: 'エンドポータル枠', e: 'エンドポータル', '?': '未ロード',
};
export const nameOf = (symbol: string | undefined): string => symbol === undefined ? '地図の外' : `${symbol} ${NAME[symbol] ?? '不明'}`;

/** 固い（歩けない・埋まっている）。 */
export const isHard = (symbol: string | undefined) => symbol !== undefined && SOLID.has(symbol);
/** 入ると危ない（溶岩・火・クモの巣・マグマ）。 */
export const isHarm = (symbol: string | undefined) => symbol !== undefined && HARM.has(symbol);
/** 空いている（固くも危なくもない。扉・葉・草・板などの「通れるか分からない」物も、preflight と同じく空きに入れる）。 */
export const isOpen = (symbol: string | undefined) => symbol !== undefined && !SOLID.has(symbol) && !HARM.has(symbol);
/** 床にならない物（空気・水・溶岩・火・クモの巣）。 */
export const noFloor = (symbol: string | undefined) => symbol !== undefined && NOT_FLOOR.has(symbol);

export interface Step { kind: 'level' | 'up' | 'down'; drop: number; to: P; dig: P[]; bad: string | null }

/** 1 歩（横に 1 列、同じ高さ・上り 1・下り 1〜3）の道のり: 掘るマスと、できない理由（掘っても足りない時）。 */
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
    const to = { x: tx, y, z: tz };
    need(to); need({ x: tx, y: y + 1, z: tz });
    const feet = s(tx, y, tz);
    if (!(feet !== undefined && STANDS.has(feet))) floorAt({ x: tx, y: y - 1, z: tz });
    return { kind, drop: 0, to, dig, bad };
  }
  if (kind === 'up') {
    const to = { x: tx, y: y + 1, z: tz };
    // 着く所の床 = 隣の同じ高さのマス: 固い時だけ上りになる（空いていれば同じ高さの歩き）。
    const step = s(tx, y, tz);
    if (!(step !== undefined && isHard(step))) bad = `隣 ${ptText({ x: tx, y, z: tz })} が固くない（上りではない）`;
    need({ x: from.x, y: y + 2, z: from.z }); need(to); need({ x: tx, y: y + 2, z: tz });
    return { kind, drop: 0, to, dig, bad };
  }
  // 下り: 同じ高さの隣 2 マス（足と頭）を通り、落ちる途中のマスは空いていて、着く所の床がある。
  const to = { x: tx, y: y - drop, z: tz };
  need({ x: tx, y, z: tz }); need({ x: tx, y: y + 1, z: tz });
  for (let level = 1; level < drop; level += 1) {
    const symbol = s(tx, y - level, tz);
    if (symbol === undefined) bad ??= `${ptText({ x: tx, y: y - level, z: tz })} は地図の外`;
    else if (!isOpen(symbol)) bad ??= `落ちる途中の ${ptText({ x: tx, y: y - level, z: tz })} が${NAME[symbol] ?? symbol}`;
  }
  const land = s(tx, y - drop, tz);
  if (land === undefined) bad ??= `着く所 ${ptText(to)} は地図の外`;
  else if (!isOpen(land)) bad ??= `着く所 ${ptText(to)} が${NAME[land] ?? land}`;
  const headLand = s(tx, y - drop + 1, tz);
  if (headLand !== undefined && !isOpen(headLand)) bad ??= `着く所の頭 ${ptText({ x: tx, y: y - drop + 1, z: tz })} が${NAME[headLand] ?? headLand}`;
  if (!(land !== undefined && STANDS.has(land))) floorAt({ x: tx, y: y - drop - 1, z: tz });
  return { kind, drop, to, dig, bad };
}

/** 横 1 列の歩きの候補（同じ高さ・上り・下り 1〜3）。 */
export function stepOptions(view: MapView, from: P, tx: number, tz: number): Step[] {
  return [stepOption(view, from, tx, tz, 'level'), stepOption(view, from, tx, tz, 'up'), ...[1, 2, 3].map(drop => stepOption(view, from, tx, tz, 'down', drop))];
}
const ORDER: Record<Step['kind'], number> = { level: 0, up: 1, down: 2 };
/** 掘るマスが最も少ない候補（同数なら 同じ高さ → 上り → 下り の短い落差）。できる候補が無ければ null。 */
export function bestStep(options: readonly Step[]): Step | null {
  const ok = options.filter(item => !item.bad);
  ok.sort((a, b) => a.dig.length - b.dig.length || ORDER[a.kind] - ORDER[b.kind] || a.drop - b.drop);
  return ok[0] ?? null;
}
/** 斜めの角（どちらかの列の足と頭が掘らずに空いている）。 */
export function cornerOk(view: MapView, from: P, dx: number, dz: number): boolean {
  const column = (x: number, z: number) => isOpen(view.symbol(x, from.y, z)) && isOpen(view.symbol(x, from.y + 1, z));
  return column(from.x + dx, from.z) || column(from.x, from.z + dz);
}

/** 床が無い所の落差: そのマスの下から、固い物にぶつかるまでの空き（地図が持つ分だけ）。 */
function fallText(view: MapView, x: number, y: number, z: number): string {
  let n = 0;
  for (let level = y; ; level -= 1) {
    const symbol = view.symbol(x, level, z);
    if (symbol === undefined) return `落差 ${n} 以上（地図は y=${level + 1} まで。それより下は地図に無い）`;
    if (!noFloor(symbol)) return `落差 ${n}、下は ${nameOf(symbol)}`;
    n += 1;
  }
}

const DIRS: Array<{ name: string; dx: number; dz: number }> = [
  { name: '北', dx: 0, dz: -1 }, { name: '南', dx: 0, dz: 1 }, { name: '東', dx: 1, dz: 0 }, { name: '西', dx: -1, dz: 0 },
  { name: '北東', dx: 1, dz: -1 }, { name: '北西', dx: -1, dz: -1 }, { name: '南東', dx: 1, dz: 1 }, { name: '南西', dx: -1, dz: 1 },
];
const triple = (view: MapView, cell: P) => `足 ${nameOf(view.symbol(cell.x, cell.y, cell.z))}・頭 ${nameOf(view.symbol(cell.x, cell.y + 1, cell.z))}・床 ${nameOf(view.symbol(cell.x, cell.y - 1, cell.z))}`;
const digText = (view: MapView, cells: readonly P[]) => cells.map(c => `${ptText(c)} ${NAME[view.symbol(c.x, c.y, c.z) ?? ''] ?? '?'}`).join('、');

/** 1 つの方向（距離 1 または 2）の 1 行。 */
function directionLine(view: MapView, feet: P, dir: { name: string; dx: number; dz: number }, distance: 1 | 2): string {
  const tx = feet.x + dir.dx * distance, tz = feet.z + dir.dz * distance;
  const label = `${dir.name}${distance === 2 ? ' 2 マス先' : ''} ${ptText({ x: tx, y: feet.y, z: tz })}`;
  const diagonal = dir.dx !== 0 && dir.dz !== 0;
  const options = stepOptions(view, feet, tx, tz);
  const best = bestStep(options);
  const head = `${label}: ${triple(view, { x: tx, y: feet.y, z: tz })} → `;
  if (distance === 2) {
    // 2 マス先は同じ高さの列だけを言う（1 マス目を越えた先の 足・頭・床）。
    const level = options[0]!;
    if (!level.bad) return `${head}${level.dig.length ? `掘れば歩ける（掘る ${digText(view, level.dig)}）` : '歩ける'}`;
    return `${head}${level.bad.includes('床が無い') ? `${level.dig.length ? '掘っても' : ''}床が無い（${fallText(view, tx, feet.y - 1, tz)}）` : level.bad}`;
  }
  if (diagonal && !cornerOk(view, feet, dir.dx, dir.dz)) {
    return `${head}斜めの角の両方の列（${ptText({ x: feet.x + dir.dx, y: feet.y, z: feet.z })} と ${ptText({ x: feet.x, y: feet.y, z: feet.z + dir.dz })}）の足か頭が固い: 斜めには歩けない（斜めは角のどちらかの列の足と頭が空いている時だけ）`;
  }
  if (best && !best.dig.length) {
    const how = best.kind === 'level' ? '' : best.kind === 'up' ? `（1 段上り、着く所 ${ptText(best.to)}）` : `（${best.drop} 段下り、着く所 ${ptText(best.to)}）`;
    return `${head}歩ける${how}`;
  }
  if (best) {
    const how = best.kind === 'level' ? '' : best.kind === 'up' ? `1 段上りで ${ptText(best.to)} に着く` : `${best.drop} 段下りで ${ptText(best.to)} に着く`;
    return `${head}掘れば歩ける: 掘る ${digText(view, best.dig)}${how ? `（${how}）` : ''}`;
  }
  const level = options[0]!;
  if (level.bad?.includes('床が無い')) return `${head}${level.dig.length ? '掘っても' : ''}床が無い（${fallText(view, tx, feet.y - 1, tz)}）`;
  return `${head}歩けない: ${level.bad ?? '理由不明'}`;
}

/** 足のマスの周り（8 方向の 1 歩、4 方向の 2 マス先、上と下）。 */
export function aroundLines(view: MapView, feet: P): string[] {
  const lines: string[] = [];
  for (const dir of DIRS) lines.push(directionLine(view, feet, dir, 1));
  for (const dir of DIRS.slice(0, 4)) lines.push(directionLine(view, feet, dir, 2));
  const over = view.symbol(feet.x, feet.y + 2, feet.z), under = view.symbol(feet.x, feet.y - 1, feet.z);
  lines.push(`上 頭の上 ${ptText({ x: feet.x, y: feet.y + 2, z: feet.z })}: ${isHard(over) ? `固い（${nameOf(over)}）` : nameOf(over)}`);
  lines.push(`下 足の下 ${ptText({ x: feet.x, y: feet.y - 1, z: feet.z })}: ${noFloor(under) ? `床が無い（${fallText(view, feet.x, feet.y - 1, feet.z)}）` : `床あり（${nameOf(under)}）`}`);
  return lines;
}

/* ------------------------------------------------------------------ 道 */
export interface Reach { cell: P; digs: number; steps: number; prev: string | null; dig: P[] }
/** 足から、掘るマスの数が少ない順に行ける立ち位置を全部求める（地図の中だけ）。 */
export function reachable(view: MapView, feet: P, maxDigs = 8): Map<string, Reach> {
  const best = new Map<string, Reach>();
  const queue: Reach[] = [{ cell: feet, digs: 0, steps: 0, prev: null, dig: [] }];
  best.set(keyOf(feet), queue[0]!);
  const better = (a: { digs: number; steps: number }, b: { digs: number; steps: number }) => a.digs < b.digs || (a.digs === b.digs && a.steps < b.steps);
  const heap = [queue[0]!];
  const pop = () => { heap.sort((a, b) => a.digs - b.digs || a.steps - b.steps); return heap.shift()!; };
  while (heap.length) {
    const at = pop();
    if (best.get(keyOf(at.cell)) !== at) continue;
    for (const dir of DIRS) {
      const diagonal = dir.dx !== 0 && dir.dz !== 0;
      if (diagonal && !cornerOk(view, at.cell, dir.dx, dir.dz)) continue;
      for (const option of stepOptions(view, at.cell, at.cell.x + dir.dx, at.cell.z + dir.dz)) {
        if (option.bad) continue;
        const digs = at.digs + option.dig.length;
        if (digs > maxDigs) continue;
        const next: Reach = { cell: option.to, digs, steps: at.steps + 1, prev: keyOf(at.cell), dig: option.dig };
        const known = best.get(keyOf(option.to));
        if (known && !better(next, known)) continue;
        best.set(keyOf(option.to), next);
        heap.push(next);
      }
    }
  }
  return best;
}
export function pathTo(reach: Map<string, Reach>, cell: P): { points: P[]; dig: P[] } {
  const points: P[] = [], dig: P[] = [], seen = new Set<string>();
  for (let at: Reach | undefined = reach.get(keyOf(cell)); at; at = at.prev ? reach.get(at.prev) : undefined) {
    points.unshift(at.cell);
    for (const cell2 of [...at.dig].reverse()) if (!seen.has(keyOf(cell2))) { seen.add(keyOf(cell2)); dig.unshift(cell2); }
  }
  return { points, dig };
}
/** 道の点を、向きが変わる所と終わりだけにして書く（walk の path に使える点）。 */
function pointsText(points: readonly P[]): string {
  if (points.length <= 2) return points.map(ptText).join('→');
  const keep: P[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = points[i - 1]!, b = points[i]!, c = points[i + 1]!;
    if (b.x - a.x !== c.x - b.x || b.z - a.z !== c.z - b.z || b.y - a.y !== c.y - b.y) keep.push(b);
  }
  keep.push(points.at(-1)!);
  return keep.map(ptText).join('→');
}

export interface Goal { at: P; range: number }
/** 計画の今の節の目的地（`＠x,y,z`、`at:x,y,z~範囲`）。複数あれば足に近い物。 */
export function goalOf(planNow: string, feet: P): Goal | null {
  const text = planNow.split('済み:')[0] ?? '';
  const at = text.indexOf('＠');
  if (at < 0) return null;
  const found = [...text.slice(at).matchAll(/(-?\d+),(-?\d+),(-?\d+)/gu)].map(m => ({ x: +m[1]!, y: +m[2]!, z: +m[3]! }));
  if (!found.length) return null;
  found.sort((a, b) => Math.hypot(a.x - feet.x, a.y - feet.y, a.z - feet.z) - Math.hypot(b.x - feet.x, b.y - feet.y, b.z - feet.z));
  const range = /at:-?\d+,-?\d+,-?\d+~(\d+)/u.exec(planNow);
  return { at: found[0]!, range: range ? Number(range[1]) : 1 };
}

/** 目的地への道の事実。手は決めない。 */
export function routeLines(view: MapView, feet: P, goal: Goal, planLabel: string): string[] {
  const reach = reachable(view, feet, 6);
  const dist = (c: P) => Math.hypot(c.x - goal.at.x, c.y - goal.at.y, c.z - goal.at.z);
  const inMap = view.known(goal.at.x, goal.at.y, goal.at.z);
  const horizontal = Math.hypot(goal.at.x - feet.x, goal.at.z - feet.z);
  const lines = [`計画 ${planLabel} の目的地 ${ptText(goal.at)}（足から 水平 ${horizontal.toFixed(1)}m・高さ ${goal.at.y - feet.y >= 0 ? '+' : ''}${goal.at.y - feet.y}。${inMap ? '地図の中' : '地図の外'}${goal.range > 1 ? `。済みの条件は目的地の ${goal.range}m 以内` : ''}）。`
    + '歩きの決まりは walk と同じ（掘らず置かず、上り 1・下り 3 まで）。敵に見られるかは含まない'];
  let previous = Infinity;
  let shown = 0;
  for (let k = 0; k <= 6 && shown < 4; k += 1) {
    let top: Reach | null = null;
    for (const item of reach.values()) {
      if (item.digs > k) continue;
      if (!top || dist(item.cell) < dist(top.cell) - 1e-9 || (Math.abs(dist(item.cell) - dist(top.cell)) < 1e-9 && (item.digs < top.digs || (item.digs === top.digs && item.steps < top.steps)))) top = item;
    }
    if (!top) continue;
    const distance = dist(top.cell);
    if (k > 0 && distance > previous - 1) continue;
    previous = distance;
    shown += 1;
    const route = pathTo(reach, top.cell);
    const arrived = distance <= Math.max(goal.range, 0.9);
    const where = `${ptText(top.cell)}（目的地まで 水平 ${Math.hypot(top.cell.x - goal.at.x, top.cell.z - goal.at.z).toFixed(1)}m・高さ ${goal.at.y - top.cell.y >= 0 ? '+' : ''}${goal.at.y - top.cell.y}）`;
    const walk = top.steps ? `道の点 ${pointsText(route.points)}` : '足のマスのまま（掘らずに歩ける隣が無い）';
    const dig = route.dig.length ? `。掘るマス（${route.dig.length}）: ${digText(view, route.dig)}` : '';
    lines.push(`${k === 0 ? '掘らずに行ける範囲の、' : `掘り ${route.dig.length} マスまで許した時の、`}目的地に最も近い立ち位置 ${arrived ? '（目的地に着く）' : ''}${where}。${walk}${dig}`);
    if (arrived) break;
  }
  if (shown === 1 && lines.length === 2 && !lines[1]!.includes('着く:')) lines.push('掘り 6 マスまで許しても、これより目的地に近づく立ち位置は地図の中に無い（地図の外へ出る道は含まない）');
  return lines;
}

/* ------------------------------------------------------------------ 地図の書き直し（全層を同じ範囲・足の列の印・足からの高さ） */
export function normalizeMap(map: string | undefined, feetOverride?: P): string | undefined {
  const layers = readLayers(map);
  if (!layers || !map) return map;
  const lines = map.split('\n');
  const head = lines[0]!;
  const ys: number[] = [];
  for (const line of lines.slice(1)) { const m = /^y=(-?\d+)/u.exec(line); if (m) ys.push(Number(m[1])); }
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const grid of layers.layers.values()) for (const k of grid.keys()) {
    const [x, z] = k.split(',').map(Number) as [number, number];
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  const feet = feetOverride ?? layers.feet;
  const out: string[] = [];
  // surface の先頭の格子（記号+高さの 2 文字）は、そのまま残す（層の始まりまで）。
  const firstLayer = lines.findIndex((line, i) => i > 0 && /^y=-?\d+/u.test(line));
  out.push(head.replace(/ 方式=/u, ' 方式='), ...(layers.mode === 'surface' ? lines.slice(1, firstLayer) : []));
  out.push(`（以下の層は全部 x=${x0}..${x1} z=${z0}..${z1} の同じ範囲。範囲の外のマスは ?。^ の列が足の x=${feet.x}）`);
  const ticks = Array.from({ length: x1 - x0 + 1 }, (_, i) => String(Math.abs(x0 + i) % 10));
  const caret = `${' '.repeat(4 + 2 * (feet.x - x0))}^`;
  for (const y of ys) {
    const grid = layers.layers.get(y)!;
    const rel = y - feet.y;
    out.push(`y=${y}（足${rel === 0 ? 'の高さ' : rel > 0 ? ` +${rel}` : ` ${rel}`}）`, `z\\x ${ticks.join(' ')}`, caret);
    for (let z = z0; z <= z1; z += 1) {
      const row = Array.from({ length: x1 - x0 + 1 }, (_, i) => grid.get(`${x0 + i},${z}`) ?? '?');
      out.push(`${String(z).padStart(3)} ${row.join(' ')}`);
    }
  }
  out.push(...lines.filter(line => line.startsWith('縦 ')));
  return out.join('\n');
}

export { mapView, readLayers };
export type { Layers, MapView };
