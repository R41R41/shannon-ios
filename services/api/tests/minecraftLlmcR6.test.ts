import { afterEach, describe, expect, it } from 'vitest';
import { planPath, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';
import { createFcaPlanTools } from '../src/mind/action/fca/fcaPlanTools.js';
import { forgetLlmcEvents, noteCautions, withLlmcBody } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { createSurpriseWatch, forgetSurpriseWatches, stepProbes, surpriseFrame } from '../src/surfaces/minecraft/minecraftLlmcProbe.js';
import { seenDoneUpdate } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import {
  carryDone, FIRST_PLAN_SYSTEM_R5, FIRST_PLAN_SYSTEM_R6, firstPlanInbox, firstPlanInput, forgetFirstPlans, planFromAnswer, seedPlan, startFirstPlan,
} from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { foodLeads, LOW_HEALTH_COST, preparationShortage, readinessOf, recoveryLine } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
/** Run 42: the fact, what to eat from the pack (none here) and what going on without it cost. */
const NO_RECOVERY = '体力 3.7/20 は自然に戻らない（満腹 17＜18、食料 0 点）';
const NO_RECOVERY_LIVE = `${NO_RECOVERY}。持ち物に食べ物が無い。食料の当てで取る。${LOW_HEALTH_COST}`;
import { forgetActNodes, noteActNode, planNowLine, tagActWhy } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { LLMC_SYSTEM_APPENDIX, LLMC_SYSTEM_APPENDIX_R5, LLMC_SYSTEM_APPENDIX_R6, R6_KNOWLEDGE } from '../src/surfaces/minecraft/minecraftKnowledge.js';

/**
 * mb-llmc r6 (production run 29, 2026-10-22, Sonnet main, r5: begun inside a Nether fortress, the blazes at 10 s past the plan's "now",
 * health 3.7 with no food at hunger 17, 325 s of waits, stopped by its third fca_wait; owner 「r6 を作り 2 モデルで比べる」): the seed and
 * the first plan begin where she is, the code says what the place lacks and that health does not come back, the first plan's done nodes
 * carried by the frame, a second miss noted, and an act that names its node. The wait in the runner: fcaLlmcR6Step.test.ts.
 */
afterEach(() => { forgetLlmcEvents(); forgetSurpriseWatches(); forgetFirstPlans(); forgetActNodes(); });

function frame(world: Record<string, unknown>): BodyObservation {
  return { schemaVersion: 1, bodyId: 'minecraft:s', sequence: 1, stateAt: '2026-10-22T00:00:00Z', receivedAt: '2026-10-22T00:00:00Z', connected: true,
    state: { world: world as never }, facts: { alive: true } };
}
const at = (x: number, y: number, z: number) => ({ x, y, z });
const IRON = '頭: iron_helmet(残り160)、胴: iron_chestplate(残り235)、脚: iron_leggings(残り220)、足: iron_boots(残り190)';
/** Run 29's start (RCON): the fortress, health 20, hunger 19, one cooked mutton, no table, slabs or shield. */
const START = { position: at(310.55, 66, 73.5), dimension: 'the_nether', health: 20, food: 19, worn: IRON,
  inventory: [{ name: 'diamond_pickaxe', count: 1 }, { name: 'iron_sword', count: 1 }, { name: 'water_bucket', count: 1 },
    { name: 'cooked_mutton', count: 1 }, { name: 'gold_nugget', count: 11 }] };
/** Run 29 at 458 s: in the sealed shaft, health 3.7, hunger 17, no food; blocks enough, one rod. */
const SHAFT = { position: at(310.67, 52, 73.5), dimension: 'the_nether', health: 3.7, food: 17, worn: IRON,
  inventory: [{ name: 'diamond_pickaxe', count: 1 }, { name: 'iron_sword', count: 1 }, { name: 'cobbled_deepslate', count: 84 },
    { name: 'netherrack', count: 143 }, { name: 'blaze_rod', count: 1 }, { name: 'gold_nugget', count: 11 }] };
const GOAL = 'エンドラを討伐してください';

describe('the seed begins where she is (run 29: begun in the Nether, "now" was 「村を回る」 until the strong model\'s plan)', () => {
  it('a dragon\'s task begun in the Nether starts at the check before going deeper; the overworld\'s seed is as it was', () => {
    for (const dimension of ['the_nether', 'minecraft:the_nether']) {
      const tree = seedPlan(GOAL, dimension)!;
      expect(planPath(tree).now).toMatch(/^p1\.1 ネザーの幹で作業台/u);
      expect(tree.nodes.find(node => node.id === 'p1')!.title).toBe('出発の点検（ネザーの奥へ）');
      expect(tree.nodes.some(node => /村を回る|木と石の道具/u.test(node.title))).toBe(false);
    }
    expect(planPath(seedPlan(GOAL, 'the_end')!).now).toMatch(/エンドでドラゴン|クリスタル/u);
    expect(seedPlan(GOAL, 'overworld')).toEqual(seedPlan(GOAL));
    expect(planPath(seedPlan(GOAL)!).now).toMatch(/^p1\.1 原木を集める/u);
  });

  it('the first decision\'s seed is the Nether\'s when the body is there', () => {
    const held: PlanTree = { schema: 'shannon.plan-tree.v1', revision: 0, current: null, nodes: [] };
    startFirstPlan({ taskId: 'r6-seed', goal: GOAL, held, world: START, log: () => {} });
    const seeded = firstPlanInbox.take('r6-seed', held)!;
    expect(seeded.tree.nodes[0]!.title).toBe('出発の点検（ネザーの奥へ）');
  });
});

describe('the first plan is told the place and what it lacks (run 29: 28 nodes, no food before the blazes)', () => {
  it('the input says the shortage and the food in points; r6\'s words follow r5\'s', async () => {
    const input = firstPlanInput(GOAL, START, { scan: true, readiness: true });
    expect(input).toContain('ディメンション: the_nether');
    expect(input).toContain('着ている物: 頭: iron_helmet');
    expect(input).toContain('食料: 15.6 点');
    expect(input).toContain('準備の不足（ネザーの奥へ）: 作業台・ハーフブロック・盾・金の防具・足場のブロックが無い。食料 15.6 点（目安 100）');
    expect(firstPlanInput(GOAL, START, { scan: true })).not.toContain('準備の不足');
    expect(FIRST_PLAN_SYSTEM_R6.startsWith(FIRST_PLAN_SYSTEM_R5)).toBe(true);
    for (const words of ['今いる所から始める', '準備の不足', '出発の点検', '食料を含む', 'ホグリン']) expect(FIRST_PLAN_SYSTEM_R6).toContain(words);
    const asked: Array<[string, string]> = [];
    startFirstPlan({ taskId: 'r6-plan', goal: GOAL, held: { schema: 'shannon.plan-tree.v1', revision: 0, current: null, nodes: [] },
      world: { ...START, scan: { at: 't', text: '走査', rows: [] } }, log: () => {},
      planner: async (system, text) => { asked.push([system, text]); return { nodes: [] }; },
      r4: { world: () => ({ ...START, scan: { at: 't', text: '走査', rows: [] } }), system: FIRST_PLAN_SYSTEM_R6, readiness: true } });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(asked[0]![0]).toBe(FIRST_PLAN_SYSTEM_R6);
    expect(asked[0]![1]).toContain('準備の不足（ネザーの奥へ）');
  });
});

describe('the shortage, the recovery and where food is: facts of the code', () => {
  const counts = (world: Record<string, unknown>) => readinessOf(frame(world))!;

  it('the Nether\'s check against the pack, in one line: none, short, food', () => {
    const shaft = counts(SHAFT);
    expect(preparationShortage({ ...shaft, nowTitle: null })).toBe('準備の不足（ネザーの奥へ）: 作業台・ハーフブロック・盾・金の防具が無い。食料 0 点（目安 100）');
    const some = counts({ ...SHAFT, inventory: [...SHAFT.inventory, { name: 'crafting_table', count: 1 }, { name: 'cobbled_deepslate_slab', count: 6 },
      { name: 'shield', count: 1 }, { name: 'cooked_porkchop', count: 5 }] });
    expect(preparationShortage({ ...some, nowTitle: null })).toBe('準備の不足（ネザーの奥へ）: 金の防具が無い。ハーフブロック 6/12');
    const ready = counts({ ...SHAFT, inventory: [...SHAFT.inventory, { name: 'blaze_rod', count: 6 }, { name: 'ender_pearl', count: 12 }] });
    expect(preparationShortage({ ...ready, nowTitle: null })).toBeNull();
  });

  it('in the overworld only by the current node: the gate\'s check before the Nether, the End\'s with eyes', () => {
    const home = counts({ ...START, dimension: 'overworld' });
    expect(preparationShortage({ ...home, nowTitle: '原木を集める' })).toBeNull();
    expect(preparationShortage({ ...home, nowTitle: 'ゲートを組んで火をつける' }))
      .toBe('準備の不足（ネザーに入る前）: 盾・金のブーツ・足場のブロックが無い。食料 15.6 点（目安 40）');
    expect(preparationShortage({ ...home, nowTitle: '2地点で投げて三角測量' })).toMatch(/^準備の不足（エンドへ）: ベッド・弓・矢・エンダーアイ・足場のブロックが無い/u);
  });

  it('health does not come back under hunger 18: said as the fact, never at 18 or at full health', () => {
    expect(recoveryLine(17, 3.7, 0)).toBe(`${NO_RECOVERY}。${LOW_HEALTH_COST}`);
    expect(recoveryLine(18, 3.7, 0)).toBeNull();
    expect(recoveryLine(17, 20, 0)).toBeNull();
  });

  it('where food is: animals near, the scan\'s village and crimson rows, the gate back from the plan\'s where', () => {
    const nodes = [{ id: 'p4', parentId: null, order: 3, title: '帰りのゲートでオーバーワールドへ', state: 'continue' as const, where: '(5,35,12)' }];
    expect(foodLeads(SHAFT, 'the_nether', nodes))
      .toBe('食料の当て: 近くに動物・村・畑は見えていない・ホグリン・真紅の森は見えていない・帰りのゲート (5,35,12) 約 312m（計画 p4 の where）');
    const near = { ...SHAFT, nearbyEntities: [{ id: 31, name: 'hoglin', distance: 24.2, position: at(330, 52, 80) }],
      scan: { at: 't', dimension: 'the_nether', text: '走査', rows: ['範囲 読み込み 353 チャンク', 'ネザーの幹 crimson_stem ×80 最寄り (200,70,60) 西 112m'] } };
    expect(foodLeads(near, 'the_nether', nodes)).toBe('食料の当て: #31 hoglin 24m・ネザーの幹 crimson_stem ×80 最寄り (200,70,60) 西 112m'
      + '・帰りのゲート (5,35,12) 約 312m（計画 p4 の where）');
    const village = { position: at(0, 64, 0), nearbyEntities: [{ id: 2, name: 'cow', distance: 9 }, { id: 3, name: 'zombie', distance: 4 }],
      scan: { at: 't', dimension: 'overworld', text: '走査', rows: ['村の鐘 最寄り (40,64,10) 東 41m', '原木 oak ×20 最寄り (3,64,3) 北 4m'] } };
    expect(foodLeads(village, 'overworld')).toBe('食料の当て: #2 cow 9m・村の鐘 最寄り (40,64,10) 東 41m');
  });
});

describe('the live state shows the plan\'s now, the shortage and the recovery just before the map (with the probe)', () => {
  const view = { revision: 3, done: '2/28', path: ['出発の点検（ネザーの奥へ）'], now: 'p1.1 作業台と板を作る＠(296,66,70)（済み: have:crafting_table）',
    next: [], blocked: [] };
  const display = { revision: 3, current: 'p1.1', nodes: [{ id: 'p1', parentId: null, title: '出発の点検（ネザーの奥へ）', state: 'continue' as const },
    { id: 'p1.1', parentId: 'p1', title: '作業台と板を作る', state: 'continue' as const }] };
  const body = (world: Record<string, unknown>) => withLlmcBody({ start() {}, revision: () => 0,
    context: () => ({ revision: 0, observation: null }), async guard() { return true; }, toolSignal: (_name, parent) => parent, async close() {} },
  { llmc: { plan: () => display as never, planView: () => view, planTree: () => ({ schema: 'shannon.plan-tree.v1', revision: 3, current: 'p1.1', nodes: [
    { id: 'p4', parentId: null, order: 3, title: 'ゲートでオーバーワールドへ', state: 'continue', where: '(5,35,12)' }] }) },
  taskId: 'r6-live', createdAt: '2026-10-22T00:00:00Z', observe: () => frame({ ...world, localMap: '地図' }),
  arrival: () => ({ at: 1, kind: 'login' }), log: () => {}, r4: { probe: () => null, planWhere: () => null } });

  it('in this order, counted and never cut', () => {
    const shaft = body(SHAFT);
    shaft.context();
    const live = shaft.transient!() as Record<string, unknown>;
    const keys = Object.keys(live);
    expect(keys.slice(0, 4)).toEqual(['planNow', 'shortage', 'recovery', 'map']);
    expect(live.planNow).toBe('[p1.1] 作業台と板を作る＠(296,66,70)（済み: have:crafting_table）（道: 出発の点検（ネザーの奥へ））');
    expect(live.shortage).toBe('準備の不足（ネザーの奥へ）: 作業台・ハーフブロック・盾・金の防具が無い。食料 0 点（目安 100）');
    expect(live.recovery).toEqual([NO_RECOVERY_LIVE,
      '食料の当て: 近くに動物・村・畑は見えていない・ホグリン・真紅の森は見えていない・帰りのゲート (5,35,12) 約 312m（計画 p4 の where）']);
  });

  it('a wait\'s result says health does not come back; not at hunger 18 or more, not for an act without a wait', () => {
    const shaft = body(SHAFT);
    const wait = { id: 'w', name: MC_ACT_TOOL, input: { hands: [{ do: 'wait', seconds: 30 }] } };
    expect(shaft.storedResult!(wait, 'act 全部済み（1/1、30.0秒）\n1 wait 済 30秒待った'))
      .toBe(`act 全部済み（1/1、30.0秒）\n1 wait 済 30秒待った\n頭: ${NO_RECOVERY_LIVE}`);
    expect(shaft.storedResult!({ ...wait, input: { hands: [{ do: 'walk', to: at(1, 2, 3) }] } }, 'act 全部済み')).toBe('act 全部済み');
    expect(body({ ...SHAFT, food: 19 }).storedResult!(wait, 'act 全部済み')).toBe('act 全部済み');
  });
});

describe('the first plan\'s done nodes are carried by the frame (run 29: 「動物を狩り肉を焼く」 food>=100 came in done at 15.6 points)', () => {
  it('a predicate node is never carried by its words; a node in free words is, by its title', () => {
    const held = seedPlan(GOAL)!;
    // Run 29: the parent 「黒曜石10とゲート」 seen done in the Nether closed its child 「食料100点以上に足す」 (food>=100) with it. r9: it does not
    // (a node is done by its own predicate); the model's own `done` on that child is what the plan then carries over, as below.
    const nether = frame(START);
    const seen = seenDoneUpdate(held, nether)!;
    const plan = createFcaPlanTools({ taskId: 'r6-carry-held', checkpoint: { fcaPlanTree: held }, seen: tree => seenDoneUpdate(tree, nether) });
    plan.port.view();
    const seenTree = plan.port.tree();
    expect(seen.ids.length).toBeGreaterThan(0);
    expect(seenTree.nodes.find(node => node.doneWhen === 'food>=100')!.state).toBe('continue');
    const settled = { ...seenTree, nodes: seenTree.nodes.map(node => node.doneWhen === 'food>=100' ? { ...node, state: 'done' as const } : node) };
    const answer = planFromAnswer({ nodes: [
      { id: 'p1', parent: '', title: '出発の点検', where: '', doneWhen: '' },
      { id: 'p1.1', parent: 'p1', title: '作業台と板を作る', where: '', doneWhen: 'have:crafting_table' },
      { id: 'p5', parent: '', title: 'オーバーワールドで準備', where: '', doneWhen: '' },
      { id: 'p5.1', parent: 'p5', title: '動物を狩り肉を焼く', where: '', doneWhen: 'food>=100' },
      { id: 'p5.2', parent: 'p5', title: '村を回る（ベッド1〜2・干し草・畑・箱）', where: '', doneWhen: '' }] })!;
    const freeDone = { ...settled, nodes: settled.nodes.map(node => /村を回る/u.test(node.title) ? { ...node, state: 'done' as const } : node) };
    const carried = carryDone(freeDone, answer);
    expect(carried.nodes.find(node => node.id === 'p5.1')!.state).toBe('continue');
    expect(carried.nodes.find(node => node.id === 'p5.2')!.state).toBe('done');
    // Read with the frame: food 15.6 points, so 「動物を狩り肉を焼く」 stays open.
    const next = createFcaPlanTools({ taskId: 'r6-carry-next', checkpoint: { fcaPlanTree: carried }, seen: tree => seenDoneUpdate(tree, nether) });
    next.port.view();
    expect(next.port.tree().nodes.find(node => node.id === 'p5.1')!.state).toBe('continue');
  });
});

describe('a miss is counted as every other surprise (run 29: two misses, the second never noted)', () => {
  const ctx = (health = 20) => surpriseFrame(frame({ position: at(310.5, 61, 73.5), health, dimension: 'the_nether' }), 1);
  const swing = 'act 全部済み（1/1、20.0秒）\n1 attack 済 blaze を 20秒攻撃した（9回振って 0回当たった）（20.1秒）';
  const sight = JSON.stringify({ v: 1, kind: 'sight', text: 'blaze #9 (308,69,73)：見えない。間に固いブロック 4', visible: false, reach: false, distance: 4.8,
    between: [{ at: at(310, 66, 73), name: 'cobbled_deepslate' }], target: { at: at(308, 69, 73), name: 'blaze' } });

  it('the second miss has nth 2 and notes the sight\'s fact', () => {
    const watch = createSurpriseWatch('r6-miss');
    watch.detect(ctx(), null);
    watch.noteResult(MC_ACT_TOOL, true, swing, { hands: [{ do: 'attack', target: '#9', hold: true, seconds: 20 }], accept: ['blaze'] });
    const [first] = watch.detect(ctx(), null);
    expect(first).toMatchObject({ code: 'miss', nth: 1, hand: { do: 'attack' } });
    for (let step = 0; step < 3; step++) watch.detect(ctx(), null);
    watch.noteResult(MC_ACT_TOOL, true, swing, { hands: [{ do: 'attack', target: '#9', hold: true, seconds: 20 }], accept: ['blaze'] });
    const [second] = watch.detect(ctx(), null);
    expect(second).toMatchObject({ code: 'miss', nth: 2 });
    const noted: string[] = [];
    expect(noteCautions([second!], second!.probes, [sight, null], text => { noted.push(text); return true; })).toBe(1);
    expect(noted).toEqual(['(308,69,73) の blaze は見えない: 間に cobbled_deepslate (310,66,73)']);
  });

  it('a hold with no target, stopped by the body\'s r6 「届かない」: the nearest it names is looked at (r4-contract.md 10:05)', () => {
    const watch = createSurpriseWatch('r6-miss-hold');
    watch.detect(ctx(), null);
    const line = 'act 0/1 済みで止まった（failure）\n1 attack 止 届かない: 8秒、打てる所（目から3m・見える）にblazeがいない。0回打った・0回当たった・倒した 0・受けた傷 6.5。'
      + '最寄り blaze #9 (308,69,73) 西2・上6・目から4.8m・見えない：間に (310,66,73) cobbled_deepslate ほか 3';
    watch.noteResult(MC_ACT_TOOL, false, line, { hands: [{ do: 'attack', hold: true, seconds: 30 }], accept: ['blaze'] });
    const [miss] = watch.detect(ctx(), null);
    expect(miss).toMatchObject({ code: 'miss', nth: 1, probes: [{ kind: 'sight', target: '#9' }, { kind: 'around' }] });
  });

  it('beside a health surprise the miss\'s sight is still sent (each surprise\'s first probe first)', () => {
    const watch = createSurpriseWatch('r6-miss-health');
    watch.detect(ctx(16.7), null);
    watch.noteResult(MC_ACT_TOOL, true, swing, { hands: [{ do: 'attack', target: '#9', hold: true, seconds: 20 }] });
    const surprises = watch.detect(ctx(10.2 - 1), null);
    expect(surprises.map(item => item.code)).toEqual(['health', 'miss']);
    expect(stepProbes(surprises)).toEqual([{ kind: 'around', radius: 8 }, { kind: 'sight', target: '#9' }]);
  });
});

describe('an act names the plan node it is for (a hypothesis, measured by the share on the plan)', () => {
  const plan = { revision: 3, current: 'p1.1', nodes: [{ id: 'p1', parentId: null, title: '出発の点検', state: 'continue' as const },
    { id: 'p1.1', parentId: 'p1', title: '作業台と板を作る', state: 'continue' as const }, { id: 'p1.1.1', parentId: 'p1.1', title: '幹', state: 'continue' as const },
    { id: 'p2.1', parentId: null, title: 'ブレイズ', state: 'continue' as const }] };
  const act = (why?: string) => ({ hands: [{ do: 'wait', seconds: 1 }], ...(why !== undefined ? { why } : {}) });

  it('a why without a tag gets the current node first (a fix said); a tag of the model is kept and read', () => {
    const none = tagActWhy(act('ブレイズを倒す'), plan);
    expect((none.input as { why: string }).why).toBe('[p1.1] ブレイズを倒す');
    expect(none.fix).toBe('why に今の節 [p1.1] を付けた');
    expect(none.mark).toMatchObject({ node: 'p1.1', by: 'head', on: true });
    expect((tagActWhy(act(), plan).input as { why: string }).why).toBe('[p1.1]');
    expect((tagActWhy(act('x'.repeat(120)), plan).input as { why: string }).why).toHaveLength(120);
    expect(tagActWhy(act('[p1.1.1] 幹を掘る'), plan)).toMatchObject({ fix: null, mark: { node: 'p1.1.1', by: 'model', on: true } });
    // r7: a parent's tag is counted apart, not on (minecraftLlmcR7.test.ts).
    expect(tagActWhy(act('[p1] 点検'), plan).mark).toMatchObject({ on: false, parent: true });
    expect(tagActWhy(act('[p2.1] 理由: 4m にいて逃げられない'), plan).mark).toMatchObject({ on: false, reason: true });
    expect(tagActWhy(act('[p2.1] ブレイズ'), plan).mark).toMatchObject({ on: false, reason: false });
    expect(tagActWhy(act('[急ぎ] 離れる'), plan).mark).toMatchObject({ urgent: true, on: false });
    expect(tagActWhy(act('x'), { revision: 0, current: null, nodes: [] })).toMatchObject({ fix: null, mark: null });
  });

  it('each act is counted per task and the log line carries the share on the plan', () => {
    const lines: string[] = [];
    for (const why of ['[p1.1] 板', '[p2.1] 理由: 近い', '[急ぎ] 離れる', 'なし']) noteActNode('r6-acts', tagActWhy(act(why), plan).mark, line => lines.push(line));
    expect(lines.at(-1)).toBe('Shannon Minecraft act node task=r6-acts node=p1.1 current=p1.1 by=head on=1 reason=0 acts=4 onPlan=1 off=1 offReason=1'
      + ' urgent=1 head=1 parent=0 share=0.25');
    expect(noteActNode('r6-acts', null, line => lines.push(line))).toBeNull();
  });

  it('the live line of the current node', () => {
    expect(planNowLine({ now: 'p1.1 作業台と板を作る', path: ['出発の点検'] })).toBe('[p1.1] 作業台と板を作る（道: 出発の点検）');
    expect(planNowLine(null)).toBeNull();
  });
});

describe('the knowledge (r6)', () => {
  it('follows r5\'s, with the node tag, the shortage, the recovery\'s branch and the wait', () => {
    // r7 is r6's with its own blaze and R7_KNOWLEDGE (minecraftLlmcR7.test.ts).
    expect(LLMC_SYSTEM_APPENDIX_R6).toBe(`${LLMC_SYSTEM_APPENDIX_R5}\n\n${R6_KNOWLEDGE}`);
    for (const words of ['[p1.2]', '理由:', '[急ぎ]', 'body.shortage', 'ネザーの中から始まった時も', '満腹 18 以上の時だけ',
      '食料が 0 で回復が要る時は、待たずに食料を取りに行く', 'fca_wait', '止めるのは運用者']) expect(R6_KNOWLEDGE).toContain(words);
  });
});
