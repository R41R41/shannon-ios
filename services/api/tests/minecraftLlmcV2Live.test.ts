import { describe, expect, it } from 'vitest';
import { aroundLines, cellLines, stepLines } from '../src/surfaces/minecraft/minecraftLlmcAround.js';
import { mergeEnemies, relText } from '../src/surfaces/minecraft/minecraftLlmcLiveEnemies.js';
import { expandAround, normalizeMap } from '../src/surfaces/minecraft/minecraftLlmcLiveMap.js';
import { fixLandmarks, mergeInventory, rewriteLlmcLive, staleStand, type RewriteNotes } from '../src/surfaces/minecraft/minecraftLlmcLiveRewrite.js';
import { mapView, readLayers } from '../src/surfaces/minecraft/minecraftLlmcPreflightMap.js';
import { goalOf, reachable, routeLines } from '../src/surfaces/minecraft/minecraftLlmcRoute.js';
import { stepOptions } from '../src/surfaces/minecraft/minecraftLlmcWalkRules.js';
import { stagesFor, stageKnowledge, V2_ALWAYS } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { candidateLive } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import lives from './fixtures/minecraft-v2-lives-v1.json' with { type: 'json' };

/**
 * SHANNON_MINECRAFT_LLMC_V2: the live state as the decision reads it (improvement plan 2.2). Small maps for the walk's rules, then seven
 * live states of runs 32–34 (the decision replay's scenes, as recorded) for the rewrite: nothing is read from a body or a clock.
 */
const notes = (): RewriteNotes => ({ dropped: [], fixed: [], merged: [], omitted: 0, added: [] });
/** Feet (10,5,20). West (9) has rock over its head, east (11) has no floor, north (z=19) is free, south (z=21) is rock. */
const MAP = [
  '地図 v1 足=(10,5,20) x=8..12 z=19..21 方式=layers 上=北',
  'y=6 x=8..12 z=19..21', 'z\\x 8 9 0 1 2', ' 19 # # . . #', ' 20 # # . . #', ' 21 # # # # #',
  'y=5 x=8..12 z=19..21', 'z\\x 8 9 0 1 2', ' 19 # . . . #', ' 20 # . @ . #', ' 21 # # # # #',
  'y=4 x=8..12 z=19..21', 'z\\x 8 9 0 1 2', ' 19 # # # # #', ' 20 # # # . #', ' 21 # # # # #',
  '縦 (10,20) 上: y=6 . / y=7 # 下: y=4 #',
].join('\n');
const view = () => mapView(readLayers(MAP)!);
const feet = { x: 10, y: 5, z: 20 };
/** A corridor east of her: x=11..16 free at feet and head with a floor, 17 with rock over its head, 18 with no floor; the map is 15 wide (x=3..17+1). */
const WIDE = (() => {
  const row = (below: string, y: number) => Array.from({ length: 13 }, (_, i) => {
    const x = 4 + i;
    if (y === 5) return x === 10 ? '@' : x >= 11 ? '.' : '#';
    if (y === 6) return (x >= 11 && x <= 14) || x === 16 ? '.' : '#';
    return x === 16 ? '.' : below;
  }).join(' ');
  const lines = ['地図 v1 足=(10,5,20) x=4..16 z=20..20 方式=layers 上=北'];
  for (const y of [6, 5, 4]) lines.push(`y=${y} x=4..16 z=20..20`, ` 20 ${row('#', y)}`);
  return lines.join('\n');
})();
const wideView = () => mapView(readLayers(WIDE)!);
const wideFeet = { x: 10, y: 5, z: 20 };

describe('v2 around: the walk\'s rules on the map', () => {
  it('walks where feet and head are free with a floor, and says what to dig otherwise', () => {
    const north = stepOptions(view(), feet, 10, 19)[0]!;
    expect(north.bad).toBeNull();
    expect(north.dig).toHaveLength(0);
    const west = stepOptions(view(), feet, 9, 20)[0]!;
    expect(west.bad).toBeNull();
    expect(west.dig).toEqual([{ x: 9, y: 6, z: 20 }]);
  });
  it('writes ten lines for the cells next to her, with whole coordinates and what each needs', () => {
    const lines = stepLines(view(), feet);
    expect(lines).toHaveLength(10);
    expect(lines.find(line => line.startsWith('北 '))).toContain('歩ける');
    expect(lines.find(line => line.startsWith('西 '))).toContain('掘れば歩ける: 掘る (9,6,20)');
    expect(lines.find(line => line.startsWith('東 '))).toContain('床が無い');
    expect(lines.find(line => line.startsWith('南東 '))).toContain('掘れば歩ける');
  });
  it('lists the cells she can stand in by level in rows of runs, and does not list rock, the cells next to her or what the map does not show', () => {
    const text = cellLines(wideView(), wideFeet).join('\n');
    expect(text).toContain('y=5（足） 歩ける: z=20 x=12..14');
    expect(text).toContain('頭を掘れば歩ける: z=20 x=15');
    expect(text).toContain('床が無い（落差 1 以上、地図に底が無い）: z=20 x=16');
    expect(text).not.toContain('x=11');
    expect(text).not.toContain('y=6（');
    expect(cellLines(view(), feet)).toEqual([]);
  });
  it('says nothing it cannot know: a cell whose head, feet or floor the map does not show is left out', () => {
    expect(cellLines(view(), feet).join('\n')).not.toContain('x=7');
    expect(aroundLines(view(), feet)).toHaveLength(1 + 10 + 1 + cellLines(view(), feet).length);
  });
});

describe('v2 route: the way to the plan\'s current node', () => {
  it('reads the goal from the coordinates right after ＠ only', () => {
    expect(goalOf('[p1.1] 湧き場から離れる＠293,67,72（道: 出発の点検）')).toEqual({ at: { x: 293, y: 67, z: 72 }, range: 1 });
    expect(goalOf('[p1.3] 箱を開ける＠chest 1,2,3。ベッド(9,9,9)')).toBeNull();
    expect(goalOf('[p1.2] 幹を取る（済み: at:195,66,60~3）')).toBeNull();
    expect(goalOf('[p1.2] 幹を取る＠195,66,60（済み: at:195,66,60~3&have:原木>=1）')).toEqual({ at: { x: 195, y: 66, z: 60 }, range: 3 });
  });
  it('finds the places she reaches without digging and with digs, the fewest digs first', () => {
    const reach = reachable(view(), feet, 4);
    expect(reach.get('10,5,20')!.digs).toBe(0);
    expect(reach.get('10,5,19')!.digs).toBe(0);
    expect([...reach.values()].some(item => item.digs > 0)).toBe(true);
  });
  it('writes the lines of the way and decides no hand', () => {
    const lines = routeLines(view(), feet, goalOf('[p1.1] 隅へ＠8,5,19')!, 'p1.1');
    expect(lines[0]).toContain('目的地 (8,5,19)');
    expect(lines.join('\n')).toContain('目的地に最も近い立ち位置');
    expect(lines.join('\n')).not.toMatch(/dig して|掘れ。|歩け。/u);
  });
});

describe('v2 live: the pieces', () => {
  it('puts every layer on one range with the feet column marked, and keeps the column line', () => {
    const text = normalizeMap(MAP)!;
    expect(text).toContain('同じ範囲');
    expect(text).toContain('y=6（足 +1）');
    expect(text).toContain('y=5（足の高さ）');
    expect(text.split('\n').filter(line => /^\s+\^$/u.test(line))).toHaveLength(3);
    expect(text).toContain('縦 (10,20)');
  });
  it('writes a stopped hand\'s surroundings with whole coordinates', () => {
    const done = expandAround('  周り（上の層から、北が上・西が左）x=308..310 z=72..74 y=68: N.#/N.#/N.N y=67: N.#/N@#/N.N y=66: ###/###/###');
    expect(done.expanded).toBe(1);
    expect(done.text).toContain('止まった所 (309,67,73) の周り 3×3×3');
    expect(done.text).toContain('@ 自分の足: (309,67,73)');
  });
  it('adds up the pack by kind and keeps a stack with durability apart', () => {
    expect(mergeInventory(['cobbled_deepslate×53', 'iron_pickaxe×1(耐久100/250)', 'cobbled_deepslate×30', 'bread×3', 'ほか2件（長いため略）'], notes()))
      .toEqual(['cobbled_deepslate×83', 'iron_pickaxe×1(耐久100/250)', 'bread×3', 'ほか2件は略']);
  });
  it('works out the landmarks\' east-west and north-south from her feet now and leaves the body\'s height as written', () => {
    const fixed = fixLandmarks(['F かまど (-37,48,191) 東1・北1・上1', 'L 溶岩源 (221,53,69) 西5・北3・下5'], { x: -37, y: 49, z: 191 }, notes());
    expect(fixed[0]).toBe('F かまど (-37,48,191) 上1');
    const second = fixLandmarks(['L 溶岩源 (221,53,69) 西5・北3・下5'], { x: 224, y: 58, z: 72 }, notes());
    expect(second[0]).toBe('L 溶岩源 (221,53,69) 西3・北3・下5');
    expect(fixLandmarks([second[0]!], { x: 224, y: 58, z: 72 }, notes())).toEqual(second);
  });
  it('joins a hostile\'s lines of urgent, unreachable and threats into one by its id, and by its kind and distance when it has no id', () => {
    const body = { state: { at: '(310,66,73)' }, urgent: ['blaze 4.3m'],
      unreachable: ['blaze #5 4.0m・上 4・壁の向こうで届かない（間に (310,68,73) cobbled_deepslate）'],
      threats: ['#5 blaze 4m (311,70,73)', '#8 blaze 4.4m (306,68,72)'] };
    const merged = mergeEnemies(body, { x: 310, y: 66, z: 73 });
    const text = [...merged.urgent ?? [], ...merged.threats ?? []].join('\n');
    expect((text.match(/#5 /gu) ?? []).length).toBe(1);
    expect(text).toContain('#5 blaze 4m (311,70,73) 東1・上4・壁の向こうで届かない');
    expect(merged.urgent).toHaveLength(1);
    expect(relText({ x: 0, y: 0, z: 0 }, { x: 2, y: 4, z: -1 })).toBe('東2・北1・上4');
  });
  it('takes out a rule about a cell the map now shows she can stand in', () => {
    expect(staleStand('注意: (10,5,19): 的そのものには立てない（足のマスが basalt で埋まっている）', view())).toBe(true);
    expect(staleStand('注意: (9,5,20): 的そのものには立てない（足のマスが basalt で埋まっている）', view())).toBe(false);
    expect(staleStand('注意: (8,5,19): 的そのものには立てない（足のマスが basalt で埋まっている）', view())).toBe(false);
  });
});

describe('v2 stages of knowledge', () => {
  it('picks the stages from the node, the dimension and what is near, and always one', () => {
    const body = (extra: Record<string, unknown>) => ({ body: { state: { dimension: 'the_nether' }, ...extra } });
    expect(stagesFor(body({ planNow: '[p1.1] 湧き場から離れる＠293,67,72' }))).toEqual(['nether']);
    expect(stagesFor(body({ planNow: '[p2.2] ブレイズの棒を 7 本' }))).toEqual(['nether', 'blaze']);
    expect(stagesFor({ body: { state: { dimension: 'overworld' }, planNow: '[p1] 黒曜石 10 個', inventory: ['ender_eye×3'] } })).toEqual(['prep', 'pearl']);
    expect(stagesFor({ body: { state: { dimension: 'the_end' } } })).toEqual(['end']);
    expect(stageKnowledge({})).toBeNull();
  });
  it('is a few times smaller than the own prompt\'s whole text in the cached part', () => {
    expect(V2_ALWAYS.length).toBeGreaterThan(1000);
    expect(V2_ALWAYS).not.toContain('## 材料と手順');
    expect(V2_ALWAYS).not.toContain('## ブレイズ');
  });
});

describe('v2 live: the recorded live states of runs 32–34', () => {
  const entries = Object.entries(lives as Record<string, Record<string, any>>);
  it.each(entries)('%s: leaves out what the decision does not need, gives the stage apart, adds around and keeps the plan and the body', (_id, live) => {
    const before = JSON.stringify(live);
    const out = candidateLive(live);
    expect(JSON.stringify(live)).toBe(before);
    expect(out.live).not.toHaveProperty('knowledge');
    expect(out.stage).toContain('この場面の知識');
    for (const gone of ['ownerClock', 'waiting', 'observations', 'recall']) expect(out.live).not.toHaveProperty(gone);
    expect(out.live.plan).toBeDefined();
    const body = out.live.body as Record<string, any>;
    expect(body.around.length).toBeGreaterThanOrEqual(11);
    expect(body.map).toContain('同じ範囲');
    expect(body.unreachable).toBeUndefined();
    expect(JSON.stringify(out.live)).not.toContain('undefined');
    expect(JSON.stringify(candidateLive(live))).toBe(JSON.stringify(out));
  });
  it('s01: one line to a blaze, the pack added up, the biome the Nether has not left out, the surroundings with whole coordinates', () => {
    const [[, live]] = entries.filter(([id]) => id.startsWith('s01'));
    const { live: out } = candidateLive(live!);
    const body = out.body as Record<string, any>;
    const hostiles = [...body.urgent ?? [], ...body.threats ?? []].join('\n');
    expect((hostiles.match(/#5 /gu) ?? []).length).toBe(1);
    expect(body.inventory).toContain('cobbled_deepslate×83');
    expect(body.state.biome).toBeUndefined();
    const results = (body.lastResults as string[]).join('\n');
    expect(results).not.toContain('周り（上の層から');
    expect(results).toContain('止まった所 (309,67,73) の周り');
    expect(body.route?.length).toBeGreaterThan(1);
  });
  it('is a rewrite that never throws on a live state it cannot read', () => {
    expect(rewriteLlmcLive({}).live).toEqual({});
    expect(rewriteLlmcLive({ body: { map: 'x', state: 5, inventory: 'y', landmarks: [3] } }).live.body).toBeDefined();
    expect(stepLines(view(), { x: 0, y: 0, z: 0 }).length).toBeGreaterThanOrEqual(3);
  });
});
