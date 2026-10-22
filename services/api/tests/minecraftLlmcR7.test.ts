import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import type { PlanNode } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';
import type { ProbeInput } from '../src/contracts/minecraftProbeContract.js';
import { forgetLlmcEvents, urgentFacts, withLlmcBody } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { urgentWatch } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { toolFailure } from '../src/mind/tools/toolRegistryPorts.js';
import { forgetSurpriseWatches } from '../src/surfaces/minecraft/minecraftLlmcProbe.js';
import { forgetThreatSights, readThreatSight, threatLine, nearThreats } from '../src/surfaces/minecraft/minecraftLlmcThreat.js';
import { CHECK_FORBID, FIRST_PLAN_SYSTEM_R6, FIRST_PLAN_SYSTEM_R7, forgetFirstPlans, seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { foodFirstLine, foodLeads } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { forgetActNodes, noteActNode, tagActWhy } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import {
  BLAZE_KNOWLEDGE_R7, DRAGON_KNOWLEDGE, DRAGON_KNOWLEDGE_R7, LLMC_SYSTEM_APPENDIX, LLMC_SYSTEM_APPENDIX_R6, LLMC_SYSTEM_APPENDIX_R7,
  llmcSystemAppendix, R7_KNOWLEDGE,
} from '../src/surfaces/minecraft/minecraftKnowledge.js';
import { startGcWatch } from '../src/infra/observer/eventLoopWatch.js';
import { createBodyTaskRecall } from '../src/mind/recall/bodyTaskRecall.js';
import type { TaskMemory } from '../src/mind/memory/taskMemoryPorts.js';

/**
 * mb-llmc r7 (production runs 29–31, 2026-10-22: Sonnet twice and Opus once, from the same start under the blaze spawner, went for the
 * blazes at 10–13 s before the check; run 31 died in a corridor open to the blaze room, its health stop leaving it in the line; owner
 * 「作って走らせる」): the urgent line says whether a hostile reaches (the body's sight), the walled-off said after the plan's now; the check's
 * forbid; the blaze 「準備が済んでから」; the gate back read from a bare where and the food node said first; the Nether's moves and a stopIf
 * stop in the line; the share counted on the leaf; a collection's pause and the pool's searches named.
 */
afterEach(() => { forgetLlmcEvents(); forgetSurpriseWatches(); forgetFirstPlans(); forgetActNodes(); forgetThreatSights(); });

function frame(world: Record<string, unknown>): BodyObservation {
  return { schemaVersion: 1, bodyId: 'minecraft:s', sequence: 1, stateAt: '2026-10-22T00:00:00Z', receivedAt: '2026-10-22T00:00:00Z', connected: true,
    state: { world: world as never }, facts: { alive: true } };
}
const at = (x: number, y: number, z: number) => ({ x, y, z });
/** Runs 29–31's start: under the spawner, the blaze 4.0 m away and 6 up behind the bricks. */
const BLAZE = { id: 9, name: 'blaze', kind: 'hostile', distance: 4.0, position: at(308.5, 72.2, 73.5), canReachMe: true, canSee: false };
const START = { position: at(310.55, 66, 73.5), dimension: 'the_nether', health: 20, food: 19, localMap: '地図',
  inventory: [{ name: 'diamond_pickaxe', count: 1 }, { name: 'cooked_mutton', count: 1 }], nearbyThreats: [BLAZE], nearbyEntities: [BLAZE] };
const WALLED = JSON.stringify({ v: 1, kind: 'sight', text: 'blaze #9 (308,72,73)：見えない。間に固いブロック 3', visible: false, reach: false, distance: 4.6,
  between: [{ at: at(310, 68, 73), name: 'nether_bricks' }, { at: at(309, 69, 73), name: 'nether_bricks' }, { at: at(309, 70, 73), name: 'nether_bricks' }],
  target: { at: at(308, 72, 73), name: 'blaze' } });
const SEEN = JSON.stringify({ v: 1, kind: 'sight', text: 'blaze #9 (308,72,73)：見える', visible: true, reach: false, distance: 4.6, between: [],
  target: { at: at(308, 72, 73), name: 'blaze' } });

const VIEW = { revision: 3, done: '0/26', path: ['出発の点検（ネザーの奥へ）'], now: 'p1.1 歪んだ幹で作業台と棒＠195,66,60', next: [], blocked: [] };
const NODES: PlanNode[] = [
  { id: 'p1', parentId: null, order: 0, title: '出発の点検（ネザーの奥へ）', state: 'continue' },
  { id: 'p1.1', parentId: 'p1', order: 0, title: '歪んだ幹で作業台と棒', state: 'continue', where: '195,66,60' },
  { id: 'p1.5', parentId: 'p1', order: 4, title: 'ゲートから戻り狩って焼く', state: 'continue', where: '5,35,12', doneWhen: 'food>=100' },
  { id: 'p2', parentId: null, order: 1, title: 'ブレイズ', state: 'continue' },
];
function lifecycle(world: () => Record<string, unknown>, answer: (input: ProbeInput) => string | null, taskId = 'r7-life') {
  const sent: ProbeInput[] = [], lines: string[] = [];
  const body = withLlmcBody({ start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
    toolSignal: (_name, parent) => parent, async close() {} },
  { llmc: { plan: () => ({ revision: 3, current: 'p1.1', nodes: NODES }) as never, planView: () => VIEW,
    planTree: () => ({ schema: 'shannon.plan-tree.v1', revision: 3, current: 'p1.1', nodes: NODES }) },
  taskId, createdAt: '2026-10-22T00:00:00Z', observe: () => frame(world()), arrival: () => ({ at: 1, kind: 'login' }), log: line => lines.push(line),
  r4: { probe: () => async input => { sent.push(input); return answer(input); }, planWhere: () => '195,66,60' } });
  return { body, sent, lines };
}

describe('the urgent line says whether a hostile reaches, by the body\'s sight (runs 29–31: 「blaze 4.0m」 first at almost every step)', () => {
  it('a blaze behind the bricks: no urgent step, its line after the plan\'s now and the shortage, with what is between', async () => {
    const { body, sent, lines } = lifecycle(() => START, () => WALLED);
    expect(await body.investigate!(new AbortController().signal)).toBeNull();
    expect(sent).toEqual([{ kind: 'sight', target: '#9' }]);
    expect(body.urgent!()).toBe(false);
    body.context();
    const live = body.transient!() as Record<string, unknown>;
    expect(live).not.toHaveProperty('urgent');
    expect(Object.keys(live).slice(0, 3)).toEqual(['planNow', 'shortage', 'unreachable']);
    expect(live.unreachable).toEqual(['blaze #9 4.0m・上 6・壁の向こうで届かない（間に (310,68,73) nether_bricks ほか 2）']);
    expect(lines.some(line => /^Shannon Minecraft threat sight task=r7-life looked=1 asked=1 known=1 walled=1 inSight=0 afterStop=0 ms=\d+$/u.test(line)))
      .toBe(true);
    // The same blaze at the same place from the same feet is not asked again.
    await body.investigate!(new AbortController().signal);
    expect(sent).toHaveLength(1);
  });

  it('a blaze in sight: urgent, said with its id, height and 「見える（射線の中）」', async () => {
    const { body } = lifecycle(() => START, () => SEEN);
    await body.investigate!(new AbortController().signal);
    expect(body.urgent!()).toBe(true);
    body.context();
    // r10 (H5): a shooter in sight is said with the cell on the line to it, after the line r7 wrote.
    const urgent = (body.transient!() as { urgent: string[] }).urgent;
    expect(urgent).toHaveLength(1);
    expect(urgent[0]!.startsWith('blaze #9 4.0m・上 6・見える（射線の中）')).toBe(true);
    expect(urgent[0]).toMatch(/。線上のマス \(-?\d+,-?\d+,-?\d+\)/u);
  });

  it('no answer (no probe, or none in time): as r3 said it; a creeper is never walled off; a walker not in sight that can come is urgent', () => {
    const walled = new Map([[9, readThreatSight(WALLED)!]]);
    expect(urgentFacts(frame(START), null).reasons).toEqual(['blaze 4.0m']);
    expect(urgentFacts(frame(START), null, walled)).toEqual({ reasons: [],
      unreachable: ['blaze #9 4.0m・上 6・壁の向こうで届かない（間に (310,68,73) nether_bricks ほか 2）'] });
    const creeper = { ...BLAZE, name: 'creeper', distance: 5 };
    expect(urgentFacts(frame({ ...START, nearbyThreats: [creeper] }), null, walled).reasons[0]).toMatch(/^creeper #9 5\.0m・上 6・見えない/u);
    const zombie = { ...BLAZE, name: 'zombie', canReachMe: true };
    const [walker] = nearThreats(frame({ ...START, nearbyThreats: [zombie] }));
    expect(threatLine(walker!, readThreatSight(WALLED))).toBe('zombie #9 4.0m・上 6・見えない（間に (310,68,73) nether_bricks ほか 2）・道はある（回って来る）');
    expect(urgentFacts(frame({ ...START, nearbyThreats: [{ ...zombie, canReachMe: false }] }), null, walled).reasons).toEqual([]);
    expect(readThreatSight('ただの文')).toBeNull();
  });

  it('a shooter the frame says cannot see her does not cut an act (run 30: a blaze 5.6 m above cut the tunnel\'s digging); a walker does', async () => {
    let threats: unknown[] = [];
    const observe = () => frame({ ...START, nearbyThreats: threats });
    const blaze = { ...BLAZE, distance: 5.6, canSee: false };
    threats = [];
    const walledWatch = urgentWatch({ hands: [] }, observe, new AbortController().signal, 5, { walled: true });
    threats = [blaze];
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(walledWatch.reason()).toBeNull();
    walledWatch.stop();
    threats = [];
    const before = urgentWatch({ hands: [] }, observe, new AbortController().signal, 5);
    threats = [blaze];
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(before.reason()).toBe('blaze 5.6m');
    before.stop();
    threats = [];
    const seen = urgentWatch({ hands: [] }, observe, new AbortController().signal, 5, { walled: true });
    threats = [{ ...blaze, canSee: true }];
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(seen.reason()).toBe('blaze 5.6m');
    seen.stop();
  });

  it('low health beside a walled-off blaze is no urgent step either', () => {
    const walled = new Map([[9, readThreatSight(WALLED)!]]);
    expect(urgentFacts(frame({ ...START, health: 6 }), null).reasons).toEqual(['blaze 4.0m', '体力 6 で敵が近い']);
    expect(urgentFacts(frame({ ...START, health: 6 }), null, walled).reasons).toEqual([]);
  });
});

describe('a stopIf stop in the line of a blaze (run 31: the health stop at 8.7 left her standing in the corridor, burning)', () => {
  const corridor = { ...START, position: at(295.5, 67, 71.5), health: 8.7, food: 17,
    nearbyThreats: [{ ...BLAZE, distance: 12.4, position: at(300.5, 70, 80.5) }] };
  const stopped = 'act 2/3 済みで止まった（stopIf: hpBelow:8.7）\n1 dig 済 netherrack を掘った\n2 walk 止 stopIf: hpBelow:8.7\n3 walk 未 未実行\n今 (295,67,71) 体力8.7 満腹17';

  it('the next step is urgent, looks at the shooters within 16 m, and says first that one sees her where she stopped', async () => {
    const { body, sent } = lifecycle(() => corridor, () => SEEN, 'r7-stop');
    body.noteResult!({ id: 'a', name: MC_ACT_TOOL, input: { hands: [{ do: 'walk', to: at(280, 67, 71) }], stopIf: { hpBelow: 9 } } },
      toolFailure('failed', stopped, { retryable: true }), 1000);
    await body.investigate!(new AbortController().signal);
    expect(sent).toContainEqual({ kind: 'sight', target: '#9' });
    expect(body.urgent!()).toBe(true);
    body.context();
    const live = body.transient!() as { urgent: string[] };
    expect(Object.keys(live)[0]).toBe('urgent');
    expect(live.urgent[0]).toBe('今いる所は blaze #9 から見える（射線の中・12.4m・上 3）');
    expect(live.urgent).toContain('前の act は stopIf（体力）で止まった');
  });

  it('without the probe a health stop is not urgent (as r6); a hostile stop is, as before', () => {
    const plain = withLlmcBody({ start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
      toolSignal: (_name, parent) => parent, async close() {} },
    { llmc: { plan: () => undefined, planView: () => null }, taskId: 'r7-off', createdAt: '2026-10-22T00:00:00Z', observe: () => frame({ ...corridor, nearbyThreats: [] }),
      arrival: () => ({ at: 1, kind: 'login' }), log: () => {} });
    plain.noteResult!({ id: 'a', name: MC_ACT_TOOL, input: {} }, toolFailure('failed', stopped, { retryable: true }), 1000);
    expect(plain.urgent!()).toBe(false);
    plain.noteResult!({ id: 'b', name: MC_ACT_TOOL, input: {} }, toolFailure('failed', 'act 0/1 済みで止まった（stopIf: hostileWithin:blaze #9 7.0m）', { retryable: true }), 1000);
    expect(plain.urgent!()).toBe(true);
  });
});

describe('the check forbids the fight before it is done (runs 30, 31: the only forbid was 「スポナーを掘らない」)', () => {
  it('the first plan is asked to write it on the check, and the seed carries it', () => {
    expect(FIRST_PLAN_SYSTEM_R7).toContain(`forbid に「${CHECK_FORBID}」を書く`);
    expect(FIRST_PLAN_SYSTEM_R7).toContain('1 段下の岩（ネザーラック）にトンネル');
    expect(FIRST_PLAN_SYSTEM_R7).toContain(BLAZE_KNOWLEDGE_R7);
    expect(FIRST_PLAN_SYSTEM_R7.startsWith(FIRST_PLAN_SYSTEM_R6.replace(DRAGON_KNOWLEDGE, () => DRAGON_KNOWLEDGE_R7))).toBe(true);
    expect(CHECK_FORBID.length).toBeLessThanOrEqual(80);
    const seed = seedPlan('エンドラを討伐してください', 'the_nether')!;
    expect(seed.nodes.find(node => node.title === '出発の点検（ネザーの奥へ）')!.forbid).toEqual([CHECK_FORBID]);
  });
});

describe('the knowledge (r7)', () => {
  it('the blaze says 「準備が済んでから」 before the fight\'s hands; r3\'s appendix is as it was', () => {
    // r8 adds its own section after r7's (minecraftLlmcR8.test.ts): the mode with the probe on reads r8's.
    expect(llmcSystemAppendix(true).startsWith(LLMC_SYSTEM_APPENDIX_R7)).toBe(true);
    expect(llmcSystemAppendix(false)).toBe(LLMC_SYSTEM_APPENDIX);
    expect(LLMC_SYSTEM_APPENDIX).toContain('## ブレイズ\n- ブレイズロッド 7 本以上');
    expect(LLMC_SYSTEM_APPENDIX_R7).not.toContain('## ブレイズ\n');
    expect(LLMC_SYSTEM_APPENDIX_R7).toBe(`${LLMC_SYSTEM_APPENDIX_R6.replace(DRAGON_KNOWLEDGE, () => DRAGON_KNOWLEDGE_R7)}\n\n${R7_KNOWLEDGE}`);
    const blaze = LLMC_SYSTEM_APPENDIX_R7.indexOf('## ブレイズ（準備が済んでから戦う）');
    expect(blaze).toBeGreaterThan(0);
    expect(LLMC_SYSTEM_APPENDIX_R7.indexOf('戦うのは「出発の点検」')).toBeLessThan(LLMC_SYSTEM_APPENDIX_R7.indexOf('準備が済んだら、待ち場'));
    expect(LLMC_SYSTEM_APPENDIX_R7.indexOf('準備が済んだら、待ち場')).toBeLessThan(LLMC_SYSTEM_APPENDIX_R7.indexOf('attack(target=blaze, hold=true'));
  });

  it('the Nether\'s moves (a tunnel in the rock below the corridors), the walled-off, and a stopIf stop in the line', () => {
    for (const words of ['body.unreachable', '壁の向こうで届かない', '急ぎを理由にブレイズを打ちに行かない', '要塞の通路（ネザーレンガの床・橋・階段）を歩かない',
      '1 段以上下のネザーラック', 'トンネル', '射線の中（ブレイズから見える所）では立ち止まらない', '水バケツで火を消せない',
      'stopIf（hpBelow・hostileWithin）で止まった次の判断は急ぎ', '今いる所は blaze #n から見える（射線の中）', 'まず見えない所へ']) {
      expect(R7_KNOWLEDGE).toContain(words);
    }
  });
});

describe('the gate back from a bare where, and the food node said first (run 30: p1.5 「ゲートから戻り狩って焼く」 where 5,35,12)', () => {
  const shaft = { position: at(310.67, 58, 73.5), dimension: 'the_nether', health: 10.1, food: 17, inventory: [{ name: 'netherrack', count: 40 }] };

  it('the gate back is read from 「5,35,12」 as from 「(5,35,12)」', () => {
    expect(foodLeads(shaft, 'the_nether', NODES)).toContain('帰りのゲート (5,35,12) 約 312m（計画 p1.5 の where）');
  });

  it('no food and health that does not come back: the plan\'s food node before its now; none when the food node is the current one', () => {
    expect(foodFirstLine(NODES, 'p1.1', at(310.67, 58, 73.5))).toBe('回復が先: 食料の節 [p1.5] ゲートから戻り狩って焼く＠5,35,12（約 312m）');
    expect(foodFirstLine(NODES, 'p1.5', null)).toBeNull();
    expect(foodFirstLine(NODES.filter(node => node.id !== 'p1.5'), 'p1.1', null)).toBeNull();
    const { body } = lifecycle(() => ({ ...shaft, nearbyThreats: [] }), () => null, 'r7-food');
    body.context();
    const live = body.transient!() as { planNow: string; recovery: string[] };
    expect(live.planNow).toBe('回復が先: 食料の節 [p1.5] ゲートから戻り狩って焼く＠5,35,12（約 312m）。その後に今の節 [p1.1] 歪んだ幹で作業台と棒＠195,66,60'
      + '（道: 出発の点検（ネザーの奥へ））');
    expect(live.recovery[1]).toContain('帰りのゲート (5,35,12)');
    // With food in the pack the plan's now is as it is.
    const fed = lifecycle(() => ({ ...shaft, nearbyThreats: [], inventory: [{ name: 'cooked_beef', count: 2 }] }), () => null, 'r7-fed').body;
    fed.context();
    expect((fed.transient!() as { planNow: string }).planNow).toMatch(/^\[p1\.1\]/u);
  });
});

describe('the share counts the leaf (runs 30, 31: a parent\'s tag and a reason of another node\'s were counted on)', () => {
  const plan = { revision: 3, current: 'p1.1', nodes: [{ id: 'p1', parentId: null, title: '出発の点検', state: 'continue' as const },
    { id: 'p1.1', parentId: 'p1', title: '歪んだ幹', state: 'continue' as const }, { id: 'p1.1.1', parentId: 'p1.1', title: '幹', state: 'continue' as const },
    { id: 'p2.1', parentId: null, title: 'ブレイズ', state: 'continue' as const }] };
  const act = (why: string) => ({ hands: [{ do: 'wait', seconds: 1 }], why });

  it('a parent\'s tag is not on (counted apart), nor the current node\'s with 「理由:」; the leaf and its child are', () => {
    expect(tagActWhy(act('[p1] 穴越しにブレイズを打つ'), plan).mark).toMatchObject({ on: false, parent: true, reason: false });
    expect(tagActWhy(act('[p1.1] 理由: 食料0で体力が戻らない。ゲートへ戻る'), plan).mark).toMatchObject({ on: false, reason: true });
    expect(tagActWhy(act('[p1.1] 幹を掘る'), plan).mark).toMatchObject({ on: true, reason: false });
    expect(tagActWhy(act('[p1.1.1] 幹'), plan).mark).toMatchObject({ on: true });
    const lines: string[] = [];
    for (const why of ['[p1] ブレイズ', '[p1.1] 理由: 食料', '[p1.1] 幹', '[急ぎ] 離れる']) noteActNode('r7-acts', tagActWhy(act(why), plan).mark, line => lines.push(line));
    expect(lines.at(-1)).toBe('Shannon Minecraft act node task=r7-acts node=急ぎ current=p1.1 by=model on=0 reason=0 acts=4 onPlan=1 off=1 offReason=1'
      + ' urgent=1 head=0 parent=1 share=0.25');
  });
});

describe('the API\'s blocks named (run 31: six blocks, 7.7 s; the three at 10:51:55–52:00 were the body recall\'s first pool)', () => {
  it('a collection\'s pause of 100 ms or more is one content-free line', () => {
    const lines: string[] = [];
    let each: ((entry: { duration: number; detail?: unknown }) => void) | null = null;
    const stop = startGcWatch('api', { log: line => lines.push(line), heapMb: () => 412, observe: fn => { each = fn; return () => { each = null; }; } });
    each!({ duration: 1367.4, detail: { kind: 2 } });
    each!({ duration: 40, detail: { kind: 1 } });
    expect(lines).toEqual(['Shannon gc pause process=api kind=major ms=1367 heapMb=412']);
    stop();
    expect(each).toBeNull();
  });

  it('the pool\'s three searches are each timed in the measure', async () => {
    let now = 0;
    const memory: TaskMemory = { available: () => true, search() { now += 700; return []; }, read: () => [], sources: () => [],
      async execute() { throw new Error('unused'); } };
    const recall = createBodyTaskRecall({ memory, state: { snapshot: () => ({}) as never }, clock: () => now });
    const { measure } = await recall.packet({ scopeKey: 'owner', taskId: 't', goal: 'エンドラ', cues: { words: [], tags: [] }, present: OWNER_AUDIENCE });
    expect(measure.searchMs).toEqual([700, 700, 700]);
    expect(measure.poolMs).toBe(2100);
  });
});
