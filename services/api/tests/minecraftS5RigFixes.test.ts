import { describe, expect, it } from 'vitest';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { doneFacts, nodesSeenDone } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

/** S5's rig of 11/5 (the stronghold section on the real head): what the decisions got wrong, as the words and the plan now say it. */
const frame = (world: Record<string, unknown>) => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true, facts: {},
  state: { world: { dimension: 'the_nether', position: { x: 0, y: 70, z: 0 }, ...world } } }) as never;

describe('the stronghold section on the real head (S5, 11/5)', () => {
  it('writes the counts of the powder and the eyes out, and says to make twelve or more before throwing', () => {
    expect(V2_STAGES.pearl).toContain('craft item=blaze_powder count=14（ロッド 7 本を使う）');
    expect(V2_STAGES.stronghold).toContain('アイは 12 個以上まとめて作ってから投げる');
    expect(V2_STAGES.nether).toContain('ネザーの座標をオーバーワールドの go に使わない');
  });
  it('closes the fortress node with seven rods or an eye in hand, not only by seeing the fortress', () => {
    const tree = seedPlan('エンドラを討伐してください', 'the_nether')!;
    const fortress = tree.nodes.find(node => node.title === 'ネザー要塞を探す')!;
    const rods = doneFacts(frame({ inventory: [{ name: 'blaze_rod', count: 7 }] }))!;
    expect(nodesSeenDone(tree, rods)).toContain(fortress.id);
    expect(nodesSeenDone(tree, doneFacts(frame({ inventory: [{ name: 'blaze_rod', count: 3 }] }))!)).not.toContain(fortress.id);
  });
});
