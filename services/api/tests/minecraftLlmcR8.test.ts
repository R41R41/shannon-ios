import { afterEach, describe, expect, it } from 'vitest';
import type { PlanNode } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { ProbeInput } from '../src/contracts/minecraftProbeContract.js';
import { forgetLlmcEvents, withLlmcBody } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { forgetSurpriseWatches } from '../src/surfaces/minecraft/minecraftLlmcProbe.js';
import { forgetThreatSights } from '../src/surfaces/minecraft/minecraftLlmcThreat.js';
import { forgetFirstPlans, FIRST_PLAN_SYSTEM_R7, FIRST_PLAN_SYSTEM_R8, seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { forgetActNodes } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { LLMC_SYSTEM_APPENDIX_R7, LLMC_SYSTEM_APPENDIX_R8, R8_KNOWLEDGE } from '../src/surfaces/minecraft/minecraftKnowledge.js';
import {
  columnKey, footingFromMap, footingLine, footingProbes, forgetColumnFacts, keepColumnFact, keptColumnFact, lookAtFooting, readAroundFooting, readColumnFact, readMap,
} from '../src/surfaces/minecraft/minecraftLlmcFooting.js';
import { approaching, approachingIds, frameThreatLine, newApproach, planNowTitle } from '../src/surfaces/minecraft/minecraftLlmcUrgent.js';
import { createFoodTrend, llmcTokens, minecraftLlmcLive, minecraftLlmcUrgentLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { nearThreats } from '../src/surfaces/minecraft/minecraftLlmcThreat.js';
import { createFcaPlanTools, planInput } from '../src/mind/action/fca/fcaPlanTools.js';
import { bridgeAt, layersMap, surfaceMap } from './support/minecraftFootingMaps.js';

/**
 * mb-llmc r8, the head (production run 32, 2026-10-22: a one-wide bridge without walls over the Nether's lava sea, a wither skeleton on the
 * fortress above, three hits in 2.3 s, thrown off, dead; the decision for it took 10.3 s and reached the body after her death): the footing
 * as a line of the live state, the knowledge of crossing a gap, and a decision thrown away when a hostile comes while it is awaited.
 */
afterEach(() => { forgetLlmcEvents(); forgetSurpriseWatches(); forgetFirstPlans(); forgetActNodes(); forgetThreatSights(); forgetColumnFacts(); });

const FEET = { x: 251, y: 55, z: 76 };
const at = (x: number, y: number, z: number) => ({ x, y, z });
const WORLD_AT = at(251.5, 55, 76.5);
function frame(world: Record<string, unknown>): BodyObservation {
  return { schemaVersion: 1, bodyId: 'minecraft:s', sequence: 1, stateAt: '2026-10-22T00:00:00Z', receivedAt: '2026-10-22T00:00:00Z', connected: true,
    state: { world: world as never }, facts: { alive: true } };
}

describe('the footing round her feet (run 32: the drop under the bridge was not on the map)', () => {
  const bridge = layersMap(FEET, bridgeAt);

  it('reads the map the body draws: the layers by y, and the cells by block', () => {
    const drawn = readMap(bridge)!;
    expect(drawn.feet).toEqual(FEET);
    expect(drawn.mode).toBe('layers');
    expect([...drawn.layers.keys()].sort()).toEqual([53, 54, 55, 56, 57]);
    expect(drawn.layers.get(55)!.cells.get('251,76')).toBe('@');
    expect(drawn.layers.get(54)!.cells.get('252,76')).toBe('#');
    expect(drawn.layers.get(54)!.cells.get('252,77')).toBe('.');
    // The outer layers are 11 × 11 and say their range: x=246..256, so x=244 is not there.
    expect(drawn.layers.get(57)!.cells.has('244,76')).toBe(false);
    expect(drawn.layers.get(54)!.cells.has('244,76')).toBe(true);
    expect(readMap('地図なし')).toBeNull();
    expect(readMap(undefined)).toBeNull();
  });

  it('a one-wide bridge: both sides are gaps, the map cannot say how deep, so the probes go to the two sides', () => {
    const footing = footingFromMap(bridge, WORLD_AT)!;
    expect(footing.floors).toBe(2);
    expect(footing.gaps.map(gap => `${gap.dx},${gap.dz}`).sort()).toEqual(['-1,-1', '-1,1', '0,-1', '0,1', '1,-1', '1,1']);
    expect(footing.gaps.every(gap => gap.deeper && gap.drop === 2)).toBe(true);
    expect(footingProbes(footing, () => undefined)).toEqual([
      { kind: 'column', x: 251, z: 75, yFrom: 54, yTo: -5 }, { kind: 'column', x: 251, z: 77, yFrom: 54, yTo: -5 }]);
    // Said as a guess until the probe answers.
    expect(footingLine(footing)).toBe('足場: 幅 1 の橋・両脇（北・南）とも空所（落差 2 以上（深さは調べていない））。押されたら落ちる');
  });

  it('with the column probe\'s answer: the drop and what is at the bottom (the example of the brief: 28 down, lava)', () => {
    const footing = footingFromMap(bridge, WORLD_AT)!;
    // The diagonals are not asked: the sides' answers measure the line, and the rest stands as they say.
    const lava = { drop: 28, bottom: 'lava' as const, name: 'lava' };
    const facts = new Map([[columnKey(at(251, 55, 75), 55), lava], [columnKey(at(251, 55, 77), 55), lava]]);
    expect(footingLine(footing, key => facts.get(key))).toBe('足場: 幅 1 の橋・両脇（北・南）とも空所（落差 28、下は溶岩）。押されたら落ちる');
    // One side measured is enough to speak for the diagonals; a measured side that is shallow says there is nothing to fear.
    const shallow = new Map([[columnKey(at(251, 55, 75), 55), { drop: 2, bottom: 'floor' as const, name: 'netherrack' }]]);
    expect(footingLine(footing, key => shallow.get(key))).toBeNull();
  });

  it('reads a column probe\'s answer by its text, else by its runs', () => {
    const text = JSON.stringify({ v: 1, kind: 'column', text: '下 24 段は空気（落差 24、底 y=30 lava）', runs: [{ top: 54, bottom: 31, name: 'air', n: 24 }, { top: 30, bottom: 30, name: 'lava', n: 1 }] });
    expect(readColumnFact(text, 55)).toEqual({ drop: 24, bottom: 'lava', name: 'lava' });
    const runs = JSON.stringify({ v: 1, kind: 'column', text: 'y=54〜31 空気×24／y=30 stone', runs: [{ top: 54, bottom: 31, name: 'air', n: 24 }, { top: 30, bottom: 30, name: 'stone', n: 1 }] });
    expect(readColumnFact(runs, 55)).toEqual({ drop: 24, bottom: 'floor', name: 'stone' });
    expect(readColumnFact('ただの文', 55)).toBeNull();
    expect(readColumnFact(null, 55)).toBeNull();
  });

  it('a tunnel in the rock and a step of one block say nothing (no line, no tokens)', () => {
    const tunnel = layersMap(FEET, (dx, dz, dy) => dy === 0 && dz === 0 && Math.abs(dx) <= 3 ? '.' : dy === 1 && dz === 0 && Math.abs(dx) <= 3 ? '.' : '#');
    const footing = footingFromMap(tunnel, WORLD_AT)!;
    expect(footing.gaps).toEqual([]);
    expect(footingLine(footing)).toBeNull();
    const step = layersMap(FEET, (dx, dz, dy) => dy === -1 && dx === 1 && dz === 0 ? '.' : dy <= -1 ? '#' : '.');
    const stepFooting = footingFromMap(step, WORLD_AT)!;
    expect(stepFooting.gaps.map(gap => gap.drop)).toEqual([1]);
    expect(footingLine(stepFooting)).toBeNull();
    expect(footingProbes(stepFooting, () => undefined)).toEqual([]);
  });

  it('lava at her feet\'s height beside her is said as lava, not as a drop', () => {
    const edge = layersMap(FEET, (dx, dz, dy) => dx === 1 && dz === 0 && dy === 0 ? 'L' : dy <= -1 ? '#' : '.');
    expect(footingLine(footingFromMap(edge, WORLD_AT))).toBe('足場: 東が空所（溶岩のマス）。押されたら落ちる');
  });

  it('a map drawn for another block than the frame\'s feet is old: no footing from it', () => {
    expect(footingFromMap(bridge, at(252.5, 55, 76.5))).toBeNull();
    expect(footingFromMap(bridge, at(251.5, 56, 76.5))).toBeNull();
    expect(footingFromMap(bridge, null)).not.toBeNull();
  });

  it('the surface form: a cliff next to her by the height codes (v: ten or more below, d: four below)', () => {
    const cliff = surfaceMap(FEET, (dx, dz) => dx === 1 && dz === 0 ? '.v' : dx === 0 && dz === -1 ? '#d' : dx === 0 && dz === 1 ? '#1' : '#0', () => '.');
    const footing = footingFromMap(cliff, WORLD_AT)!;
    expect(footing.gaps.map(gap => `${gap.dx},${gap.dz}:${gap.drop}${gap.deeper ? '+' : ''}`).sort()).toEqual(['0,-1:4', '1,0:12+']);
    expect(footingLine(footing)).toBe('足場: 北・東が空所（落差 12 以上（深さは調べていない））。押されたら落ちる');
    const facts = new Map([[columnKey(at(252, 55, 76), 55), { drop: 15, bottom: 'floor' as const, name: 'stone' }]]);
    expect(footingLine(footing, key => facts.get(key))).toBe('足場: 北・東が空所（落差 15、下は stone）。押されたら落ちる');
  });

  it('asks the body\'s column probe for the gaps the map cannot measure, keeps the answers, and asks no more of the same cell', async () => {
    const sent: ProbeInput[] = [];
    const column = JSON.stringify({ v: 1, kind: 'column', text: '下 24 段は空気（落差 24、底 y=30 lava）' });
    const first = await lookAtFooting({ taskId: 'r8-look', map: bridge, feet: WORLD_AT, index: 20, budgetMs: 200,
      run: async input => { sent.push(input); return input.kind === 'around' ? null : column; } });
    // The body's `around` (it says the footing itself, where it can) beside the two columns; an older body gives no word, and the map's and the columns' stand.
    expect(sent.map(input => input.kind)).toEqual(['around', 'column', 'column']);
    expect(first).toMatchObject({ gaps: 6, asked: 3, by: 'map' });
    expect(first.line).toContain('落差 24、下は溶岩');
    expect(keptColumnFact('r8-look')(columnKey(at(251, 55, 75), 55))).toEqual({ drop: 24, bottom: 'lava', name: 'lava' });
    // A side that is measured speaks for the diagonals: the columns are not asked again (the body's around is), and the line is the same.
    const second = await lookAtFooting({ taskId: 'r8-look', map: bridge, feet: WORLD_AT, index: 20, budgetMs: 200,
      run: async input => { sent.push(input); return input.kind === 'around' ? null : column; } });
    expect(second.asked).toBe(1);
    expect(sent.map(input => input.kind)).toEqual(['around', 'column', 'column', 'around']);
    expect(second.line).toBe(first.line);
  });

  it('the body\'s own word (its around: 「足場: …」 in the text, else the field footing) is the line; no gap in the map, no question', async () => {
    const said = '足場: 幅 1 の橋・左右とも空所（落差 26、下は溶岩）。押されたら落ちる。近くに生き物は居ない';
    const around = JSON.stringify({ v: 1, kind: 'around', text: said, footing: { voids: 6, deepest: 26, lava: true, bridge: true, pillar: false, text: '幅 1 の橋' } });
    const sent: ProbeInput[] = [];
    const asked = await lookAtFooting({ taskId: 'r8-body', map: bridge, feet: WORLD_AT, index: 20, budgetMs: 200,
      run: async input => { sent.push(input); return input.kind === 'around' ? around : null; } });
    expect(asked).toMatchObject({ line: '足場: 幅 1 の橋・左右とも空所（落差 26、下は溶岩）。押されたら落ちる', by: 'body' });
    expect(sent[0]).toEqual({ kind: 'around', radius: 4 });
    expect(readAroundFooting(JSON.stringify({ v: 1, kind: 'around', text: '近くに敵は居ない', footing: { text: '幅 1 の足場・四方とも空所（落差 33）' } })))
      .toBe('足場: 幅 1 の足場・四方とも空所（落差 33）');
    expect(readAroundFooting(JSON.stringify({ v: 1, kind: 'around', text: '近くに敵は居ない' }))).toBeNull();
    expect(readAroundFooting(JSON.stringify({ v: 1, kind: 'column', text: said }))).toBeNull();
    expect(readAroundFooting(null)).toBeNull();
    const tunnel = layersMap(FEET, (dx, dz, dy) => dy === 0 && dz === 0 && Math.abs(dx) <= 3 ? '.' : dy === 1 && dz === 0 && Math.abs(dx) <= 3 ? '.' : '#');
    sent.length = 0;
    await lookAtFooting({ taskId: 'r8-body', map: tunnel, feet: WORLD_AT, index: 20, budgetMs: 50, run: async input => { sent.push(input); return around; } });
    expect(sent).toEqual([]);
  });

  it('a probe that does not answer in time leaves the map\'s guess, said as one; no body probe: the guess too', async () => {
    const slow = await lookAtFooting({ taskId: 'r8-slow', map: bridge, feet: WORLD_AT, index: 20, budgetMs: 20,
      run: () => new Promise<string | null>(resolve => setTimeout(() => resolve(null), 500)) });
    expect(slow.line).toBe('足場: 幅 1 の橋・両脇（北・南）とも空所（落差 2 以上（深さは調べていない））。押されたら落ちる');
    const none = await lookAtFooting({ taskId: 'r8-none', map: bridge, feet: WORLD_AT, index: 20, budgetMs: 20, run: null });
    expect(none).toMatchObject({ asked: 0, line: slow.line });
    expect(await lookAtFooting({ taskId: 'r8-none', map: undefined, feet: WORLD_AT, index: 20, budgetMs: 20, run: null })).toMatchObject({ line: null, gaps: 0 });
    keepColumnFact('r8-none', 'k', { drop: 1, bottom: null, name: '' });
    expect(keptColumnFact('r8-none')('k')).toEqual({ drop: 1, bottom: null, name: '' });
  });

  it('is a key of the live state before the map, counted in its bound and never cut', () => {
    const world = { position: WORLD_AT, health: 20, food: 20, localMap: bridge, inventory: [{ name: 'cobblestone', count: 64 }] };
    const live = minecraftLlmcLive({ observation: frame(world), elapsedMinutes: 3, trend: createFoodTrend(), events: [],
      footing: '足場: 幅 1 の橋・両脇（北・南）とも空所（落差 28、下は溶岩）。押されたら落ちる' });
    const keys = Object.keys(live);
    expect(keys.indexOf('footing')).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf('footing')).toBeLessThan(keys.indexOf('map'));
    expect(live.footing).toBe('足場: 幅 1 の橋・両脇（北・南）とも空所（落差 28、下は溶岩）。押されたら落ちる');
    expect(minecraftLlmcLive({ observation: frame(world), elapsedMinutes: 3, trend: createFoodTrend(), events: [] })).not.toHaveProperty('footing');
  });
});

describe('a hostile she must act on (run 32: 「wither_skeleton #696 は見える・6m」, the decision 10.3 s)', () => {
  const skeleton = { id: 696, name: 'wither_skeleton', kind: 'hostile', distance: 6.1, position: at(256.5, 61, 76.5), canReachMe: true, canSee: true };
  const meters = (name: string) => name === 'creeper' ? 10 : 8;

  it('a shooter only while it sees her; any other while it can come and does not lack sight; none beyond 8 m (a creeper 10)', () => {
    const [seen] = nearThreats(frame({ position: WORLD_AT, nearbyThreats: [skeleton] }));
    expect(seen).toMatchObject({ id: 696, canSee: true, canReachMe: true, dy: 6 });
    expect(approaching(seen!, 8)).toBe(true);
    expect(approaching({ ...seen!, distance: 8.5 }, 8)).toBe(false);
    expect(approaching({ ...seen!, canReachMe: false }, 8)).toBe(false);
    expect(approaching({ ...seen!, canSee: false }, 8)).toBe(false);
    expect(approaching({ ...seen!, canSee: null, canReachMe: null }, 8)).toBe(true);
    const blaze = { ...seen!, name: 'blaze', canReachMe: true };
    expect(approaching({ ...blaze, canSee: false }, 8)).toBe(false);
    expect(approaching({ ...blaze, canSee: null }, 8)).toBe(false);
    expect(approaching({ ...blaze, canSee: true }, 8)).toBe(true);
    expect(approaching({ ...seen!, name: 'creeper', distance: 9.5, canSee: null }, 10)).toBe(true);
  });

  it('one that was not so when the request was built is new: its line has the id, the height and the sight', () => {
    const before = frame({ position: WORLD_AT, nearbyThreats: [] });
    const after = frame({ position: WORLD_AT, nearbyThreats: [skeleton] });
    const baseline = approachingIds(before, meters);
    expect(baseline.size).toBe(0);
    expect(newApproach(after, baseline, meters)).toBe('wither_skeleton #696 6.1m・上 6・見える（射線の中）');
    // Already so at the request: not new. Near but walled off at the request, then seeing her: new.
    expect(newApproach(after, approachingIds(after, meters), meters)).toBeNull();
    const hidden = frame({ position: WORLD_AT, nearbyThreats: [{ ...skeleton, canSee: false, canReachMe: false }] });
    expect(newApproach(after, approachingIds(hidden, meters), meters)).toBe('wither_skeleton #696 6.1m・上 6・見える（射線の中）');
    expect(frameThreatLine({ ...nearThreats(after)[0]!, canSee: false })).toBe('wither_skeleton #696 6.1m・上 6・道がある（回って来る）');
  });

  it('the plan\'s now by its title only', () => {
    expect(planNowTitle('[p1.2] 作業台と木のツルハシ＠195,66,60（済み: 板）（道: 出発の点検）')).toBe('[p1.2] 作業台と木のツルハシ');
    expect(planNowTitle(null)).toBeNull();
    expect(planNowTitle('p1.2 だけ')).toBeNull();
  });
});

describe('the short live state of an urgent decision (run 32: 696 tokens of answer in 10.3 s)', () => {
  const world = { position: WORLD_AT, health: 15.5, food: 16, dimension: 'the_nether', localMap: layersMap(FEET, bridgeAt),
    mapLandmarks: ['T 作業台 (250,55,77) 東1', 'F かまど (240,55,70) 西11', 'S スポナー (260,60,70) 東9'], recentStops: ['(1,2,3)→(4,5,6) 届かない ×2 30秒前'],
    inventory: [{ name: 'cobblestone', count: 64 }, { name: 'netherrack', count: 40 }, { name: 'cooked_mutton', count: 1 }],
    nearbyThreats: [{ id: 696, name: 'wither_skeleton', kind: 'hostile', distance: 6.1, position: at(256.5, 61, 76.5), canReachMe: true, canSee: true }],
    nearbyEntities: [{ id: 5, name: 'zombified_piglin', distance: 20, position: at(270, 55, 76) }] };

  it('keeps the urgent lines, the footing, the map, her state, the hostiles and what she holds; the rest waits for the next decision', () => {
    const short = minecraftLlmcUrgentLive({ observation: frame(world), elapsedMinutes: 5.4, events: ['反射が mc.act を止めた'], lastResults: ['act 1/2 済みで止まった'],
      urgent: ['wither_skeleton #696 6.1m・上 6・見える（射線の中）'], investigation: [], footing: '足場: 幅 1 の橋（落差 28、下は溶岩）。押されたら落ちる',
      planNowTitle: '[p1.2] 橋を西へ', answer: '急ぎの答え方: 短く' });
    expect(Object.keys(short)).toEqual(['urgent', 'planNow', 'footing', 'map', 'state', 'threats', 'inventory', 'events', 'lastResults', 'answer']);
    expect(short.threats).toHaveLength(1);
    expect((short.threats as string[])[0]).toMatch(/^#696 wither_skeleton 6\.1m \(256,61,76\)/u);
    expect(short.inventory).toEqual(['cobblestone×64', 'netherrack×40', 'cooked_mutton×1']);
    expect(short).not.toHaveProperty('landmarks');
    expect(short).not.toHaveProperty('stops');
    expect(short).not.toHaveProperty('near');
    const full = minecraftLlmcLive({ observation: frame(world), elapsedMinutes: 5.4, trend: createFoodTrend(), events: ['反射が mc.act を止めた'],
      lastResults: ['act 1/2 済みで止まった'], urgent: ['wither_skeleton #696 6.1m・上 6・見える（射線の中）'] });
    expect(Object.keys(full)).toEqual(expect.arrayContaining(['landmarks', 'stops', 'near', 'foodPoints']));
    expect(llmcTokens(JSON.stringify(short))).toBeLessThan(llmcTokens(JSON.stringify(full)));
  });

  it('the results shown this once are kept, to 2,400 characters, since they are not shown again', () => {
    const long = 'あ'.repeat(5_000);
    const short = minecraftLlmcUrgentLive({ observation: frame(world), elapsedMinutes: null, events: [], lastResults: [long], urgent: ['x'], investigation: [], footing: null,
      planNowTitle: null, answer: 'a' });
    expect(JSON.stringify(short.lastResults).length).toBeLessThan(2_500 + 40);
    expect(minecraftLlmcUrgentLive({ observation: null, elapsedMinutes: null, events: ['a', 'b', 'c', 'd'], urgent: ['x'], investigation: [], footing: null,
      planNowTitle: null, answer: 'a' })).toEqual({ connected: false, urgent: ['x'], events: ['b', 'c', 'd'], answer: 'a' });
  });
});

const NODES: PlanNode[] = [
  { id: 'p1', parentId: null, order: 0, title: '出発の点検（ネザーの奥へ）', state: 'continue' },
  { id: 'p1.2', parentId: 'p1', order: 1, title: '橋を西へ', state: 'continue', where: '225,55,76' },
];
const VIEW = { revision: 3, done: '0/26', path: ['出発の点検（ネザーの奥へ）'], now: 'p1.2 橋を西へ＠225,55,76', next: [], blocked: [] };
function lifecycle(world: () => Record<string, unknown>, answer: (input: ProbeInput) => string | null, taskId = 'r8-life') {
  const sent: ProbeInput[] = [], lines: string[] = [];
  const body = withLlmcBody({ start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
    toolSignal: (_name, parent) => parent, async close() {} },
  { llmc: { plan: () => ({ revision: 3, current: 'p1.2', nodes: NODES }) as never, planView: () => VIEW,
    planTree: () => ({ schema: 'shannon.plan-tree.v1', revision: 3, current: 'p1.2', nodes: NODES }) },
  taskId, createdAt: '2026-10-22T00:00:00Z', observe: () => frame(world()), arrival: () => ({ at: 1, kind: 'login' }), log: line => lines.push(line),
  r4: { probe: () => async input => { sent.push(input); return answer(input); }, planWhere: () => '225,55,76' } });
  return { body, sent, lines };
}
const COLUMN = JSON.stringify({ v: 1, kind: 'column', text: '下 28 段は空気（落差 28、底 y=26 lava）' });

describe('the lifecycle: the footing in the live state, a hostile that comes while the decision is awaited', () => {
  const quiet = { position: WORLD_AT, health: 20, food: 19, dimension: 'the_nether', localMap: layersMap(FEET, bridgeAt), nearbyThreats: [],
    inventory: [{ name: 'cobblestone', count: 64 }], mapLandmarks: ['T 作業台 (250,55,77) 東1'] };
  const skeleton = { id: 696, name: 'wither_skeleton', kind: 'hostile', distance: 6.1, position: at(256.5, 61, 76.5), canReachMe: true, canSee: true };

  it('asks the column probe for the two sides before the decision and puts the footing in the live state, before the map', async () => {
    const { body, sent, lines } = lifecycle(() => quiet, input => input.kind === 'column' ? COLUMN : null);
    expect(await body.investigate!(new AbortController().signal)).toBeNull();
    expect(sent.filter(input => input.kind === 'column')).toHaveLength(2);
    body.context();
    const live = body.transient!() as Record<string, unknown>;
    expect(live.footing).toBe('足場: 幅 1 の橋・両脇（北・南）とも空所（落差 28、下は溶岩）。押されたら落ちる');
    expect(Object.keys(live).indexOf('footing')).toBeLessThan(Object.keys(live).indexOf('map'));
    expect(lines.some(line => /^Shannon Minecraft footing task=r8-life gaps=6 asked=3 line=1 by=map ms=\d+$/u.test(line))).toBe(true);
  });

  it('a hostile that comes while the request is awaited: told once, the same decision\'s context again, the short state, its seconds in the log', async () => {
    let world: Record<string, unknown> = quiet;
    const { body, lines } = lifecycle(() => world, input => input.kind === 'column' ? COLUMN : null);
    await body.investigate!(new AbortController().signal);
    expect(body.urgent!()).toBe(false);
    body.context();
    const first = body.transient!() as Record<string, unknown>;
    expect(first).toHaveProperty('landmarks');
    expect(body.interrupt!()).toBeNull();
    world = { ...quiet, health: 18, nearbyThreats: [skeleton] };
    expect(body.interrupt!()).toBe('wither_skeleton #696 6.1m・上 6・見える（射線の中）');
    expect(body.interrupt!()).toBeNull();
    body.rebuilding!();
    body.context();
    const short = body.transient!() as { urgent: string[]; footing: string; planNow: string; answer: string };
    expect(Object.keys(short).slice(0, 3)).toEqual(['urgent', 'planNow', 'footing']);
    expect(short.urgent[0]).toBe('急ぎ: 判断を待つ間に wither_skeleton #696 6.1m・上 6・見える（射線の中）');
    expect(short.planNow).toBe('[p1.2] 橋を西へ');
    expect(short.footing).toContain('押されたら落ちる');
    expect(short.answer).toContain('急ぎの答え方');
    expect(short).not.toHaveProperty('landmarks');
    body.decided!({ ms: 4_200, aborted: true, thrownMs: 2_600 });
    expect(lines.find(line => line.startsWith('Shannon Minecraft urgent decision')))
      .toMatch(/^Shannon Minecraft urgent decision task=r8-life ms=4200 aborted=1 ctxTokens=\d+ thrownMs=2600$/u);
    // The next decision: nothing is urgent, the state is whole again, and a hostile that is already so at the request is no new one.
    world = { ...quiet, nearbyThreats: [skeleton] };
    body.context();
    expect(body.transient!()).toHaveProperty('landmarks');
    expect(body.interrupt!()).toBeNull();
  });

  it('what the first request showed once (the events, the results) is shown again by the one asked again, not lost', async () => {
    const { body } = lifecycle(() => quiet, () => null);
    body.noteResult!({ id: 'a', name: 'mc.act', input: { hands: [] } }, { ok: true, text: 'act 全部済み（1/1、1.0秒）' } as never, 1000);
    body.storedResult!({ id: 'a', name: 'mc.view', input: {} }, `地図\n${'x'.repeat(900)}`);
    await body.investigate!(new AbortController().signal);
    body.context();
    const first = body.transient!() as { lastResults?: string[] };
    expect(first.lastResults?.[0]).toContain('xxxx');
    body.interrupt!();
    body.rebuilding!();
    body.context();
    expect((body.transient!() as { lastResults?: string[] }).lastResults?.[0]).toContain('xxxx');
    // A new decision starts clean.
    body.context();
    expect((body.transient!() as { lastResults?: string[] }).lastResults).toBeUndefined();
  });

  it('an urgent step reads the short state; the seconds of its decision are logged with its tokens', async () => {
    const { body, lines } = lifecycle(() => ({ ...quiet, nearbyThreats: [skeleton] }), () => null);
    await body.investigate!(new AbortController().signal);
    expect(body.urgent!()).toBe(true);
    body.context();
    const state = body.transient!() as Record<string, unknown>;
    expect(Object.keys(state)[0]).toBe('urgent');
    expect(state).toHaveProperty('answer');
    body.decided!({ ms: 4_900, aborted: false, thrownMs: 0 });
    expect(lines.find(line => line.startsWith('Shannon Minecraft urgent decision'))).toMatch(/ms=4900 aborted=0 ctxTokens=\d+$/u);
    // A decision that was not urgent logs nothing.
    lines.length = 0;
    body.context();
    body.decided!({ ms: 6_000, aborted: false, thrownMs: 0 });
    expect(lines.filter(line => line.startsWith('Shannon Minecraft urgent decision'))).toEqual([]);
  });
});

describe('the knowledge and the first plan (r8)', () => {
  it('the appendix of the mode is r7\'s and r8\'s section: a gap crossed in the rock or by a walled bridge, never a bare one-wide bridge', () => {
    // r9 adds its section after r8's (the same bytes up to it).
    expect(LLMC_SYSTEM_APPENDIX_R8).toBe(`${LLMC_SYSTEM_APPENDIX_R7}\n\n${R8_KNOWLEDGE}`);
    for (const words of ['岩の中のトンネル', '両脇（足の高さ）に壁のブロックを置いた橋', '壁の無い幅 1 の橋は使わない', '落差 4 以上', '敵のいる構造物（要塞・砦の遺跡）',
      'body.footing', '押されたら落ちる', '近接の敵', 'まず空所から離れる', '敵との間にブロックを置く', '急ぎの判断', '考えは 2〜3 文', 'body.planNow']) {
      expect(R8_KNOWLEDGE).toContain(words);
    }

  });

  it('the first plan is asked to plan a gap in the rock or as a walled bridge, with the caution', () => {
    expect(FIRST_PLAN_SYSTEM_R8.startsWith(FIRST_PLAN_SYSTEM_R7)).toBe(true);
    for (const words of ['空所を渡る節（r8）', '岩の中のトンネル', '両脇の足の高さに壁を置いた橋', '壁の無い幅 1 の橋は、落差 4 以上', '橋は両脇に壁を置く', '橋の上で立ち止まらない']) {
      expect(FIRST_PLAN_SYSTEM_R8).toContain(words);
    }
  });
});

describe('the plan in the live state without what planNow repeats (r8)', () => {
  it('the live view leaves out the path and the now, keeps done, next, blocked and the rules; the body\'s view stays whole', () => {
    const tree = seedPlan('エンドラを討伐してください', 'the_nether')!;
    const compact = createFcaPlanTools({ taskId: 'r8-plan', checkpoint: { fcaPlanTree: tree }, rules: true, compact: true });
    const view = compact.port.view()!;
    expect(view.now).toBeTruthy();
    const live = planInput(compact.port).plan!;
    expect(live).not.toHaveProperty('path');
    expect(live).not.toHaveProperty('now');
    expect(Object.keys(live)).toEqual(expect.arrayContaining(['revision', 'done', 'next', 'blocked']));
    expect(live.rules).toEqual(view.rules);
    const whole = createFcaPlanTools({ taskId: 'r8-plan', checkpoint: { fcaPlanTree: tree }, rules: true });
    expect(planInput(whole.port).plan).toMatchObject({ now: view.now, path: view.path });
    expect(JSON.stringify(live).length).toBeLessThan(JSON.stringify(planInput(whole.port).plan).length);
  });
});
