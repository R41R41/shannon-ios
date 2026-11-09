import { describe, expect, it, vi } from 'vitest';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { minecraftV2Hooks } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { STRATEGY_KNOWLEDGE, STRATEGY_KNOWLEDGE_V2 } from '../src/surfaces/minecraft/minecraftStrategy.js';
import { CURRENT_PLAN_STRUCTURE } from '../src/surfaces/minecraft/minecraftCurrentPlanPrompt.js';

describe('the End fallback alongside the main bed plan', () => {
  it('delivers the Wither height exception and bounded clutch evidence in the actual V2 request', async () => {
    const calls: Record<string, unknown>[] = [];
    const client = { messages: { async create(body: Record<string, unknown>) {
      calls.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
      throw new Error('OFFLINE_CAPTURE_ONLY');
    } } };
    const model = createAnthropicFcaModel({ model: 'claude-haiku-5-5', client: client as never,
      recordUsage() {}, minecraftOwnPrompt: true, minecraftV2: minecraftV2Hooks() });
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(model.decide({ task: { id: 'guidance', title: 'End', goal: 'エンドラ討伐', completionCriteria: 'native' },
        messages: [], children: [], history: [], tools: [], coreTools: [],
        transient: { state: { dimension: 'the_end' } } }, new AbortController().signal)).rejects.toThrow();
    } finally { quiet.mockRestore(); }
    expect(calls).toHaveLength(1);
    const system = JSON.stringify(calls[0]!.system);
    expect(system).toContain('柱はpillarUp 2');
    expect(system).toContain('ウィザースケルトンは3段');
    expect(system).toContain('跳ぶ頭上の空間も確認');
    const messages = JSON.stringify(calls[0]!.messages);
    for (const fact of ['対応版で有効な時だけ', '手・hotbar の水', '垂直 10・25・90m を各 1 回',
      'pack からの自動装備はしない', '虚空・未読地形・横の押し・敵との接触・実戦での救命は未保証',
      '旧無効版や有効状態が未確認なら頼らない', '計画的な下降', '水を置かずに跳び降りない']) expect(messages).toContain(fact);
    expect(messages).not.toContain('今は働かない前提');
  });

  it('keeps first-plan bucket preparation conservative without claiming that the connected body is disabled', () => {
    const plan = seedPlan('エンドラ討伐')!;
    const departure = plan.nodes.find(node => node.title === '出発の点検（エンドへ）')!;
    expect(departure.note).toContain('手・hotbar');
    expect(departure.note).toContain('対応版で有効な時だけ');
    expect(departure.note).toContain('事前に水を置くか vertical');
    expect(departure.note).not.toContain('働かない前提');
  });
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

  it('e01 S11: the first planner aims the bed at the perch, not the caged crystals', () => {
    // e01 (11/9): the plan asked crystals<=0, so the head spent the dragon's two perches 60 m off on a cage and never placed a bed.
    expect(CURRENT_PLAN_STRUCTURE).not.toContain('crystals<=0');
    expect(CURRENT_PLAN_STRUCTURE).toContain('crystals<=2');
    expect(CURRENT_PLAN_STRUCTURE).toContain('止まり木に降りた時にベッドで倒すのが本命');
    expect(CURRENT_PLAN_STRUCTURE).toContain('最初の計画に入れない');
  });

  it('makes the insomnia threshold, dive and reset available during preparation', () => {
    expect(V2_STAGES.prep).toContain('3 夜寝ていないと夜に現れることがあり、空から急降下');
    expect(V2_STAGES.prep).toContain('ベッドで寝ると、ファントムが現れるまでの不眠の数えが戻る');
  });
});
