import { afterEach, describe, expect, it } from 'vitest';
import { applyPlanUpdate, planPath, type PlanNode, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { ACT_DESCRIPTION, MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';
import { createFcaPlanTools } from '../src/mind/action/fca/fcaPlanTools.js';
import { forgetFirstPlans, FIRST_PLAN_SYSTEM_R8, FIRST_PLAN_SYSTEM_R9, carryDone, planFromAnswer, seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { LLMC_SYSTEM_APPENDIX_R8, LLMC_SYSTEM_APPENDIX_R9, llmcSystemAppendix, R9_KNOWLEDGE } from '../src/surfaces/minecraft/minecraftKnowledge.js';
import { doneFacts, nodesHeldOpen, nodesSeenDone, parseDoneWhen, seenDoneUpdate } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { checkedStopIf } from '../src/surfaces/minecraft/minecraftLlmcStopIf.js';

/**
 * mb-llmc r9 (run 33): the plan's done by the code (H1), the stopIf looked at against the frame (H2), and the words (H3, H4). The H1 tree is the
 * one task ca976e03 held at its last checkpoint (revision 22), with the doneWhen of each node as the model wrote it.
 */
afterEach(() => { forgetFirstPlans(); });

function frame(world: Record<string, unknown>): BodyObservation {
  return { schemaVersion: 1, bodyId: 'minecraft:s', sequence: 1, stateAt: '2026-10-22T00:00:00Z', receivedAt: '2026-10-22T00:00:00Z', connected: true,
    state: { world: world as never }, facts: { alive: true } };
}
const at = (x: number, y: number, z: number) => ({ x, y, z });
type Row = [id: string, parent: string | null, title: string, doneWhen?: string, state?: PlanNode['state']];
function treeOf(rows: readonly Row[], current: string | null = null): PlanTree {
  const order = new Map<string | null, number>();
  const nodes: PlanNode[] = rows.map(([id, parent, title, doneWhen, state]) => {
    const next = order.get(parent) ?? 0;
    order.set(parent, next + 1);
    return { id, parentId: parent, order: next, title, state: state ?? 'continue', ...(doneWhen ? { doneWhen } : {}) };
  });
  return { schema: 'shannon.plan-tree.v1', revision: 1, current, nodes };
}
/** Run 33's plan: p1 the check, p2 back to the Nether (the blaze rods), p3 the pearls, p4 the eyes thrown on the surface, p5 the portal, p6 the dragon. */
const RUN33: readonly Row[] = [
  ['p1', null, '出発の点検', 'have:crafting_table&have:slab>=12&have:shield&food>=100'],
  ['p1.1', 'p1', 'スポナーから離れ塞ぐ', 'at:293,67,72~6'],
  ['p1.2', 'p1', '歪んだ幹を取る', 'have:warped_stem>=4'],
  ['p1.3', 'p1', '作業台と棒を作る', 'have:crafting_table&have:stick>=4'],
  ['p1.4', 'p1', 'ハーフブロック12作る', 'have:slab>=12'],
  ['p1.5', 'p1', 'ゲートで地上へ戻る', 'dim:overworld|at:40,64,96~200'],
  ['p1.6', 'p1', '鉄を掘り盾と金防具', 'have:shield&have:golden_helmet'],
  ['p1.7', 'p1', '動物を狩って焼く', 'food>=100'],
  ['p2', null, 'ネザーへ戻る', 'dim:the_nether'],
  ['p2.1', 'p2', '要塞の湧き場へ行く', 'at:311,70,72~8'],
  ['p2.2', 'p2', '隠れ場を作る'],
  ['p2.3', 'p2', 'ブレイズロッド7本', 'have:blaze_rod>=7'],
  ['p3', null, 'エンダーパール集め', 'have:ender_pearl>=12'],
  ['p3.1', 'p3', '歪んだ森でエンダーマン', 'have:ender_pearl>=12'],
  ['p3.2', 'p3', 'アイを作る', 'have:ender_eye>=12'],
  ['p4', null, '地上でアイを投げる', 'dim:overworld'],
  ['p4.1', 'p4', '1回目に投げる'], ['p4.2', 'p4', '200m離れ2回目'], ['p4.3', 'p4', '交点へ行き掘り下る'],
  ['p5', null, 'エンドポータルを開く', 'dim:the_end'],
  ['p5.1', 'p5', 'ポータルの部屋を探す'], ['p5.2', 'p5', '枠にアイをはめる'], ['p5.3', 'p5', '点検して入る', 'dim:the_end'],
  ['p6', null, 'ドラゴン討伐'], ['p6.1', 'p6', 'クリスタルを壊す'], ['p6.2', 'p6', '止まり木で剣と爆発'],
];
const NETHER_START = frame({ position: at(310.5, 66, 73.5), dimension: 'minecraft:the_nether', health: 20, food: 19,
  inventory: [{ name: 'iron_pickaxe', count: 1 }, { name: 'iron_sword', count: 1 }, { name: 'water_bucket', count: 1 }, { name: 'cooked_mutton', count: 1 },
    { name: 'gold_nugget', count: 11 }] });

describe('the plan\'s done is each node\'s own (run 33: p2.3 with 0 rods, p4 after the respawn, p1.5 in the Nether)', () => {
  it('p2 `dim:the_nether` true at the start no longer closes p2.3 `have:blaze_rod>=7` (0 rods) nor p2.2; p2.1 `at:` holds by its own', () => {
    const tree = treeOf(RUN33, 'p1.1');
    const done = nodesSeenDone(tree, doneFacts(NETHER_START)!);
    expect(done).toEqual(['p2.1']);
    expect(done).not.toContain('p2');
    expect(done).not.toContain('p2.3');
    const held = nodesHeldOpen(tree, doneFacts(NETHER_START)!);
    expect(held).toEqual([{ id: 'p2', open: ['p2.2', 'p2.3'] }]);
    const update = seenDoneUpdate(tree, NETHER_START)!;
    expect(update.held).toEqual(['p2←p2.2,p2.3']);
    expect(update.ids).toEqual(['p2.1']);
  });

  it('the plan\'s tool leaves p2.3 open at the start, says what it holds open in the log once, and the blaze node can be the current one', () => {
    const tree = treeOf(RUN33);
    const lines: string[] = [];
    const plan = createFcaPlanTools({ taskId: 'r9-start', checkpoint: { fcaPlanTree: tree }, rules: true, log: line => lines.push(line),
      seen: held => seenDoneUpdate(held, NETHER_START) });
    plan.port.view();
    plan.port.view();
    const settled = plan.port.tree();
    expect(settled.nodes.find(node => node.id === 'p2.3')!.state).toBe('continue');
    expect(settled.nodes.find(node => node.id === 'p2')!.state).toBe('continue');
    expect(lines.filter(line => line.startsWith('Shannon FCA plan held task=r9-start'))).toHaveLength(1);
    expect(lines.find(line => line.startsWith('Shannon FCA plan held'))).toContain('held=p2←p2.2,p2.3');
    const chosen = applyPlanUpdate(settled, { current: 'p2.3' });
    expect(chosen.tree.current).toBe('p2.3');
  });

  it('p1.5 `dim:overworld|at:40,64,96~200` is not seen done at (225,62,80) in the Nether (the overworld\'s place, not the Nether\'s), and is in the overworld there', () => {
    const tree = treeOf(RUN33);
    const nether = doneFacts(frame({ position: at(225, 62, 80), dimension: 'the_nether' }))!;
    expect(nodesSeenDone(tree, nether)).not.toContain('p1.5');
    const overworld = doneFacts(frame({ position: at(100, 64, 100), dimension: 'overworld' }))!;
    expect(nodesSeenDone(tree, overworld)).toContain('p1.5');
    const far = doneFacts(frame({ position: at(400, 64, 100), dimension: 'overworld' }))!;
    // The dim clause holds in the overworld whatever the place.
    expect(nodesSeenDone(tree, far)).toContain('p1.5');
    expect(parseDoneWhen('at:40,64,96~200')).toEqual([[{ kind: 'at', x: 40, y: 64, z: 96, r: 200 }]]);
    expect(parseDoneWhen('dim:overworld|at:40,64,96~200')![1]).toEqual([{ kind: 'at', x: 40, y: 64, z: 96, r: 200, dimension: 'overworld' }]);
    expect(parseDoneWhen('at:196,69,237~6@nether')).toEqual([[{ kind: 'at', x: 196, y: 69, z: 237, r: 6, dimension: 'the_nether' }]]);
    expect(parseDoneWhen('at:1,2,3@moon')).toBeNull();
  });

  it('a place with no dimension of its own takes that of the nearest dim node before it; with none it is compared alone, as before', () => {
    const tree = treeOf(RUN33);
    const nearFortress = (dimension: string) => doneFacts(frame({ position: at(311, 70, 72), dimension }))!;
    expect(nodesSeenDone(tree, nearFortress('the_nether'))).toContain('p2.1');
    expect(nodesSeenDone(tree, nearFortress('overworld'))).not.toContain('p2.1');
    // p1.1 has no dim node before it: the place alone.
    const spawner = (dimension: string) => doneFacts(frame({ position: at(293, 67, 72), dimension }))!;
    expect(nodesSeenDone(tree, spawner('the_nether'))).toContain('p1.1');
    expect(nodesSeenDone(tree, spawner('overworld'))).toContain('p1.1');
  });

  it('after the respawn in the overworld p4 `dim:overworld` and its three steps stay open; p5, p6 are not touched', () => {
    const rows = RUN33.map(([id, parent, title, doneWhen]): Row => [id, parent, title, doneWhen,
      ['p1.1', 'p1.2', 'p1.3', 'p1.4', 'p1.5', 'p2', 'p2.1', 'p2.2', 'p2.3'].includes(id) ? 'done' : 'continue']);
    const tree = treeOf(rows, 'p3.1');
    const respawn = doneFacts(frame({ position: at(-38.5, 48, 193.5), dimension: 'overworld', health: 20, food: 20, inventory: [{ name: 'red_bed', count: 1 }] }))!;
    const done = nodesSeenDone(tree, respawn);
    expect(done).not.toContain('p4');
    expect(done.filter(id => id.startsWith('p4'))).toEqual([]);
    expect(nodesHeldOpen(tree, respawn).map(item => item.id)).toContain('p4');
    // When the model has closed the three steps, the parent is done by the plan's own rule.
    const closed = applyPlanUpdate(tree, { ops: ['p4.1', 'p4.2', 'p4.3'].map(id => ({ op: 'set' as const, id, state: 'done' as const })) });
    expect(closed.tree.nodes.find(node => node.id === 'p4')!.state).toBe('done');
  });

  it('a node whose pack predicate holds is done with children left open and the next node is not one of them; positional parents wait for their children', () => {
    const tree = treeOf([
      ['a', null, '鉄の道具', 'have:iron_pickaxe'], ['a.1', 'a', '板を集める', 'have:planks>=8'], ['a.2', 'a', '鉄を掘る'],
      ['b', null, 'ゲート', 'dim:the_nether'], ['b.1', 'b', '食料', 'food>=100'], ['b.2', 'b', '火をつける', 'dim:the_nether'],
      ['c', null, '次']], 'a.1');
    const facts = doneFacts(frame({ position: at(0, 64, 0), dimension: 'the_nether', inventory: [{ name: 'iron_pickaxe', count: 1 }, { name: 'cooked_beef', count: 2 }] }))!;
    const done = nodesSeenDone(tree, facts);
    // a: by the pack, its children untouched (planks consumed: a.1 stays as it is); b.2 by its own dim; b waits for b.1 (food 41.6 < 100).
    expect(done).toEqual(['a', 'b.2']);
    const applied = applyPlanUpdate(tree, { ops: done.map(id => ({ op: 'set' as const, id, state: 'done' as const })) });
    expect(applied.tree.current).toBe('b.1');
    expect(planPath(applied.tree).next).toEqual([expect.stringContaining('c ')]);
  });

  it('a done node leaves nothing under it as the next, by the plan\'s own rule (a model\'s done too)', () => {
    const tree = treeOf([['a', null, '親'], ['a.1', 'a', '子1'], ['a.2', 'a', '子2'], ['b', null, '次']], 'a.1');
    const result = applyPlanUpdate(tree, { ops: [{ op: 'set', id: 'a', state: 'done' }] });
    expect(result.tree.current).toBe('b');
    expect(planPath(result.tree).next).toEqual([]);
    const named = applyPlanUpdate(tree, { ops: [{ op: 'set', id: 'a', state: 'done' }], current: 'a.2' });
    expect(named.tree.current).toBe('a.2');
  });

  it('the first plan\'s arrival does not make a node under a done one the open one', () => {
    const held = treeOf([['p1', null, '一'], ['p1.1', 'p1', '子']]);
    const answer = planFromAnswer({ nodes: [{ id: 'p1', parent: '', title: '一', where: '', doneWhen: '' }, { id: 'p1.1', parent: 'p1', title: '子', where: '', doneWhen: '' },
      { id: 'p2', parent: '', title: '二', where: '', doneWhen: '' }] })!;
    const doneParent = { ...held, nodes: held.nodes.map(node => node.id === 'p1' ? { ...node, state: 'done' as const } : node) };
    expect(carryDone(doneParent, answer).current).toBe('p2');
  });

  it('the seed\'s check holds a piece of golden armour (have:gold_armor), and the predicate reads any piece', () => {
    const tree = seedPlan('エンドラを討伐してください', 'the_nether')!;
    const check = tree.nodes.find(node => node.title.startsWith('出発の点検（ネザーの奥へ）'))!;
    expect(check.doneWhen).toContain('have:gold_armor');
    expect(check.forbid?.[0]).toContain('金の防具');
    expect(tree.nodes.some(node => node.parentId === check.id && node.doneWhen === 'have:gold_armor')).toBe(true);
    const base = { position: at(0, 64, 0), dimension: 'the_nether' };
    expect(nodesSeenDone(tree, doneFacts(frame({ ...base, inventory: [] }))!)).not.toContain(tree.nodes.find(node => node.doneWhen === 'have:gold_armor')!.id);
    expect(nodesSeenDone(tree, doneFacts(frame({ ...base, inventory: [{ name: 'golden_boots', count: 1 }] }))!)).toContain(tree.nodes.find(node => node.doneWhen === 'have:gold_armor')!.id);
  });
});

describe('the stopIf looked at against the frame (run 33 +997: hpBelow 9 at health 6.6 stopped with 0 hands)', () => {
  const hurt = frame({ health: 6.6, position: at(0, 64, 0), dimension: 'the_nether', nearbyThreats: [] });
  it('takes off an hpBelow above her health and says so; keeps one at or under it', () => {
    const act = { hands: [{ do: 'attack', target: '#1677', untilDead: true }], accept: ['piglin'], stopIf: { hpBelow: 9 }, why: '[急ぎ] ピグリンを倒す' };
    const checked = checkedStopIf(act, hurt);
    expect(checked.input).toEqual({ hands: act.hands, accept: ['piglin'], why: act.why });
    expect(checked.fixes).toEqual(['stopIf hpBelow 9 は今の体力 6.6 以上なので外した（付けたままだと 1 手も動かずに止まる）']);
    expect(checkedStopIf({ ...act, stopIf: { hpBelow: 6.6 } }, hurt).fixes).toEqual([]);
    expect(checkedStopIf({ ...act, stopIf: { hpBelow: 5 } }, hurt).input).toEqual({ ...act, stopIf: { hpBelow: 5 } });
    const mixed = checkedStopIf({ ...act, stopIf: { hpBelow: 9, hostileWithin: 6 } }, hurt);
    expect(mixed.input).toMatchObject({ stopIf: { hostileWithin: 6 } });
    expect((mixed.input as { stopIf: object }).stopIf).not.toHaveProperty('hpBelow');
    expect(checkedStopIf(act, frame({ position: at(0, 64, 0) })).fixes).toEqual([]);
  });

  it('adds hostileWithin 4 to a wait and a hold with none, and says so; not when one is there, or an unaccepted hostile is already that near', () => {
    const calm = frame({ health: 20, position: at(0, 64, 0), nearbyThreats: [{ name: 'piglin', distance: 9, canReachMe: true }] });
    const wait = { hands: [{ do: 'look', yaw: 90 }, { do: 'wait', seconds: 10 }], why: '待つ' };
    const added = checkedStopIf(wait, calm);
    expect(added.input).toEqual({ ...wait, stopIf: { hostileWithin: 4 } });
    expect(added.fixes).toEqual(['待つ手の act に stopIf hostileWithin 4 を足した（歩く敵が 4m 内に来たら止まる。accept の種類は除く）']);
    const hold = { hands: [{ do: 'attack', target: 'blaze', hold: true, seconds: 20 }], accept: ['blaze'], stopIf: { hpBelow: 12 } };
    expect(checkedStopIf(hold, calm).input).toEqual({ ...hold, stopIf: { hpBelow: 12, hostileWithin: 4 } });
    expect(checkedStopIf({ ...wait, stopIf: { hostileWithin: 8 } }, calm).fixes).toEqual([]);
    expect(checkedStopIf({ hands: [{ do: 'wait', seconds: 1 }] }, calm).fixes).toEqual([]);
    expect(checkedStopIf({ hands: [{ do: 'walk', to: at(1, 2, 3) }] }, calm).fixes).toEqual([]);
    const crowded = frame({ health: 20, nearbyThreats: [{ name: 'piglin', distance: 2.1, canReachMe: true }] });
    const skipped = checkedStopIf(wait, crowded);
    expect(skipped.input).toEqual(wait);
    expect(skipped.fixes[0]).toContain('足さなかった（piglin が既に 2.1m にいて');
    // Accepted, or walled off: the body does not stop on them, so they do not stand in the way of the default.
    expect(checkedStopIf({ ...wait, accept: ['piglin'] }, crowded).fixes[0]).toContain('を足した');
    expect(checkedStopIf(wait, frame({ health: 20, nearbyThreats: [{ name: 'piglin', distance: 2.1, canReachMe: false }] })).fixes[0]).toContain('を足した');
  });
});

describe('the words (r9)', () => {
  it('the mode\'s appendix is r8\'s with r9\'s section: the piglin, the pearls after the rods, the chase, the stopIf, the long act, the bare-hand column', () => {
    expect(llmcSystemAppendix(true)).toBe(LLMC_SYSTEM_APPENDIX_R9);
    expect(LLMC_SYSTEM_APPENDIX_R9).toBe(`${LLMC_SYSTEM_APPENDIX_R8}\n\n${R9_KNOWLEDGE}`);
    for (const words of ['金の防具を 1 つ着けるまでピグリンの近く（8m）に長居しない', 'エンダーパールはブレイズの棒（7 本）の後', 'plan.update の理由に書く',
      '離れても同じ速さで追われ', '打ち返す', 'pillarUp n=2', '体力 6 以下', '親の節が済みになっても子は済みにならない', '消費して無くなる物',
      'hpBelow は今の体力より低い値', 'stopIf hostileWithin 4〜8', '10〜12 手（上限 12）', 'dig の at は 1 手に 8〜16 マス', '反射（溶岩・落下・溺れ・燃え・逃走）はいつも効き',
      '自分の x,z で mc.probe column を聞く', '「真上」の行（above）', '素手の石は約 7.7 秒', '足のマスの下・次のマス（足・頭・下）・そのマスにいる物']) {
      expect(R9_KNOWLEDGE).toContain(words);
    }
    expect(llmcSystemAppendix(false)).not.toContain('R9');
  });

  it('the act\'s description says the stopIf\'s hpBelow and the long act', () => {
    for (const words of ['hpBelow は今の体力より低い値（以上だと 1 手も動かず止まる）', '10〜12 手を 1 つの act に入れる', 'dig の at は 16 マスまで、walk の path は 32 点まで']) {
      expect(ACT_DESCRIPTION).toContain(words);
    }
    expect(MC_ACT_TOOL).toBe('mc.act');
  });

  it('the first plan is asked to write the dimension of a place, a parent\'s condition from the pack, the rods before the pearls and the golden armour', () => {
    expect(FIRST_PLAN_SYSTEM_R9.startsWith(FIRST_PLAN_SYSTEM_R8)).toBe(true);
    for (const words of ['at:196,69,237~6@overworld', '@nether', '親が済んでも子は済みにならない', '消費して無くなる物（板・棒・原木）は子の doneWhen にしない',
      'ブレイズロッド（7 本以上）の節はエンダーパールの節より前', 'have:gold_armor']) expect(FIRST_PLAN_SYSTEM_R9).toContain(words);
  });
});
