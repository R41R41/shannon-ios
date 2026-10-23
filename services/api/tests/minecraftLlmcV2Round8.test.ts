import { describe, expect, it } from 'vitest';
import { SHORT_ACT_DESCRIPTION } from '../src/contracts/minecraftActShortContract.js';
import { packLines } from '../src/surfaces/minecraft/minecraftLlmcPack.js';
import { repeatedFailures, triedAgain } from '../src/surfaces/minecraft/minecraftLlmcRepeat.js';
import { V2_ALWAYS } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

/**
 * SHANNON_MINECRAFT_LLMC_V2, the eighth round: the body's third candidate (Shannon mb-llmc-cand 70d2343, body 7d50c56). A walk's stop line carries its cause
 * right after the closed word, `一歩ではない（元: …）: 本文` (up to 260 characters), and a drop says where it fell (3 m away or more it is not picked up again).
 * The four scenes of the body's tests (a stream, a house's door, a trapdoor, a stone in the next head) are the causes of the six stops of run 37.
 */
const BODY = '(0,64,0)（自分から同じマス）、的まで 3.0m（range 0.5））。probe path の決まりでは歩いて行ける（3 マス）が、体はそこまで進まなかった。次のマス (-1,64,0)（西1）は 足 air・頭 air・下 stone。';
const SCENES: Array<[string, string]> = [
  ['a stream', '経路探索は道を見つけたが体は進まなかった・水の中・今のマスが水の流れ 5'],
  ['a house\'s door', '経路探索は道を見つけたが体は進まなかった・横の壁に当たっている・次のマスが閉じた oak_door'],
  ['a trapdoor, the cause with a parenthesis of its own', '経路探索は道を見つけたが体は進まなかった・次の頭が oak_trapdoor（手では開かない）・扉を開けようとして失敗'],
  ['a stone in the next head', '経路探索は道を見つけたが体は進まなかった・次の頭が cobblestone'],
];
const lineOf = (cause: string) => `3 walk 止 一歩ではない（元: ${cause}）: 4秒進めず止まった（今 ${BODY}そのマスは water（流れ 5）`;

describe('a walk\'s stop with its cause after the word', () => {
  for (const [name, cause] of SCENES) {
    it(`is read as the same stop at the same cell: ${name}`, () => {
      const body = { lastResults: [lineOf(cause)], stops: ['(0,64,0) 一歩ではない ×2 5秒前'] };
      expect(triedAgain(body)).toEqual([{ do: 'walk', reason: '一歩ではない', cell: '0,64,0', target: null, count: 2 }]);
      expect(repeatedFailures(body)).toEqual(['同じやり直しはしない: (0,64,0) の walk は「一歩ではない」で 2 回止まった']);
    });
  }
  it('is not mistaken for a cell of the cause: the first cell is the body text\'s (今)', () => {
    const body = { lastResults: ['1 walk 止 一歩ではない（元: 次のマスが閉じた oak_door (9,9,9)）: 4秒進めず止まった（今 (2,60,3)（自分から同じマス）'], stops: ['(2,60,3) 一歩ではない ×3 5秒前'] };
    expect(triedAgain(body)[0]).toMatchObject({ cell: '2,60,3', count: 3 });
  });
  it('reads the old form as before (no cause)', () => {
    const body = { lastResults: ['1 walk 止 一歩ではない: 4秒進めず止まった（今 (2,60,3)（自分から同じマス）'], stops: ['(2,60,3) 一歩ではない ×2 5秒前'] };
    expect(triedAgain(body)[0]).toMatchObject({ do: 'walk', reason: '一歩ではない', cell: '2,60,3', count: 2 });
  });
});

describe('the pack and the drop (the body: thrown 3 m or more off, not picked up again)', () => {
  const FULL = ['cobblestone×64', 'cobblestone×57', 'diorite×64', 'cobbled_deepslate×64', 'cobbled_deepslate×64', 'cobbled_deepslate×26', 'dirt×40'];
  it('says the same number as the body: a drop is thrown 3 m or more away, and standing near it picks it up again', () => {
    const line = packLines(FULL)[1]!;
    expect(line).toContain('drop（体は 3m 以上先へ水平に投げる。その近くに立ち続ける・歩くと拾い直す）');
    expect(line).toContain('階段・トンネルで使わない石や土を掘る dig は collect=false');
  });
  it('recommends collect=false for the stair and the tunnel, not for what is picked up (a log, an ore), in the act\'s description and the knowledge', () => {
    expect(SHORT_ACT_DESCRIPTION).toContain('[collect=false: 掘るだけで拾いに歩かない。階段・トンネルで石や土を掘り進む dig に付ける');
    expect(SHORT_ACT_DESCRIPTION).toContain('原木・鉱石など拾う物の dig には付けない');
    expect(V2_ALWAYS).toContain('階段・トンネルで石や土を掘り進む dig は collect=false（付けないと拾い続けて満杯。原木・鉱石の dig には付けない）');
  });
});
