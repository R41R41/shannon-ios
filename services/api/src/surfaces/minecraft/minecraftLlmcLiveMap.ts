import { readLayers } from './minecraftLlmcPreflightMap.js';
import { nameOf, ptText, type P } from './minecraftLlmcWalkRules.js';

/**
 * mb-llmc v2 live (改修案 2.2 「地図は予備として残し、全層の範囲と目盛りをそろえ、足の列の印を全層に」; 再現台 R10・R11): the map text, kept as the
 * spare of `around` and `route`, with every layer on the same x and z range (a cell outside a layer is `?`), the height from her feet in
 * each layer's name and a `^` over her feet's column in each (the replay's count: the layers' ranges differed from the heading's in 45 of 45
 * scenes, 1.8 ranges a scene), and a stopped hand's 3×3×3 with the whole coordinate of each cell.
 */
export function normalizeMap(map: string | undefined): string | undefined {
  const layers = readLayers(map);
  if (!layers || !map) return map;
  const lines = map.split('\n');
  const ys: number[] = [];
  for (const line of lines.slice(1)) {
    const m = /^y=(-?\d+)/u.exec(line);
    if (m) ys.push(Number(m[1]));
  }
  // The range every layer shows (the smallest layer's): a cell outside it is cut, so that no cell is a `?` that only the layout made.
  let x0 = -Infinity, x1 = Infinity, z0 = -Infinity, z1 = Infinity;
  for (const grid of layers.layers.values()) {
    const xs = [...grid.keys()].map(key => Number(key.split(',')[0])), zs = [...grid.keys()].map(key => Number(key.split(',')[1]));
    x0 = Math.max(x0, Math.min(...xs));
    x1 = Math.min(x1, Math.max(...xs));
    z0 = Math.max(z0, Math.min(...zs));
    z1 = Math.min(z1, Math.max(...zs));
  }
  const feet = layers.feet;
  // The surface form's top grid (symbol and height, two characters a cell) stays as it is, up to the first layer.
  const firstLayer = lines.findIndex((line, i) => i > 0 && /^y=-?\d+/u.test(line));
  const out: string[] = [lines[0]!, ...(layers.mode === 'surface' ? lines.slice(1, firstLayer) : [])];
  out.push(`（以下の層は全部 x=${x0}..${x1} z=${z0}..${z1} の同じ範囲（全層が持つ範囲。外は around か mc_view）。^ の列が足の x=${feet.x}。列の見出しは x の下 1 桁）`);
  const ticks = Array.from({ length: x1 - x0 + 1 }, (_, i) => String(Math.abs(x0 + i) % 10));
  out.push(`z\\x ${ticks.join(' ')}`);
  const caret = `${' '.repeat(4 + 2 * (feet.x - x0))}^`;
  for (const y of ys) {
    const grid = layers.layers.get(y)!;
    const rel = y - feet.y;
    out.push(`y=${y}（足${rel === 0 ? 'の高さ' : rel > 0 ? ` +${rel}` : ` ${rel}`}）`, caret);
    for (let z = z0; z <= z1; z += 1) {
      const row = Array.from({ length: x1 - x0 + 1 }, (_, i) => grid.get(`${x0 + i},${z}`) ?? '?');
      out.push(`${String(z).padStart(3)} ${row.join(' ')}`);
    }
  }
  out.push(...lines.filter(line => line.startsWith('縦 ')));
  return out.join('\n');
}

/**
 * A stopped hand's surroundings (`周り（上の層から、北が上・西が左）x=308..310 z=72..74 y=68: N.#/N.#/N.N y=67: …`, the body's text) with the whole
 * coordinate of every cell, the cells of one symbol together. A line that is not that text is left as it is.
 */
export function expandAround(text: string): { text: string; expanded: number } {
  let expanded = 0;
  const out = text.split('\n').map(line => {
    const m = /^(\s*)周り（上の層から、北が上・西が左）x=(-?\d+)\.\.(-?\d+) z=(-?\d+)\.\.(-?\d+) (.*)$/u.exec(line);
    if (!m) return line;
    expanded += 1;
    const x0 = Number(m[2]), z0 = Number(m[4]);
    const groups = new Map<string, string[]>();
    let center: P | null = null;
    const layers = [...m[6]!.matchAll(/y=(-?\d+): (\S+)/gu)];
    const midY = Number(layers[Math.floor(layers.length / 2)]?.[1]);
    for (const layer of layers) {
      const y = Number(layer[1]);
      layer[2]!.split('/').forEach((row, rowIndex) => [...row].forEach((symbol, col) => {
        const cell = { x: x0 + col, y, z: z0 + rowIndex };
        if (y === midY && col === 1 && rowIndex === 1) center = cell;
        const label = symbol === '@' ? '@ 自分の足' : nameOf(symbol);
        groups.set(label, [...groups.get(label) ?? [], ptText(cell)]);
      }));
    }
    const body = [...groups].map(([label, cells]) => `${label}: ${cells.join('')}`).join(' ／ ');
    return `${m[1]}止まった所 ${center ? ptText(center) : ''} の周り 3×3×3（マスごとの座標つき）: ${body}`;
  });
  return { text: out.join('\n'), expanded };
}
