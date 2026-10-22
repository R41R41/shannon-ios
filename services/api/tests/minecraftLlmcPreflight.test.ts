import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { preflightAct, preflightText, type PreflightStop } from '../src/surfaces/minecraft/minecraftLlmcPreflight.js';
import { readLayers } from '../src/surfaces/minecraft/minecraftLlmcPreflightMap.js';

/**
 * act-preflight (Syzygy ADR-0014 D3; SHANNON_MINECRAFT_ACT_PREFLIGHT): an `mc.act` the map shows the body would refuse at a hand's start is
 * not sent. The unit cases are made-up maps; the two fixtures are the real thing — the production acts of runs 32–34 with the body's own
 * result lines (`act-preflight-recorded-v1.json`: a hand the preflight holds that the body DID do is a wrong stop, and there must be none),
 * and the answers of the decision replay's scenes with their grades (`act-preflight-replay-v1.json`).
 */
type Cell = { x: number; y: number; z: number };
/** A map of rock with the cells in `open` made `.` (or the symbol given), drawn in the body's layers form around `feet`. */
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
const at = (x: number, y: number, z: number): Cell => ({ x, y, z });
const feet = at(0, 0, 0);
/** A level corridor along +x from the feet, with a floor (rock) under it. */
const corridor = (length: number, y = 0): Cell[] => Array.from({ length: length + 1 }, (_, x) => at(x, y, 0)).flatMap(cell => [cell, at(cell.x, cell.y + 1, 0)]);
const hold = (hands: unknown[], open: Array<Cell | [Cell, string]> = corridor(3), options?: { route?: boolean }): PreflightStop | null =>
  preflightAct({ hands }, { map: mapOf(feet, open), feet }, options);

describe('a walk the body would refuse at its start (primitives/walk.ts unstandable: the target is a place no body stands in)', () => {
  it('the feet cell is rock: 一歩ではない, with the hand, the cell and the block by the map', () => {
    const stop = hold([{ do: 'walk', to: at(1, 0, 0) }, { do: 'walk', to: at(5, 0, 0) }])!;
    expect(stop).toMatchObject({ hand: 2, kind: 'walk', word: '一歩ではない', code: 'feet_solid', cell: at(5, 0, 0) });
    expect(preflightText(stop)).toBe('送る前に止めた（体には何も送っていない。手は 1 つも動いていない）: 手 2 walk 一歩ではない: 足のマス (5,0,0) が 石の類（地図 #） で埋まっている（地図で確かめた）。'
      + 'walk は掘らず置かない。先に dig か place で足と頭の 2 マスと床を整えるか、別の道・別の着く所へ。');
  });

  it('the head cell is rock while the feet cell is open (run 34: five of the nine 一歩ではない)', () => {
    const open = [at(1, 0, 0), at(2, 0, 0), at(1, 1, 0)];
    const stop = hold([{ do: 'walk', to: at(2, 0, 0) }], open)!;
    expect(stop).toMatchObject({ code: 'head_solid', cell: at(2, 1, 0) });
    expect(stop.why).toBe('頭の高さ (2,1,0) が 石の類（地図 #） で通れない（足のマス (2,0,0) は空いている）');
  });

  it('no floor under the feet cell: the cells of air counted (exact where the map reaches a floor); water and lava are no floor', () => {
    expect(hold([{ do: 'walk', to: at(3, 0, 0) }], corridor(3))).toBeNull();
    const stop = hold([{ do: 'walk', to: at(3, 0, 0) }], [...corridor(3), at(3, -1, 0)])!;
    expect(stop).toMatchObject({ code: 'no_floor', cell: at(3, -1, 0) });
    expect(stop.why).toBe('足のマス (3,0,0) の下 1 マスが空気（立つ床が無い）');
    expect(hold([{ do: 'walk', to: at(3, 0, 0) }], [...corridor(3), at(3, -1, 0), at(3, -2, 0)])!.why).toBe('足のマス (3,0,0) の下 2 以上 マスが空気（立つ床が無い）');
    expect(hold([{ do: 'walk', to: at(3, 0, 0) }], [...corridor(3), [at(3, -1, 0), 'w']])!.why).toContain('下 (3,-1,0) が水（立つ床にならない）');
    expect(hold([{ do: 'walk', to: at(3, 0, 0) }], [...corridor(3), [at(3, -1, 0), 'L']])!).toMatchObject({ code: 'floor_lava' });
    // Standing in water or on a ladder needs no floor.
    expect(hold([{ do: 'walk', to: at(3, 0, 0) }], [...corridor(2), [at(3, 0, 0), 'w'], at(3, 1, 0)])).toBeNull();
  });

  it('an earlier hand of the act that opens the cell is taken as done (a dig, then the walk); a place gives the floor', () => {
    expect(hold([{ do: 'walk', to: at(4, 0, 0) }])).toMatchObject({ code: 'feet_solid' });
    expect(hold([{ do: 'dig', at: [at(4, 0, 0), at(4, 1, 0)] }, { do: 'walk', to: at(4, 0, 0) }])).toBeNull();
    // One hand more is the head cell the dig left: the walk is stopped there.
    expect(hold([{ do: 'dig', at: [at(4, 0, 0)] }, { do: 'walk', to: at(4, 0, 0) }])).toMatchObject({ code: 'head_solid', hand: 2 });
    const pit = [...corridor(3), at(4, 0, 0), at(4, 1, 0), at(4, -1, 0)];
    expect(hold([{ do: 'walk', to: at(4, 0, 0) }], pit)).toMatchObject({ code: 'no_floor' });
    expect(hold([{ do: 'place', block: 'cobblestone', at: [at(4, -1, 0)] }, { do: 'walk', to: at(4, 0, 0) }], pit)).toBeNull();
  });

  it('what the map does not name is not stopped: off the map, a door or a plant, a range of one or more, a map older than the frame, a hand of unknown effect', () => {
    expect(hold([{ do: 'walk', to: at(30, 0, 0) }])).toBeNull();
    expect(hold([{ do: 'walk', to: at(4, 0, 0) }], [...corridor(3), [at(4, 0, 0), 'D'], [at(4, 1, 0), 'D']])).toBeNull();
    expect(hold([{ do: 'walk', to: at(4, 0, 0) }], [...corridor(3), [at(4, 0, 0), '%'], [at(4, 1, 0), ','], [at(4, -1, 0), '%']])).toBeNull();
    // A plant or carpet under the target might be a carpet: a floor.
    expect(hold([{ do: 'walk', to: at(4, 0, 0) }], [...corridor(4), [at(4, -1, 0), ',']])).toBeNull();
    expect(hold([{ do: 'walk', to: at(5, 0, 0), range: 2 }])).toBeNull();
    expect(preflightAct({ hands: [{ do: 'walk', to: at(5, 0, 0) }] }, { map: mapOf(feet, corridor(3)), feet: at(1, 0, 0) })).toBeNull();
    expect(hold([{ do: 'use', item: 'water_bucket', at: [at(1, 0, 0)] }, { do: 'walk', to: at(5, 0, 0) }])).toBeNull();
    expect(preflightAct({ hands: [{ do: 'walk', to: at(5, 0, 0) }] }, { map: undefined, feet })).toBeNull();
    expect(preflightAct({ hands: [{ do: 'walk', to: at(5, 0, 0) }] }, { map: mapOf(feet), feet: null })).toBeNull();
  });

  it('every point of a path is a target; relative hands count from where she stands after the hands before them', () => {
    expect(hold([{ do: 'walk', path: [at(1, 0, 0), at(2, 0, 0), at(2, 0, 1)] }])).toMatchObject({ code: 'feet_solid', cell: at(2, 0, 1) });
    expect(hold([{ do: 'walk', to: at(1, 0, 0) }, { do: 'walk', rel: true, to: at(5, 0, 0) }])).toMatchObject({ code: 'feet_solid', cell: at(6, 0, 0) });
    // After a dig that walks to pick up, a relative hand cannot be placed: the rest of the act is not walked through.
    expect(hold([{ do: 'dig', at: [at(1, 0, 0)] }, { do: 'walk', rel: true, to: at(9, 0, 0) }])).toBeNull();
    // An absolute cell after it still can.
    expect(hold([{ do: 'attack', target: 'zombie' }, { do: 'walk', to: at(5, 0, 0) }])).toMatchObject({ code: 'feet_solid' });
  });

  it('the column answer the head kept says what the map cannot (the floor cell off the map)', () => {
    const tall = [...corridor(2), at(3, 0, 0), at(3, 1, 0)];
    const world = { map: mapOf(feet, tall).split('\n').filter(line => !/^y=-1$/u.test(line)).join('\n'), feet };
    const without = preflightAct({ hands: [{ do: 'walk', to: at(3, 0, 0) }] }, world);
    expect(without).not.toBeNull(); // the layer under is still drawn here: rock at (3,-1,0) is air in the shaft
    const column = (cell: Cell, y: number) => cell.x === 12 && y === 0 ? { drop: 5, bottom: 'floor' as const, name: 'stone' } : undefined;
    const far = { map: mapOf(feet, [...corridor(7)]), feet, column };
    expect(preflightAct({ hands: [{ do: 'walk', to: at(12, 0, 0) }] }, far)).toBeNull();
  });
});

describe('a route that does not exist (primitives/walk.ts: the walk neither digs nor lays a block; a step down needs the cells over the lower level)', () => {
  it('one step down is stopped when the head cell of the higher level is rock; open, it is walked', () => {
    const open = [at(0, 0, 0), at(0, 1, 0), at(1, -1, 0), at(1, 0, 0), at(1, 1, 0)];
    expect(hold([{ do: 'walk', to: at(1, -1, 0) }], open)).toBeNull();
    const shut = open.filter(cell => !(cell.x === 1 && cell.y === 1));
    const stop = hold([{ do: 'walk', to: at(1, -1, 0) }], shut)!;
    expect(stop.code).toBe('no_route');
    expect(stop.why).toBe('(1,-1,0) へ掘らず置かずに行く道が無い（1 歩下りるには、隣の足と頭の 2 マス（今の足と頭の高さ）が空いている必要があるが (1,1,0) 石の類（地図 #） が塞がっている）');
    // The same step with the route check off is not held (the stand check alone says nothing of it).
    expect(hold([{ do: 'walk', to: at(1, -1, 0) }], shut, { route: false })).toBeNull();
    // The act that digs the head cell first walks it.
    expect(hold([{ do: 'dig', at: [at(1, 1, 0)] }, { do: 'walk', to: at(1, -1, 0) }], shut)).toBeNull();
  });

  it('a long way through open ground is reachable; ground that leaves the map is a way out (not stopped)', () => {
    expect(hold([{ do: 'walk', to: at(6, 0, 0) }], corridor(6))).toBeNull();
    // Two corridors that do not meet inside the map, both reaching its edge: out beyond it they might.
    expect(hold([{ do: 'walk', to: at(6, 0, 3) }], [...corridor(7), ...Array.from({ length: 6 }, (_, i) => [at(2 + i, 0, 3), at(2 + i, 1, 3)]).flat()])).toBeNull();
    // The same two corridors shut in the map: no way.
    expect(hold([{ do: 'walk', to: at(6, 0, 3) }], [...corridor(4), ...Array.from({ length: 5 }, (_, i) => [at(2 + i, 0, 3), at(2 + i, 1, 3)]).flat()])).toMatchObject({ code: 'no_route' });
  });
});

describe('a place the body would refuse (primitives/place.ts)', () => {
  it('into a cell that holds a block: 置けない, and a cell that a dig of the act opened is free', () => {
    const stop = hold([{ do: 'place', block: 'cobblestone', at: [at(1, 0, 0), at(5, 0, 0)] }])!;
    expect(stop).toMatchObject({ kind: 'place', word: '置けない', code: 'occupied', cell: at(5, 0, 0), hand: 1 });
    expect(stop.why).toBe('(5,0,0) は埋まっている（そのマスは 石の類（地図 #）。置く必要は無い）');
    expect(hold([{ do: 'dig', at: [at(5, 0, 0)] }, { do: 'place', block: 'cobblestone', at: [at(5, 0, 0)] }])).toBeNull();
  });

  it('into the air with no face to set against: only when all six neighbours are known open; a cell placed before gives the next its face', () => {
    const air = [at(0, 0, 0), at(2, 0, 0), at(3, 0, 0), at(4, 0, 0), at(5, 0, 0)];
    const world = [...air, at(1, 0, 0)];
    expect(hold([{ do: 'place', block: 'cobblestone', at: [at(3, 0, 0)] }], world)).toBeNull();
    const around = (c: Cell) => [c, at(c.x + 1, c.y, c.z), at(c.x - 1, c.y, c.z), at(c.x, c.y + 1, c.z), at(c.x, c.y - 1, c.z), at(c.x, c.y, c.z + 1), at(c.x, c.y, c.z - 1)];
    const floating = around(at(4, 0, 2));
    expect(hold([{ do: 'place', block: 'cobblestone', at: [at(4, 0, 2)] }], floating)).toMatchObject({ code: 'no_support', kind: 'place' });
    // A face given by the hand, or a neighbour the map does not name, leaves it to the body.
    expect(hold([{ do: 'place', block: 'cobblestone', at: [at(4, 0, 2)], face: 'down' }], floating)).toBeNull();
    expect(hold([{ do: 'place', block: 'cobblestone', at: [at(4, 0, 2)] }], [...floating.filter(c => c.x !== 5), [at(5, 0, 2), 'P']])).toBeNull();
    // The second cell is set against the first.
    const chain = [...floating, at(5, 0, 2), at(6, 0, 2), at(5, 1, 2), at(5, -1, 2), at(5, 0, 3), at(5, 0, 1)];
    expect(hold([{ do: 'place', block: 'cobblestone', at: [at(5, 0, 2)] }], chain)).toMatchObject({ code: 'no_support' });
    expect(hold([{ do: 'place', block: 'cobblestone', at: [at(4, 0, 2), at(5, 0, 2)], face: undefined }], [...floating, at(5, 0, 2), at(5, 1, 2), at(5, -1, 2), at(5, 0, 3), at(5, 0, 1), at(6, 0, 2)]))
      .toMatchObject({ hand: 1, cell: at(4, 0, 2) });
  });

  it('pillarUp puts its blocks under the feet: the walk onto the top of them is not a walk to a place with no floor', () => {
    const shaft = [at(0, 0, 0), at(0, 1, 0), at(0, 2, 0), at(0, 3, 0)];
    // The cell she stood in is a block after the pillar: a place into it is a place into a filled cell.
    expect(hold([{ do: 'pillarUp', n: 1 }, { do: 'place', block: 'cobblestone', at: [at(0, 0, 0)] }], shaft)).toMatchObject({ code: 'occupied', hand: 2 });
    expect(hold([{ do: 'place', block: 'cobblestone', at: [at(0, 0, 0)] }], shaft)).toBeNull();
  });
});

describe('the map as the body draws it in the surface form (the three layers are 11 wide under a 21-wide top grid)', () => {
  it('reads each layer\'s cells at their own x, not from the top grid\'s first column', () => {
    const rows = (symbol: string) => Array.from({ length: 11 }, (_, i) => ` ${58 + i} ${Array.from({ length: 11 }, (_, x) => symbol === '.' && x === 5 && i === 5 ? '@' : symbol).join(' ')}`);
    const top = Array.from({ length: 21 }, (_, i) => ` ${53 + i} ${Array.from({ length: 21 }, () => 'n+').join(' ')}`);
    const map = ['地図 v1 足=(260,57,63) x=250..270 z=53..73 方式=surface 上=北', 'z\\x 0 1', ...top, 'y=58', 'z\\x 5 6 7 8 9 0 1 2 3 4 5', ...rows('n'), 'y=57', ...rows('.'), 'y=56', ...rows('n'), '縦 (260,63) 上: y=58〜73 .×16 …'].join('\n');
    const layers = readLayers(map)!;
    expect(layers.layers.get(57)!.get('255,58')).toBe('.');
    expect(layers.layers.get(57)!.get('265,68')).toBe('.');
    expect(layers.layers.get(57)!.has('250,58')).toBe(false);
    expect(layers.layers.get(58)!.get('260,63')).toBe('n');
  });
});

interface Recorded { run: string; seq: number; from: string; feet: Cell; map: string; input: { hands: Array<{ do: string }> }; lines: Array<{ i: number; do: string; status: string; word: string }> }
const recorded = JSON.parse(readFileSync(new URL('./fixtures/act-preflight-recorded-v1.json', import.meta.url), 'utf8')) as { acts: Recorded[] };
interface Replayed { scenes: Record<string, { map: string; feet: Cell }>; answers: Array<{ scene: string; key: string; verdict: string; input: { hands: Array<{ do: string }> } }> }
const replayed = JSON.parse(readFileSync(new URL('./fixtures/act-preflight-replay-v1.json', import.meta.url), 'utf8')) as Replayed;

describe('against the body\'s own results (production runs 32–34: what the body did with each hand)', () => {
  const judged = recorded.acts.map(act => ({ act, stop: preflightAct(act.input, { map: act.map, feet: act.feet }) }));
  const outcomeOf = ({ act, stop }: (typeof judged)[number]) => {
    const line = act.lines.find(item => item.i === stop!.hand);
    if (!line) return 'none';
    if (line.status === '済') return 'wrong'; // the hand held back is one the body did
    if (line.status === '未') return 'earlier'; // an earlier hand stopped the act first
    return line.word === stop!.word ? 'same' : 'other';
  };
  const held = judged.filter(item => item.stop);
  const counts = (kind: string) => held.filter(item => outcomeOf(item) === kind).length;

  it('holds no hand the body did (wrong stops: none), and every stop it holds is one the body made or came after one', () => {
    const wrong = held.filter(item => outcomeOf(item) === 'wrong').map(item => `${item.act.run} ${item.act.seq} 手${item.stop!.hand} ${item.stop!.code}`);
    expect(wrong).toEqual([]);
    expect(counts('other')).toBe(0);
    expect(counts('none')).toBe(0);
    // The numbers of the fixture (107 acts with a walk or a place: every one the body stopped at, a third of the rest).
    expect(counts('same')).toBeGreaterThanOrEqual(29);
  });

  it('catches the body\'s own 一歩ではない / 置けない of the walks and places before it sends them (the share it can see for certain)', () => {
    const own = recorded.acts.filter(act => act.lines.some(line => (line.status === '止' || line.status === '失') && ((line.do === 'walk' && line.word === '一歩ではない') || (line.do === 'place' && line.word === '置けない'))));
    const caught = own.filter(act => preflightAct(act.input, { map: act.map, feet: act.feet }));
    expect(own.length).toBeGreaterThanOrEqual(50);
    expect(caught.length).toBeGreaterThanOrEqual(29);
  });

  it('reads the surface form\'s maps rightly: the stops held in them are the body\'s too', () => {
    const surface = held.filter(item => item.act.map.includes('方式=surface'));
    expect(surface.length).toBeGreaterThan(0);
    expect(surface.every(item => ['same', 'earlier'].includes(outcomeOf(item)))).toBe(true);
  });
});

describe('against the answers of the decision replay (32 scenes; the answers of v1–v3 and of the production record, with their grades)', () => {
  const held = replayed.answers.map(answer => ({ answer, stop: preflightAct(answer.input, { map: replayed.scenes[answer.scene]!.map, feet: replayed.scenes[answer.scene]!.feet }) }));
  it('holds the answers graded × far more often than the ones graded ○ or △, and the ○ and △ it holds are counted', () => {
    const stopped = held.filter(item => item.stop);
    const by = (verdict: string) => stopped.filter(item => item.answer.verdict === verdict).length;
    const total = (verdict: string) => held.filter(item => item.answer.verdict === verdict).length;
    // Counted, not argued: 192 acts, 54 held. Graded × 31 of 79; graded ○ 17 of 76 and △ 6 of 37 are held too — each of them
    // is an answer that puts a block into a cell the map shows filled, floats a block with no face, or walks to a cell the map shows as rock
    // or with no head room (the grade of the replay does not look at the map's cells; the body would stop at the same hand).
    expect({ answers: held.length, held: stopped.length, 'ok-held': by('○'), 'half-held': by('△'), 'bad-held': by('×') }).toEqual({ answers: 192, held: 54, 'ok-held': 17, 'half-held': 6, 'bad-held': 31 });
    expect(by('×') / total('×')).toBeGreaterThan(0.3);
    expect((by('○') + by('△')) / (total('○') + total('△'))).toBeLessThan(0.25);
  });
  it('every ○ or △ answer it holds is a place into a filled cell, a floating place, a walk into rock, no floor or no route (the fact is in the text)', () => {
    for (const item of held.filter(entry => entry.stop && entry.answer.verdict !== '×')) {
      expect(['occupied', 'no_support', 'feet_solid', 'head_solid', 'no_floor', 'no_route']).toContain(item.stop!.code);
      expect(preflightText(item.stop!)).toMatch(/^送る前に止めた（体には何も送っていない。手は 1 つも動いていない）: 手 \d+ (walk 一歩ではない|place 置けない): /u);
    }
  });
});
