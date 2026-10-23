import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { SHORT_ACT_DESCRIPTION } from '../src/contracts/minecraftActShortContract.js';
import { minecraftV2System } from '../src/infra/models/anthropic/anthropicFcaMinecraftSystem.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { createFoodTrend, minecraftLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { rewriteLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLiveRewrite.js';
import { obsidianWays } from '../src/surfaces/minecraft/minecraftLlmcObsidianWays.js';
import { BODY_RULES, mapView, readLayers } from '../src/surfaces/minecraft/minecraftLlmcPreflightMap.js';
import { DRAGON_MILESTONES, isDragonPlan, meterLine, milestoneWords, roadLine } from '../src/surfaces/minecraft/minecraftLlmcRoad.js';
import { routeLines } from '../src/surfaces/minecraft/minecraftLlmcRoute.js';
import { V2_ALWAYS } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { digWords, lavaNext } from '../src/surfaces/minecraft/minecraftLlmcWalkRules.js';

/**
 * SHANNON_MINECRAFT_LLMC_V2, the eleventh round (mb-llmc-cand 11): the three scenes of the bench the answers went wrong in (s14: where to go away from the
 * enderman; s47: a place 115 m away written as if it were near; s67: the lava pool, where the water and the lava meet), and chapter 4 A (the goal's yardstick:
 * the stage road and the pace against the milestones' targets).
 */
type Cell = { x: number; y: number; z: number };
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
  state: { world: world as never }, facts: {} });
/** A 7×7 map round feet (0,0,0), layers y=-2..2, rock everywhere but the cells given (`x,y,z` → symbol). */
function mapOf(cells: Record<string, string>, base = '#'): string {
  const lines = ['地図 v1 足=(0,0,0) x=-3..3 z=-3..3 方式=layers 上=北'];
  for (const y of [2, 1, 0, -1, -2]) {
    lines.push(`y=${y}`);
    for (let z = -3; z <= 3; z += 1) {
      lines.push(`${String(z).padStart(2)} ${Array.from({ length: 7 }, (_, i) => cells[`${i - 3},${y},${z}`] ?? (y === 0 && z === 0 && i === 3 ? '@' : base)).join(' ')}`);
    }
  }
  return lines.join('\n');
}
const viewOf = (map: string) => mapView(readLayers(map, BODY_RULES)!);
const origin: Cell = { x: 0, y: 0, z: 0 };

describe('s47: a place far outside the map is not written as if it were near', () => {
  const view = viewOf(mapOf({ '1,0,0': '.', '1,1,0': '.' }));
  it('says that the way out there is unknown, that a walk neither digs nor lays, and where the map says she gets to', () => {
    const lines = routeLines(view, origin, { at: { x: 195, y: 66, z: 60 }, range: 1 }, 'p1.1');
    expect(lines[0]).toContain('地図の外');
    expect(lines[1]).toContain('目的地は地図の外（水平 204m）: そこまでの道は地図に無く、不明');
    expect(lines[1]).toContain('walk は掘らず置かないので、遠い点を渡しても途中の壁で止まる');
  });
  it('writes nothing of the kind for a place on the map', () => {
    const lines = routeLines(view, origin, { at: { x: 1, y: 0, z: 0 }, range: 1 }, 'p1.1');
    expect(lines.join('\n')).not.toContain('地図に無く、不明');
  });
  it('says in mc.act that a far point only works when the way is open, not that any far point may be given', () => {
    expect(SHORT_ACT_DESCRIPTION).toContain('地図の外の遠い点も渡せるが、掘らず置かないので、途中に壁があるとそこで止まる');
    expect(SHORT_ACT_DESCRIPTION).not.toContain('40m 以上先は地図の外の座標を渡してよい');
    expect(V2_ALWAYS).toContain('目的地が地図の外なら、その先の道は不明');
  });
});

describe('s14: the steps that take her away from the hostile', () => {
  const open: Record<string, string> = {};
  for (let x = -3; x <= 3; x += 1) for (let z = -3; z <= 3; z += 1) for (const y of [0, 1]) open[`${x},${y},${z}`] = '.';
  const map = mapOf(open);
  const live = (urgent: string[], threats: string[]) => rewriteLlmcLive({ plan: {}, body: { state: { at: '(0,0,0)' }, map, urgent, threats } }).live.body as Record<string, any>;
  it('lists the walkable neighbours that are farther from an enderman in sight, and not the ones toward it', () => {
    const away = live([], ['#1 enderman 4.2m (-3,0,-3)・見える（射線の中）']).away as string[];
    expect(away).toHaveLength(1);
    expect(away[0]).toContain('#1 enderman（4.2m）から離れる、掘らずに歩ける隣: ');
    for (const word of ['南 (0,0,1)', '東 (1,0,0)', '南東 (1,0,1)']) expect(away[0], word).toContain(word);
    for (const word of ['北 (0,0,-1)', '西 (-1,0,0)', '北西 (-1,0,-1)']) expect(away[0], word).not.toContain(word);
  });
  it('takes the urgent line\'s hostile first, and writes nothing when no hostile is near or in sight', () => {
    expect((live(['#7 blaze 5.0m (3,0,0) 東3'], ['#1 enderman 4.2m (-3,0,-3)・見える（射線の中）']).away as string[])[0]).toContain('#7 blaze');
    expect(live([], ['#1 zombie 12m (5,0,0)']).away).toBeUndefined();
    expect(live([], ['#1 zombie 20m (20,0,0)・見える（射線の中）']).away).toBeUndefined();
  });
  it('says there is none when every step is toward it or needs a dig', () => {
    const out = rewriteLlmcLive({ plan: {}, body: { state: { at: '(0,0,0)' }, map: mapOf({}), urgent: ['#1 enderman 4.2m (-3,0,-3)'] } }).live.body as Record<string, any>;
    expect(out.away[0]).toContain('離れる、掘らずに歩ける隣は無い');
  });
  it('is in the dictionary and the enderman\'s rule points to it', () => {
    expect(V2_ALWAYS).toMatch(/^- away: /mu);
  });
});

describe('s67: where the water and the lava meet', () => {
  // A water source south of her feet and a lava source beside the rock south of it: the cells (1,0,1) and (0,0,2) touch both.
  const cells = { '0,0,1': 'w', '1,0,2': 'L', '0,0,2': '#', '1,0,1': '#' };
  const view = viewOf(mapOf(cells));
  it('names the cell beside both a water source and a lava source, with the two', () => {
    const lines = obsidianWays({ planNow: '[p7.2] 黒曜石を作る' }, origin, view);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('水の源と溶岩の源の両方に隣り合うマス（開けると水と溶岩が出会う）: (1,0,1) 目から 1.4m（石の類）・隣の水の源 (0,0,1)・溶岩の源 (1,0,2) / (0,0,2) 目から 2.0m（石の類）・隣の水の源 (0,0,1)・溶岩の源 (1,0,2)');
    expect(lines[1]).toContain('溶岩の源だけに隣り合う岩を開けると、溶岩が流れ込む');
  });
  it('lists no cell when no cell touches both, and the old line keeps no story of one run', () => {
    const none = obsidianWays({ planNow: '[p7.2] 黒曜石を作る' }, origin, viewOf(mapOf({ '0,0,1': 'w', '3,0,3': 'L' })));
    expect(none).toHaveLength(1);
    expect(none[0]).not.toContain('実走');
  });
  it('marks a cell to dig that lies beside lava, in the lines of the steps and the route', () => {
    expect(lavaNext(view, { x: 0, y: 0, z: 2 })).toBe(true);
    expect(lavaNext(view, { x: -1, y: 0, z: 0 })).toBe(false);
    expect(digWords(view, [{ x: 0, y: 0, z: 2 }, { x: -1, y: 0, z: 0 }])).toBe('(0,0,2) 石の類（溶岩の隣: 開けると溶岩が流れ込む）、(-1,0,0) 石の類');
  });
  it('says the same in the stage knowledge and in the dictionary', () => {
    expect(V2_ALWAYS).toContain('開けると溶岩が流れ込むマス');
    expect(V2_ALWAYS).toContain('水の源と溶岩の源の両方に隣り合うマス');
  });
});

describe('chapter 4 A: the road and the pace', () => {
  const tree = seedPlan('エンドラを倒して')!;
  const notDragon = { ...tree, nodes: tree.nodes.filter(node => !/ドラゴン|エンドラ/u.test(node.title)) };
  const withStates = (done: string[], current: string) => ({ ...tree, current, nodes: tree.nodes.map(node => ({ ...node, state: done.includes(node.id) ? 'done' as const : node.state })) });
  it('tells the dragon plan from another by a node that names the dragon', () => {
    expect(isDragonPlan(tree)).toBe(true);
    expect(isDragonPlan(notDragon)).toBe(false);
    expect(isDragonPlan(null)).toBe(false);
  });
  it('writes the top-level nodes: the done ones with ✓, the one she is in with ◀今, the next five, and how many are left', () => {
    const road = roadLine(withStates(['p1', 'p2', 'p3', 'p4'], 'p5.1'))!;
    expect(road).toBe('道のり: 済み 1 節 食料とベッド✓ 鉄✓ 水入りバケツ✓ → ダイヤ◀今 → 黒曜石10とゲート → 出発の点検 → ネザー要塞を探す → ブレイズロッド7以上 → エンダーパール12前後 → ほか 4 節');
  });
  it('is absent for a plan that is not the dragon\'s', () => {
    expect(roadLine(notDragon)).toBeNull();
    expect(roadLine(null)).toBeNull();
  });
  const have = (items: Array<[string, number]>, dimension = 'overworld') => frame({ position: { x: 0, y: 0, z: 0 }, dimension,
    inventory: items.map(([name, count]) => ({ name, count })) });
  it('says the seconds and the next milestone with its target, ahead and behind', () => {
    const kit = have([['blue_bed', 1], ['iron_pickaxe', 1], ['bucket', 1]]);
    expect(meterLine(tree, kit, 812 / 60)).toBe('目安: 今 812 秒・次の節目 ダイヤのツルハシ 目安 1,000 秒（あと 188 秒）');
    expect(meterLine(tree, kit, 1_100 / 60)).toBe('目安: 今 1,100 秒・次の節目 ダイヤのツルハシ 目安 1,000 秒（100 秒遅れ）');
    expect(meterLine(tree, have([]), 30 / 60)).toBe('目安: 今 30 秒・次の節目 ベッド 目安 150 秒（あと 120 秒）');
  });
  it('takes the last milestone the frame shows as reached (one used up does not hold it back), and ends with the Nether', () => {
    expect(meterLine(tree, have([['diamond_pickaxe', 1], ['water_bucket', 1]]), 1_200 / 60)).toContain('次の節目 黒曜石 10 個 目安 1,500 秒');
    expect(meterLine(tree, have([['diamond_pickaxe', 1]], 'the_nether'), 1_700 / 60)).toBe('目安: 今 1,700 秒・節目（ネザー まで）は全部済んだ');
  });
  it('is absent for another plan, an unknown time or no frame', () => {
    expect(meterLine(notDragon, have([]), 1)).toBeNull();
    expect(meterLine(tree, have([]), null)).toBeNull();
    expect(meterLine(tree, null, 1)).toBeNull();
  });
  it('puts both lines in the live state after planNow for the mode, and leaves the old mode\'s as it was', () => {
    const parts = { elapsedMinutes: 1, trend: createFoodTrend(() => 0), events: [], observation: frame({ position: { x: 1, y: 2, z: 3 }, dimension: 'overworld' }),
      planNow: '[p1.1] 原木', road: '道のり: A◀今 → B', meter: '目安: 今 60 秒・次の節目 ベッド 目安 150 秒（あと 90 秒）' };
    expect(Object.keys(minecraftLlmcLive(parts, 0, true)).slice(0, 3)).toEqual(['planNow', 'road', 'meter']);
    expect(Object.keys(minecraftLlmcLive({ ...parts, road: null, meter: null }, 0, false))).not.toContain('road');
  });
  it('gives the goal and the yardstick in the instructions, the numbers from the one constant, and each line in the dictionary', () => {
    const system = minecraftV2System(V2_ALWAYS);
    expect(system).toContain('## 目的と物差し');
    expect(system).toContain('ネザーへ入るまでを 30 分以内に');
    expect(system).toContain('死ぬと持ち物と時間を失い');
    expect(system).toContain('時間を理由に止めたり、早く完了にしたりしない');
    expect(system).toContain(milestoneWords());
    expect(milestoneWords()).toBe('ベッド 150・鉄のツルハシ 250・バケツ 600・ダイヤのツルハシ 1,000・水バケツ 1,000・黒曜石 10 個 1,500・ネザー 1,800');
    expect(DRAGON_MILESTONES.map(item => item.seconds)).toEqual([150, 250, 600, 1_000, 1_000, 1_500, 1_800]);
    expect(V2_ALWAYS).toMatch(/^- road: /mu);
    expect(V2_ALWAYS).toMatch(/^- meter: /mu);
  });
});
