import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { CHECK_FORBID } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { aroundLines, awayLines, standLine, watchedHostile } from '../src/surfaces/minecraft/minecraftLlmcAround.js';
import { seenReopenStop } from '../src/surfaces/minecraft/minecraftLlmcHandGuards.js';
import { heldBeforeSend } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { preflightAct, preflightText } from '../src/surfaces/minecraft/minecraftLlmcPreflight.js';
import { BODY_RULES, mapView, readLayers } from '../src/surfaces/minecraft/minecraftLlmcPreflightMap.js';
import { retreatLine } from '../src/surfaces/minecraft/minecraftLlmcRetreat.js';
import { lookOf } from '../src/surfaces/minecraft/minecraftLlmcSurfaceLook.js';
import { V2_ALWAYS, V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

/**
 * mc-sonnet-guards (decision replay 2026-10-26, Sonnet 5.5 against Opus 5.5 on the rel44 input): what the code holds before an act is sent
 * (a block put into her own feet or head cell, a dig beside lava, a dig of a cell that stopped for 「見られる」 written relative to her feet), what the
 * live says (the cell she stands in, the nearest place that cuts a hostile's line).
 */
type Cell = { x: number; y: number; z: number };
const at = (x: number, y: number, z: number): Cell => ({ x, y, z });
/** A map of rock around `feet` with the cells in `open` made `.` (or the symbol given). */
function mapOf(feet: Cell, open: Array<Cell | [Cell, string]> = []): string {
  const changed = new Map<string, string>(open.map(item => Array.isArray(item) ? [`${item[0].x},${item[0].y},${item[0].z}`, item[1]] : [`${item.x},${item.y},${item.z}`, '.']));
  const lines = [`地図 v1 足=(${feet.x},${feet.y},${feet.z}) x=${feet.x - 7}..${feet.x + 7} z=${feet.z - 7}..${feet.z + 7} 方式=layers 上=北`];
  for (const dy of [2, 1, 0, -1, -2]) {
    const y = feet.y + dy, half = Math.abs(dy) === 2 ? 5 : 7;
    lines.push(Math.abs(dy) === 2 ? `y=${y} x=${feet.x - half}..${feet.x + half} z=${feet.z - half}..${feet.z + half}` : `y=${y}`);
    for (let z = feet.z - half; z <= feet.z + half; z += 1) {
      const row: string[] = [];
      for (let x = feet.x - half; x <= feet.x + half; x += 1) row.push(changed.get(`${x},${y},${z}`) ?? (x === feet.x && y === feet.y && z === feet.z ? '@' : '#'));
      lines.push(` ${z} ${row.join(' ')}`);
    }
  }
  return lines.join('\n');
}
const feet = at(0, 0, 0);
/** A level corridor along +x from the feet with rock under it. */
const corridor = (length: number): Cell[] => Array.from({ length: length + 1 }, (_, x) => at(x, 0, 0)).flatMap(cell => [cell, at(cell.x, 1, 0)]);
const hold = (hands: unknown[], open: Array<Cell | [Cell, string]> = corridor(6), options: { bodyRules?: boolean; continuePlace?: boolean; notes?: string[] } = { bodyRules: true }) =>
  preflightAct({ hands }, { map: mapOf(feet, open), feet }, options);

describe('a block put into the cell she stands in', () => {
  const open = [...corridor(6), at(0, 2, 0)];
  it('is held when the place names her feet or her head cell, with what to do instead', () => {
    const stop = hold([{ do: 'place', block: 'cobblestone', at: [at(0, 1, 0)] }], open)!;
    expect(stop).toMatchObject({ hand: 1, kind: 'place', word: '置けない', code: 'own_cell', cell: at(0, 1, 0) });
    expect(stop.why).toBe('(0,1,0) は今立っている頭のマス（足 (0,0,0) と頭 (0,1,0) の 2 マスには place できない）');
    expect(hold([{ do: 'place', block: 'cobblestone', at: [at(1, 0, 0), at(0, 0, 0)] }], open)).toMatchObject({ code: 'own_cell', cell: at(0, 0, 0) });
    const text = preflightText(stop);
    expect(text).toContain('手 1 place 置けない');
    expect(text).toContain('足の下に積むなら pillarUp');
  });
  it('is not held for the cell over her head, a neighbour, or a cell she has walked away from', () => {
    expect(hold([{ do: 'place', block: 'cobblestone', at: [at(0, 2, 0)] }], open)).toBeNull();
    expect(hold([{ do: 'place', block: 'cobblestone', at: [at(1, 0, 0)] }], open)).toBeNull();
    expect(hold([{ do: 'walk', to: at(3, 0, 0) }, { do: 'place', block: 'cobblestone', at: [at(0, 1, 0)] }], open)).toBeNull();
  });
  it('follows where the hands before leave her: the cell she walked to is hers', () => {
    const stop = hold([{ do: 'walk', to: at(3, 0, 0) }, { do: 'place', block: 'cobblestone', at: [at(3, 1, 0)] }], open)!;
    expect(stop).toMatchObject({ hand: 2, code: 'own_cell', cell: at(3, 1, 0) });
  });
  it('reads a relative cell from her feet, and says nothing when a dig that walks to pick up leaves her place unknown', () => {
    expect(hold([{ do: 'place', block: 'cobblestone', rel: true, at: [at(0, 0, 0)] }], open)).toMatchObject({ code: 'own_cell' });
    expect(hold([{ do: 'dig', at: [at(1, 0, 0)] }, { do: 'place', block: 'cobblestone', at: [at(0, 0, 0)] }], open)).toBeNull();
    expect(hold([{ do: 'dig', at: [at(1, 0, 0)], collect: false }, { do: 'place', block: 'cobblestone', at: [at(0, 1, 0)] }], open)).toMatchObject({ code: 'own_cell', hand: 2 });
  });
  it('is a skipped cell, not a stop, with onFail continue (the body skips the cell): said as a note', () => {
    const notes: string[] = [];
    expect(hold([{ do: 'place', block: 'cobblestone', at: [at(0, 1, 0)], onFail: 'continue' }], open, { bodyRules: true, continuePlace: true, notes })).toBeNull();
    expect(notes[0]).toContain('onFail continue');
  });
});

describe('a dig of a block with lava beside it', () => {
  // Rock at (3,0,0) and (3,1,0) in a corridor 2 long, lava at (4,0,0).
  const open = [...corridor(2), [at(4, 0, 0), 'L'] as [Cell, string]];
  it('is held, naming the lava, the closed word and what to do instead', () => {
    const stop = hold([{ do: 'dig', at: [at(3, 0, 0)] }], open)!;
    expect(stop).toMatchObject({ hand: 1, kind: 'dig', word: '溶岩が流れ込む', code: 'lava_next', cell: at(3, 0, 0) });
    expect(stop.why).toBe('(3,0,0) は石の類（地図 #）で、(4,0,0) に溶岩が隣り合う（開けると溶岩が流れ込む）');
    expect(preflightText(stop)).toContain('溶岩の隣は掘らない。溶岩に接しない別のマスを掘るか、先に溶岩の面へ place');
  });
  it('is held for flowing lava over the cell too, and for the later cell of a dig', () => {
    expect(hold([{ do: 'dig', at: [at(3, 1, 0)] }], [...corridor(2), [at(3, 2, 0), 'l']])).toMatchObject({ code: 'lava_next', cell: at(3, 1, 0) });
    expect(hold([{ do: 'dig', at: [at(2, 0, 0), at(3, 0, 0)] }], open)).toMatchObject({ code: 'lava_next', cell: at(3, 0, 0) });
  });
  it('is let go with water beside the cell (the obsidian way), for obsidian, for a block the act put on the lava, and away from lava', () => {
    expect(hold([{ do: 'dig', at: [at(3, 0, 0)] }], [...open, [at(3, 1, 0), 'w']])).toBeNull();
    expect(hold([{ do: 'dig', at: [at(3, 0, 0)] }], [...open, [at(3, 0, 0), 'O']])).toBeNull();
    expect(hold([{ do: 'place', block: 'cobblestone', at: [at(4, 0, 0)] }, { do: 'dig', at: [at(3, 0, 0)] }], open)).toBeNull();
    expect(hold([{ do: 'dig', at: [at(1, 0, 0)] }], open)).toBeNull();
  });
  it('is held only where the guards read the map as the body does (bodyRules): the production preflight', () => {
    expect(hold([{ do: 'dig', at: [at(3, 0, 0)] }], open, {})).toBeNull();
  });
  it('is sent in part: the hands before it go, the held one and the rest come back as a fact', () => {
    const map = mapOf(feet, open);
    const frame = { schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: '', receivedAt: '', connected: true, facts: {},
      state: { world: { position: { x: 0.5, y: 0, z: 0.5 }, localMap: map } as never } } as BodyObservation;
    const sent = heldBeforeSend(false, { hands: [{ do: 'walk', to: at(2, 0, 0) }, { do: 'dig', at: [at(3, 0, 0)] }] }, frame, 'task')!;
    expect((sent.input as { hands: unknown[] }).hands).toHaveLength(1);
    expect(sent.tail).toContain('手 2 dig 溶岩が流れ込む');
  });
});

describe('a dig of a cell that stopped for 「見られる」, written relative to her feet', () => {
  const frame = (): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: '', receivedAt: '', connected: true, facts: {},
    state: { world: { position: { x: 300.5, y: 61, z: 73.5 }, recentStops: ['(299,61,73) 見られる 4秒前'] } as never } });
  it('is held like the absolute one, from her feet', () => {
    expect(seenReopenStop({ hands: [{ do: 'dig', rel: true, at: [{ x: -1, y: 0, z: 0 }] }] }, frame())).toMatchObject({ hand: 1, code: 'reopen_seen' });
    expect(seenReopenStop({ hands: [{ do: 'dig', at: [{ x: 299, y: 61, z: 73 }] }] }, frame())).toMatchObject({ hand: 1 });
  });
  it('follows a walk with no range, and reads nothing once a hand leaves her place unknown', () => {
    const hands = (...list: unknown[]) => ({ hands: list });
    const there = { do: 'dig', rel: true, at: [{ x: 0, y: 0, z: 0 }] };
    expect(seenReopenStop(hands({ do: 'walk', to: { x: 301, y: 61, z: 73 } }, { do: 'dig', rel: true, at: [{ x: -2, y: 0, z: 0 }] }), frame())).toMatchObject({ hand: 2 });
    expect(seenReopenStop(hands({ do: 'dig', at: [{ x: 305, y: 61, z: 73 }] }, { do: 'dig', rel: true, at: [{ x: -1, y: 0, z: 0 }] }), frame())).toBeNull();
    expect(seenReopenStop(hands(there), frame())).toBeNull();
  });
  it('is let go with exposeOk, as before', () => {
    expect(seenReopenStop({ hands: [{ do: 'dig', rel: true, exposeOk: true, at: [{ x: -1, y: 0, z: 0 }] }] }, frame())).toBeNull();
  });
});

describe('the cell she stands in, said first in `around`', () => {
  it('names the feet and the head cell and that nothing is placed into them', () => {
    const view = mapView(readLayers(mapOf(feet, corridor(3)), BODY_RULES)!);
    const lines = aroundLines(view, feet);
    expect(lines[0]).toBe('立っているマス: 足 (0,0,0)・頭 (0,1,0)（この 2 マスには place できない）');
    expect(lines[0]).toBe(standLine(feet));
    expect(lines.length).toBeGreaterThan(10);
  });
});

describe('the nearest place that cuts a hostile\'s line (away)', () => {
  // A corridor along +x from her feet; a wall of rock at x=2 between her and a hostile standing at (4,0,3) is not there: the hostile is in the open at (-1,0,5).
  // Rock everywhere but the corridor (0..6, 0..1, 0) and an open room: the hostile stands in a room at z=3..5 whose wall (z=1..2 rock) hides the corridor.
  const room = [] as Cell[];
  for (let x = -2; x <= 2; x += 1) for (let z = 3; z <= 5; z += 1) room.push(at(x, 0, z), at(x, 1, z));
  const open = [...corridor(6), at(0, 0, 1), at(0, 1, 1), at(0, 0, 2), at(0, 1, 2), ...room];
  const map = mapOf(feet, open);
  const view = mapView(readLayers(map, BODY_RULES)!);
  const look = lookOf(view, map, feet);
  const hostile = { id: '7', name: 'blaze', at: at(0, 0, 4) };
  it('is the first cell the walk reaches without digging whose way to the hostile crosses a block, with that block', () => {
    const line = retreatLine(view, look, feet, hostile)!;
    expect(line).toContain('#7 blaze の射線を切れる最寄りの立ち位置: (1,0,0)');
    expect(line).toContain('歩いて 1 歩');
    expect(line).toMatch(/間に \(-?\d+,-?\d+,-?\d+\) # 石の類/u);
  });
  it('says nothing when she is out of its sight already, or when the map certifies no such cell', () => {
    expect(retreatLine(view, look, at(1, 0, 0), hostile)).toBeNull();
    const openMap = mapOf(feet, [...corridor(6), ...Array.from({ length: 15 }, (_, i) => at(-7 + i, 0, 1)), ...Array.from({ length: 15 }, (_, i) => at(-7 + i, 1, 1))]);
    const openView = mapView(readLayers(openMap, BODY_RULES)!);
    expect(retreatLine(openView, lookOf(openView, openMap, feet), feet, { id: '7', name: 'blaze', at: at(0, 0, 1) })).toBeNull();
  });
  it('is added to `away` for a hostile that sees her or shoots, and only then', () => {
    const watched = watchedHostile(['#7 blaze 4.0m (0,0,4) 南4・見える（射線の中）'], [])!;
    expect(watched.ranged).toBe(true);
    const lines = awayLines(view, feet, watched, look);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('射線を切れる最寄りの立ち位置');
    const melee = watchedHostile(['#7 zombie 4.0m (0,0,4) 南4・追ってくる'], [])!;
    expect(melee.ranged).toBe(false);
    expect(awayLines(view, feet, melee, look)).toHaveLength(1);
    expect(awayLines(view, feet, watched)).toHaveLength(1);
  });
});

describe('the dictionary of the live says what the new lines are', () => {
  it('names the retreat place in away (the cell line itself says the cell she stands in)', () => {
    expect(V2_ALWAYS).toContain('射線を切れる最寄りの立ち位置（歩いて行ける所。間に固いブロック）が出ることもある');
  });
  it('leaves the words of the rules as they were (the replay of 2026-10-26 did not show that putting a condition in them helped)', () => {
    expect(CHECK_FORBID).toContain('湧き場の前で戦わない。受けた時は離れて塞ぐ');
    expect(V2_ALWAYS).toContain('急ぎは「[急ぎ] …」');
    expect(V2_STAGES.blaze).toContain('準備の前に近くにいる・撃たれた時は戦わず');
  });
});
