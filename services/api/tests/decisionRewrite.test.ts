import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadAllRuns } from './decisionReplay/allRuns.js';
import { mechOf } from './decisionReplay/inspectMech.js';
import { relText, rewriteLive, REWRITE_LEGEND } from './decisionReplay/rewriteLive.js';
import { aroundLines, goalOf, mapView, normalizeMap, readLayers, reachable, routeLines, stepOptions } from './decisionReplay/rewriteMap.js';
import { VARIANTS } from './decisionReplay/request.js';
import { decisionOf, loadScenes } from './decisionReplay/score.js';

/**
 * 書き直した live（tests/decisionReplay/rewriteLive.ts・rewriteMap.ts、決まりは rewriteRules.md）の、API を呼ばない試験。
 * 小さな地図で歩きの決まり（掘らず置かず、上り 1・下り 3、斜めは角）を確かめ、本番の DB の控えがある所では場面の live を書き直して数える。
 */
const dataFile = (name: string) => new URL(`./decisionReplay/data/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const haveData = existsSync(dataFile('export1.txt')) && existsSync(dataFile('export2.txt')) && existsSync(dataFile('journal.txt'));

/** 足 (10,5,20)。西 (9) は頭が固い、東 (11) は床が無い、北 (z=19) は空き、南 (z=21) は固い。 */
const MAP = [
  '地図 v1 足=(10,5,20) x=8..12 z=19..21 方式=layers 上=北',
  'y=6 x=8..12 z=19..21', 'z\\x 8 9 0 1 2', ' 19 # # . . #', ' 20 # # . . #', ' 21 # # # # #',
  'y=5 x=8..12 z=19..21', 'z\\x 8 9 0 1 2', ' 19 # . . . #', ' 20 # . @ . #', ' 21 # # # # #',
  'y=4 x=8..12 z=19..21', 'z\\x 8 9 0 1 2', ' 19 # # # # #', ' 20 # # # . #', ' 21 # # # # #',
  '縦 (10,20) 上: y=6 . / y=7 # 下: y=4 #',
].join('\n');

describe('rewritten live: the walking rules on the map', () => {
  const view = mapView(readLayers(MAP)!);
  const feet = { x: 10, y: 5, z: 20 };
  it('walks where feet and head are free and a floor is there, and says what to dig otherwise', () => {
    const north = stepOptions(view, feet, 10, 19)[0]!;
    expect(north.bad).toBeNull();
    expect(north.dig).toHaveLength(0);
    // west: the cell (9,5,20) is free but its head (9,6,20) is rock: one cell to dig
    const west = stepOptions(view, feet, 9, 20)[0]!;
    expect(west.bad).toBeNull();
    expect(west.dig).toEqual([{ x: 9, y: 6, z: 20 }]);
  });
  it('says there is no floor over a hole, and what to dig in a wall', () => {
    const lines = aroundLines(view, feet);
    const east = lines.find(line => line.startsWith('東 '))!;
    expect(east).toContain('床が無い');
    const southEast = lines.find(line => line.startsWith('南東 '))!;
    expect(southEast).toContain('掘れば歩ける');
  });
  it('lists 14 lines: 8 steps, 4 cells two away, the cell over the head and the cell under the feet', () => {
    expect(aroundLines(view, feet)).toHaveLength(14);
  });
  it('finds the cheapest routes to a goal and does not decide a hand', () => {
    const goal = goalOf('[p1.1] 湧き場から離れる＠8,5,19（道: x）', feet)!;
    expect(goal.at).toEqual({ x: 8, y: 5, z: 19 });
    const reach = reachable(view, feet, 4);
    expect(reach.get('10,5,20')!.digs).toBe(0);
    const lines = routeLines(view, feet, goal, 'p1.1');
    expect(lines[0]).toContain('目的地 (8,5,19)');
    expect(lines.join('\n')).not.toMatch(/dig して|掘れ。/u);
  });
});

describe('rewritten live: the map', () => {
  it('puts every layer on the same range, marks the feet column and the height from the feet', () => {
    const text = normalizeMap(MAP)!;
    expect(text).toContain('同じ範囲');
    expect(text).toContain('y=6（足 +1）');
    expect(text).toContain('y=5（足の高さ）');
    expect(text.split('\n').filter(line => line.includes('^'))).toHaveLength(4 /* the note line and three layers */ - 1 + 1);
    expect(text).toContain('縦 (10,20)');
  });
  it('says a relative position the way the landmarks do', () => {
    expect(relText({ x: 0, y: 0, z: 0 }, { x: 2, y: 4, z: -1 })).toBe('東2・北1・上4');
    expect(relText({ x: 3, y: 3, z: 3 }, { x: 3, y: 3, z: 3 })).toBe('同じマス');
  });
});

describe('rewritten live: the version', () => {
  it('v9b and v9c carry the legend; v9c also writes the hands in lines', () => {
    const b = VARIANTS.find(item => item.id === 'v9b')!, c = VARIANTS.find(item => item.id === 'v9c')!;
    expect(b.legend).toBe(true);
    expect(c.legend).toBe(true);
    expect(c.slim?.short).toBe(true);
    expect(REWRITE_LEGEND).toContain('body.around');
    expect(REWRITE_LEGEND).toContain('body.route');
  });
});

describe.skipIf(!haveData)('rewritten live: on the recorded scenes', () => {
  const runs = haveData ? loadAllRuns() : new Map();
  const sceneLive = (id: string) => decisionOf(runs, loadScenes().find(item => item.id.startsWith(`${id}-`))!).live as Record<string, any>;
  it('drops the clock, the waiting line and the observation hash, and keeps the plan and the body', () => {
    const { live } = rewriteLive(sceneLive('s01'));
    expect(live.ownerClock).toBeUndefined();
    expect(live.waiting).toBeUndefined();
    expect(live.observations).toBeUndefined();
    expect(live.body.planNow).toContain('湧き場から離れる');
    expect(live.body.around).toHaveLength(14);
    expect(live.body.route?.length).toBeGreaterThan(1);
  });
  it('merges the same item and the same enemy, and takes out the biome that the dimension has not', () => {
    const { live } = rewriteLive(sceneLive('s01'));
    expect(live.body.inventory).toContain('cobbled_deepslate×83');
    expect(live.body.state.biome).toBeUndefined();
    expect(live.body.unreachable).toBeUndefined();
    const lines = [...live.body.urgent, ...live.body.threats].join('\n');
    expect((lines.match(/#5 /gu) ?? []).length).toBe(1);
  });
  it('turns the compact "surroundings" notation into cells with whole coordinates', () => {
    const { live } = rewriteLive(sceneLive('s01'));
    const text = (live.body.lastResults as string[]).join('\n');
    expect(text).not.toContain('周り（上の層から');
    expect(text).toContain('止まった所 (309,67,73) の周り');
  });
  it('counts the same things on both, and the rewrite removes the wrong values it can repair', () => {
    const live = sceneLive('s03');
    const before = mechOf('s03', live), after = mechOf('s03', rewriteLive(live).live);
    expect(before.useless.ownerClock).toBe(1);
    expect(after.useless.ownerClock).toBe(0);
    expect(before.wrong.landmarkStale).toBeGreaterThan(0);
    expect(after.wrong.landmarkStale).toBe(0);
    expect(after.omit.markers).toBe(before.omit.markers);
  });
});
