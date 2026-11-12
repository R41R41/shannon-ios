import { afterEach, describe, expect, it } from 'vitest';
import type { PlanKind, PlanNode, PlanPromise } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { urgentFacts } from '../src/surfaces/minecraft/minecraftLlmcEvents.js';
import { liquidLines } from '../src/surfaces/minecraft/minecraftLlmcLiquid.js';
import { lavaSitesIn, nearbyLines, type NearbyResource } from '../src/surfaces/minecraft/minecraftLlmcNearby.js';
import { obsidianWays } from '../src/surfaces/minecraft/minecraftLlmcObsidianWays.js';
import { forgetOnceFacts, pending } from '../src/surfaces/minecraft/minecraftLlmcOnceFacts.js';
import { BODY_RULES, mapView, readLayers } from '../src/surfaces/minecraft/minecraftLlmcPreflightMap.js';
import { promiseLines } from '../src/surfaces/minecraft/minecraftLlmcPromises.js';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { obsidianTallyLine, waterNodeFacts, waterNodeUnneeded } from '../src/surfaces/minecraft/minecraftLlmcWaterNode.js';
import { doneFacts, parseDoneWhen, predicateHolds } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { planFacts, v2tree } from './helpers/planTreeV2.js';

/**
 * Run 8 (11/13), the head's half of the six fixes: the lava pools near her (not the nearest source alone), the obsidian carried and in view beside
 * the gate's least, the water node said unneeded when the obsidian in view covers the lack, the lava touching an obsidian cell, the End's water
 * bucket said as one for later, and the skeletons that shoot from beyond the reflex's 4 m. The gate's half is in the gate's own tests.
 */
afterEach(() => forgetOnceFacts());

const FEET = { x: 0, y: 0, z: 0 };
/** A map of 7×7 round her feet at (0,0,0) on the layers `ys`; the cells not given are rock below her feet and air at and above them. */
const mapOf = (cells: Record<string, string>, ys: number[] = [1, 0, -1, -2]): string => {
  const lines = ['地図 v1 足=(0,0,0) x=-3..3 z=-3..3 方式=layers 上=北'];
  for (const y of ys) {
    lines.push(`y=${y}`);
    for (let z = -3; z <= 3; z += 1) {
      const row: string[] = [];
      for (let x = -3; x <= 3; x += 1) row.push(cells[`${x},${y},${z}`] ?? (y < 0 ? '#' : '.'));
      lines.push(`${z} ${row.join(' ')}`);
    }
  }
  return lines.join('\n');
};
const view = (cells: Record<string, string>) => mapView(readLayers(mapOf(cells), BODY_RULES)!);
const frame = (items: ReadonlyArray<readonly [string, number]>, world: Record<string, unknown> = {}, facts: Record<string, unknown> = {}): BodyObservation => ({
  schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true, facts,
  state: { world: { dimension: 'overworld', position: { x: 0, y: 0, z: 0 }, health: 20, food: 20, inventory: items.map(([name, count]) => ({ name, count })),
    worn: '', ...world } as never } }) as BodyObservation;
const node = (id: string, kind: PlanKind, order: number, doneWhen: string, parentId: string | null = null): PlanNode =>
  ({ id, parentId, order, title: id, state: 'continue', kind, ...(doneWhen ? { doneWhen } : {}) } as PlanNode);

const POOLS: NearbyResource = { purpose: 'lava', kind: 'lava', count: 4, range: 96, sites: [
  { x: 7, y: 20, z: 0, note: '源 3・覆い×' }, { x: 0, y: -19, z: 40, note: '源 30・覆い○' }, { x: 36, y: -45, z: 0, note: '源 64' }, { x: 0, y: -55, z: 60, note: '源 90' }] };

describe('the lava pools near her (run 8: four pools loaded, the head told the nearest source 27 below across a hollow)', () => {
  it('writes the pools as a nearby line, first while the plan is at the obsidian, and reads them back', () => {
    const lines = nearbyLines([{ purpose: 'wood', kind: 'oak_log', count: 10, range: 64, sites: [{ x: 3, y: 0, z: 0 }] }, POOLS], FEET, '[p7.1] 溶岩源で黒曜石22');
    expect(lines[0]!.startsWith('溶岩の溜まり: lava 96m 内に 4つ。最寄り (7,20,0) 東7・上20 21m（源 3・覆い×）')).toBe(true);
    expect(nearbyLines([POOLS, { purpose: 'wood', kind: 'oak_log', count: 10, range: 64, sites: [{ x: 3, y: 0, z: 0 }] }], FEET, '[p3] 鉄')[0]).toMatch(/^木: /u);
    expect(lavaSitesIn(lines)).toEqual({ range: 96, sites: [{ x: 7, y: 20, z: 0, sources: 3, covered: false }, { x: 0, y: -19, z: 40, sources: 30, covered: true },
      { x: 36, y: -45, z: 0, sources: 64, covered: null }] });
    expect(lavaSitesIn(nearbyLines([{ ...POOLS, count: 0, sites: [] }], FEET))).toEqual({ range: 96, sites: [] });
    expect(lavaSitesIn(['木: oak_log 64m 内に なし'])).toBeNull();
  });
  it('puts the three pools in the obsidian line with how far across and up or down from her feet, beside the obsidian carried and in view', () => {
    const body = { planFacts: planFacts('obsidian', { id: 'p7.1' }), nearby: nearbyLines([POOLS], FEET, '黒曜石'), inventory: ['obsidian×4', 'diamond_pickaxe×1'] };
    const [line] = obsidianWays(body, FEET, view({ '2,0,0': 'O', '2,0,1': 'O' }));
    expect(line!.startsWith('黒曜石: 持ち物 4／ゲートの最低 10／目標 22（ゲート 10＋竜戦 12）。見えている自然の黒曜石 地図に 2 マス・最寄り (2,0,0) まで 2m（地図）。')).toBe(true);
    expect(line).toContain('溶岩の溜まり（近い順・今の足から）: (7,20,0) 水平 7m・上 20・源 3・覆い× / (0,-19,40) 水平 40m・下 19・源 30・覆い○ / (36,-45,0) 水平 36m・下 45・源 64。');
    expect(line).not.toContain('源が 10 以上の溜まり');
  });
  it('says none within the range and where else to look only when the body sees no pool and the map no lava', () => {
    const body = { planFacts: planFacts('obsidian'), nearby: nearbyLines([{ ...POOLS, count: 0, sites: [] }], FEET) };
    const [line] = obsidianWays(body, FEET, view({}));
    expect(line).toContain('自然の黒曜石 見えていない。溶岩の溜まり 96m 内に見えない（洞窟・地表の近くも mc_probe kind=scan で読み直す。それでも無ければ低い y を当てて掘る）');
    // A lava source on the map is said as before (the body's count was cut or old).
    expect(obsidianWays(body, FEET, view({ '1,0,0': 'L' }))[0]).toContain('溶岩の源 (1,0,0) まで 1m（地図）');
    // With pools in sight the hint is not said.
    expect(obsidianWays({ planFacts: planFacts('obsidian'), nearby: nearbyLines([POOLS], FEET) }, FEET, view({}))[0]).not.toContain('低い y');
  });
});

describe('the lava touching an obsidian cell (run 8: six dug with lava beside or under them burned)', () => {
  it('marks a cell with lava under it (also through air), beside it or above it, and counts them', () => {
    const cells = { '2,0,0': 'O', '2,-1,0': 'L', '-2,0,0': 'O', '-2,-1,0': '.', '-2,-2,0': 'l', '0,0,2': 'O', '1,0,2': 'L', '0,0,-2': 'O' };
    const line = liquidLines(view(cells), FEET).find(item => item.startsWith('黒曜石'))!;
    expect(line.startsWith('黒曜石 4 マス（うち下か横が溶岩 3）: ')).toBe(true);
    expect(line).toContain('(2,0,0) 目から');
    expect(line).toMatch(/\(2,0,0\) 目から [\d.]+m・届く・下が溶岩/u);
    expect(line).toMatch(/\(-2,0,0\) 目から [\d.]+m・届く・下が溶岩/u);
    expect(liquidLines(view({ '0,0,2': 'O', '1,0,2': 'L', '0,-1,2': 'L' }), FEET).find(item => item.startsWith('黒曜石'))).toContain('・下と横が溶岩');
    expect(liquidLines(view({ '0,0,-2': 'O' }), FEET).find(item => item.startsWith('黒曜石'))).toBe('黒曜石 1 マス: (0,0,-2) 目から 2.3m・届く');
  });
});

describe('the water node said unneeded when the obsidian in view covers the lack (run 8: 252 s to fetch water with obsidian standing near)', () => {
  const tree = (nodes: PlanNode[]) => v2tree({ revision: 1, current: 'p7.1', nodes });
  const WITH_WATER = [node('p7', 'portal', 0, 'dim:the_nether'), node('p7.1', 'obsidian', 0, 'have:obsidian>=22', 'p7'), node('n3', 'water', 1, 'have:water_bucket', 'p7')];
  const twelve = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`${(index % 6) - 3},-1,${Math.floor(index / 6) + 1}`, 'O']));
  const facts = (items: Array<[string, number]>) => doneFacts(frame(items))!;
  it('says it once with the lack, the obsidian in view and that water is only for pouring', () => {
    const [fact] = waterNodeUnneeded(tree(WITH_WATER), facts([['diamond_pickaxe', 1]]), view(twelve));
    expect(fact!.key).toBe('water_node_unneeded:n3');
    expect(fact!.text).toContain('水入りバケツの節 n3「n3」: 黒曜石の不足はゲートの最低 10 まで 10・目標 22 まで 22、見えている黒曜石は 12 マス（最寄り');
    expect(fact!.text).toContain('水は溶岩に注いで作る時だけ要る。見えている黒曜石を掘るだけなら要らない');
  });
  it('says nothing with too little obsidian in view, no water node, a full bucket or no diamond pickaxe', () => {
    expect(waterNodeUnneeded(tree(WITH_WATER), facts([['diamond_pickaxe', 1]]), view({ '1,-1,1': 'O', '2,-1,1': 'O', '3,-1,1': 'O' }))).toEqual([]);
    expect(waterNodeUnneeded(tree(WITH_WATER.slice(0, 2)), facts([['diamond_pickaxe', 1]]), view(twelve))).toEqual([]);
    expect(waterNodeUnneeded(tree(WITH_WATER), facts([['diamond_pickaxe', 1], ['water_bucket', 1]]), view(twelve))).toEqual([]);
    expect(waterNodeUnneeded(tree(WITH_WATER), facts([['iron_pickaxe', 1]]), view(twelve))).toEqual([]);
    // Ten carried: the aim's 12 still to dig, twelve in view.
    expect(waterNodeUnneeded(tree(WITH_WATER), facts([['diamond_pickaxe', 1], ['obsidian', 10]]), view(twelve))).toHaveLength(1);
  });
  it('is offered with the frame and taken back when it no longer holds', () => {
    const map = mapOf(twelve);
    waterNodeFacts('w', tree(WITH_WATER), frame([['diamond_pickaxe', 1]], { localMap: map }));
    expect(pending('w').map(fact => fact.key)).toEqual(['water_node_unneeded:n3']);
    waterNodeFacts('w', tree(WITH_WATER), frame([['diamond_pickaxe', 1], ['water_bucket', 1]], { localMap: map }));
    expect(pending('w')).toEqual([]);
  });
  it('gives the replan the obsidian carried and in view', () => {
    expect(obsidianTallyLine(frame([['obsidian', 4]], { localMap: mapOf({ '2,0,0': 'O', '2,0,1': 'O' }) })))
      .toBe('黒曜石: 持ち物 4／ゲートの最低 10／目標 22（ゲート 10＋竜戦 12）。見えている自然の黒曜石 地図に 2 マス・最寄り 2m（地図）');
    expect(obsidianTallyLine(frame([], { dimension: 'the_nether' }))).toBeNull();
  });
  it('says in the stage knowledge that obsidian in view is dug with no water', () => {
    const text = Object.values(V2_STAGES).join('\n');
    expect(text).toContain('見えている黒曜石（live の obsidian・liquid の行）を掘るだけなら水は要らない（下・横が溶岩の黒曜石は、石（dirt・丸石）を持っていれば体が埋めてから掘る）');
    expect(text).not.toContain('水入りバケツ・ダイヤpick・作業位置を先に確保し');
  });
});

describe('the End\'s water bucket promised (run 8: 「足りない 1」 at every decision of the obsidian)', () => {
  const promise: PlanPromise = { id: 3, rev: 1, item: 'water_bucket', count: 1, use: 'エンド用', state: 'open', ledger: [] };
  it('is said as one to have before the End while she is not there and has no stronghold eyes', () => {
    expect(promiseLines([promise], { observation: frame([]) })[0]).toContain('（エンドの前に用意）');
    expect(promiseLines([promise], { observation: frame([]) })[0]).not.toContain('足りない');
    expect(promiseLines([promise], { observation: frame([['ender_eye', 10]]) })[0]).toContain('（足りない 1）');
    expect(promiseLines([promise], { observation: frame([], { dimension: 'the_end' }) })[0]).toContain('（足りない 1）');
    expect(promiseLines([{ ...promise, use: '黒曜石を作る' }], { observation: frame([]) })[0]).toContain('（足りない 1）');
  });
});

describe('the lit gate is entered (run 8: the obsidian node opened again when the frame took 10)', () => {
  it('closes the obsidian node when a lit portal is in view, and has no food 100 before the gate', () => {
    const plan = seedPlan('エンドラを倒して')!;
    const obsidian = plan.nodes.find(item => item.kind === 'obsidian' && item.title.startsWith('溶岩源で黒曜石22'))!;
    const seen = { ...doneFacts(frame([['obsidian', 8]]))!, seen: new Set(['nether_portal']) };
    expect(predicateHolds(parseDoneWhen(obsidian.doneWhen)!, seen)).toBe(true);
    expect(predicateHolds(parseDoneWhen(obsidian.doneWhen)!, doneFacts(frame([['obsidian', 8]]))!)).toBe(false);
    const gate = plan.nodes.find(item => item.title === '黒曜石10とゲート')!;
    expect(plan.nodes.filter(item => item.parentId === gate.id).map(item => item.doneWhen)).not.toContain('food>=100');
  });
});

describe('the skeletons that shoot from beyond the reflex\'s 4 m (run 8: about 158 s, health 20 to 2.2 in one meeting)', () => {
  const skeleton = (id: number, distance: number, extra: Record<string, unknown> = {}) => ({ id, name: 'skeleton', distance, position: { x: distance, y: 2, z: 0 },
    canSee: true, ...extra });
  const shot = (threats: unknown[], closeIn: boolean) => frame([], { nearbyThreats: threats, worn: '頭: iron_helmet(残り165/165)、左手: shield(残り32/336)' },
    { closeInAdvised: closeIn });
  const hits = [{ by: 'skeleton #6480' }, { by: 'skeleton #6480' }, { by: 'zombie #11' }];
  it('names the shooter that hit her with its id, height, the hits, the shield left and that a lone one can be closed in on', () => {
    const { reasons } = urgentFacts(shot([skeleton(6480, 9.3)], true), null, null, null, hits);
    expect(reasons).toContain('撃ってきた射手: skeleton #6480 9.3m・上 2・見える（射線の中）・10 秒で 2 回当たった・盾 残り約 8 本受けられる・盾・剣・撃ってくる骸骨 1 体で、詰めて斬れる');
  });
  it('says no closing in when the body does not advise it, two skeletons shoot, or no way leads to it', () => {
    expect(urgentFacts(shot([skeleton(6480, 9.3)], false), null, null, null, hits).reasons.join()).not.toContain('詰めて斬れる');
    const two = urgentFacts(shot([skeleton(6480, 9.3), skeleton(7103, 11)], true), null, null, null, [...hits, { by: 'skeleton #7103' }]).reasons;
    expect(two.filter(line => line.startsWith('撃ってきた射手:'))).toHaveLength(2);
    expect(two.join()).not.toContain('詰めて斬れる');
    expect(urgentFacts(shot([skeleton(6480, 9.3, { position: { x: 9, y: 8, z: 0 } })], true), null, null, null, hits).reasons.join()).not.toContain('詰めて斬れる');
  });
  it('says nothing of a shooter that did not hit her, and does not say the near one twice', () => {
    expect(urgentFacts(shot([skeleton(6480, 9.3)], true), null, null, null, [{ by: 'zombie #11' }]).reasons).toEqual([]);
    const near = urgentFacts(shot([skeleton(6480, 3.1)], true), null, null, null, hits).reasons;
    expect(near.filter(line => line.includes('#6480'))).toHaveLength(1);
  });
  it('tells the decision how skeletons keep their distance and to close in on a lone one with fight range 16', () => {
    const text = Object.values(V2_STAGES).join('\n');
    expect(text).toContain('骸骨（skeleton・stray・bogged）は 7.5〜15m の間を保って射つ');
    expect(text).toContain('fight target=#id range=16 seconds=15 で詰めて斬る');
    expect(text).toContain('ほかの射手（ブレイズ・ガスト・ピリジャーなど）に撃たれている間は');
  });
});
