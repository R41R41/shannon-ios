import { describe, expect, it } from 'vitest';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

/**
 * end1108b S9 (11/8): the eyes' intersection lay across a sea. She wrote 「海の上は渡れない」「橋で届く量ではない」, bridged and tunnelled in
 * 30 m legs at 0.5-0.8 m/s, and turned to a gate, flint and gold. The same body swam the sea with go waterOk at about 3 m/s.
 */
describe('end1108b S9: the sea is swum on the way to the stronghold, in long legs', () => {
  const stronghold = V2_STAGES.stronghold;
  it('says the sea is swum with go waterOk, not bridged or tunnelled, and is no reason to turn to the Nether', () => {
    for (const word of ['海・川・湖は泳いで渡れる', 'go に waterOk を付けると、体は水面を泳いで進む', '海に橋を架けない・海の下を掘って進まない', 'walk は泳がない',
      '交点が海の向こうにあることは、地上の道をやめる理由にならない']) expect(stronghold, word).toContain(word);
    expect(stronghold).not.toContain('海は迂回');
    expect(stronghold).not.toContain('丸石を多めに持つ');
  });
  it('asks for legs of about 200 m and says why 30 m legs were slow', () => {
    for (const word of ['go の to は 200m 前後先', '海が見えていなくても毎回。無いと水の上に橋を架けて丸石を使い切る', '30m 刻みでは全体が 0.5〜0.8 m/s に落ちた', '丸石は 64 あれば足りる']) expect(stronghold, word).toContain(word);
  });
  it('puts the same caution on the plan\'s node that walks to the intersection', () => {
    const node = seedPlan('エンドラを倒して', 'overworld')!.nodes.find(each => each.title === '目玉の交点へ行き、地下の枠の部屋を見つける')!;
    expect(node.caution?.[0]).toContain('海は go waterOk で泳いで渡る');
  });
});
