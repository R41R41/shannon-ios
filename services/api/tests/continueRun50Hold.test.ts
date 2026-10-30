import { describe, expect, it } from 'vitest';
import type { PlanTree, PlanUpdate } from '@shannon/mind';
import { createFcaPlanTools } from '../src/mind/action/fca/fcaPlanTools.js';
import { preparationCompletionProblem } from '../src/surfaces/minecraft/minecraftPlanCompletion.js';
import { doneFacts } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { vitalsLine } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { heldBeforeSend } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';

const frame = (extra: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1,
  connected: true, stateAt: 't', receivedAt: 't', facts: {}, state: { world: { health: 2, food: 16, inventory: { crafting_table: 1, rotten_flesh: 1 }, ...extra } } });
const tree: PlanTree = { schema: 'shannon.plan-tree.v2', revision: 1, current: 'p2', promises: [], nodes: [
  { id: 'p2', parentId: null, order: 0, title: '食料を集める', state: 'continue', kind: 'food', doneWhen: 'food>=40' },
  { id: 'p3', parentId: null, order: 1, title: '下りる前の準備', state: 'continue', kind: 'prep_descent', doneWhen: 'food>=40&have:crafting_table|food>=40&have:planks>=4' },
] };
function tools(observation: BodyObservation) {
  const made = createFcaPlanTools({ taskId: 't', checkpoint: { fcaPlanTree: tree },
    validateUpdate: (before, after) => preparationCompletionProblem(before, after, observation) });
  return { ...made, update: (input: PlanUpdate) => made.tools.execute({ scopeKey: 's', taskId: 't', operationId: 'op',
    name: 'plan.update', input, signal: new AbortController().signal }) };
}

describe('run50 hold1: deferring unmet preparation is not completing it', () => {
  it('rejects the actual two-node false completion atomically, even when the reason says skipped', async () => {
    const made = tools(frame());
    const result = await made.update({ ops: [{ op: 'set', id: 'p2', state: 'done', reason: '近くに動物無し・食料は後で探す' },
      { op: 'set', id: 'p3', state: 'done', reason: '食料不足を承知で skipped。地下で動物か箱を探す' }] });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('食料 0/40');
    expect(made.port.tree().nodes.every(node => node.state === 'continue')).toBe(true);
  });
  it('accepts the explicit skipped representation without counting it as met', async () => {
    const made = tools(frame());
    expect((await made.update({ ops: tree.nodes.map(node => ({ op: 'set', id: node.id, state: 'done', prep: { state: 'skipped', why: '後で補う' } })) })).ok).toBe(true);
    expect(made.port.tree().nodes.every(node => node.prep?.state === 'skipped')).toBe(true);
  });
  it('accepts genuinely met preparation and ordinary historical completion is not undone after eating', async () => {
    const made = tools(frame({ inventory: { bread: 4, crafting_table: 1 } }));
    expect((await made.update({ ops: tree.nodes.map(node => ({ op: 'set', id: node.id, state: 'done' })) })).ok).toBe(true);
    const done = made.port.tree();
    expect(preparationCompletionProblem(done, { ...done, current: null }, frame())).toBeNull();
  });
  it('rejects a newly claimed prep met state while food is still absent', async () => {
    const made = tools(frame());
    expect((await made.update({ ops: [{ op: 'set', id: 'p3', prep: { state: 'met' } }] })).ok).toBe(false);
  });
  it('does not turn missing or shortened inventory into an empty-stock finding', async () => {
    for (const inventory of [undefined, null, ['crafting_table×1', 'ほか4件（長いため略）']]) {
      const made = tools(frame({ inventory }));
      expect((await made.update({ ops: [{ op: 'set', id: 'p3', state: 'done' }] })).ok).toBe(true);
    }
  });
});

describe('run50 hold1: low-health combat and emergency food', () => {
  it.each([undefined, 3, 5, 8])('does not send a fight at health 5 with retreatHp %s, but permits fleeing', retreatHp => {
    const hand = { do: 'fight', target: 'skeleton', ...(retreatHp === undefined ? {} : { retreatHp }) };
    expect(heldBeforeSend(false, { hands: [hand] }, frame({ health: 5 }), 't')?.result?.text).toContain('fight は送っていない');
    expect(heldBeforeSend(false, { hands: [{ ...hand, stance: 'flee' }] }, frame({ health: 5 }), 't')).toBeNull();
  });
  it('lets a healthy body fight, with the existing retreat threshold respected', () => {
    expect(heldBeforeSend(false, { hands: [{ do: 'fight', target: 'skeleton', retreatHp: 8 }] }, frame({ health: 12 }), 't')).toBeNull();
  });
  it('reports the hidden emergency food without adding it to normal preparation food points', () => {
    expect(vitalsLine(frame())).toContain('非常食 rotten_flesh×1');
    expect(vitalsLine(frame())).toContain('空腹の効果');
    expect(doneFacts(frame())?.food).toBe(0);
    expect(vitalsLine(frame({ inventory: {} }))).not.toContain('非常食');
  });
});
