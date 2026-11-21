import { describe, expect, it } from 'vitest';
import { firstPlanSystemFor, ownFirstPlanSystem, singleRequestFirstPlanSystem } from '../src/surfaces/minecraft/minecraftStrategy.js';
import { firstPlanInput } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { MATERIAL_ACQUISITION_LINES } from '../src/surfaces/minecraft/minecraftRequestKnowledge.js';
import { stageKnowledge } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

describe('what she is told for a request that is one thing to make', () => {
  it('plans a request of one thing from the request, with the way each material is obtained, and not from the whole-game route', () => {
    const single = singleRequestFirstPlanSystem();
    expect(single).toContain('この依頼だけを計画する');
    // The whole-game route and the descent's preparation (the long text on food and nights) are not in it.
    for (const line of ['地下へ下りる前の準備を節に書く', '準備の節の doneWhen は観測の形で書く', '食料と準備', '最初の夜の前、鉄より前に 40〜60 点']) expect(single).not.toContain(line);
    for (const line of MATERIAL_ACQUISITION_LINES) expect(single).toContain(line);
    expect(single).toContain('use bucket target=#id');
    expect(single).toContain('バケツは 3 個');
  });

  it('keeps the whole-game words for the dragon and the Nether, and uses the request words for any other goal', () => {
    expect(firstPlanSystemFor('ケーキを作ってください')).toBe(singleRequestFirstPlanSystem());
    expect(firstPlanSystemFor('オークの原木を16個集める')).toBe(singleRequestFirstPlanSystem());
    expect(firstPlanSystemFor('エンドラを倒して')).toBe(ownFirstPlanSystem());
    expect(firstPlanSystemFor('ネザーに入って')).toBe(ownFirstPlanSystem());
    expect(ownFirstPlanSystem()).toContain('準備の節の doneWhen は観測の形で書く');
  });

  it('puts the cake materials and the milk way into the knowledge of every overworld decision', () => {
    const text = stageKnowledge({ body: { state: { dimension: 'overworld' } } })!;
    for (const line of MATERIAL_ACQUISITION_LINES) expect(text).toContain(line);
    expect(text).toContain('空のバケツを持って牛に use bucket target=#id');
  });

  it('leaves out of a single request the whole-game lines of the structure and the descent food count of the input', () => {
    const single = singleRequestFirstPlanSystem();
    for (const line of ['下の方針', 'エンドラ討伐の後半は', '村が見えれば近い段階で干し草']) expect(single).not.toContain(line);
    expect(ownFirstPlanSystem()).toContain('エンドラ討伐の後半は');
    const world = { dimension: 'overworld', inventory: 'oak_log x3', food: 20, health: 20 };
    expect(firstPlanInput('ケーキを作って', world, { readiness: true })).not.toContain('食料');
    expect(firstPlanInput('エンドラを倒して', world, { readiness: true })).toContain('食料');
  });

  it('tells how wheat and eggs are had when there is no farm or no chicken in sight', () => {
    const text = MATERIAL_ACQUISITION_LINES.join(' ');
    expect(text).toContain('種を植える');
    expect(text).toContain('ニワトリが見えなければ');
  });
});
