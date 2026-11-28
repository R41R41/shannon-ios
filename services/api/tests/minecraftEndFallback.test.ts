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
    expect(system).toContain('For a pillar use pillarUp 2');
    expect(system).toContain('for a wither skeleton 3 levels');
    expect(system).toContain('Also check the headroom for a jump');
    const messages = JSON.stringify(calls[0]!.messages);
    for (const fact of ['手か hotbar に水バケツがあり', '実走で水を置いて被害 0 だった最大は総落差 25m', '垂直 10・25・90m を各 1 回',
      'pack の水バケツは落ちる間に出せないので、先に equip', '未確認: 虚空・未読地形・横の押し・敵との接触',
      'go の目録の maxDrop に「11 以上はエンドだけ」の書きが無く 10 までなら体は旧版', '降りずに欠けた条件を返す', '計画的に降りる手は 3 つ', '飛び降りを最後の手とも、避ける手とも決めつけず']) expect(messages).toContain(fact);
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
  it('puts the crystals, caged ones too, before the bed in the dragon node (11/27), and the sword after them', () => {
    const tree = seedPlan('エンドラ討伐', 'the_end')!;
    const crystals = tree.nodes.find(node => node.title.includes('結晶を全部壊す'))!;
    const bed = tree.nodes.find(node => node.title.includes('（本命）'))!;
    expect(crystals.title).toContain('檻つきも');
    expect(crystals.doneWhen).toBe('crystals<=0');
    expect(crystals.note).toContain('本数に比例しない');
    expect(crystals.note).toContain('格子ごしにそのまま殴る');
    expect(tree.nodes.indexOf(crystals)).toBeLessThan(tree.nodes.indexOf(bed));
    expect(bed.note).toContain('結晶 0 本から');
    expect(bed.note).toContain('ベッドが尽きたら窪みの剣');
    expect(tree.nodes.some(node => node.title.includes('（予備）'))).toBe(false);
  });

  it('gives the first planner and the decision the same words: every crystal, caged ones too, goes down before the dragon', () => {
    for (const words of [V2_STAGES.end, STRATEGY_KNOWLEDGE, STRATEGY_KNOWLEDGE_V2]) {
      expect(words).toContain('檻つきも');
      expect(words).toContain('本数に比例しない');
      expect(words).not.toContain('結晶や檻へ行かず');
      expect(words).not.toContain('檻は最後');
      expect(words).not.toContain('予備の最後');
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

  it('11/27: the first planner puts the crystals, caged ones too, before the dragon, with the reason and the way', () => {
    // e01 (11/9) had the plan ask crystals<=0 and the head spent the perches on a cage; the owner's rule (11/27) is every crystal, caged ones too, with the bars dug on the climb.
    expect(CURRENT_PLAN_STRUCTURE).toContain('crystals<=0');
    expect(CURRENT_PLAN_STRUCTURE).not.toContain('crystals<=2');
    expect(CURRENT_PLAN_STRUCTURE).toContain('檻つきも含めて全部壊す');
    expect(CURRENT_PLAN_STRUCTURE).toContain('毎秒 2 回復し（本数に比例しない）');
    expect(CURRENT_PLAN_STRUCTURE).toContain('格子ごしにそのまま殴り');
    expect(CURRENT_PLAN_STRUCTURE).toContain('竜の節（ベッドを持ち結晶が 0 本なら、bed_standby で「竜をベッドで倒す」ことを体へ予約する。');
    expect(CURRENT_PLAN_STRUCTURE).toContain('飛んでいる間と座りの間は止まり木の脇 10〜14m の足場で、次の降りを待つ）はその後ろ');
    expect(CURRENT_PLAN_STRUCTURE).not.toContain('最初の計画に入れない');
    expect(CURRENT_PLAN_STRUCTURE).not.toContain('最後の手');
  });

  it('makes the insomnia threshold, dive and reset available during preparation', () => {
    expect(V2_STAGES.prep).toContain('3 夜寝ていないと夜に現れることがあり、空から急降下');
    expect(V2_STAGES.prep).toContain('ベッドで寝ると、ファントムが現れるまでの不眠の数えが戻る');
  });
});
