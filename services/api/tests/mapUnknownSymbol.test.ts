import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { rangeStop } from '../src/surfaces/minecraft/minecraftLlmcRangeGuard.js';
import { BODY_RULES, mapView, readLayers } from '../src/surfaces/minecraft/minecraftLlmcPreflightMap.js';
import { lookOf } from '../src/surfaces/minecraft/minecraftLlmcSurfaceLook.js';

/**
 * Run 47, +1,657.4 (after a restart of the VM the whole map was `?` but the feet): the model checked the lava source with view and sent obsidian (171,-5,179), and the head refused it before sending:
 * 「at の (171,-5,179) は地図で溶岩のマスではない」. A `?` is a cell the map cannot say; a guard that refuses a cell for being something else than what the hand needs reads only what the map shows for
 * certain. The `?` goes to the body, which checks the real block.
 */
const FEET = { x: 171, y: -4, z: 180 };
const AT = { x: 171, y: -5, z: 179 };
/** x=166..176 z=174..184 of one layer per y from -7 to -3; the feet cell is `@`; `symbol` gives every other cell. */
function map(symbol: (x: number, y: number, z: number) => string): string {
  const lines = [`地図 v1 足=(${FEET.x},${FEET.y},${FEET.z}) x=166..176 z=174..184 方式=layers 上=北`];
  for (let y = -3; y >= -7; y -= 1) {
    lines.push(`y=${y} x=166..176 z=174..184`, 'z\\x 166 167 168 169 170 171 172 173 174 175 176');
    for (let z = 174; z <= 184; z += 1) lines.push(` ${z} ${Array.from({ length: 11 }, (_, i) => x_(166 + i, y, z, symbol)).join(' ')}`);
  }
  return lines.join('\n');
}
const x_ = (x: number, y: number, z: number, symbol: (x: number, y: number, z: number) => string) => x === FEET.x && y === FEET.y && z === FEET.z ? '@' : symbol(x, y, z);
const frame = (localMap: string): BodyObservation => ({ state: { world: { position: { x: FEET.x + 0.5, y: FEET.y, z: FEET.z + 0.5 }, localMap } } } as unknown as BodyObservation);
const obsidian = { hands: [{ do: 'obsidian', at: [AT] }] };

describe('obsidian: a cell the map cannot say is not refused as no lava', () => {
  it('the whole map is ? but the feet: the hand goes to the body', () => {
    expect(rangeStop(obsidian, frame(map(() => '?')))).toBeNull();
  });
  it('the cell is ? beside known cells: the hand goes to the body too', () => {
    expect(rangeStop(obsidian, frame(map((x, y, z) => x === AT.x && y === AT.y && z === AT.z ? '?' : '#')))).toBeNull();
  });
  it('the cell is lava on the map (L or l): it goes', () => {
    expect(rangeStop(obsidian, frame(map((x, y, z) => x === AT.x && y === AT.y && z === AT.z ? 'L' : '?')))).toBeNull();
    expect(rangeStop(obsidian, frame(map((x, y, z) => x === AT.x && y === AT.y && z === AT.z ? 'l' : '?')))).toBeNull();
  });
  it('the cell is something else that the map shows for certain (rock, air, water): refused, as before', () => {
    for (const symbol of ['#', '.', 'w']) {
      expect(rangeStop(obsidian, frame(map((x, y, z) => x === AT.x && y === AT.y && z === AT.z ? symbol : '?'))), symbol).toMatchObject({ hand: 1, kind: 'obsidian', code: 'not_lava' });
    }
  });
  it('a cell the map does not draw at all is not refused either (as before)', () => {
    expect(rangeStop({ hands: [{ do: 'obsidian', at: [{ x: 500, y: -5, z: 500 }] }] }, frame(map(() => '#')))).toBeNull();
  });
});

describe('the look of the map: ? is no wall', () => {
  const text = map((x, y, z) => x === AT.x && y === AT.y && z === AT.z ? '?' : x === AT.x + 1 && y === AT.y && z === AT.z ? '#' : '.');
  const view = mapView(readLayers(text, BODY_RULES)!);
  const look = lookOf(view, text, FEET);
  it('a ? cell is unknown, a known rock is closed, air is open', () => {
    expect(look(AT.x, AT.y, AT.z)).toEqual({ kind: 'unknown' });
    expect(look(AT.x + 1, AT.y, AT.z)).toMatchObject({ kind: 'closed', symbol: '#' });
    expect(look(AT.x - 1, AT.y, AT.z)).toEqual({ kind: 'open' });
  });
});
