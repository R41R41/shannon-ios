import { describe, expect, it } from 'vitest';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { STRATEGY_KNOWLEDGE, STRATEGY_KNOWLEDGE_V2 } from '../src/surfaces/minecraft/minecraftStrategy.js';

describe('the End fallback alongside the main bed plan', () => {
  it('keeps bow and perched sword together without a full-crystal-clearance prerequisite', () => {
    const tree = seedPlan('エンドラ討伐', 'the_end')!;
    const fallback = tree.nodes.find(node => node.title.includes('（予備）'))!;
    expect(fallback.title).toContain('結晶を弓で壊しつつ止まり木の竜を剣で打つ');
    expect(fallback.doneWhen).toBeUndefined();
    expect(fallback.note).toContain('竜の体力50以下なら結晶へ行かず窪みの足場の剣か残りのベッド');
    expect(tree.nodes.some(node => node.doneWhen === 'crystals<=0')).toBe(false);
    expect(tree.nodes.find(node => node.title.includes('（本命）'))).toBeDefined();
  });

  it('gives the first planner and the decision the same low-health and cage facts', () => {
    for (const words of [V2_STAGES.end, STRATEGY_KNOWLEDGE, STRATEGY_KNOWLEDGE_V2]) {
      expect(words).toContain('体力 50 以下');
      expect(words).toContain('結晶や檻へ行かず');
      expect(words).toContain('体力が 100 超');
      expect(words).toContain('檻は');
      expect(words).not.toContain('クリスタルを全部壊した後');
      expect(words).not.toContain('エンドクリスタルを先に壊し');
    }
    expect(V2_STAGES.end).toContain('onFail="continue"');
    expect(V2_STAGES.end).toContain('頭の次の判断を待たず後ろの go が動く');
  });

  it('describes the crossing and the Enderman refuge without guessing a fixed island landing', () => {
    const words = V2_STAGES.end;
    expect(words).toContain('竜が遠い時（phase 2');
    expect(words).toContain('原点 (0,y,0) 側の主島');
    expect(words).toContain('観測済みの床と頭上の空間があるマス');
    expect(words).not.toContain('(67,59,0)');
    for (const fact of ['エンダーマンは目が合うと怒る', 'エンダーマンの少ない足場', '足元の水', '高さ 2 マスの天井']) {
      expect(words).toContain(fact);
    }
  });

  it('makes the insomnia threshold, dive and reset available during preparation', () => {
    expect(V2_STAGES.prep).toContain('3 夜寝ていないと夜に現れることがあり、空から急降下');
    expect(V2_STAGES.prep).toContain('ベッドで寝ると、ファントムが現れるまでの不眠の数えが戻る');
  });
});
