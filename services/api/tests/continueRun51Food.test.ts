import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PlanNode, PlanTree } from '@shannon/mind';
import { foodFirstLine } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { createLlmcEvents, llmcTransient } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
const tree = JSON.parse(readFileSync(new URL('./fixtures/run51-food-plan.json', import.meta.url), 'utf8')) as PlanTree;
const frame = (dimension: string) => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, connected: true, stateAt: 't', receivedAt: 't', facts: {},
  state: { world: { dimension, health: 15.8, food: 17, inventory: {}, position: { x: -10, y: 69, z: 1 } } } }) as const;
describe('run51 hold2: food for recovery belongs to the current dimension', () => {
  it('does not direct the actual overworld recovery to future Nether hoglins', () => {
    const line = foodFirstLine(tree.nodes, tree.current, null, 'overworld');
    expect(line).toContain('今いる次元（overworld）で向かえる食料の節は未確認');
    expect(line).not.toContain('p12.4'); expect(line).not.toContain('ホグリン');
  });
  it('passes the actual frame dimension through the production live-state builder', () => {
    const made = llmcTransient({ plan: () => ({ revision: tree.revision, current: tree.current, nodes: tree.nodes }), planView: () => tree,
      planTree: () => tree }, createLlmcEvents('r51-food'), frame('overworld'), 20) as { planNow: string };
    expect(made.planNow).not.toContain('[p12.4]'); expect(made.planNow).toContain('今いる次元（overworld）');
  });
  it('can still point to that food once she is in the Nether', () => {
    expect(foodFirstLine(tree.nodes, tree.current, null, 'the_nether')).toContain('[p12.4] 食料100点');
  });
  it('does not infer a dimension from a title or free-form place name', () => {
    const nodes = tree.nodes.filter(n => n.id !== 'p11');
    expect(foodFirstLine(nodes, tree.current, null, 'overworld')).toContain('[p12.4]');
  });
  it('finds a later current-dimension food node after an explicit return gate', () => {
    const nodes: PlanNode[] = [{ id: 'now', parentId: null, order: 0, title: '今の節', state: 'continue', kind: 'diamond' },
      { id: 'return', parentId: null, order: 90, title: '戻る', state: 'continue', kind: 'portal', doneWhen: 'dim:overworld' },
      { id: 'food-again', parentId: null, order: 91, title: '地上で食料', state: 'continue', kind: 'food', doneWhen: 'food>=40' }];
    expect(foodFirstLine(nodes, 'now', null, 'overworld')).toContain('[food-again]');
    expect(foodFirstLine(nodes, 'now', null, 'the_nether')).not.toContain('[food-again]');
  });
  it('keeps the previous unknown-dimension behavior and does not reopen a skipped preparation', () => {
    expect(foodFirstLine(tree.nodes, tree.current, null)).toContain('[p12.4]');
    const nodes = tree.nodes.map(n => n.id === 'p12.4' ? { ...n, prep: { state: 'skipped' as const, why: '今回は省く' } } : n);
    expect(foodFirstLine(nodes, tree.current, null, 'overworld')).not.toContain('[p12.4]');
  });
});
