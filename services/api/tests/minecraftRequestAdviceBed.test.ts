import { describe, expect, it } from 'vitest';
import { REPLAN_SYSTEM } from '../src/surfaces/minecraft/minecraftLlmcReplan.js';
import { REQUEST_NIGHT_WAY, REQUEST_PLAN_SHAPE_LINES, REQUEST_REPLAN_KNOWLEDGE } from '../src/surfaces/minecraft/minecraftRequestSteps.js';

describe('a one-thing request: the advice of a person and the bed are said with their reasons', () => {
  it('the plan made again takes a person\'s bone meal advice as a node, with what bone meal does for the crop', () => {
    expect(REQUEST_REPLAN_KNOWLEDGE).toContain('人の助言で骨粉・骨・スケルトンが来た時は採る');
    expect(REQUEST_REPLAN_KNOWLEDGE).toContain('植えた小麦の育ちを早め');
    expect(REQUEST_REPLAN_KNOWLEDGE).toContain('理由: 役立つ助言を捨てると');
    expect(REPLAN_SYSTEM).toContain('助言が依頼の目的にどう効くかを先に考える');
  });
  it('the first plan puts a bed node before the materials when no bed is carried, and the evening line says to make the bed first', () => {
    const shape = REQUEST_PLAN_SHAPE_LINES.join('\n');
    expect(shape).toContain('材料の節より前（最初の節）に「ベッドを作る」');
    expect(shape).toContain('理由: 夜は地上の敵が増えて危なく、寝れば夜を飛ばせる');
    expect(REQUEST_NIGHT_WAY.startsWith('まずベッドを作る')).toBe(true);
    expect(REQUEST_NIGHT_WAY).toContain('理由: 夜の地上は敵が増えて危なく、寝れば夜を飛ばせて');
  });
});
