import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPlanUpdate, orderedPlan, planDisplay, planPath, PLAN_KINDS, readPlanTree, readPlanTreeWith, type PlanKind, type PlanNode, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { carryDone, FIRST_PLAN_SCHEMA_R4, FIRST_PLAN_SYSTEM, planFromAnswer, seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { carriedItemCounts } from '../src/surfaces/minecraft/minecraftItems.js';
import { createLlmcEvents, forgetLlmcEvents, llmcTransient, readinessParts } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { forgetOnceFacts, markDelivered, offer, pending, withdraw } from '../src/surfaces/minecraft/minecraftLlmcOnceFacts.js';
import { obsidianWays } from '../src/surfaces/minecraft/minecraftLlmcObsidianWays.js';
import { chestNodesDone, forgetActNodes, isPrepNode, noteChestsOpened } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { foodFirstLine, foodLeads, preparationShortage, preparationStage } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { nearNeeds } from '../src/surfaces/minecraft/minecraftLlmcReachWords.js';
import { rewriteLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLiveRewrite.js';
import { isDragonPlan, meterLine, roadLine } from '../src/surfaces/minecraft/minecraftLlmcRoad.js';
import { goalOf } from '../src/surfaces/minecraft/minecraftLlmcRoute.js';
import { planNowTitle } from '../src/surfaces/minecraft/minecraftLlmcUrgent.js';
import { stagesFor } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { prepUnmetFacts, seenDoneUpdate } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { doneRange, factsIn, nowKinds, planFactsOf, PLAN_FACTS_KEY, readWhere } from '../src/surfaces/minecraft/minecraftPlanFacts.js';
import { planFacts } from './helpers/planTreeV2.js';

/**
 * The continue contract, chapter 7 and boundary 9 (the head's half): the plan's `kind` and `prep` are the model's words; the head's code reads the kinds and never
 * a title. The five fixtures of `fixtures/continue/plan/` are the cases: a first plan with kinds and promises, the same decisions after the titles are changed,
 * the fact said (and no `skipped` written) when she goes down without the preparation, the one move of a v1 tree to v2, and a kind that is not in the list.
 */
const fixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/continue/plan/${name}.json`, import.meta.url), 'utf8')) as Record<string, any>;
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
  state: { world: world as never }, facts: {} });
const counts = (items: Array<[string, number]> = []) => carriedItemCounts({ inventory: items.map(([name, count]) => ({ name, count })) }, {});
const withCurrent = (tree: PlanTree, current: string): PlanTree => applyPlanUpdate(tree, { current }).tree;

afterEach(() => { forgetOnceFacts(); forgetLlmcEvents(); forgetActNodes(); });

describe('plan/first-plan-with-kind.json: the first plan\'s answer carries the kind and the promises, and they are the same in the saved tree, the stage and the facts', () => {
  const sample = fixture('first-plan-with-kind');
  const tree = planFromAnswer(sample.input.firstPlanAnswer, '2026-10-28T00:00:00Z')!;
  it('keeps each node\'s kind (a node with none is other), and the promises as plan.update\'s promise op makes them', () => {
    expect(tree.schema).toBe(sample.expected.saved.schema);
    expect(Object.fromEntries(tree.nodes.map(node => [node.id, node.kind]))).toEqual(sample.expected.saved.kinds);
    expect(tree.promises).toHaveLength(1);
    expect(tree.promises[0]).toMatchObject(sample.expected.saved.promises[0]);
    expect(tree.promises[0]!.ledger).toEqual([{ id: 'plan:1', at: '2026-10-28T00:00:00Z', kind: 'made', count: 4, have: 0 }]);
    // A first plan is made whole: its revision stays 1 with promises in it.
    expect(tree.revision).toBe(1);
  });
  it('reads the stage from the kind of the current node (diamond: the diamonds\' check; the preparation: none)', () => {
    for (const [id, stage] of Object.entries(sample.expected.preparationStageWhenCurrent as Record<string, string | null>)) {
      const facts = planFactsOf(withCurrent(tree, id));
      expect(preparationStage('overworld', counts(), nowKinds(facts))).toBe(stage);
    }
  });
  it('asks for the kind in the answer (a closed list) and for the promises, and the model is told the words', () => {
    const item = (FIRST_PLAN_SCHEMA_R4.properties.nodes.items as Record<string, any>);
    expect(item.properties.kind).toEqual({ type: 'string', enum: [...PLAN_KINDS] });
    expect(item.required).toContain('kind');
    expect(FIRST_PLAN_SCHEMA_R4.properties).toHaveProperty('promises');
    for (const word of ['kind', 'prep_descent', 'portal', 'promises']) expect(FIRST_PLAN_SYSTEM).toContain(word);
  });
  it('a kind outside the list is other, the written word kept; a promise whose condition does not read is left out, as is one for a node the plan does not have', () => {
    const made = planFromAnswer({ nodes: [{ id: 'p1', parent: '', title: '畑', kind: 'farm', where: '', doneWhen: '' }, { id: 'p2', parent: '', title: '鉄', kind: 'iron', where: '', doneWhen: '' }],
      promises: [
        { item: 'planks', count: 4, use: '作業台', until: { condition: 'have:crafting_table>=1' }, instead: 'have:crafting_table>=1' },
        { item: 'food', count: 20, use: '地下で食べる分', until: { node: 'p2' } },
        { item: 'planks', count: 2, use: 'x', until: { condition: 'いつか' } },
        { item: 'coal', count: 3, use: 'x', until: { node: 'p99' } },
        { item: 'Not An Item', count: 3, use: 'x' }] }, '2026-10-28T00:00:00Z')!;
    expect(made.nodes[0]).toMatchObject({ kind: 'other', kindRaw: 'farm' });
    expect(made.promises.map(item => [item.id, item.item])).toEqual([[1, 'planks'], [2, 'food']]);
    expect(made.promises[0]!.until?.condition).toEqual([[{ k: 'have', item: 'crafting_table', n: 1 }]]);
    expect(made.promises[1]!.until).toEqual({ node: 'p2' });
  });
});

describe('plan/title-renamed-same-decisions.json: the values the code decides by are the same after the titles are changed; the shown sentences may differ', () => {
  const sample = fixture('title-renamed-same-decisions');
  const base = readPlanTree(sample.input.tree)!;
  // The meter and the road are the dragon plan's: one node of the kind dragon.
  const withDragon = (tree: PlanTree, title: string): PlanTree => ({ ...tree, nodes: [...tree.nodes, { id: 'p8', parentId: null, order: 6, title, state: 'wait' as const, kind: 'dragon' as const }] });
  const renamed = (tree: PlanTree): PlanTree => ({ ...tree, nodes: tree.nodes.map(node => (sample.input.rename as Record<string, string>)[node.id] ? { ...node, title: (sample.input.rename as Record<string, string>)[node.id]! } : node) });
  const before = withDragon(base, 'エンドでドラゴン'), after = withDragon(renamed(base), '龍を倒す');
  const world = { dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: [{ name: 'bread', count: 2 }, { name: 'stone_sword', count: 1 }], health: 20, food: 20 };
  const LANDMARKS = ['L 溶岩源 (173,-16,147) 東3・北3・下2 溜まりの源 4', 'O 黒曜石 (253,-55,154) 東83・南4・下41 ×6'];
  const gate = (tree: PlanTree) => foodLeads({ position: { x: 150, y: 64, z: 200 } }, 'the_nether', tree.nodes);
  const decisions = (tree: PlanTree, current: string) => {
    const at = withCurrent(tree, current), facts = planFactsOf(at);
    const body = { state: { dimension: 'overworld', fullness: 20 }, foodPoints: { total: 60 }, planFacts: facts, landmarks: LANDMARKS, planNow: `[${current}] ${at.nodes.find(node => node.id === current)!.title}` };
    const meter = meterLine(at, frame({ ...world, inventory: [] }), 1_900 / 60)!;
    return {
      preparationStage: preparationStage('overworld', counts(), nowKinds(facts)),
      preparationShortage: preparationShortage({ dimension: 'overworld', counts: counts([['stone_sword', 1]]), food: 20, nowKinds: nowKinds(facts) }),
      stagesFor: stagesFor({ body: { state: { dimension: 'overworld' }, planFacts: facts } }),
      obsidianWays: obsidianWays(body, { x: 170, y: -14, z: 150 }, null),
      nearNeeds: nearNeeds(body),
      gateBack: gate(at),
      next: meter.match(/次の節目 (.+?) 目安/u)?.[1], lateness: meter.match(/（(あと [\d,]+ 秒|[\d,]+ 秒遅れ)）/u)?.[1],
    };
  };
  it.each(['p3', 'p4', 'p5', 'p6', 'p7'])('current %s: the stage, the shortage, the knowledge, the obsidian\'s distances, the near creatures, the gate back and the meter\'s next and lateness are the same', current => {
    expect(decisions(after, current)).toEqual(decisions(before, current));
  });
  it('the same values are not empty: the diamonds\' check is asked, the gate is found by its kind, the obsidian is shown when the next node is the gate', () => {
    const atDiamond = decisions(before, 'p5');
    expect(atDiamond.preparationStage).toBe('diamonds');
    expect(atDiamond.preparationShortage).toContain('ダイヤを掘る前');
    expect(decisions(before, 'p7').gateBack).toContain('帰りのゲート (150,64,210)');
    expect(decisions(before, 'p6').obsidianWays).toHaveLength(1);
    expect(decisions(before, 'p4').obsidianWays).toHaveLength(0);
    expect(decisions(before, 'p3').nearNeeds.food).toBe(false);
  });
  it('what is shown follows the title: the road\'s label and the title line of an urgent decision differ', () => {
    const labelBefore = roadLine(withCurrent(before, 'p5'))!, labelAfter = roadLine(withCurrent(after, 'p5'))!;
    expect(labelBefore).toContain('ダイヤ');
    expect(labelAfter).toContain('深い所の青い石を掘る');
    expect(labelAfter).not.toBe(labelBefore);
    expect(planNowTitle(withCurrent(before, 'p5').nodes.find(node => node.id === 'p5'))).toBe('[p5] ダイヤ（y=-58）');
    expect(planNowTitle(withCurrent(after, 'p5').nodes.find(node => node.id === 'p5'))).toBe('[p5] 深い所の青い石を掘る');
  });
  it('no kind is inferred from a title: the same words with the kind other decide nothing', () => {
    const plain = (title: string): PlanTree => ({ ...base, nodes: base.nodes.map(node => ({ ...node, kind: 'other' as const, title: node.id === 'p5' ? title : node.title })), current: 'p5' });
    const tree = plain('ダイヤ（y=-58）');
    const facts = planFactsOf(tree);
    expect(preparationStage('overworld', counts(), nowKinds(facts))).toBeNull();
    expect(stagesFor({ body: { state: { dimension: 'overworld' }, planFacts: facts } })).toEqual(['prep']);
    expect(isDragonPlan({ ...tree, nodes: [...tree.nodes, { id: 'p8', parentId: null, order: 7, title: 'エンドでドラゴン', state: 'wait', kind: 'other' }] })).toBe(false);
    expect(foodLeads({ position: { x: 150, y: 64, z: 200 } }, 'the_nether', tree.nodes)).not.toContain('帰りのゲート');
    expect(isPrepNode(tree.nodes.find(node => node.id === 'p3')!)).toBe(false);
  });
});

describe('plan/descended-without-prep-fact.json: she goes down without the preparation: the head says the fact, once, and writes no skipped', () => {
  const sample = fixture('descended-without-prep-fact');
  const tree = readPlanTree(sample.input.tree)!;
  const down = { counts: new Map(Object.entries(sample.input.body.have as Record<string, number>)), dimension: sample.input.body.dimension as string,
    feet: { x: 160, y: sample.input.body.y as number, z: 200 }, food: sample.input.body.foodPoints as number };
  it('the fact names the node, says it is not met, and where she is; the node\'s state and prep stay as they were', () => {
    const [fact, ...rest] = prepUnmetFacts(tree, down);
    expect(rest).toEqual([]);
    for (const word of sample.expected.fact.mustContain as string[]) expect(fact!.text).toContain(word);
    expect(fact!.text).toContain('食料 17.6 点');
    const p3 = tree.nodes.find(node => node.id === 'p3')!;
    expect(p3.state).toBe(sample.expected.p3.state);
    expect(p3.prep).toBeUndefined();
    // The update of the frame (what the head writes on the plan by itself) does not touch the node.
    const observation = frame({ dimension: 'overworld', position: { x: 160, y: 16, z: 200 }, inventory: [{ name: 'raw_iron', count: 3 }, { name: 'bread', count: 1 }, { name: 'apple', count: 1 }], health: 20, food: 20 });
    expect(JSON.stringify(seenDoneUpdate(tree, observation)?.update ?? {})).not.toMatch(/p3|prep|省いた/u);
  });
  it('the model writes the answer with plan.update, and the head\'s fact is then not said any more', () => {
    const answer = applyPlanUpdate(tree, { ops: [sample.expected.thenLlmMay] }, { at: '2026-10-28T00:00:00Z' });
    expect(answer.problem ?? null).toBeNull();
    const p3 = answer.tree.nodes.find(node => node.id === 'p3')!;
    expect(p3.prep).toEqual({ state: 'skipped', why: '鉄を先に取る', at: '2026-10-28T00:00:00Z' });
    expect(prepUnmetFacts(answer.tree, down)).toEqual([]);
  });
  it('is offered once a task through readinessParts: kept until a request has it, then not again, taken back when the node is answered', () => {
    const observation = frame({ dimension: 'overworld', position: { x: 160, y: 16, z: 200 }, inventory: [{ name: 'raw_iron', count: 3 }, { name: 'apple', count: 1 }], health: 20, food: 20 });
    const llmc = (held: PlanTree) => ({ plan: () => undefined, planView: () => null, planTree: () => held });
    const first = readinessParts(llmc(tree), null, observation, 'task-a');
    expect(first.onceFacts?.map(item => item.key)).toEqual(['prep_unmet:p3']);
    // Not delivered yet: it is offered again with the next input (an urgent or compressed one did not take it).
    expect(readinessParts(llmc(tree), null, observation, 'task-a').onceFacts?.map(item => item.key)).toEqual(['prep_unmet:p3']);
    // Without a task id nothing is offered or kept.
    expect(readinessParts(llmc(tree), null, observation).onceFacts).toBeUndefined();
    markDelivered('task-a', ['prep_unmet:p3']);
    expect(readinessParts(llmc(tree), null, observation, 'task-a').onceFacts).toBeUndefined();
    // Another task has its own.
    expect(readinessParts(llmc(tree), null, observation, 'task-b').onceFacts?.map(item => item.key)).toEqual(['prep_unmet:p3']);
    // The model wrote prep on it before it was delivered: taken back.
    const answered = applyPlanUpdate(tree, { ops: [{ op: 'set', id: 'p3', prep: { state: 'skipped' } }] }).tree;
    expect(readinessParts(llmc(answered), null, observation, 'task-b').onceFacts).toBeUndefined();
    expect(pending('task-b')).toEqual([]);
  });
});

describe('plan/migrate-v1-to-v2.json: a v1 tree is moved to v2 once', () => {
  const sample = fixture('migrate-v1-to-v2');
  it('gets its kinds, the old 「準備を省いた」 note as prep: skipped, no promises and the revision one up; read again as it is', () => {
    const moved = readPlanTreeWith(sample.input.v1)!;
    expect(moved.migrated).toBe(true);
    expect(moved.tree.schema).toBe(sample.expected.v2.schema);
    expect(moved.tree.revision).toBe(sample.expected.v2.revision);
    expect(Object.fromEntries(moved.tree.nodes.map(node => [node.id, node.kind]))).toEqual(sample.expected.v2.kinds);
    expect(moved.tree.nodes.find(node => node.id === 'p1')!.prep?.state).toBe(sample.expected.v2.prep.p1);
    expect(moved.tree.promises).toEqual([]);
    const again = readPlanTreeWith(JSON.parse(JSON.stringify(moved.tree)))!;
    expect(again.migrated).toBe(false);
    expect(again.tree).toEqual(moved.tree);
  });
  it('kind and prep stay through the first plan, plan.update, a save and a read back (boundary 9)', () => {
    const made = planFromAnswer({ nodes: [{ id: 'p1', parent: '', title: '準備', kind: 'prep_descent', where: '', doneWhen: 'food>=40' }, { id: 'p2', parent: '', title: '鉄', kind: 'iron', where: '', doneWhen: '' }] })!;
    const updated = applyPlanUpdate(made, { ops: [{ op: 'set', id: 'p1', prep: { state: 'unmet_now', why: '地下' } }, { op: 'add', title: '箱', kind: 'chest' }] }, { at: '2026-10-28T00:00:00Z' }).tree;
    const read = readPlanTree(JSON.parse(JSON.stringify(updated)))!;
    expect(read).toEqual(updated);
    expect(read.nodes.map(node => [node.id, node.kind, node.prep?.state])).toEqual([['p1', 'prep_descent', 'unmet_now'], ['p2', 'iron', undefined], ['n1', 'chest', undefined]]);
  });
});

describe('plan/unknown-kind.json: a kind that is not in the list', () => {
  const sample = fixture('unknown-kind');
  it('is taken as other with the written word kept in kindRaw, and kept through a save', () => {
    const start = planFromAnswer({ nodes: [{ id: 'p1', parent: '', title: '食料', kind: 'food', where: '', doneWhen: '' }] })!;
    const result = applyPlanUpdate(start, sample.input.planUpdate);
    expect(result.problem ?? null).toBeNull();
    const added = result.tree.nodes.find(node => node.title === '小麦の畑')!;
    expect(added.kind).toBe(sample.expected.node.kind);
    expect(added.kindRaw).toBe(sample.expected.node.kindRaw);
    expect(readPlanTree(JSON.parse(JSON.stringify(result.tree)))!.nodes.find(node => node.id === added.id)).toMatchObject(sample.expected.node);
    // A word outside the list decides nothing the list's words decide.
    expect(isPrepNode(added)).toBe(false);
  });
});

describe('the seed plan: every node has the kind its work is, and the seed is picked by kind and condition, not by title', () => {
  const dragon = seedPlan('エンドラを倒して')!;
  const kindsOf = (tree: PlanTree) => tree.nodes.map(node => `${node.id}:${node.kind}`).join(' ');
  it('names the kinds of the whole route (the nodes of no kind of their own are other)', () => {
    const kinds = Object.fromEntries(dragon.nodes.map(node => [node.id, node.kind]));
    expect(kinds).toMatchObject({ p1: 'stone_tools', 'p1.1': 'wood', 'p1.3': 'stone_tools', p2: 'prep_descent', 'p2.1': 'village', 'p2.2': 'food', 'p2.3': 'food', p3: 'iron',
      'p3.3': 'iron_armor', p4: 'water', p5: 'diamond', 'p5.1': 'diamond' });
    expect(dragon.nodes.filter(node => node.kind === 'dragon').length).toBeGreaterThan(0);
    for (const kind of ['fortress', 'blaze', 'pearl', 'stronghold', 'portal', 'obsidian'] as PlanKind[]) expect(dragon.nodes.some(node => node.kind === kind), kind).toBe(true);
    expect(dragon.nodes.filter(node => node.kind === 'other').map(node => node.id).length).toBeLessThan(12);
    expect(isDragonPlan(dragon)).toBe(true);
    expect(isDragonPlan(seedPlan('ネザーに行って')!)).toBe(false);
    expect(seedPlan('ネザーに行って')!.nodes.some(node => node.kind === 'portal')).toBe(true);
  });
  it('the gate-first changes find their seeds by kind: one bed, the iron with the armour, the golden boots after the diamonds, no food 100 before the gate', () => {
    const titles = dragon.nodes.map(node => node.title);
    expect(titles).toContain('村を回る（ベッド1〜2・干し草・畑・箱）');
    expect(titles).toContain('鉄（約30・兜・胸・脚まで）');
    expect(titles).toContain('鉄を約30個掘る（y=16前後・洞窟）');
    expect(titles).toContain('鉄の兜・胸当て・脚を作って着る');
    const diamond = dragon.nodes.findIndex(node => node.kind === 'diamond' && node.parentId === null);
    expect(orderedPlan(dragon.nodes).filter(node => node.parentId === null).map(node => node.title)).toContain('金のブーツ（ネザーの前）');
    expect(diamond).toBeGreaterThan(0);
    expect(dragon.nodes.some(node => node.kind === 'food' && node.doneWhen === 'food>=100' && node.parentId !== null && node.title.includes('食料100点'))).toBe(false);
  });
  it('the seed\'s kinds do not change when a title does', () => {
    expect(kindsOf(dragon)).toBe(kindsOf(seedPlan('エンドラを倒して')!));
    const retitled: PlanTree = { ...dragon, nodes: dragon.nodes.map(node => ({ ...node, title: `節${node.id}` })) };
    expect(planFactsOf(withCurrent(retitled, 'p5'))!.now!.kind).toBe('diamond');
    expect(isDragonPlan(retitled)).toBe(true);
  });
  it('the nodes done in the plan held are carried to the answer by kind and words only', () => {
    const held: PlanTree = { ...dragon, nodes: dragon.nodes.map(node => node.kind === 'fortress' ? { ...node, state: 'done' as const } : node) };
    const next = planFromAnswer({ nodes: [{ id: 'q1', parent: '', title: 'x', kind: 'fortress', where: '', doneWhen: 'ネザーレンガ（N）が見える' },
      { id: 'q2', parent: '', title: 'ネザー要塞を探す', kind: 'other', where: '', doneWhen: 'ネザーレンガ（N）が見える' }, { id: 'q3', parent: '', title: 'ネザー要塞を探す', kind: 'fortress', where: '', doneWhen: '' }] })!;
    const carried = carryDone(held, next);
    expect(carried.nodes.map(node => [node.id, node.state])).toEqual([['q1', 'done'], ['q2', 'continue'], ['q3', 'continue']]);
  });
});

describe('the readers of the plan\'s facts', () => {
  it('planFactsOf: the current node with its place, the kinds above it, and the next nodes as planPath shows them', () => {
    const tree = seedPlan('エンドラを倒して')!;
    for (const id of ['p1.2', 'p2.3', 'p5.2', 'p7', 'p10.1']) {
      const at = withCurrent(tree, id), facts = planFactsOf(at)!;
      expect(facts.now!.id).toBe(id);
      expect(facts.next.map(item => item.id), id).toEqual(planPath(at).next.map(line => line.split(' ')[0]));
      expect(facts.above.length).toBe(at.nodes.find(node => node.id === id)!.parentId ? 1 : 0);
    }
    expect(planFactsOf(null)).toBeNull();
    expect(planFactsOf({ ...tree, current: null })!.now).toBeNull();
  });
  it('factsIn reads the body\'s field back, and nothing else (a malformed one is none)', () => {
    const facts = planFacts('portal', { id: 'p7', where: '(150,64,210)', doneWhen: 'dim:the_nether', above: ['obsidian'], next: ['nether'] });
    expect(factsIn({ [PLAN_FACTS_KEY]: JSON.parse(JSON.stringify(facts)) })).toEqual({ ...facts, next: [{ id: 'n1', kind: 'nether' }] });
    expect(factsIn({ planNow: '[p7] ゲート' })).toBeNull();
    expect(factsIn({ [PLAN_FACTS_KEY]: { now: { id: 'p1', kind: 'gate' } } })!.now).toBeNull();
    expect(factsIn(null)).toBeNull();
  });
  it('readWhere: the one reader of a where, and the radius of a done-condition', () => {
    expect(readWhere('195,66,60')).toEqual({ x: 195, y: 66, z: 60 });
    expect(readWhere('(196,69,237) 村の北')).toEqual({ x: 196, y: 69, z: 237 });
    expect(readWhere('@ (150,64,210)')).toEqual({ x: 150, y: 64, z: 210 });
    expect(readWhere('chest 1,2,3。ベッド(9,9,9)')).toBeNull();
    expect(readWhere('村の北 (5,35,12)', 'any')).toEqual({ x: 5, y: 35, z: 12 });
    expect(readWhere('5,35,12', 'any')).toEqual({ x: 5, y: 35, z: 12 });
    expect(readWhere(undefined)).toBeNull();
    expect(doneRange('at:195,66,60~3&have:log>=1')).toBe(3);
    expect(doneRange('have:log>=1')).toBeNull();
    expect(goalOf({ where: '(196,69,237) 村の北', doneWhen: 'at:196,69,237~6' })).toEqual({ at: { x: 196, y: 69, z: 237 }, range: 6 });
    expect(goalOf({ doneWhen: 'at:196,69,237~6' })).toBeNull();
  });
  it('planDisplay gives the kind to the body for its display (no model reads it); a node of the kind other has none in it', () => {
    const tree = planFromAnswer({ nodes: [{ id: 'p1', parent: '', title: '木', kind: 'wood', where: '', doneWhen: '' }, { id: 'p2', parent: '', title: '何か', where: '', doneWhen: '' }] })!;
    expect(planDisplay(tree).nodes.map(node => node.kind)).toEqual(['wood', undefined]);
  });
  it('the chest, the food-first line and the prep node read the kind, not the words', () => {
    const tree: PlanTree = { schema: 'shannon.plan-tree.v2', revision: 1, current: 'p1', promises: [], nodes: [
      { id: 'p1', parentId: null, order: 0, title: '村の箱を開ける', state: 'continue', kind: 'chest', where: '157,67,200' },
      { id: 'p2', parentId: null, order: 1, title: '箱を開ける', state: 'continue', kind: 'other', where: '157,67,200' },
      { id: 'p3', parentId: null, order: 2, title: '肉を焼く', state: 'continue', kind: 'food', where: '(5,35,12)' },
      { id: 'p4', parentId: null, order: 3, title: '食料を集める', state: 'continue', kind: 'other', doneWhen: 'food>=40' }] };
    noteChestsOpened('chest-task', '1 chest 済\nchest (157,67,200): 木材×3', '[p1] 箱');
    const done = chestNodesDone('chest-task', tree);
    expect(done?.ids).toEqual(['p1']);
    expect(foodFirstLine(tree.nodes, 'p1', null)).toBe('回復が先: 食料の節 [p3] 肉を焼く＠(5,35,12)');
    expect(isPrepNode(tree.nodes[2]!)).toBe(true);
    expect(isPrepNode(tree.nodes[3]!)).toBe(false);
  });
});

describe('the live state: the facts are the code\'s own, outside the model\'s sight', () => {
  const tree = seedPlan('エンドラを倒して')!;
  const observation = frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: [{ name: 'bread', count: 2 }], health: 20, food: 20, localMap: '地図なし' });
  const llmc = (held: PlanTree) => ({ plan: () => undefined, planView: () => null, planTree: () => held });
  it('llmcTransient carries planFacts of the current node, and the rewrite takes it out before the model reads it', () => {
    const at = withCurrent(tree, 'p5.1');
    const live = llmcTransient(llmc(at), createLlmcEvents('plan-facts'), observation, 10, [], {}, 'plan-facts');
    expect(live[PLAN_FACTS_KEY]).toMatchObject({ now: { id: 'p5.1', kind: 'diamond' }, above: ['diamond'] });
    // The next nodes' kinds count too: the golden boots (the gate's kind) come after the diamonds, so the Nether's knowledge is ready.
    expect(stagesFor({ body: live })).toEqual(['prep', 'nether']);
    const shown = rewriteLlmcLive({ plan: {}, body: live }).live.body as Record<string, unknown>;
    expect(shown).not.toHaveProperty(PLAN_FACTS_KEY);
    expect(JSON.stringify(shown)).not.toContain('"kind"');
    // The shortage is the diamonds' check, from the kind.
    expect(String(shown.shortage)).toContain('ダイヤを掘る前');
    // A live state that is not connected has no plan to read.
    expect(llmcTransient(llmc(at), createLlmcEvents('plan-facts-2'), null, 10)).not.toHaveProperty(PLAN_FACTS_KEY);
  });
  it('the dedupe of the plan\'s now compares the node\'s id, also an id the model made (n3)', () => {
    const plan = { now: 'n3 水を汲む', path: [], next: [] };
    const body = { planNow: '[n3] 水を汲む', planFacts: planFacts('water', { id: 'n3' }) };
    expect(rewriteLlmcLive({ plan, body }).live.plan).not.toHaveProperty('now');
    expect(rewriteLlmcLive({ plan, body: { planNow: '[n3] 水を汲む' } }).live.plan).toHaveProperty('now');
  });
  it('the kinds decide the add-ons of the pack and the route\'s goal', () => {
    const body = { state: { dimension: 'overworld' }, inventory: ['red_bed×3'], planFacts: planFacts('stronghold') };
    expect(JSON.stringify(rewriteLlmcLive({ plan: {}, body }).live.body)).not.toContain('ベッドは足りている');
    expect(JSON.stringify(rewriteLlmcLive({ plan: {}, body: { ...body, planFacts: planFacts('wood') } }).live.body)).toContain('ベッドは足りている');
  });
});

describe('the facts said once (minecraftLlmcOnceFacts.ts)', () => {
  it('one per key; kept until delivered, then not offered again; taken back before it was; a task\'s own', () => {
    expect(offer('t1', 'k', 'words')).toBe(true);
    expect(offer('t1', 'k', 'newer words')).toBe(true);
    expect(pending('t1')).toEqual([{ key: 'k', text: 'newer words' }]);
    expect(pending('t2')).toEqual([]);
    markDelivered('t1', ['unknown', 'k']);
    expect(pending('t1')).toEqual([]);
    expect(offer('t1', 'k', 'again')).toBe(false);
    expect(offer('t1', 'j', 'x')).toBe(true);
    withdraw('t1', 'j');
    expect(pending('t1')).toEqual([]);
    expect(offer('t1', 'j', 'x')).toBe(true);
  });
  it('measure/one-time-fact-delivery.json: a fact a compression dropped is offered with the next input, and is delivered when a request holds it', () => {
    const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/continue/measure/one-time-fact-delivery.json', import.meta.url), 'utf8')) as Record<string, any>;
    const inLast: Record<string, boolean> = {}, deliveredAt: string[] = [];
    offer('fixture-task', 'fact', sample.input.fact);
    for (const decision of sample.input.decisions as Array<{ d: string; compressedOut?: boolean }>) {
      // The input of this decision carries what is pending; the last request holds it unless the compression dropped it.
      const carried = pending('fixture-task').map(item => item.key);
      inLast[decision.d] = carried.includes('fact') && decision.compressedOut !== true;
      if (inLast[decision.d]) { markDelivered('fixture-task', carried); deliveredAt.push(decision.d); }
    }
    expect(inLast).toEqual(sample.expected.inLastRequest);
    expect(deliveredAt).toEqual([sample.expected.deliveredAt]);
  });
});
describe('a node of the old plan seen done by the frame is not given a word of the head\'s', () => {
  it('a done node is closed by the frame as before, with no note', () => {
    const tree = seedPlan('エンドラを倒して')!;
    const update = seenDoneUpdate(tree, frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: [{ name: 'stone_pickaxe', count: 1 }], health: 20, food: 20 }))!;
    expect(JSON.stringify(update.update)).not.toContain('準備を省いた');
    expect(update.ids.length).toBeGreaterThan(0);
  });
});
