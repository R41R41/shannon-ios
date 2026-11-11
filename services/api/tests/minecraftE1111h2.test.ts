import { describe, expect, it } from 'vitest';
import type { DoneFacts } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { closedUnder, nodesSeenDone } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { sheepAbsentLine } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';

/** e1111h2 (00:19): the village node says nothing about sheep, and the wood of the run is not closed by an iron-pickaxe branch. */
const facts = (extra: Partial<DoneFacts> = {}, items: Record<string, number> = {}): DoneFacts => ({ counts: new Map(Object.entries(items)), dimension: 'overworld',
  feet: { x: 250, y: 62, z: -92 }, food: 30, ...extra });

describe('the sheep line for a village node', () => {
  const now = (kind: string) => ({ id: 'p2.1', parentId: 'p2', title: '村のベッド', kind, doneWhen: 'have:bed>=8' }) as never;
  it('says nothing for a village node and still says it for a bed node', () => {
    const world = { position: { x: 0, y: 64, z: 0 } };
    expect(sheepAbsentLine(world, new Map(), 'overworld', [], now('village'))).toBeNull();
    expect(sheepAbsentLine(world, new Map(), 'overworld', [now('bed')], now('bed'))).toContain('羊: 今の節 p2.1');
  });
});

describe('the seed plan: the wood of the whole run is waited for', () => {
  it('has no done-condition on p1, and p1.4 stays open when the iron pickaxe is made with 3 logs', () => {
    const t = seedPlan('ネザーに行って')!;
    const p1 = t.nodes.find(node => node.id === 'p1')!;
    expect(p1.doneWhen).toBeUndefined();
    const f = facts({}, { oak_log: 3, iron_pickaxe: 1 });
    const seen = nodesSeenDone(t, f, true);
    expect(seen).not.toContain('p1');
    expect(closedUnder(t, seen, f).map(item => item.id)).not.toContain('p1.4');
  });
});
