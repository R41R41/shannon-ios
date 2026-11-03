import { afterEach, describe, expect, it } from 'vitest';
import type { PlanKind, PlanNode } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { doneFacts } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { forgetHeldStreaks, followHeld, HELD_LIMIT, HELD_WINDOW, noteHeldAct } from '../src/surfaces/minecraft/minecraftLlmcHeldStreak.js';
import { v2tree } from './helpers/planTreeV2.js';

/** A gate that stops the same node again and again (run59, d50: the blaze gate three times): the current node goes to the next open leaf of another kind, as a fact. */
afterEach(() => forgetHeldStreaks());
const frameWith = (items: ReadonlyArray<readonly [string, number]>, world: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1,
  stateAt: 't', receivedAt: 't', connected: true, facts: {},
  state: { world: { dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, health: 20, food: 20, inventory: items.map(([name, count]) => ({ name, count })), worn: '', ...world } as never } });
const node = (id: string, kind: PlanKind, order: number, doneWhen: string, parentId: string | null = null): PlanNode =>
  ({ id, parentId, order, title: id, state: 'continue', kind, ...(doneWhen ? { doneWhen } : {}) } as PlanNode);
const tree = (current: string) => v2tree({ revision: 1, current, nodes: [node('p3', 'nether', 0, ''), node('p3.1', 'fortress', 0, 'see:fortress', 'p3'),
  node('p3.2', 'blaze', 1, 'have:blaze_rod>=7', 'p3'), node('p3.3', 'pearl', 2, 'have:ender_pearl>=12', 'p3')] });
const facts = (extra: Record<string, unknown> = {}) => ({ ...doneFacts(frameWith([['cooked_beef', 20]], { dimension: 'the_nether', ...extra }))!, seen: new Set(['fortress']) });
const gate = { code: 'gate_required', kind: 'fight' };

describe('followHeld', () => {
  it('moves the current node to the next open leaf of another kind after two holds of the same gate, once, and says what lifts it', () => {
    noteHeldAct('t', gate);
    expect(followHeld('t', tree('p3.2'), facts())).toBeNull();
    noteHeldAct('t', gate);
    const moved = followHeld('t', tree('p3.2'), facts())!;
    expect(moved).toMatchObject({ to: 'p3.3', from: 'p3.2' });
    expect(moved.words).toContain(`ブレイズの関所が ${HELD_LIMIT} 回止めた: 今の節を [p3.3]`);
    expect(moved.words).toContain('元の節 [p3.2] p3.2 は順のまま残る');
    expect(moved.words).toContain('そろえば元の節に戻れる');
    expect(followHeld('t', tree('p3.3'), facts())).toBeNull();
  });
  it('counts the holds among the last acts (an act that went through between them does not reset), not across a long gap, not for another gate', () => {
    noteHeldAct('t', gate);
    noteHeldAct('t', null);
    noteHeldAct('t', gate);
    expect(followHeld('t', tree('p3.2'), facts())).toMatchObject({ to: 'p3.3' });
    forgetHeldStreaks();
    noteHeldAct('t', gate);
    for (let n = 0; n < HELD_WINDOW; n += 1) noteHeldAct('t', null);
    noteHeldAct('t', gate);
    expect(followHeld('t', tree('p3.2'), facts())).toBeNull();
    forgetHeldStreaks();
    noteHeldAct('t', gate);
    noteHeldAct('t', { code: 'gate_required', kind: 'walk' });
    expect(followHeld('t', tree('p3.2'), facts())).toBeNull();
    noteHeldAct('t', { code: 'cannot_dig', kind: 'dig' });
    noteHeldAct('t', { code: 'cannot_dig', kind: 'dig' });
    expect(followHeld('t', tree('p3.2'), facts())).toBeNull();
  });
  it('the entry gate of the Nether looks back first, to the golden piece, and never puts the node on the work of the Nether while she is in the overworld', () => {
    const rows = (current: string) => v2tree({ revision: 1, current, nodes: [node('p6', 'portal', 0, ''), node('p6.1', 'other', 0, 'have:golden_boots', 'p6'),
      node('p7', 'portal', 1, 'dim:the_nether'), node('p7.3', 'portal', 0, 'dim:the_nether', 'p7'), node('p9', 'fortress', 2, 'see:fortress'), node('p10', 'blaze', 3, 'have:blaze_rod>=7')] });
    const overworld = doneFacts(frameWith([['cooked_beef', 20]], { dimension: 'overworld' }))!;
    noteHeldAct('t', { code: 'gate_required', kind: 'portal' });
    noteHeldAct('t', { code: 'gate_required', kind: 'portal' });
    const moved = followHeld('t', rows('p7.3'), overworld)!;
    expect(moved).toMatchObject({ to: 'p6.1', from: 'p7.3' });
    expect(moved.words).toContain('ネザーへ入る関所が 2 回止めた');
  });
  it('does not put the node on a food node of the overworld while she is in the Nether (the next read would move it back: pearl, food, pearl)', () => {
    const rows = v2tree({ revision: 1, current: 'p3.2', nodes: [node('p3', 'nether', 0, ''), node('p3.2', 'blaze', 0, 'have:blaze_rod>=7', 'p3'), node('p4', 'food', 1, 'have:cooked_beef>=20')] });
    noteHeldAct('t', gate);
    noteHeldAct('t', gate);
    expect(followHeld('t', rows, facts())).toBeNull();
  });
  it('goes to nothing when no open leaf of another kind is left', () => {
    noteHeldAct('t', gate);
    noteHeldAct('t', gate);
    const alone = v2tree({ revision: 1, current: 'p3.2', nodes: [node('p3.2', 'blaze', 0, 'have:blaze_rod>=7')] });
    expect(followHeld('t', alone, facts())).toBeNull();
  });
});
