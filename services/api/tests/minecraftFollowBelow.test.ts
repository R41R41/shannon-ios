import { describe, expect, it } from 'vitest';
import type { PlanKind, PlanNode } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { followBelow, followNode } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { doneFacts } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { v2tree } from './helpers/planTreeV2.js';

/** Underground, the now does not stay on a preparation node of the descent (run61: seven minutes of coming up for wood the live called 「地下なので今は満たせない」). */
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't',
  connected: true, facts: {}, state: { world: { dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, health: 20, food: 20, inventory: [], worn: '', ...world } as never } });
const node = (id: string, kind: PlanKind, order: number, doneWhen: string, extra: Partial<PlanNode> = {}): PlanNode =>
  ({ id, parentId: null, order, title: `節 ${id}`, state: 'continue', kind, ...(doneWhen ? { doneWhen } : {}), ...extra } as PlanNode);
const tree = (current: string, prep: Partial<PlanNode> = {}) => v2tree({ revision: 1, current,
  nodes: [node('n8', 'prep_descent', 0, 'have:crafting_table>=1', prep), node('p5', 'obsidian', 1, 'have:obsidian>=10'), node('p6', 'nether', 2, 'dim:the_nether')] });
const below = (world: Record<string, unknown> = {}) => doneFacts(frame({ position: { x: 0, y: 10, z: 0 }, ...world }))!;

describe('followBelow', () => {
  it('moves the now off an open preparation node to the first open leaf of the work down there, and says the preparation stays', () => {
    const moved = followBelow(tree('n8'), below())!;
    expect(moved).toMatchObject({ to: 'p5', from: 'n8' });
    expect(moved.words).toContain('下りる前の準備の節で、地下なので今は満たせない');
    expect(moved.words).toContain('準備の節は順のまま残る');
  });
  it('does nothing on the surface, in the Nether, when the model wrote prep skipped or unmet_now, or when the now is not a preparation node', () => {
    expect(followBelow(tree('n8'), doneFacts(frame({})))).toBeNull();
    expect(followBelow(tree('n8'), doneFacts(frame({ dimension: 'the_nether', position: { x: 0, y: 10, z: 0 } })))).toBeNull();
    expect(followBelow(tree('n8', { prep: { state: 'skipped' } } as never), below())).toBeNull();
    expect(followBelow(tree('n8', { prep: { state: 'unmet_now' } } as never), below())).toBeNull();
    expect(followBelow(tree('p5'), below())).toBeNull();
  });
  it('skips a node whose condition holds and goes to nothing when none is open', () => {
    const items = [['obsidian', 10]].map(([name, count]) => ({ name, count }));
    expect(followBelow(tree('n8'), doneFacts(frame({ position: { x: 0, y: 10, z: 0 }, inventory: items }))!)).toMatchObject({ to: 'p6' });
    const alone = v2tree({ revision: 1, current: 'n8', nodes: [node('n8', 'prep_descent', 0, 'have:crafting_table>=1')] });
    expect(followBelow(alone, below())).toBeNull();
  });
  it('is not pulled back by the tags of the items (followNode underground leaves a preparation target alone)', () => {
    const t = tree('p5');
    for (let n = 0; n < 6; n += 1) expect(followNode('t-below', t, true)).toBeNull();
  });
});
