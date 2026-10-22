import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { ruleGuardAct, ruleGuardOfFrame, seenThreats, type SeenThreat } from '../src/surfaces/minecraft/minecraftLlmcRuleGuard.js';
import { readTopGrid } from '../src/surfaces/minecraft/minecraftLlmcSurfaceLook.js';
import { keepThreatSight, forgetThreatSights, threatSightKey } from '../src/surfaces/minecraft/minecraftLlmcThreat.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/minecraft-bare-bridge-v1.json', import.meta.url), 'utf8')) as unknown[];

/**
 * mb-llmc-cand 規則の守り: 敵が見えている時に、落差 4 以上の空所の上へ壁の無い幅 1 の橋を伸ばす手を止める（手は直さず足さない）。
 * 作った地図（床の高さ y=9 の岩棚が x<=10、その先は空所）で、見える敵・壁・落差・地図の外を 1 つずつ変え、本番の記録の橋（実走32 +332 秒）で確かめる。
 */
type Sym = (x: number, y: number, z: number) => string;
/** x=4..14, z=-3..3 の層の地図（足 (10,10,0)、y は yLow … 11）。 */
function layers(symbol: Sym, yLow = 4): string {
  const lines = ['地図 v1 足=(10,10,0) x=4..14 z=-3..3 方式=layers 上=北'];
  for (let y = 11; y >= yLow; y -= 1) {
    lines.push(`y=${y} x=4..14 z=-3..3`, 'z\\x 4 5 6 7 8 9 0 1 2 3 4');
    for (let z = -3; z <= 3; z += 1) lines.push(` ${z} ${Array.from({ length: 11 }, (_, i) => symbol(4 + i, y, z)).join(' ')}`);
  }
  return lines.join('\n');
}
/** 岩棚: x<=10 の y<=9 は岩。それより先と上は空気。足 (10,10,0) は '@'。 */
const ledge: Sym = (x, y, z) => x === 10 && y === 10 && z === 0 ? '@' : x <= 10 && y <= 9 ? '#' : '.';
const feet = { x: 10, y: 10, z: 0 };
const seen: SeenThreat[] = [{ label: '#12 wither_skeleton', distance: 6.7, rel: '東3・北2・上1' }];
const place = (...cells: Array<[number, number, number]>) => ({ do: 'place', block: 'nether_bricks', at: cells.map(([x, y, z]) => ({ x, y, z })) });
const walk = (x: number, y: number, z: number) => ({ do: 'walk', to: { x, y, z } });
const one = { hands: [{ do: 'sneak', on: true }, place([11, 9, 0]), walk(11, 10, 0)] };
const bridge = { hands: [{ do: 'sneak', on: true }, place([11, 9, 0]), walk(11, 10, 0), place([12, 9, 0]), walk(12, 10, 0)] };

describe('the rule guard: a bare one-wide bridge over a drop of four or more while a hostile sees her', () => {
  it('stops the first place that stretches the bridge, with the facts, when a hostile sees her', () => {
    const stop = ruleGuardAct(bridge, { map: layers(ledge), feet }, seen);
    expect(stop).toMatchObject({ hand: 2, kind: 'place', code: 'bare_bridge', cell: { x: 11, y: 9, z: 0 } });
    expect(stop!.why).toContain('#12 wither_skeleton が見えている（東3・北2・上1、6.7m）');
    expect(stop!.why).toContain('足場が幅 1');
    expect(stop!.why).toContain('落差 5 以上');
    expect(stop!.why).not.toMatch(/dig して|掘れ。/u);
  });

  it('lets the act go as it is when no hostile sees her', () => {
    expect(ruleGuardAct(bridge, { map: layers(ledge), feet }, [])).toBeNull();
  });

  it('does not stop a bridge with walls: a wall in the map, or walls the same act places', () => {
    const walled: Sym = (x, y, z) => x === 11 && y === 10 && z === 1 ? '#' : ledge(x, y, z);
    expect(ruleGuardAct(one, { map: layers(walled), feet }, seen)).toBeNull();
    // the next cell of the long act has no wall in the map: that one is the bridge
    expect(ruleGuardAct(bridge, { map: layers(walled), feet }, seen)?.cell).toEqual({ x: 12, y: 9, z: 0 });
    const withWalls = { hands: [{ do: 'sneak', on: true }, place([11, 9, 0], [11, 10, 1], [11, 10, -1]), walk(11, 10, 0)] };
    expect(ruleGuardAct(withWalls, { map: layers(ledge), feet }, seen)).toBeNull();
    // the same cells placed after the floor cell are walls of the same act
    const later = { hands: [place([11, 9, 0]), place([11, 10, 1]), place([11, 10, -1])] };
    expect(ruleGuardAct(later, { map: layers(ledge), feet }, seen)).toBeNull();
  });

  it('does not stop a bridge whose sides are rock at the floor (a ledge, not a bridge)', () => {
    const rim: Sym = (x, y, z) => x >= 11 && y <= 9 && Math.abs(z) === 1 ? '#' : ledge(x, y, z);
    expect(ruleGuardAct(bridge, { map: layers(rim), feet }, seen)).toBeNull();
  });

  it('stops at a drop of four and not at a drop of three (the cells under the new floor)', () => {
    const floorAt = (y: number): Sym => (x, yy, z) => x >= 11 && yy <= y ? '#' : ledge(x, yy, z);
    expect(ruleGuardAct(bridge, { map: layers(floorAt(5)), feet }, seen)).toBeNull();
    expect(ruleGuardAct(bridge, { map: layers(floorAt(4)), feet }, seen)?.hand).toBe(2);
    const stop = ruleGuardAct(bridge, { map: layers(floorAt(4)), feet }, seen);
    expect(stop!.why).toContain('落差 4');
  });

  it('says the lava under the drop when the map reaches it', () => {
    const lava: Sym = (x, y, z) => x >= 11 && y <= 4 ? 'L' : ledge(x, y, z);
    expect(ruleGuardAct(bridge, { map: layers(lava, 3), feet }, seen)!.why).toContain('落差 4、下は溶岩');
  });

  it('says nothing where the map does not show for certain: cells under the bridge off the map, a symbol that is not plain, a stale map', () => {
    expect(ruleGuardAct(one, { map: layers(ledge, 7), feet }, seen)).toBeNull();
    const plant: Sym = (x, y, z) => x === 11 && y === 10 && z === 1 ? ',' : ledge(x, y, z);
    expect(ruleGuardAct(one, { map: layers(plant), feet }, seen)).toBeNull();
    expect(ruleGuardAct(one, { map: layers(ledge), feet: { x: 9, y: 10, z: 0 } }, seen)).toBeNull();
    expect(ruleGuardAct(bridge, { map: undefined, feet }, seen)).toBeNull();
  });

  it('does not read acts it cannot follow (a hand relative to her feet) and takes no hand but a place for a bridge', () => {
    expect(ruleGuardAct({ hands: [{ do: 'walk', rel: true, to: { x: 1, y: 0, z: 0 } }, place([11, 9, 0])] }, { map: layers(ledge), feet }, seen)).toBeNull();
    expect(ruleGuardAct({ hands: [walk(11, 10, 0), walk(12, 10, 0)] }, { map: layers(ledge), feet }, seen)).toBeNull();
    expect(ruleGuardAct({ hands: [{ do: 'pillarUp', n: 2 }] }, { map: layers(ledge), feet }, seen)).toBeNull();
  });

  it('says nothing of a place into a cell the map shows filled (the body says its own stop)', () => {
    const wall: Sym = (x, y, z) => x === 11 && y <= 10 && z !== 0 ? '#' : x === 11 && z === 0 && y === 9 ? '#' : ledge(x, y, z);
    expect(ruleGuardAct({ hands: [place([11, 9, 0])] }, { map: layers(wall), feet }, seen)).toBeNull();
  });

  it('reads a surface map: the columns off the layers are open above their top block, "v" is ten or more below', () => {
    const surface = [
      '地図 v1 足=(10,10,0) x=4..14 z=-3..3 方式=surface 上=北',
      'z\\x 4 5 6 7 8 9 0 1 2 3 4',
      ...[-3, -2, -1, 0, 1, 2, 3].map(z => ` ${z} ${Array.from({ length: 11 }, (_, i) => 4 + i <= 10 ? '#a' : '.v').join(' ')}`),
      'y=11 x=9..11 z=-1..1', 'z\\x 9 0 1', ' -1 . . .', ' 0 . . .', ' 1 . . .',
      'y=10 x=9..11 z=-1..1', 'z\\x 9 0 1', ' -1 . . .', ' 0 . @ .', ' 1 . . .',
      'y=9 x=9..11 z=-1..1', 'z\\x 9 0 1', ' -1 # # .', ' 0 # # .', ' 1 # # .',
    ].join('\n');
    expect(readTopGrid(surface).get('12,0')).toMatchObject({ symbol: '.', far: 'down' });
    expect(readTopGrid(surface).get('8,0')).toMatchObject({ symbol: '#', diff: -1 });
    const stop = ruleGuardAct({ hands: [place([11, 9, 0])] }, { map: surface, feet }, seen);
    expect(stop).toMatchObject({ hand: 1, cell: { x: 11, y: 9, z: 0 } });
    expect(stop!.why).toContain('落差 8 以上');
  });

  it('uses the column answers the head kept when the map ends: air from the feet down `drop` cells', () => {
    const shallow = layers(ledge, 8);
    const column = (cell: { x: number; z: number }) => cell.x >= 11 ? { drop: 8, bottom: 'lava', name: 'lava' } : undefined;
    expect(ruleGuardAct(bridge, { map: shallow, feet }, seen)).toBeNull();
    expect(ruleGuardAct(bridge, { map: shallow, feet, column: column as never }, seen)?.hand).toBe(2);
  });
});

describe('the rule guard on the bridge of the record (run 32, +332 s: the act that ended in the lava)', () => {
  const [flat, death] = fixture as Array<{ seq: number; feet: { x: number; y: number; z: number }; map: string; input: unknown }>;
  const wither: SeenThreat[] = [{ label: '#696 wither_skeleton', distance: 7.5, rel: '東5・北7・上5' }];
  it('stops the second hand (the first place of the bridge) with the hostile in sight, and sends the sneak before it', () => {
    const stop = ruleGuardAct(death!.input, { map: death!.map, feet: death!.feet }, wither);
    expect(stop).toMatchObject({ hand: 2, kind: 'place', cell: { x: 224, y: 55, z: 78 } });
    expect(stop!.why).toContain('#696 wither_skeleton が見えている');
    expect(stop!.why).toContain('落差 8 以上');
  });
  it('lets the act go when nothing sees her (the same bridge, +235 s: the body finished it)', () => {
    expect(ruleGuardAct(death!.input, { map: death!.map, feet: death!.feet }, [])).toBeNull();
    expect(ruleGuardAct(flat!.input, { map: flat!.map, feet: flat!.feet }, [])).toBeNull();
    expect(ruleGuardAct(flat!.input, { map: flat!.map, feet: flat!.feet }, wither)?.hand).toBe(3);
  });
});

describe('which hostiles see her', () => {
  const frame = (threats: Array<Record<string, unknown>>): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1, stateAt: '', receivedAt: '', connected: true,
    state: { world: { position: { x: 10.5, y: 10, z: 0.5 }, nearbyThreats: threats, localMap: layers(ledge) } as never }, facts: {} as never });
  it('takes the body\'s own canSee, nearest first, with a direction from her feet', () => {
    const list = seenThreats(frame([
      { name: 'blaze', id: 5, distance: 9, position: { x: 14, y: 12, z: 1 }, canSee: true }, { name: 'zombie', id: 6, distance: 3, position: { x: 10, y: 10, z: 3 }, canSee: false },
      { name: 'wither_skeleton', id: 4, distance: 6.7, position: { x: 13, y: 11, z: -2 }, canSee: true }]), 'task-a');
    expect(list.map(item => item.label)).toEqual(['#4 wither_skeleton', '#5 blaze']);
    expect(list[0]).toMatchObject({ distance: 6.7, rel: '東3・北2・上1' });
  });
  it('without canSee (an older body) takes the sight answer the head kept for that hostile and spot, and not a stale one for another spot', () => {
    forgetThreatSights();
    const threat = { name: 'piglin', id: 9, distance: 7, position: { x: 13, y: 10, z: 0 } };
    expect(seenThreats(frame([threat]), 'task-b')).toEqual([]);
    const key = threatSightKey({ id: 9, name: 'piglin', distance: 7, at: { x: 13, y: 10, z: 0 }, dy: 0, canReachMe: null }, { x: 10, y: 10, z: 0 });
    keepThreatSight('task-b', key, { visible: true, between: null, more: 0 });
    expect(seenThreats(frame([threat]), 'task-b').map(item => item.label)).toEqual(['#9 piglin']);
    expect(seenThreats(frame([{ ...threat, position: { x: 14, y: 10, z: 0 } }]), 'task-b')).toEqual([]);
    forgetThreatSights();
  });
  it('ruleGuardOfFrame reads the map, her feet and the hostiles of the one frame', () => {
    const near = frame([{ name: 'wither_skeleton', id: 4, distance: 6.7, position: { x: 13, y: 11, z: -2 }, canSee: true }]);
    expect(ruleGuardOfFrame(bridge, near, 'task-c')?.hand).toBe(2);
    expect(ruleGuardOfFrame(bridge, frame([{ name: 'wither_skeleton', id: 4, distance: 6.7, position: { x: 13, y: 11, z: -2 }, canSee: false }]), 'task-c')).toBeNull();
    expect(ruleGuardOfFrame(bridge, null, 'task-c')).toBeNull();
  });
});
