/**
 * Maps drawn as the body draws them (`localMap.ts`, `drawLocalMap`), for the footing's tests: the layers form (feet −2..+2: feet −1..+1 at
 * 15×15 and feet ±2 at 11×11, each narrower layer naming its range) and the surface form (the top grid of symbol + height cells, 21×21,
 * then feet −1..+1 at 11×11), the feet's column last.
 */
export type Feet = { x: number; y: number; z: number };
/** The symbol of the block at an offset from the feet (dx east, dz south, dy up); the feet themselves are drawn `@` by the drawing. */
export type SymbolAt = (dx: number, dz: number, dy: number) => string;

const pad = (text: string | number, width: number) => String(text).padStart(width, ' ');
const digit = (n: number) => String(Math.abs(n) % 10);

function layer(feet: Feet, dy: number, radius: number, symbolAt: SymbolAt, ranged: boolean): string[] {
  const minX = feet.x - radius, maxX = feet.x + radius, minZ = feet.z - radius, maxZ = feet.z + radius, y = feet.y + dy;
  const lines = [ranged ? `y=${y} x=${minX}..${maxX} z=${minZ}..${maxZ}` : `y=${y}`];
  lines.push(`${'z\\x'.padEnd(3, ' ')} ${Array.from({ length: maxX - minX + 1 }, (_, i) => digit(minX + i)).join(' ')}`);
  for (let z = minZ; z <= maxZ; z++) {
    const row = Array.from({ length: maxX - minX + 1 }, (_, i) => dy === 0 && z === feet.z && minX + i === feet.x ? '@' : symbolAt(minX + i - feet.x, z - feet.z, dy));
    lines.push(`${pad(z, 3)} ${row.join(' ')}`);
  }
  return lines;
}

/** The layers form: the feet's column last (the body draws it; the footing does not read it). */
export function layersMap(feet: Feet, symbolAt: SymbolAt): string {
  return [`地図 v1 足=(${feet.x},${feet.y},${feet.z}) x=${feet.x - 7}..${feet.x + 7} z=${feet.z - 7}..${feet.z + 7} 方式=layers 上=北`,
    ...layer(feet, 2, 5, symbolAt, true), ...[1, 0, -1].flatMap(dy => layer(feet, dy, 7, symbolAt, false)), ...layer(feet, -2, 5, symbolAt, true),
    `縦 (${feet.x},${feet.z}) 上: y=${feet.y + 1}〜${feet.y + 6} .×6`, `縦 (${feet.x},${feet.z}) 下: y=${feet.y - 1} #`].join('\n');
}

/** The surface form: `topAt` gives the two characters of a column's top (symbol + height code), the layers round the feet at 11×11. */
export function surfaceMap(feet: Feet, topAt: (dx: number, dz: number) => string, symbolAt: SymbolAt): string {
  const minX = feet.x - 10, maxX = feet.x + 10, minZ = feet.z - 10, maxZ = feet.z + 10;
  const top = [`${'z\\x'.padEnd(3, ' ')} ${Array.from({ length: 21 }, (_, i) => digit(minX + i).padEnd(2, ' ')).join(' ').trimEnd()}`];
  for (let z = minZ; z <= maxZ; z++) {
    top.push(`${pad(z, 3)} ${Array.from({ length: 21 }, (_, i) => minX + i === feet.x && z === feet.z ? '@0' : topAt(minX + i - feet.x, z - feet.z)).join(' ')}`);
  }
  return [`地図 v1 足=(${feet.x},${feet.y},${feet.z}) x=${minX}..${maxX} z=${minZ}..${maxZ} 方式=surface 上=北`, ...top,
    ...[1, 0, -1].flatMap(dy => layer(feet, dy, 5, symbolAt, true)), `縦 (${feet.x},${feet.z}) 上: y=${feet.y + 1}〜${feet.y + 6} .×6`].join('\n');
}

/** Run 32's place: a bridge one block wide along x at the feet's height −1, open air (and the lava far below) either side. */
export const bridgeAt = (dx: number, dz: number, dy: number): string => dy === -1 && dz === 0 ? '#' : '.';
