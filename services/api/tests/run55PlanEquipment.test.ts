import { describe, expect, it } from 'vitest';
import type { PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { readinessParts } from '../src/surfaces/minecraft/minecraftLlmcBodyFacts.js';
import { preparationShortage } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';

const TOOL = '黒曜石の採掘に使えるツルハシ';
const tree: PlanTree = { schema: 'shannon.plan-tree.v2', revision: 1, current: 'p10', promises: [], nodes: [
  { id: 'p4', parentId: null, order: 4, title: '下りる前の準備', kind: 'prep_descent', state: 'continue',
    doneWhen: 'food>=40', prep: { state: 'skipped', why: '雪原で食料探索に時間がかかった', at: '2026-10-31T04:44:20.446Z' } },
  { id: 'p7', parentId: null, order: 7, title: 'ダイヤ3掘る', kind: 'diamond', state: 'done', doneWhen: 'have:diamond_pickaxe' },
  { id: 'p10', parentId: null, order: 10, title: '黒曜石10作る', kind: 'obsidian', state: 'continue', doneWhen: 'have:obsidian>=10' },
] };
const observation = (pick = 'iron_pickaxe'): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, connected: true,
  stateAt: '2026-10-31T07:35:01Z', receivedAt: '2026-10-31T07:35:01Z', facts: {}, state: {
    life: { life: 2 } as never,
    world: { dimension: 'overworld', position: { x: -5, y: 63, z: 24 }, health: 20, food: 17,
      inventory: [{ name: pick, count: 1 }, { name: 'water_bucket', count: 1 }, { name: 'iron_chestplate', count: 1 }], worn: {} } as never } });
const parts = { plan: () => undefined, planView: () => null, planTree: () => tree };

describe('run55: past tool acquisition does not establish current mining capability', () => {
  it('reports the missing current obsidian tool beside the food shortage without rewriting history or the model waiver', () => {
    const before = JSON.stringify(tree);
    const live = readinessParts(parts, null, observation());
    expect(live.shortage).toContain(TOOL);
    expect(live.shortage).toContain('食料 0');
    expect(JSON.stringify(tree)).toBe(before);
    expect(tree.nodes[1]!.state).toBe('done');
    expect(tree.nodes[0]!.prep?.state).toBe('skipped');
  });
  it.each(['diamond_pickaxe', 'netherite_pickaxe'])('stops reporting the tool gap when %s is currently present', pick => {
    expect(readinessParts(parts, null, observation(pick)).shortage).not.toContain(TOOL);
  });
  it.each(['wooden_pickaxe', 'stone_pickaxe', 'golden_pickaxe'])('%s does not establish obsidian harvesting', pick => {
    expect(readinessParts(parts, null, observation(pick)).shortage).toContain(TOOL);
  });
  it('does not infer mining from a portal node or an obsidian ancestor', () => {
    expect(preparationShortage({ dimension: 'overworld', counts: new Map([['iron_pickaxe', 1]]), food: 40,
      nowKinds: ['portal', 'obsidian'] })).not.toContain(TOOL);
  });
  it('states the same tool fact for obsidian mining in the End without adding a preparation stage', () => {
    expect(preparationShortage({ dimension: 'the_end', counts: new Map([['iron_pickaxe', 1]]), food: 40,
      nowKinds: ['obsidian'] })).toContain(TOOL);
  });
  it('makes no current inventory claim without an observation', () => {
    expect(readinessParts(parts, null, null).shortage).toBeUndefined();
  });
});
