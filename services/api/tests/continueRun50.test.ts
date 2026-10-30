import { describe, expect, it } from 'vitest';
import type { PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { nodesSeenDone, seenDoneUpdate, doneFacts } from '../src/surfaces/minecraft/minecraftPlanDone.js';

const equipment = ['iron_chestplate', 'iron_leggings', 'iron_helmet', 'shield'];
const frame = (extra: string[]): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1, connected: true,
  stateAt: '2026-10-30T00:00:00Z', receivedAt: '2026-10-30T00:00:00Z', facts: {},
  state: { world: { dimension: 'overworld', position: { x: 0, y: 16, z: 0 }, inventory: Object.fromEntries([...equipment, ...extra].map(item => [item, 1])) } } });
const tree: PlanTree = { schema: 'shannon.plan-tree.v2', revision: 1, current: 'p5', promises: [], nodes: [
  { id: 'p5', parentId: null, order: 0, title: '鉄を掘り装備', state: 'continue', doneWhen: 'have:iron_chestplate&have:iron_leggings&have:iron_helmet' },
  { id: 'p5.2', parentId: 'p5', order: 0, title: '道具と防具を作り着る', state: 'continue',
    doneWhen: 'have:iron_chestplate&have:iron_leggings&have:iron_helmet&have:shield&have:bucket&have:flint_and_steel' },
] };

describe('run 49: a completed armour parent must not discard its unfinished equipment child', () => {
  it.each([[], ['bucket'], ['flint_and_steel'], ['water_bucket']].map(extra => ({ extra })))('keeps the parent and its own child open with $extra', ({ extra }) => {
    expect(nodesSeenDone(tree, doneFacts(frame(extra))!)).toEqual([]);
    expect(seenDoneUpdate(tree, frame(extra))?.ids ?? []).toEqual([]);
  });
  it('closes both only once the child has the bucket and flint and steel, including a full bucket', () => {
    for (const bucket of ['bucket', 'water_bucket']) {
      expect(nodesSeenDone(tree, doneFacts(frame([bucket, 'flint_and_steel']))!)).toEqual(['p5', 'p5.2']);
    }
  });
});
