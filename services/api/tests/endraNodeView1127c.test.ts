import { afterEach, describe, expect, it } from 'vitest';
import type { PlanNode, PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { currentNodeLine, forgetActNodes, followNode, noteItemStart, planNowOf, reachWords, withNodeView } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { firstPlanInboxWith, firstPlanInbox, startFirstPlan, strongholdFirst, forgetFirstPlans } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { CURRENT_PLAN_STRUCTURE } from '../src/surfaces/minecraft/minecraftCurrentPlanPrompt.js';
import { firstPlanSystemFor } from '../src/surfaces/minecraft/minecraftStrategy.js';
import { furnaceMeanwhileLine, forgetPlanChoices } from '../src/surfaces/minecraft/minecraftFurnaceMeanwhile.js';
import { crossingOfWorld, crossingWords } from '../src/surfaces/minecraft/minecraftEyeLedger.js';
import { v2tree } from './helpers/planTreeV2.js';

/**
 * Run 9 of 11/27 (the first plan put the stronghold first, and every hand of the 10 minutes was for the preparation behind it): the node of the walk to the point shown as a thing to do
 * (its distance in place of an empty condition), the node left by a follow named with how to go back, the adoption said, the default plan's wait said, the furnace's walk sent as written.
 */
afterEach(() => { forgetActNodes(); forgetFirstPlans(); forgetPlanChoices(); });
const NOW = Date.now();
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: new Date(NOW).toISOString(), receivedAt: 't', connected: true,
  state: { world: world as never }, facts: {} });
/** Run 7's two thrown eyes (two lines about 0.7 degrees apart), which the body keeps on the world. */
const throws = [{ dim: 'overworld', x: 197, z: -245, yawDeg: 171.2, flewM: 12, atMs: NOW - 60_000, broke: true }, { dim: 'overworld', x: 176, z: -241, yawDeg: 170.5, flewM: 12, atMs: NOW - 30_000, broke: true }];
const world = (extra: Record<string, unknown> = {}) => ({ dimension: 'overworld', position: { x: 223, y: 64, z: -20 }, health: 20, food: 20, inventory: [], eyeThrows: throws, ...extra });

type Row = { id: string; parent: string | null; title: string; kind?: PlanNode['kind']; doneWhen?: string; where?: string; caution?: string[]; state?: PlanNode['state'] };
function treeOf(rows: readonly Row[], current: string | null): PlanTree {
  const order = new Map<string | null, number>();
  const nodes: PlanNode[] = rows.map(row => {
    const next = order.get(row.parent) ?? 0;
    order.set(row.parent, next + 1);
    return { id: row.id, parentId: row.parent, order: next, title: row.title, state: row.state ?? 'continue', ...(row.kind ? { kind: row.kind } : {}),
      ...(row.doneWhen ? { doneWhen: row.doneWhen } : {}), ...(row.where ? { where: row.where } : {}), ...(row.caution ? { caution: row.caution } : {}) };
  });
  return v2tree({ revision: 1, current, nodes });
}
const ROWS: Row[] = [{ id: 'p1', parent: null, title: '要塞の場所を絞る', kind: 'stronghold' },
  { id: 'p1.1', parent: 'p1', title: '交点の手前まで歩く', kind: 'stronghold', where: '437,1311（現世）' },
  { id: 'p2', parent: null, title: 'エンド前の準備', kind: 'other', caution: ['ベッドと黒曜石は要塞の後ろで取る', '鉄は要塞の後ろで取る'] },
  { id: 'p2.3', parent: 'p2', title: '鉄のレギンスとブーツを作る', kind: 'iron_armor', doneWhen: 'have:iron_leggings&have:iron_boots' }];
const REACH = '交点まで 1,625m（地上で約 406〜813 秒）';

describe('(1) the walk to the point shows how far the point is', () => {
  it('crossingOfWorld reads the point and the distance from her feet; none without throws or outside the overworld', () => {
    const crossing = crossingOfWorld(world(), NOW)!;
    expect(crossing.meters).toBeGreaterThan(1_000);
    expect(crossingOfWorld(world({ eyeThrows: [] }), NOW)).toBeNull();
    expect(crossingOfWorld(world({ dimension: 'the_nether' }), NOW)).toBeNull();
    expect(crossingWords(1625)).toBe(REACH);
  });
  it('currentNodeLine: an empty condition with a reach says 今: 未: 交点まで N m; a node with its own condition and a line without a reach are as before', () => {
    const node = { id: 'p1.1', title: '交点の手前まで歩く', where: '437,1311（現世）' };
    expect(currentNodeLine(node, ['要塞の場所を絞る'], null, REACH)).toBe(`[p1.1] 交点の手前まで歩く（今: 未: ${REACH}）＠437,1311（現世）（道: 要塞の場所を絞る）`);
    expect(currentNodeLine(node, ['要塞の場所を絞る'], null)).toBe('[p1.1] 交点の手前まで歩く＠437,1311（現世）（道: 要塞の場所を絞る）');
    expect(currentNodeLine({ ...node, doneWhen: 'at:455,64,1434~30@overworld' }, [], '未: 1476m', '交点まで 9m'))
      .toBe('[p1.1] 交点の手前まで歩く（済む条件: at:455,64,1434~30@overworld／今: 未: 1476m）＠437,1311（現世）');
  });
  it('planNowOf puts the distance on the open stronghold leaf with no condition (a where of two numbers too), and nothing on others or with no point', () => {
    const tree = treeOf(ROWS, 'p1.1');
    expect(planNowOf(tree, null, frame(world()))).toMatch(/^\[p1\.1\] 交点の手前まで歩く（今: 未: 交点まで [\d,]+m（地上で約 [\d,]+〜[\d,]+ 秒））＠437,1311（現世）/u);
    // no throw yet: the search node keeps its line as it was
    expect(planNowOf(tree, null, frame(world({ eyeThrows: [] })))).not.toContain('交点まで');
    // a node with a condition of its own, or of another kind, is as it was
    expect(planNowOf(treeOf(ROWS, 'p2.3'), null, frame(world()))).not.toContain('交点まで');
    const withWhen = treeOf(ROWS.map(row => row.id === 'p1.1' ? { ...row, doneWhen: 'at:465,30,1484~30@overworld' } : row), 'p1.1');
    expect(planNowOf(withWhen, null, frame(world()))).toContain('（済む条件: at:465,30,1484~30@overworld／今:');
    expect(planNowOf(treeOf(ROWS.map(row => row.id === 'p1.1' ? { ...row, kind: 'other' as const } : row), 'p1.1'), null, frame(world()))).not.toContain('交点まで');
    // a parent (it has a child) says nothing
    const nodes = tree.nodes;
    expect(reachWords(nodes.find(node => node.id === 'p1')!, nodes, frame(world()))).toBeNull();
    expect(reachWords(nodes.find(node => node.id === 'p1.1')!, nodes, frame(world()))).toContain('交点まで');
  });
});

describe('(2) a follow names the node it left, and how to go back', () => {
  const follow = () => {
    noteItemStart('t1', 'p2.3', 'p1.1');
    noteItemStart('t1', 'p2.3', 'p1.1');
    return followNode('t1', treeOf(ROWS, 'p1.1'), false, undefined, node => node.id === 'p1.1' ? REACH : null);
  };
  it('says the node left (with its distance), that it stays open, the way back, and the one order caution of the node moved to', () => {
    const found = follow()!;
    expect(found).toMatchObject({ to: 'p2.3', from: 'p1.1' });
    expect(found.words).toContain('今の節を [p2.3] に進めた');
    expect(found.words).toContain(`計画の順で先の [p1.1] 交点の手前まで歩く（${REACH}） は開いたまま`);
    expect(found.words).toContain('防具・食料・掘る道具の欠けの手なら、そのまま続けてよい。エンドの点検物（ベッド・黒曜石・足場）の手なら、要塞の後ろの順なので plan_update の current で [p1.1] に戻せる。弓矢の節は要塞の前の道中の短い節で、見えた分だけ作って進めてよい');
    expect(found.words).toContain('注意（p2）: ベッドと黒曜石は要塞の後ろで取る');
    // the node left is not listed a second time among the nodes passed
    expect(found.words).not.toContain('飛ばした節は順のまま残っている');
  });
  it('a move on that leaves no node keeps the old words', () => {
    noteItemStart('t2', 'p4.1', 'p3');
    noteItemStart('t2', 'p4.1', 'p3');
    const tree = treeOf([{ id: 'p3', parent: null, title: '木' }, { id: 'p4', parent: null, title: '鉄' }, { id: 'p4.1', parent: 'p4', title: '洞窟' }], 'p3');
    expect(followNode('t2', tree)!.words).toBe('今の節を [p4.1] に進めた（体が [p4.1] の項目を始めたため）。飛ばした節は順のまま残っている: [p3] 木');
  });
  it('withNodeView puts the node left first in next, and the later order caution in rules once', () => {
    const out = withNodeView({ next: ['p9 先'], rules: ['注意（p2）: ベッドと黒曜石は要塞の後ろで取る'], now: null }, treeOf(ROWS, 'p2.3'), 'overworld', node => node.id === 'p1.1' ? REACH : null)!;
    expect((out.next as string[])[0]).toBe(`戻る先 [p1.1] 交点の手前まで歩く（${REACH}）: 計画の順で先の、開いたままの節（身を守る物の準備の手を続けるのは妨げない）`);
    expect(out.next).toHaveLength(2);
    // the ancestors' caution is already in rules: not added again
    expect(out.rules).toHaveLength(1);
    // the now at p1.1: the later node's order caution is shown, with no node left behind
    const early = withNodeView({ next: [], now: null }, treeOf(ROWS, 'p1.1'), 'overworld')!;
    expect(early.rules).toEqual(['注意（p2・今より後ろの節）: ベッドと黒曜石は要塞の後ろで取る']);
    expect(early.next).toEqual([]);
    // in the Nether the overworld's work left behind is not a place to go back to
    const woodBehind = treeOf(ROWS.map(row => row.id === 'p1.1' ? { ...row, kind: 'wood' as const } : row), 'p2.3');
    expect((withNodeView({ next: [], now: null, rules: ['x'] }, woodBehind, 'the_nether')!).next).toEqual([]);
    expect(withNodeView({ next: [] }, treeOf(ROWS, null), null)).toEqual({ next: [] });
  });
});

describe('(3) the first plan: what it keeps, what it says, the adoption and the default plan\'s wait', () => {
  it('writes the walk node as a thing to do with a condition (with its reason), keeps the exploring node as before; for the dragon goal only', () => {
    expect(CURRENT_PLAN_STRUCTURE).toContain('題を「行く事」（例: 交点の手前まで歩く）にし、doneWhen を at:x,y,z~30@overworld');
    expect(CURRENT_PLAN_STRUCTURE).toContain('空にしない');
    expect(CURRENT_PLAN_STRUCTURE).toContain('理由: 空の doneWhen では頭の入力に「済む条件」も「今: 未…（距離）」も出ず');
    expect(CURRENT_PLAN_STRUCTURE).toContain('座標がまだ無い探索の節（目を投げて位置を絞る前、目が 0 個の序盤）は at: を書かない（書くと作った座標が済む条件になる）。see:・have: の形で閉じる印を書く');
    expect(CURRENT_PLAN_STRUCTURE).toContain('防具の欠け・食料・掘る道具の欠けは、海を渡り要塞の中で戦う前の備えなので、要塞の前の短い節（出発の準備）にしてよい');
    expect(CURRENT_PLAN_STRUCTURE).toContain('削らず、順だけ要塞の後ろ・エンドへ入る節の前に置く');
    expect(firstPlanSystemFor('エンドラを討伐して')).toContain('要塞へ向かう節の書き方');
    expect(firstPlanSystemFor('作業台を作って')).not.toContain('要塞へ向かう節の書き方');
  });
  it('keeps the End\'s side (the obsidian for the dragon, the portal opened with the eyes) and still drops the Nether\'s', () => {
    const row = (id: string, kind: string, title: string, doneWhen = '', parent = '') => ({ id, kind, title, parent, doneWhen });
    const answer = { nodes: [row('p1', 'stronghold', '要塞の場所を絞る'), row('p2', 'other', 'エンド前の準備'), row('p2.2', 'obsidian', '黒曜石を5個足す', 'have:obsidian>=12', 'p2'),
      row('p3', 'portal', '枠を12にしてポータルを開く', 'see:end_portal'), row('p4', 'portal', 'ゲート', 'dim:the_nether'), row('p5', 'obsidian', '黒曜石10とゲート', 'have:obsidian>=10|dim:the_nether'),
      row('p6', 'end', 'エンドへ入る', 'dim:the_end')] };
    const said: string[] = [];
    const kept = (strongholdFirst(answer, 11, line => said.push(line)) as { nodes: Array<{ id: string }> }).nodes.map(node => node.id);
    expect(kept).toEqual(['p1', 'p2', 'p2.2', 'p3', 'p6']);
    expect(said[0]).toContain('dropped=p4,p5');
  });
  it('says on adoption that the now changed, which node (with how far), and that the running items are the old default plan\'s', async () => {
    const answer = { nodes: [{ id: 'p1', parent: '', title: '要塞の場所を絞る', kind: 'stronghold' },
      { id: 'p1.1', parent: 'p1', title: '交点の手前まで歩く', kind: 'stronghold', where: '437,1311（現世）' }, { id: 'p4', parent: '', title: 'エンドへ入る', kind: 'end', doneWhen: 'dim:the_end' }] };
    startFirstPlan({ taskId: 'a1', goal: 'エンドラを討伐して', held: v2tree({ revision: 1, current: null, nodes: [] }), world: world(), log: () => undefined, planner: async () => answer });
    await new Promise(resolve => setTimeout(resolve, 20));
    const inbox = firstPlanInboxWith({ running: () => ['q1', 'q2'], crossing: (node, nodes) => reachWords(node, nodes, frame(world())) });
    const note = inbox.take('a1', v2tree({ revision: 1, current: null, nodes: [] }))?.note ?? '';
    expect(note).toMatch(/最初の計画（強いモデル）が届いた。済んだ節は引き継いだ。計画が替わった。今の節は \[p1\.1\] 交点の手前まで歩く（交点まで [\d,]+m/u);
    expect(note).toContain('走っている q1・q2 は旧の既定計画の物（要るなら replace で入れ替えてよい）');
    expect(note).toContain('合わなければ plan.update で直す');
  });
  it('without the step\'s words the adoption note keeps its old sentence', async () => {
    const answer = { nodes: [{ id: 'p1', parent: '', title: '木', kind: 'wood' }, { id: 'p4', parent: '', title: 'エンドへ入る', kind: 'end' }] };
    startFirstPlan({ taskId: 'a4', goal: 'エンドラを討伐して', held: v2tree({ revision: 1, current: null, nodes: [] }), world: { dimension: 'overworld' }, log: () => undefined, planner: async () => answer });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(firstPlanInbox.take('a4', v2tree({ revision: 1, current: null, nodes: [] }))?.note).toContain('最初の計画（強いモデル）が届いた。済んだ節は引き継いだ。計画が替わった。今の節は [p1] 木。合わなければ plan.update で直す');
  });
  it('the default plan\'s note says to wait for the world\'s plan with short hands (the old words when no plan is being asked)', () => {
    const held = v2tree({ revision: 1, current: null, nodes: [] });
    startFirstPlan({ taskId: 'a2', goal: 'エンドラを討伐して', held, world: { dimension: 'overworld' }, log: () => undefined, planner: () => new Promise(() => undefined) });
    const note = firstPlanInbox.take('a2', held)?.note ?? '';
    expect(note).toContain('この世界に合わせた計画が約 1 分以内に届く');
    expect(note).toContain('長い act（歩きが 30 秒を超える物）を出さず、probe・短い手で待つ');
    expect(note).toContain('理由: 既定計画は旧の準備順で');
    startFirstPlan({ taskId: 'a3', goal: 'エンドラを討伐して', held, world: { dimension: 'overworld' }, log: () => undefined });
    expect(firstPlanInbox.take('a3', held)?.note).toBe('既定の最初の計画。この世界に合わせた計画が後で届く');
  });
});

describe('(4) the furnace\'s next hand for the walk to the point is sent as written', () => {
  const job = { status: 'waiting_external', remainingEstimateMs: 88_000, input: 'raw_iron', count: 9, expects: 'iron_ingot×9', position: { x: 253, y: 37, z: -121 } };
  const walk = (extra: Record<string, unknown> = {}) => ({ ...world(), jobs: [job], mapLandmarks: [], ...extra });
  const nodes = treeOf(ROWS, 'p1.1').nodes;
  it('B is mc_act with the go and its distance when the next node is the walk to a far point; the old words with no point or a near one', () => {
    const line = furnaceMeanwhileLine(walk(), new Map(), nodes, 'p1.1', 't')!;
    expect(line).toMatch(/次の節 \[p1\.1\] 交点の手前まで歩く（437,1311（現世））（かまどの出力に頼らない）: mc_act \["go -?\d+,64,-?\d+ waterOk dig=dirt,gravel,sand maxDig=20 seconds=120"\]（交点まで [\d,]+m/u);
    expect(furnaceMeanwhileLine(walk({ eyeThrows: [] }), new Map(), nodes, 'p1.1', 't')).toContain('かまどの出力に頼らない）: その節の手を足す');
    const near = furnaceMeanwhileLine(walk({ position: { x: 465, y: 64, z: 1_480 } }), new Map(), nodes, 'p1.1', 't');
    expect(near ?? '').not.toContain('mc_act ["go');
  });
});
