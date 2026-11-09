import { afterEach, describe, expect, it } from 'vitest';
import type { PlanKind, PlanNode } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { doneFacts } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { blazeLacks, deadlyGateHold } from '../src/surfaces/minecraft/minecraftLlmcDeadlyGates.js';
import { followDimension } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { readinessOf } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { followBack, followDimensionHeld, followHeld, forgetHeldStreaks, noteHeldAct } from '../src/surfaces/minecraft/minecraftLlmcHeldStreak.js';
import { v2tree } from './helpers/planTreeV2.js';

/**
 * end1109f02 (11/9): a wither skeleton took health to 11.6 with 24 beef and a shield carried; the blaze gate counted the health as shutting the
 * stage, the plan went from the rods to the pearls, and nothing put it back: health 20 and 1 rod for the rest of the run. Health and hunger come
 * back where she stands, so they hold the hand but not the node; food points and a shield shut the stage, and when they are carried the node goes back.
 */
afterEach(() => forgetHeldStreaks());
const frame = (items: ReadonlyArray<readonly [string, number]>, world: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1,
  stateAt: 't', receivedAt: 't', connected: true, facts: {},
  state: { world: { dimension: 'the_nether', position: { x: 0, y: 70, z: 0 }, health: 20, food: 20, inventory: items.map(([name, count]) => ({ name, count })), worn: '', ...world } as never } });
const node = (id: string, kind: PlanKind, order: number, doneWhen: string, parentId: string | null = null): PlanNode =>
  ({ id, parentId, order, title: id, state: 'continue', kind, ...(doneWhen ? { doneWhen } : {}) } as PlanNode);
const tree = (current: string) => v2tree({ revision: 1, current, nodes: [node('p1', 'nether', 0, ''), node('p1.1', 'fortress', 0, 'see:fortress', 'p1'),
  node('p2', 'blaze', 1, 'have:blaze_rod>=7'), node('p3', 'pearl', 2, 'have:ender_pearl>=14')] });
const F02: Array<[string, number]> = [['cooked_beef', 24], ['shield', 1], ['iron_sword', 1], ['blaze_rod', 1]];
const facts = (items: ReadonlyArray<readonly [string, number]>, world: Record<string, unknown> = {}) =>
  ({ ...doneFacts(frame(items, world))!, seen: new Set(['fortress']) });
const fight = { hands: [{ do: 'fight', target: 'blaze', seconds: 20 }] };

describe('the blaze gate and the plan (end1109f02)', () => {
  it('splits what is missing: health and hunger are quick, food points and a shield are lasting', () => {
    expect(blazeLacks(readinessOf(frame(F02, { health: 11.6 }))!)).toMatchObject({ lasting: [] });
    expect(blazeLacks(readinessOf(frame(F02, { health: 11.6 }))!).quick[0]).toContain('体力 11.6/20');
    expect(blazeLacks(readinessOf(frame([['cooked_beef', 24]]))!).lasting[0]).toContain('盾 0/1');
    expect(blazeLacks(readinessOf(frame([['shield', 1], ['cooked_beef', 2]]))!).lasting[0]).toContain('持ち物の食料');
    // end1109f03: with iron and planks carried a broken shield is made where she stands, so it does not move the node.
    const makeable = blazeLacks(readinessOf(frame([['cooked_beef', 24], ['iron_ingot', 2], ['oak_planks', 16]]))!);
    expect(makeable.lasting).toEqual([]);
    expect(makeable.quick[0]).toContain('今その場で make shield');
  });
  it('holds the fight for health alone and says to keep the node, not to go on to the pearls', () => {
    const held = deadlyGateHold(fight, frame(F02, { health: 11.6 }))!;
    expect(held).toMatchObject({ kind: 'fight' });
    expect(held.line).toContain('体力 11.6/20');
    expect(held.line).toContain('今の節はブレイズのまま変えない');
    expect(held.line).not.toContain('先にパールなど他の段の節へ');
    expect(deadlyGateHold(fight, frame([['cooked_beef', 24]]))!.line).toContain('先にパールなど他の段の節へ今の節を移して進めてよい');
  });
  it('keeps the node on the rods with health 11.6 (the skip of f02) and after two holds for health', () => {
    expect(followDimension(tree('p2'), facts(F02, { health: 11.6 }))).toBeNull();
    expect(followDimensionHeld('t', tree('p2'), facts(F02, { health: 11.6 }))).toBeNull();
    noteHeldAct('t', { code: 'gate_required', kind: 'fight' });
    noteHeldAct('t', { code: 'gate_required', kind: 'fight' });
    expect(followHeld('t', tree('p2'), facts(F02, { health: 11.6, food: 15 }))).toBeNull();
  });
  it('puts the node back on the rods once the shield is carried, after the gate passed them for it, once', () => {
    const noShield: Array<[string, number]> = [['cooked_beef', 24], ['iron_sword', 1]];
    const away = followDimensionHeld('t', tree('p2'), facts(noShield))!;
    expect(away).toMatchObject({ from: 'p2', to: 'p3' });
    expect(away.words).toContain('食料・盾がそろえば元の節へ戻す');
    expect(followBack('t', tree('p3'), facts(noShield))).toBeNull();
    const back = followBack('t', tree('p3'), facts(F02, { health: 14 }))!;
    expect(back).toMatchObject({ from: 'p3', to: 'p2' });
    expect(back.words).toContain('ブレイズの関所の食料・盾がそろった: 今の節を [p2]');
    expect(followBack('t', tree('p3'), facts(F02))).toBeNull();
  });
  it('puts the node back after a move of the held streak too', () => {
    const noShield: Array<[string, number]> = [['cooked_beef', 24], ['iron_sword', 1]];
    noteHeldAct('t', { code: 'gate_required', kind: 'fight' });
    noteHeldAct('t', { code: 'gate_required', kind: 'fight' });
    expect(followHeld('t', tree('p2'), facts(noShield))).toMatchObject({ from: 'p2', to: 'p3' });
    expect(followBack('t', tree('p3'), facts(F02))).toMatchObject({ to: 'p2' });
  });
  it('leaves a node the head chose itself since, and a blaze node done meanwhile', () => {
    const noShield: Array<[string, number]> = [['cooked_beef', 24], ['iron_sword', 1]];
    followDimensionHeld('t', tree('p2'), facts(noShield));
    const chosen = v2tree({ revision: 2, current: 'p4', nodes: [...tree('p3').nodes, node('p4', 'other', 3, '')] });
    expect(followBack('t', chosen, facts(F02))).toBeNull();
    expect(followBack('t', tree('p3'), facts(F02))).toBeNull();
    followDimensionHeld('t', tree('p2'), facts(noShield));
    expect(followBack('t', tree('p3'), facts([...F02, ['blaze_rod', 7]]))).toBeNull();
  });
});
