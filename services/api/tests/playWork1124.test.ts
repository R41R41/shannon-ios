import { afterEach, describe, expect, it } from 'vitest';
import { applyPlanUpdate, emptyPlanTree, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { createFcaPlanTools } from '../src/mind/action/fca/fcaPlanTools.js';
import { droppedOpenProblem } from '../src/mind/action/fca/fcaPlanDrops.js';
import { forgetJudgedLife, lostDoneUpdate } from '../src/surfaces/minecraft/minecraftPlanLost.js';
import { seenDoneUpdate } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { clockStalledSeconds, forgetClocks, timeWords } from '../src/surfaces/minecraft/minecraftLlmcStateWords.js';
import { ACT_INPUT_SCHEMA } from '../src/contracts/minecraftActContract.js';
import { REQUEST_STEPS_LINES } from '../src/surfaces/minecraft/minecraftRequestSteps.js';

/** Play 1124 (the cake and the bone meal request): what a death leaves of the plan, a stopped clock, the drop of open nodes, the limits the grammar says. */
const AT = '2026-11-24T00:00:00Z';
const frame = (items: Array<[string, number]>, life: number): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: AT, receivedAt: AT, connected: true,
  state: { world: { dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: items.map(([name, count]) => ({ name, count })) } as never,
    life: { life, alive: true, since: AT, dimension: 'overworld', dimensionSince: AT } as never }, facts: {} });
const planOf = (): PlanTree => applyPlanUpdate(emptyPlanTree(), { ops: [
  { op: 'add', parent: null, id: 'p1', title: '材料' },
  { op: 'add', parent: 'p1', id: 'p1.1', title: '小麦3', doneWhen: 'have:wheat>=3' },
  { op: 'add', parent: 'p1', id: 'p1.2', title: '砂糖2', doneWhen: 'have:sugar>=2' },
  { op: 'add', parent: null, id: 'p2', title: '作る', doneWhen: 'have:cake>=1' },
] }, { at: AT }).tree;

afterEach(() => { forgetJudgedLife(); forgetClocks(); });

describe('#11: a node done by the pack goes back to open after a death', () => {
  const done = (tree: PlanTree) => applyPlanUpdate(tree, { ops: [{ op: 'set', id: 'p1.1', state: 'done' }, { op: 'set', id: 'p1.2', state: 'done' }] }).tree;
  it('opens the done `have:` nodes the pack does not show, and the parent that was done only by its children', () => {
    const tree = done(planOf());
    expect(tree.nodes.find(node => node.id === 'p1')?.state).toBe('done');
    expect(lostDoneUpdate('t', tree, frame([['wheat', 3], ['sugar', 2]], 1))).toBeNull(); // the first reading takes the life as the base
    const lost = lostDoneUpdate('t', tree, frame([['sugar', 2]], 2))!;
    expect(lost.ids).toEqual(['p1', 'p1.1']);
    const after = applyPlanUpdate(tree, lost.update).tree;
    expect(after.nodes.find(node => node.id === 'p1.1')?.state).not.toBe('done');
    expect(after.nodes.find(node => node.id === 'p1.2')?.state).toBe('done');
    expect(lost.words).toContain('p1.1');
  });
  it('does nothing in the same life (the work used the material up), and judges once per death', () => {
    const tree = done(planOf());
    lostDoneUpdate('t', tree, frame([['wheat', 3]], 1));
    expect(lostDoneUpdate('t', tree, frame([], 1))).toBeNull();
    expect(lostDoneUpdate('t', tree, frame([], 2))).not.toBeNull();
    expect(lostDoneUpdate('t', tree, frame([], 2))).toBeNull();
  });
  it('leaves a node done when the new pack still holds it, and a node with no `have:` condition', () => {
    const tree = applyPlanUpdate(done(planOf()), { ops: [{ op: 'set', id: 'p2', state: 'done' }] }).tree;
    lostDoneUpdate('t', tree, frame([['wheat', 3], ['sugar', 2], ['cake', 1]], 1));
    expect(lostDoneUpdate('t', tree, frame([['wheat', 3], ['sugar', 2], ['cake', 1]], 2))).toBeNull();
  });
  it('is read by the plan port before the frame is read for done nodes: the node stays open and is not closed again', () => {
    let observation = frame([['wheat', 3], ['sugar', 2]], 1);
    const tools = createFcaPlanTools({ taskId: 'tk', checkpoint: { fcaPlanTree: done(planOf()) }, lost: tree => lostDoneUpdate('tk', tree, observation),
      seen: tree => seenDoneUpdate(tree, observation) });
    tools.port.view();
    observation = frame([['sugar', 2]], 2);
    const view = tools.port.view() as { note?: string } | null;
    expect(tools.port.tree().nodes.find(node => node.id === 'p1.1')?.state).not.toBe('done');
    expect(view?.note).toContain('未済へ戻した');
    tools.port.view();
    expect(tools.port.tree().nodes.find(node => node.id === 'p1.1')?.state).not.toBe('done');
  });
});

describe('#11: dropping open nodes to reach a completion', () => {
  const tree = planOf();
  const dropAll = (goal?: string) => applyPlanUpdate(tree, { ops: [{ op: 'drop', id: 'p1' }, { op: 'drop', id: 'p2' }], ...(goal ? { goal } : {}) }).tree;
  it('is turned away when no open node is left, unless the goal is written', () => {
    expect(droppedOpenProblem(tree, dropAll())).toContain('goal');
    expect(droppedOpenProblem(tree, dropAll())).toContain('summary');
    expect(droppedOpenProblem(tree, dropAll('ケーキの小麦だけ'))).toBeNull();
  });
  it('lets a plan change on the way (open nodes dropped, others stay open)', () => {
    expect(droppedOpenProblem(tree, applyPlanUpdate(tree, { ops: [{ op: 'drop', id: 'p1.2' }] }).tree)).toBeNull();
  });
  it('is the tool\'s answer: the plan is not changed', async () => {
    const tools = createFcaPlanTools({ taskId: 'tk', checkpoint: { fcaPlanTree: tree } });
    const answer = await tools.tools.execute({ name: 'plan.update', input: { ops: [{ op: 'drop', id: 'p1' }, { op: 'drop', id: 'p2' }] }, signal: new AbortController().signal } as never);
    expect(JSON.stringify(answer)).toContain('計画は変えていない');
    expect(tools.port.tree().nodes.length).toBe(tree.nodes.length);
  });
});

describe('#6: a clock that does not move', () => {
  it('says the clock is stopped after 30 s of the same reading, and only then', () => {
    expect(clockStalledSeconds('b', '1000', 0)).toBe(0);
    expect(clockStalledSeconds('b', '1000', 20_000)).toBe(20);
    expect(timeWords('1000', 'overworld', undefined, 20)).not.toContain('止まっている');
    const words = timeWords('1000', 'overworld', undefined, 45)!;
    expect(words).toContain('時刻が止まっている');
    expect(words).toContain('夜まで');
    expect(clockStalledSeconds('b', '1200', 50_000)).toBe(0); // it moved
  });
  it('is not said in the Nether, which has no clock', () => {
    expect(timeWords('1000', 'the_nether', undefined, 90)).toBe('（時刻なし）');
  });
  it('is in the request\'s knowledge, with its reason, beside the rule that the plan\'s material is not food', () => {
    const text = REQUEST_STEPS_LINES.join('\n');
    expect(text).toContain('時刻が止まっている');
    expect(text).toMatch(/配合の材料.*食べ物にしない/u);
    expect(text).toContain('理由: 実走では、死んで材料を失った');
  });
});

describe('#8: the limits of seconds and range are written where the model reads them', () => {
  it('say go\'s range and the wait and attack tops in the schema, and the range top is hunt\'s', () => {
    const hand = (ACT_INPUT_SCHEMA.properties.hands as { items: { properties: Record<string, { description?: string; maximum?: number }> } }).items.properties;
    expect(hand.range!.maximum).toBe(48);
    expect(hand.range!.description).toContain('go 0〜4');
    expect(hand.range!.description).toContain('動かさずに断られる');
    expect(hand.seconds!.description).toContain('wait 0.5〜30');
    expect(hand.seconds!.description).toContain('attack 30');
  });
});
