import { afterEach, describe, expect, it } from 'vitest';
import { applyPlanUpdate, emptyPlanTree, orderedPlan, type PlanTree } from '@shannon/mind';
import { createFcaPlanTools } from '../src/mind/action/fca/fcaPlanTools.js';
import {
  applyOwnerNodeChange, findOwnerNode, forgetOwnerNodeOps, OWNER_HOLD_REASON, OWNER_SKIP_REASON, ownerNodeChange, ownerPlanOf, putOwnerNodeOp,
  registerOwnerPlan, withOwnerNodeInbox, ownerPlanPromptLines,
} from '../src/surfaces/minecraft/minecraftPlanOp.js';
import { MINECRAFT_PLAN_PATH, parsedMinecraftPlanRequest } from '../src/contracts/minecraftPlanOpContract.js';
import { applyQueueIntent } from '../src/wiring/fcaMinecraftQueueIntent.js';
import { bodyIntentOf, parsedMinecraftIntent, MINECRAFT_INTENT_SCHEMA } from '../src/surfaces/minecraft/minecraftIntent.js';

afterEach(() => forgetOwnerNodeOps());

const AT = '2026-11-26T00:00:00.000Z';
/** The cake's plan: wheat (seeds, plant), bone meal, cake; the current node is the seeds. */
function cakePlan(): PlanTree {
  const made = applyPlanUpdate(emptyPlanTree(), { ops: [
    { op: 'add', title: '小麦を育てる' }, { op: 'add', title: '骨粉を作る' }, { op: 'add', title: 'ケーキを作る' },
  ] }, { at: AT });
  expect(made.problem).toBeFalsy();
  const [wheat] = orderedPlan(made.tree.nodes);
  const kids = applyPlanUpdate(made.tree, { ops: [{ op: 'add', parent: wheat!.id, title: '種を集める' }, { op: 'add', parent: wheat!.id, title: '畑に植える' }] }, { at: AT });
  expect(kids.problem).toBeFalsy();
  return applyPlanUpdate(kids.tree, { ops: [], current: orderedPlan(kids.tree.nodes).find(node => node.title === '種を集める')!.id }, { at: AT }).tree;
}
const idOf = (tree: PlanTree, title: string) => tree.nodes.find(node => node.title === title)!.id;
const nodeOf = (tree: PlanTree, title: string) => tree.nodes.find(node => node.title === title)!;
const inner = { take: () => null };

describe('finding the node the owner means', () => {
  it('takes an id, a title as said, or a part of it; and never guesses between two', () => {
    const tree = cakePlan();
    expect(findOwnerNode(tree, idOf(tree, '骨粉を作る'), 'skip')).toMatchObject({ node: { title: '骨粉を作る' } });
    expect(findOwnerNode(tree, '骨粉', 'skip')).toMatchObject({ node: { title: '骨粉を作る' } });
    expect(findOwnerNode(tree, '種を 集める。', 'skip')).toMatchObject({ node: { title: '種を集める' } });
    expect(findOwnerNode(tree, 'ケーキを作る前の準備', 'skip')).toMatchObject({ node: { title: 'ケーキを作る' } });
    expect(findOwnerNode(tree, 'を作る', 'skip')).toMatchObject({ problem: 'ambiguous' });
    expect(findOwnerNode(tree, 'ダイヤ掘り', 'skip')).toEqual({ problem: 'no_such_node' });
    expect(findOwnerNode(tree, 'あ', 'skip')).toEqual({ problem: 'no_such_node' });
  });
});

describe('skip, hold and resume of one node', () => {
  it('skip sets the current node aside with the owner reason and moves on to the next open node; the parent stays open', () => {
    const tree = cakePlan();
    expect(tree.current).toBe(idOf(tree, '種を集める'));
    const change = ownerNodeChange(tree, '種を集める', 'skip');
    expect(change.ok).toBe(true);
    if (!change.ok) return;
    const next = applyOwnerNodeChange(tree, change, AT)!;
    expect(nodeOf(next, '種を集める')).toMatchObject({ state: 'blocked', reason: OWNER_SKIP_REASON });
    expect(nodeOf(next, '種を集める').caution?.[0]).toContain('飛ばした');
    expect(next.current).toBe(idOf(tree, '畑に植える'));
    expect(nodeOf(next, '小麦を育てる').state).not.toBe('done');
    expect(change.note).toContain('飛ばした');
    expect(change.note).toContain('代わりの道');
    expect([...change.cut]).toEqual([idOf(tree, '種を集める')]);
  });

  it('skip of a parent cuts the nodes under it too, and the next open node after it becomes current', () => {
    const tree = cakePlan();
    const change = ownerNodeChange(tree, '小麦を育てる', 'skip');
    if (!change.ok) throw new Error('refused');
    expect(change.cut.size).toBe(3);
    const next = applyOwnerNodeChange(tree, change, AT)!;
    expect(next.current).toBe(idOf(tree, '骨粉を作る'));
  });

  it('hold uses its own reason, and a hold turned into a skip replaces the old caution line', () => {
    let tree = cakePlan();
    const hold = ownerNodeChange(tree, '骨粉を作る', 'hold');
    if (!hold.ok) throw new Error('refused');
    tree = applyOwnerNodeChange(tree, hold, AT)!;
    expect(nodeOf(tree, '骨粉を作る')).toMatchObject({ state: 'blocked', reason: OWNER_HOLD_REASON });
    expect(ownerNodeChange(tree, '骨粉を作る', 'hold')).toMatchObject({ ok: false, problem: 'unchanged' });
    const skip = ownerNodeChange(tree, '骨粉を作る', 'skip');
    if (!skip.ok) throw new Error('refused');
    tree = applyOwnerNodeChange(tree, skip, AT)!;
    expect(nodeOf(tree, '骨粉を作る').reason).toBe(OWNER_SKIP_REASON);
    expect(nodeOf(tree, '骨粉を作る').caution).toHaveLength(1);
    expect(nodeOf(tree, '骨粉を作る').caution![0]).toContain('飛ばした');
  });

  it('resume puts a set-aside node back to continue, lifts the owner line and makes it the current node; only a blocked node can be resumed', () => {
    let tree = cakePlan();
    expect(ownerNodeChange(tree, '骨粉を作る', 'resume')).toMatchObject({ ok: false, problem: 'not_blocked' });
    const hold = ownerNodeChange(tree, '骨粉を作る', 'hold');
    if (!hold.ok) throw new Error('refused');
    tree = applyOwnerNodeChange(tree, hold, AT)!;
    const back = ownerNodeChange(tree, '骨粉を作る', 'resume');
    if (!back.ok) throw new Error('refused');
    tree = applyOwnerNodeChange(tree, back, AT)!;
    expect(nodeOf(tree, '骨粉を作る').state).toBe('continue');
    expect(nodeOf(tree, '骨粉を作る').reason).toBeUndefined();
    expect(nodeOf(tree, '骨粉を作る').caution ?? []).toHaveLength(0);
    expect(tree.current).toBe(idOf(tree, '骨粉を作る'));
  });

  it('refuses a done node, and says a promise tied to the skipped node stays open', () => {
    let tree = cakePlan();
    tree = applyPlanUpdate(tree, { ops: [{ op: 'set', id: idOf(tree, '種を集める'), state: 'done' }] }, { at: AT }).tree;
    expect(ownerNodeChange(tree, '種を集める', 'skip')).toMatchObject({ ok: false, problem: 'node_done' });
    const promised = applyPlanUpdate(tree, { ops: [{ op: 'promise', item: 'wheat_seeds', count: 3, use: '小麦', until: { node: idOf(tree, '畑に植える') } }] }, { at: AT });
    expect(promised.problem).toBeFalsy();
    const change = ownerNodeChange(promised.tree, '畑に植える', 'skip');
    if (!change.ok) throw new Error('refused');
    expect(change.note).toContain('約束');
  });
});

describe('the owner node ops taken at the next read of the task plan', () => {
  it('are taken once, in order, and say what happened in the plan note', () => {
    const tree = cakePlan();
    const logs: string[] = [];
    putOwnerNodeOp('t1', { node: idOf(tree, '種を集める'), title: '種を集める', op: 'skip' });
    putOwnerNodeOp('t1', { node: idOf(tree, '骨粉を作る'), title: '骨粉を作る', op: 'hold' });
    const inbox = withOwnerNodeInbox(inner, line => logs.push(line));
    const taken = inbox.take('t1', tree)!;
    expect(nodeOf(taken.tree, '種を集める').state).toBe('blocked');
    expect(nodeOf(taken.tree, '骨粉を作る').reason).toBe(OWNER_HOLD_REASON);
    expect(taken.note).toContain('飛ばした');
    expect(taken.note).toContain('止めた');
    expect(inbox.take('t1', taken.tree)).toBeNull();
    expect(logs.filter(line => line.includes('taken')).length).toBe(2);
  });

  it('are not taken when the node is not the node they were checked against (the plan was replaced)', () => {
    const tree = cakePlan();
    putOwnerNodeOp('t2', { node: idOf(tree, '種を集める'), title: '別の題', op: 'skip' });
    const logs: string[] = [];
    expect(withOwnerNodeInbox(inner, line => logs.push(line)).take('t2', tree)).toBeNull();
    expect(logs[0]).toContain('not taken');
  });

  it('reach the plan of a task through its plan tools (port.view adopts them; no plan.update of the model is needed)', () => {
    const tree = cakePlan();
    const { port } = createFcaPlanTools({ taskId: 't3', checkpoint: { fcaPlanTree: tree }, inbox: withOwnerNodeInbox(inner), now: () => AT });
    expect(port.view()?.note).toBeUndefined();
    putOwnerNodeOp('t3', { node: idOf(tree, '種を集める'), title: '種を集める', op: 'skip' });
    const view = port.view()!;
    expect(view.note).toContain('飛ばした');
    expect(nodeOf(port.tree(), '種を集める').reason).toBe(OWNER_SKIP_REASON);
    expect(port.tree().current).toBe(idOf(tree, '畑に植える'));
    expect(port.committed()).not.toBeNull();
  });
});

describe('the intent of a voice or a game chat turn', () => {
  it('reads skip with a node, refuses skip without one, and keeps hold of a request apart from hold of a node', () => {
    expect(parsedMinecraftIntent({ kind: 'skip', goal: '', placement: '', target: '', node: '小麦集め' })).toEqual({ kind: 'skip', goal: '', node: '小麦集め' });
    expect(parsedMinecraftIntent({ kind: 'skip', goal: '', placement: '', target: '', node: '' })).toBeNull();
    expect(parsedMinecraftIntent({ kind: 'hold', goal: '', target: '#3' })).toEqual({ kind: 'hold', goal: '', target: '#3' });
    expect(parsedMinecraftIntent({ kind: 'hold', goal: '', target: '', node: '採掘' })).toEqual({ kind: 'hold', goal: '', node: '採掘' });
    expect(parsedMinecraftIntent({ kind: 'resume', goal: '', node: '採掘' })).toEqual({ kind: 'resume', goal: '', node: '採掘' });
    expect(parsedMinecraftIntent({ kind: 'task', goal: 'ケーキ', node: 'x' })).toEqual({ kind: 'task', goal: 'ケーキ' });
    expect(bodyIntentOf({ kind: 'hold', goal: '', node: '採掘' })).toEqual({ kind: 'none', goal: '' });
    expect(bodyIntentOf({ kind: 'hold', goal: '' })).toEqual({ kind: 'stop', goal: '' });
    expect(MINECRAFT_INTENT_SCHEMA.required).toContain('node');
    expect(MINECRAFT_INTENT_SCHEMA.properties.kind.enum).toContain('skip');
  });

  it('carries a node op through the list: the node of the request that runs is skipped, the request stays on the list', async () => {
    const tree = cakePlan();
    const cut: string[][] = [];
    registerOwnerPlan('task-9', { tree: () => tree, cut: async nodes => { cut.push([...nodes]); return 'cut'; } });
    const queue = { locate: () => null, current: () => ({ id: 'e1', seq: 1, taskId: 'task-9', goal: 'ケーキ', state: 'running' }) } as never;
    const outcome = await applyQueueIntent(queue, { kind: 'skip', goal: '', node: '種を集める' }, { origin: 'voice' });
    expect(outcome).toMatchObject({ delivered: true, as: 'queue' });
    expect(cut).toEqual([[idOf(tree, '種を集める')]]);
    expect(withOwnerNodeInbox(inner).take('task-9', tree)?.tree.nodes.find(node => node.title === '種を集める')?.state).toBe('blocked');
    expect(await applyQueueIntent(queue, { kind: 'skip', goal: '', node: 'ダイヤ' }, { origin: 'voice' })).toEqual({ delivered: false, reason: 'no_such_node' });
    expect(await applyQueueIntent({ locate: () => null, current: () => null } as never, { kind: 'skip', goal: '', node: '種' }, { origin: 'voice' }))
      .toEqual({ delivered: false, reason: 'nothing_running' });
    expect(ownerPlanOf('task-9')).not.toBeNull();
  });

  it('says a request that runs with no plan yet is not "nothing running" (no_plan), and a request that is not running is', async () => {
    const running = { id: 'e2', seq: 2, taskId: 'task-new', goal: 'ケーキ', state: 'running' };
    const queue = { locate: () => null, current: () => running } as never;
    expect(await applyQueueIntent(queue, { kind: 'skip', goal: '', node: '種' }, { origin: 'voice' })).toEqual({ delivered: false, reason: 'no_plan' });
    expect(await applyQueueIntent({ locate: () => null, current: () => null } as never, { kind: 'skip', goal: '', node: '種' }, { origin: 'voice' }))
      .toEqual({ delivered: false, reason: 'nothing_running' });
  });
});

describe('the nodes of the plan that run, as lines of her guide', () => {
  it('lists the current node, the next ones and the blocked ones with their ids, and nothing for a task with no plan', () => {
    const tree = cakePlan();
    expect(ownerPlanPromptLines('task-none')).toEqual([]);
    registerOwnerPlan('task-7', { tree: () => tree, cut: async () => '' });
    const lines = ownerPlanPromptLines('task-7', 3);
    expect(lines[0]).toContain('#3');
    expect(lines[1]).toBe(`今 ${idOf(tree, '種を集める')} 種を集める`);
    expect(lines).toContain(`次 ${idOf(tree, '畑に植える')} 畑に植える`);
    expect(lines.join(' ')).toContain('骨粉を作る');
    const change = ownerNodeChange(tree, '骨粉を作る', 'hold');
    if (!change.ok) throw new Error('hold refused');
    const held = applyOwnerNodeChange(tree, change, AT)!;
    registerOwnerPlan('task-7', { tree: () => held, cut: async () => '' });
    expect(ownerPlanPromptLines('task-7').some(line => line.startsWith('止まった') && line.includes('骨粉を作る') && line.includes('owner_hold'))).toBe(true);
    expect(ownerPlanPromptLines('task-7').length).toBeLessThanOrEqual(7);
  });
});

describe('the door of the mod', () => {
  it('reads a closed request', () => {
    expect(MINECRAFT_PLAN_PATH).toBe('/v1/body/minecraft/plan');
    expect(parsedMinecraftPlanRequest({ op: 'skip', node: 'p1.2' })).toEqual({ op: 'skip', node: 'p1.2' });
    expect(parsedMinecraftPlanRequest({ op: 'hold', node: ' 小麦集め ', task: '#3' })).toEqual({ op: 'hold', node: '小麦集め', task: '#3' });
    expect(parsedMinecraftPlanRequest({ op: 'drop', node: 'p1' })).toBeNull();
    expect(parsedMinecraftPlanRequest({ op: 'skip', node: '' })).toBeNull();
    expect(parsedMinecraftPlanRequest({ op: 'skip', node: 'p1', extra: 1 })).toBeNull();
    expect(parsedMinecraftPlanRequest({ op: 'skip', node: 'p1', task: 'bad id!' })).toBeNull();
  });
});
